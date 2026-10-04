/**
 * Dependency analysis.
 *
 * Reading package.json and comparing it against the imports in the code is easy
 * to do badly in two directions:
 *
 * - Reporting a dependency as unused when it is only used by a config file, a
 *   test, or a build script. Removing it breaks the build.
 * - Missing a dependency that the code imports but package.json does not list.
 *   That one is worse, because it only fails on a clean install, which is
 *   exactly when nobody is watching.
 *
 * Both are handled by classifying where each mention appears rather than by
 * counting mentions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_DIRECTORIES } from '../../config/defaults.js';
import { isTestFile } from '../../config/load.js';
import { normalisePath } from '../../utils/path.js';
import type { DependencyFinding } from '../../types.js';
import type { ParsedFile } from '../parser/parse.js';

interface Manifest {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly peerDependencies: Record<string, string>;
  readonly optionalDependencies: Record<string, string>;
  readonly scripts: Record<string, string>;
  readonly name: string | undefined;
}

function readManifest(root: string): Manifest | null {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const record = (key: string): Record<string, string> => {
      const value = parsed[key];
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, string>)
        : {};
    };
    return {
      dependencies: record('dependencies'),
      devDependencies: record('devDependencies'),
      peerDependencies: record('peerDependencies'),
      optionalDependencies: record('optionalDependencies'),
      scripts: record('scripts'),
      name: typeof parsed['name'] === 'string' ? parsed['name'] : undefined,
    };
  } catch {
    return null;
  }
}

/** The npm package a bare specifier refers to. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? null);
}

/** Whether a root-relative path is a config or tooling location. */
function isConfigLocation(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => CONFIG_DIRECTORIES.includes(segment))) return true;
  const base = segments[segments.length - 1] ?? '';
  return (
    base.includes('.config.') ||
    base.startsWith('.eslintrc') ||
    base.startsWith('.prettierrc') ||
    base === 'jest.config.js' ||
    base === 'jest.config.ts'
  );
}

/**
 * Compare declared dependencies against the imports found in the code.
 *
 * The returned list covers only what the tool has an opinion about, so the
 * caller can decide which findings to emit and at what severity.
 */
export function analyseDependencies(
  root: string,
  parsed: readonly ParsedFile[],
): DependencyFinding[] {
  const manifest = readManifest(root);
  if (!manifest) return [];

  // Which package is mentioned where.
  const mentions = new Map<string, { files: Set<string>; configOnly: boolean }>();
  const note = (name: string, relativePath: string): void => {
    let entry = mentions.get(name);
    if (!entry) {
      entry = { files: new Set<string>(), configOnly: true };
      mentions.set(name, entry);
    }
    entry.files.add(relativePath);
    if (!isConfigLocation(relativePath) && !isTestFile(relativePath)) {
      entry.configOnly = false;
    }
  };

  for (const file of parsed) {
    const relativePath = normalisePath(relative(root, file.path));
    for (const { specifier } of file.specifiers) {
      const name = packageOf(specifier);
      if (name) note(name, relativePath);
    }
  }

  // A dependency can also be used only by a script in package.json, which no
  // source file mentions. `--ignore-scripts` skips these.
  const scriptText = Object.values(manifest.scripts).join('\n');

  // Packages that are consumed without ever being imported. Reporting these is
  // the fastest way to make a dependency report untrustworthy, because the
  // first one it gets wrong is a devDependency the build needs.
  const TOOLING_PREFIXES = ['@types/', 'eslint-plugin-', 'prettier-plugin-', '@typescript-eslint/'];
  const isToolingOnly = (name: string): boolean =>
    TOOLING_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    // A framework's own tool: esbuild, vite, webpack, jest. They are invoked by
    // a script or by a config, never imported by the code they build.
    [
      'typescript', 'ts-node', 'tsx', 'esbuild', 'vite', 'rollup', 'webpack',
      'jest', 'vitest', 'mocha', 'ava', 'eslint', 'prettier', 'husky',
      'lint-staged', 'nodemon', 'tsup', 'unbuild',
    ].includes(name);

  const declared: { name: string; kind: DependencyFinding['kind'] }[] = [
    ...Object.keys(manifest.dependencies).map((name) => ({ name, kind: 'runtime' as const })),
    ...Object.keys(manifest.devDependencies).map((name) => ({
      name,
      kind: 'dev' as const,
    })),
    ...Object.keys(manifest.peerDependencies).map((name) => ({
      name,
      kind: 'peer' as const,
    })),
    ...Object.keys(manifest.optionalDependencies).map((name) => ({
      name,
      kind: 'optional' as const,
    })),
  ];

  const results: DependencyFinding[] = [];

  for (const { name, kind } of declared) {
    // A package can be its own devDependency and its own dependency; the runtime
    // kind is the one that matters and is reported by the caller.
    const entry = mentions.get(name);
    if (entry) {
      results.push({
        name,
        kind,
        usedIn: [...entry.files].sort(),
        configOnly: entry.configOnly,
      });
      continue;
    }
    if (isToolingOnly(name)) {
      results.push({
        name,
        kind,
        usedIn: ['(consumed by the build, not imported by code)'],
        configOnly: true,
      });
      continue;
    }
    if (scriptText.includes(name)) {
      results.push({ name, kind, usedIn: ['package.json scripts'], configOnly: true });
      continue;
    }
    results.push({ name, kind, usedIn: [], configOnly: false });
  }

  return results;
}

/**
 * Packages the code imports but package.json does not declare.
 *
 * Node resolves anything in node_modules, so a missing declaration only breaks a
 * clean install. That is the classic "works on my machine" dependency bug, and
 * finding it is the most useful thing this module does.
 */
export function findMissingDependencies(
  root: string,
  parsed: readonly ParsedFile[],
): { name: string; usedIn: string[] }[] {
  const manifest = readManifest(root);
  if (!manifest) return [];

  const declared = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
    ...Object.keys(manifest.peerDependencies),
    ...Object.keys(manifest.optionalDependencies),
  ]);
  // A package never depends on itself.
  if (manifest.name) declared.add(manifest.name);
  // Node's own prefixes and subpath imports are not packages.
  declared.add('node:fs');
  for (const builtin of [
    'fs', 'path', 'os', 'url', 'http', 'https', 'crypto', 'child_process',
    'worker_threads', 'events', 'stream', 'util', 'zlib', 'net', 'tls', 'dns',
    'assert', 'buffer', 'process', 'module', 'readline', 'perf_hooks', 'v8',
    'cluster', 'querystring', 'string_decoder', 'timers', 'tty', 'vm',
  ]) {
    declared.add(builtin);
    declared.add(`node:${builtin}`);
  }

  const found = new Map<string, Set<string>>();
  for (const file of parsed) {
    const relativePath = normalisePath(relative(root, file.path));
    for (const { specifier } of file.specifiers) {
      const name = packageOf(specifier);
      if (!name || declared.has(name)) continue;
      if (name.startsWith('@types/')) continue;
      let set = found.get(name);
      if (!set) {
        set = new Set<string>();
        found.set(name, set);
      }
      set.add(relativePath);
    }
  }

  return [...found].map(([name, files]) => ({ name, usedIn: [...files].sort() }));
}

/** Duplicates across dependency sections, which npm silently resolves. */
export function findDuplicateDependencies(root: string): string[] {
  const manifest = readManifest(root);
  if (!manifest) return [];
  const seen = new Map<string, string[]>();
  const add = (name: string, section: string): void => {
    const list = seen.get(name) ?? [];
    list.push(section);
    seen.set(name, list);
  };
  for (const [name] of Object.entries(manifest.dependencies)) add(name, 'dependencies');
  for (const [name] of Object.entries(manifest.devDependencies)) add(name, 'devDependencies');
  for (const [name] of Object.entries(manifest.peerDependencies)) add(name, 'peerDependencies');
  for (const [name] of Object.entries(manifest.optionalDependencies)) add(name, 'optionalDependencies');
  return [...seen].filter(([, sections]) => sections.length > 1).map(([name]) => name);
}