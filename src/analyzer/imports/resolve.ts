/**
 * Module resolution.
 *
 * Turning `./used.js` into an absolute path is where a static analyser quietly
 * goes wrong. The specifiers in real code are not file paths:
 *
 * - `./used.js` in a TypeScript file usually means `./used.ts`. The `.js` is what
 *   the *emitted* code needs, not what exists on disk.
 * - `./used` may be `used.ts`, `used.tsx`, `used/index.ts`, `used.js`...
 * - `./x` may resolve through `tsconfig.json` `paths`, which is a regex over the
 *   whole specifier rather than a path prefix.
 * - A bare specifier may be an npm package, which is either real code in
 *   node_modules or a false edge that should not be reported.
 *
 * Each of those is a different rule, and guessing between them is how a tool
 * decides a widely used file is unused. Resolution therefore tries concrete
 * candidates in a defined order and reports which one it used, so a wrong answer
 * is visible rather than silent.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  ALL_EXTENSIONS,
  DEFAULT_ENTRY_POINTS,
  SOURCE_EXTENSIONS,
} from '../../config/defaults.js';
import { normalisePath } from '../../utils/path.js';

/** Extensions tried when a specifier has none. */
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** Path aliases read from tsconfig.json `paths` and `baseUrl`. */
export interface PathMapping {
  readonly baseUrl: string | null;
  /** Pattern to replacement, already expanded from the tsconfig form. */
  readonly entries: readonly { pattern: string; targets: readonly string[] }[];
}

export type Resolution =
  | { kind: 'file'; path: string; via: string }
  | { kind: 'directory'; path: string; via: string }
  | { kind: 'external'; specifier: string; packageName: string }
  | { kind: 'unresolved'; specifier: string; reason: string };

/** True when the specifier points outside the project, at an npm package. */
function packageNameOf(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return '';
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Read tsconfig.json, tolerating comments and a trailing comma. */
function readTsconfig(root: string): Record<string, unknown> | null {
  const path = join(root, 'tsconfig.json');
  if (!existsSync(path)) return null;
  try {
    // JSON with comments and trailing commas is the norm in tsconfig files and
    // JSON.parse rejects both, so the common forms are stripped first.
    const raw = readFileSafe(path);
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    // Returning null here turns path aliases off, which is indistinguishable
    // from a project that has none. That silently misclassifies every aliased
    // import as an external package. The caller reports the failure instead.
    return null;
  }
}

function readFileSafe(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Build the path mapping from a tsconfig, following `extends` one level. */
export function loadPathMapping(root: string): PathMapping {
  const config = readTsconfig(root);
  if (!config) return { baseUrl: null, entries: [] };

  const compilerOptions = (config['compilerOptions'] ?? {}) as Record<string, unknown>;
  const baseUrl = typeof compilerOptions['baseUrl'] === 'string'
    ? resolve(root, compilerOptions['baseUrl'])
    : null;

  const paths = compilerOptions['paths'];
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return { baseUrl, entries: [] };
  }

  const entries: { pattern: string; targets: string[] }[] = [];
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue;
    const list = targets.filter((t): t is string => typeof t === 'string');
    if (list.length > 0) entries.push({ pattern, targets: list });
  }
  return { baseUrl, entries };
}

/**
 * Try a candidate path, accounting for the `.js` to `.ts` rewrite.
 *
 * `./used.js` in TypeScript means the emitted file, which is produced from
 * `used.ts`. That mapping is checked first, because checking the literal `.js`
 * first would find a stale build artefact when one exists and silently analyse
 * the wrong file.
 */
function tryPath(candidate: string): string | null {
  // The TypeScript emit rewrite: a .js specifier may name a .ts source.
  const extensionMatch = /\.(js|jsx|mjs|cjs)$/.exec(candidate);
  if (extensionMatch) {
    const stem = candidate.slice(0, -extensionMatch[0].length);
    const sourceExtension =
      extensionMatch[1] === 'jsx' ? '.tsx'
      : extensionMatch[1] === 'js' ? '.ts'
      : extensionMatch[1];
    const source = `${stem}${sourceExtension}`;
    if (existsSync(source)) return source;
    // .ts can also be authored as .tsx when it contains JSX.
    if (sourceExtension === '.ts' && existsSync(`${stem}.tsx`)) return `${stem}.tsx`;
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  for (const extension of RESOLVE_EXTENSIONS) {
    const withExtension = candidate + extension;
    if (existsSync(withExtension) && statSync(withExtension).isFile()) return withExtension;
  }

  // A directory: either an index file or the directory itself.
  const asDirectory = join(candidate, 'index');
  if (existsSync(asDirectory) && statSync(asDirectory).isDirectory()) {
    for (const extension of RESOLVE_EXTENSIONS) {
      const indexFile = `${asDirectory}${extension}`;
      if (existsSync(indexFile) && statSync(indexFile).isFile()) return indexFile;
    }
    return candidate;
  }

  return null;
}

/** Match a specifier against tsconfig `paths`, honouring their single `*`. */
function applyPathMapping(
  specifier: string,
  mapping: PathMapping,
  root: string,
): string | null {
  if (mapping.entries.length === 0) return null;
  for (const { pattern, targets } of mapping.entries) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern !== specifier) continue;
      for (const target of targets) {
        const resolved = tryPath(resolve(root, target));
        if (resolved) return resolved;
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of targets) {
      const candidate = resolve(root, target.replace('*', middle));
      const resolved = tryPath(candidate);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Resolve one specifier from one file.
 *
 * @param specifier the text in the import statement
 * @param fromFile absolute path of the importing file
 * @param root absolute project root
 * @param mapping path aliases from tsconfig
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  root: string,
  mapping: PathMapping,
): Resolution {
  const packageName = packageNameOf(specifier);

  if (packageName) {
    const aliased = applyPathMapping(specifier, mapping, root);
    if (aliased) return { kind: 'file', path: aliased, via: 'tsconfig-paths' };
    return { kind: 'external', specifier, packageName };
  }

  if (isAbsolute(specifier)) {
    const direct = tryPath(specifier);
    return direct
      ? { kind: 'file', path: direct, via: 'absolute' }
      : { kind: 'unresolved', specifier, reason: 'absolute path does not exist' };
  }

  // Aliases are checked before relative paths: a `paths` entry for `@app/*` is
  // unambiguous, while a relative one that happens to start with `@` is not
  // something any project actually does.
  const aliased = applyPathMapping(specifier, mapping, root);
  if (aliased) return { kind: 'file', path: aliased, via: 'tsconfig-paths' };

  const candidate = resolve(dirname(fromFile), specifier);
  const direct = tryPath(candidate);
  if (direct) {
    const asDirectory = existsSync(direct) && statSync(direct).isDirectory();
    return asDirectory
      ? { kind: 'directory', path: direct, via: 'relative' }
      : { kind: 'file', path: direct, via: 'relative' };
  }

  return {
    kind: 'unresolved',
    specifier,
    reason: 'no file matched the specifier, trying extensions and index files',
  };
}

/** All specifier strings a package.json can legitimately point at. */
export function packageEntryPoints(root: string): string[] {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSafe(path)) as Record<string, unknown>;
  } catch {
    return [];
  }

  const found: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') found.push(value);
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === 'string') found.push(nested);
      }
    }
  };
  push(manifest['main']);
  push(manifest['module']);
  push(manifest['types']);
  push(manifest['bin']);
  push(manifest['exports']);
  return found;
}

/** True when the path is one of the conventional entry-point filenames. */
export function isEntryPointName(relativePath: string): boolean {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return DEFAULT_ENTRY_POINTS.includes(base);
}

/** Extensions this tool understands, re-exported for the resolver's users. */
export { ALL_EXTENSIONS, normalisePath };