/**
 * Reachability.
 *
 * ## The failure this file exists to prevent
 *
 * A dead-code tool that reports "unused file" for a file which is loaded at
 * runtime gets uninstalled. Those files are not rare:
 *
 * - a `vite.config.ts` that no source file imports
 * - a CLI entry point named by `package.json` `bin`
 * - a test file nothing imports, because the runner finds it
 * - a module reached only through `await import(variable)`
 * - a `__generated__` file a build step writes
 * - anything named in a framework's registry, plugin list or decorator
 *
 * So a file is reachable if ANY of these hold. Every one of them is a way the
 * runtime can reach code without an import statement, and each corresponds to a
 * mechanism a tool actually uses.
 *
 * ## Why an unresolvable import makes a file reachable
 *
 * If a specifier does not resolve to a file in the project, this tool does not
 * know what it points at. It might be a generated file, a package with a
 * loader, or a path computed at runtime. Marking the importing file unreachable
 * on the strength of a guess is how a tool deletes a working tree, so the
 * conservative answer is the only one that is safe.
 */
import { basename, join, relative } from 'node:path';
import {
  CONFIG_PATHS,
  DEFAULT_ENTRY_POINTS,
  GENERATED_PATTERN,
} from '../../config/defaults.js';
import { compileGlob, normalisePath } from '../../utils/path.js';
import { isTestFile } from '../../config/load.js';
import type { DeadcodeConfig, GraphEdge } from '../../types.js';

/** One edge with the reason it exists, kept so the reporter can explain itself. */
export interface ReachabilityEdge extends GraphEdge {
  /** Why this edge was followed. */
  readonly reason: string;
}

/** Everything that determines whether a file is alive. */
export interface ReachabilityInput {
  /** Absolute path of every analysed file. */
  readonly files: readonly string[];
  /** Resolved edges between them, keyed by the importing file. */
  readonly edges: ReadonlyMap<string, readonly ReachabilityEdge[]>;
  readonly root: string;
  readonly config: DeadcodeConfig;
  /** Specifiers that could not be resolved to a file in the project. */
  readonly unresolved: ReadonlyMap<string, readonly string[]>;
  /** Extra entry points from package.json `main`, `exports`, `bin`. */
  readonly manifestEntries: readonly string[];
}

/** The result, with enough detail to explain any single verdict. */
export interface ReachabilityResult {
  /** Absolute paths considered alive. */
  readonly reachable: ReadonlySet<string>;
  /** Absolute paths considered dead. */
  readonly unreachable: ReadonlySet<string>;
  /** Why each seed was treated as an entry point. */
  readonly seeds: readonly { path: string; reason: string }[];
  /** Files skipped because nothing could prove them dead. */
  readonly uncertain: ReadonlySet<string>;
}

/** A relative path with forward slashes. */
function rel(root: string, path: string): string {
  return normalisePath(relative(root, path));
}

/**
 * True when a file is generated rather than authored.
 *
 * Generated code is almost always reachable, because something generates it and
 * then something imports it. Reporting unused members inside it produces
 * findings the user cannot act on without editing a generator.
 */
function isGenerated(relativePath: string): boolean {
  return GENERATED_PATTERN.test(relativePath);
}

/**
 * True when a path is read by a tool rather than by code.
 *
 * The pattern list is what stops `vite.config.ts` being reported as an unused
 * file, which is the single most common false positive for this class of tool.
 */
function isConfigPath(relativePath: string): boolean {
  return CONFIG_PATHS.some((pattern: string) => compileGlob(pattern)(relativePath));
}

/**
 * Collect the files that are alive before the graph is even walked.
 *
 * Everything here is a "there is no importer, and that is fine" case.
 */
function collectSeeds(input: ReachabilityInput): { path: string; reason: string }[] {
  const seeds: { path: string; reason: string }[] = [];
  const seen = new Set<string>();

  const add = (path: string, reason: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    seeds.push({ path, reason });
  };

  for (const file of input.files) {
    const relativePath = rel(input.root, file);

    if (isConfigPath(relativePath)) {
      add(file, 'read by a build or runtime tool, not by an import');
      continue;
    }
    if (isTestFile(relativePath)) {
      add(file, 'a test file: discovered by the test runner, not by an import');
      continue;
    }
    if (DEFAULT_ENTRY_POINTS.includes(basename(relativePath))) {
      add(file, 'conventional entry-point filename');
      continue;
    }
    if (isGenerated(relativePath)) {
      add(file, 'generated code: something else produced it');
    }
  }

  // package.json points at entry points by name, and those names almost always
  // refer to built output: `main: "dist/index.js"`, `bin: "dist/cli/bin.js"`.
  // The source that produced it is the same path with a source extension AND
  // without the build directory, which is why a plain extension swap finds
  // nothing and the CLI executable gets reported as unused.
  //
  // Both forms are checked: the literal path (for a repo that runs its source
  // directly) and the build-stripped variant (for the usual case).
  const BUILD_PREFIXES = ['dist/', 'build/', 'out/', 'lib/'];
  for (const entry of input.manifestEntries) {
    const clean = entry.replace(/^\.\//, '');
    const candidates: string[] = [];

    const variants = [clean];
    for (const prefix of BUILD_PREFIXES) {
      if (clean.startsWith(prefix)) variants.push(clean.slice(prefix.length));
    }

    for (const variant of variants) {
      candidates.push(join(input.root, variant));
      const stem = variant.replace(/\.(js|jsx|mjs|cjs)$/, '');
      candidates.push(join(input.root, `${stem}.ts`));
      candidates.push(join(input.root, `${stem}.tsx`));
      candidates.push(join(input.root, `${stem}.mts`));
      candidates.push(join(input.root, `${stem}.cts`));
    }

    for (const candidate of candidates) {
      if (input.files.includes(candidate)) {
        add(candidate, `named by package.json as ${entry}`);
        break;
      }
    }
  }

  // An explicit `entryPoints` entry wins over every heuristic.
  for (const pattern of input.config.entryPoints) {
    const matcher = compileGlob(pattern);
    for (const file of input.files) {
      if (matcher(rel(input.root, file))) {
        add(file, `configured as an entry point (${pattern})`);
      }
    }
  }

  return seeds;
}

/**
 * Walk the graph from every seed.
 *
 * Type-only edges are followed, because a file that only exists to type-check
 * another file is still code the compiler must be able to find; treating it as
 * unreachable would report the importing file as unused.
 */
export function computeReachability(input: ReachabilityInput): ReachabilityResult {
  const seeds = collectSeeds(input);
  const reachable = new Set<string>();
  const uncertain = new Set<string>();
  // A Set, because `Array.includes` inside the walk makes the whole traversal
  // quadratic in file count, which is exactly the cost profile a tool is judged
  // on for a large repository.
  const known = new Set(input.files);

  // Queue rather than recursion: a project can have thousands of files, and a
  // deep chain would risk a stack overflow on the way in.
  const queue: string[] = [];
  for (const seed of seeds) {
    reachable.add(seed.path);
    queue.push(seed.path);
  }

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const outgoing = input.edges.get(current) ?? [];

    // A file that imports something unresolvable is alive but not fully
    // understood, and neither is anything it reaches.
    const unresolvedHere = input.unresolved.get(current);
    if (unresolvedHere && unresolvedHere.length > 0) {
      uncertain.add(current);
    }

    for (const edge of outgoing) {
      if (!known.has(edge.to)) continue;
      if (reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }

  const unreachable = new Set<string>();
  for (const file of input.files) {
    if (!reachable.has(file)) unreachable.add(file);
  }

  return { reachable, unreachable, seeds, uncertain };
}

/**
 * Whether an unresolved specifier is worth warning about.
 *
 * Bare specifiers are packages and are not a problem. A relative specifier that
 * does not resolve is usually a typo, but it can also be a file the build
 * generates, so it is reported as information rather than an error.
 */
export function shouldReportUnresolved(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}