/**
 * The analyser: everything the tool knows, assembled.
 *
 * The order below is the whole design in one place:
 *
 *   1. read configuration      -- what is in scope
 *   2. scan files              -- what exists
 *   3. parse                   -- what each file declares and references
 *   4. resolve specifiers      -- which file each reference points at
 *   5. reachability            -- which files are alive
 *   6. rules                   -- what is unused inside the live files
 *
 * Each step only depends on the ones above it, so a failure in a later step
 * cannot corrupt an earlier result, and every finding can name the evidence
 * that produced it.
 */
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { scanProject } from '../scanner/files.js';
import { parseFile, type ParsedFile } from './parser/parse.js';
import { loadPathMapping, resolveSpecifier, packageEntryPoints, type PathMapping } from './imports/resolve.js';
import {
  computeReachability,
  shouldReportUnresolved,
  type ReachabilityEdge,
} from './reachability/compute.js';
import {
  findUnusedImports,
  findUnusedSymbols,
  findUnreachableCode,
  withImporters,
} from '../rules/index.js';
import { analyseDependencies } from './dependencies/analyse.js';
import { normalisePath } from '../utils/path.js';
import type {
  Analysis,
  AnalysisStats,
  DeadcodeConfig,
  Finding,
  GraphNode,
} from '../types.js';

/** Overrides accepted from the CLI. */
export interface AnalyseOptions {
  readonly root: string;
  readonly overrides?: Partial<
    Pick<
      DeadcodeConfig,
      | 'include'
      | 'exclude'
      | 'entryPoints'
      | 'detectDependencies'
      | 'detectUnusedFiles'
      | 'includeInfo'
    >
  >;
  /** Skip dependency analysis even when configuration enables it. */
  readonly skipDependencies?: boolean;
}

/** Intermediate state, exposed so tests can assert on a single stage. */
export interface AnalysisContext {
  readonly root: string;
  readonly config: DeadcodeConfig;
  readonly loaded: LoadedConfig;
  readonly parsed: readonly ParsedFile[];
  readonly edges: ReadonlyMap<string, readonly ReachabilityEdge[]>;
  readonly unresolved: ReadonlyMap<string, readonly string[]>;
  readonly findings: readonly Finding[];
  readonly stats: AnalysisStats;
}

/**
 * Run the full analysis.
 *
 * Errors in one file are contained: a file that fails to parse produces no
 * findings rather than aborting the run, because one unparseable generated file
 * should not hide the rest of the project.
 */
export async function analyse(options: AnalyseOptions): Promise<Analysis> {
  const started = Date.now();
  const { root } = options;

  // 1. Configuration.
  const loaded = loadConfig(root);
  const config: DeadcodeConfig = { ...loaded.config, ...(options.overrides ?? {}) };
  const warnings = [...loaded.warnings];

  // 2. Files.
  const { files: sourceFiles, skipped } = await scanProject(root, config);
  for (const path of skipped) {
    warnings.push(`could not read ${normalisePath(path)}`);
  }

  // 3. Parsing.
  const parsed: ParsedFile[] = [];
  for (const file of sourceFiles) {
    try {
      parsed.push(parseFile(file, root));
    } catch (error) {
      warnings.push(
        `could not parse ${normalisePath(file.path.replace(root, '').replace(/^\//, ''))}: ` +
          (error as Error).message,
      );
    }
  }

  // 4. Resolution.
  const mapping = loadPathMapping(root);
  const edges = new Map<string, ReachabilityEdge[]>();
  const unresolved = new Map<string, string[]>();
  const filePaths = new Set(parsed.map((file) => file.file));
  let importsResolved = 0;
  let importsUnresolved = 0;

  for (const file of parsed) {
    const outgoing: ReachabilityEdge[] = [];
    const missing: string[] = [];

    for (const { specifier, kind } of file.specifiers) {
      const resolution = resolveSpecifier(specifier, file.file, root, mapping);

      if (resolution.kind === 'file' || resolution.kind === 'directory') {
        if (filePaths.has(resolution.path)) {
          outgoing.push({
            from: file.file,
            to: resolution.path,
            kind,
            specifier,
            reason: `resolved ${resolution.via} to ${normalisePath(resolution.path.replace(root, ''))}`,
          });
          importsResolved += 1;
        } else if (resolution.kind === 'file') {
          // Resolved to something outside the scan, e.g. an excluded build
          // directory. It is not a dead project file, so it is not an edge.
          importsResolved += 1;
        }
        continue;
      }

      if (resolution.kind === 'external') {
        importsResolved += 1;
        continue;
      }

      importsUnresolved += 1;
      missing.push(specifier);
    }

    edges.set(file.file, outgoing);
    if (missing.length > 0) unresolved.set(file.file, missing);
  }

  // 5. Reachability.
  const reachability = computeReachability({
    files: parsed.map((file) => file.file),
    edges,
    root,
    config,
    unresolved,
    manifestEntries: packageEntryPoints(root),
  });

  // 6. Rules over the live files.
  const findings: Finding[] = [];
  const liveFiles = parsed.filter((file) => reachability.reachable.has(file.file));

  // The importer index is what keeps a re-exported helper from being reported as
  // unused, so it is built once over the whole project rather than per file.
  const importerIndex = buildImporterIndex(parsed, mapping, root);

  for (const file of liveFiles) {
    findings.push(
      ...withImporters(importerIndex, () => findUnusedImports(file, { ignore: config.ignore })),
      ...withImporters(importerIndex, () => findUnusedSymbols(file, { ignore: config.ignore })),
      ...findUnreachableCode(file),
    );
  }

  if (config.detectUnusedFiles) {
    for (const path of reachability.unreachable) {
      findings.push({
        kind: 'unused-file',
        severity: config.severity['unused-file'] ?? 'error',
        file: path,
        line: 0,
        column: 0,
        symbol: normalisePath(path.replace(root, '').replace(/^\/+/, '')),
        reason: {
          source: 'graph',
          detail: 'no import path reaches this file from any entry point',
          escape: 'it may be loaded at runtime, by a plugin registry, or by a path this tool cannot resolve',
        },
        confidence: reachability.uncertain.has(path) ? 0.4 : 0.85,
      });
    }
  }

  // Unresolved relative specifiers are worth a mention: they are usually a typo
  // or a missing generated file, and either way the user should know.
  for (const [file, specifiers] of unresolved) {
    for (const specifier of specifiers) {
      if (!shouldReportUnresolved(specifier)) continue;
      findings.push({
        kind: 'missing-dependency',
        severity: 'info',
        file,
        line: 1,
        column: 1,
        symbol: specifier,
        reason: {
          source: 'compiler',
          detail: `the specifier "${specifier}" does not resolve to any file in the project`,
          escape: 'the target may be generated at build time, or produced by a loader',
        },
        confidence: 0.5,
      });
    }
  }

  const filtered = config.includeInfo ? findings : findings.filter((f) => f.severity !== 'info');

  const dependencies =
    config.detectDependencies && !options.skipDependencies
      ? analyseDependencies(root, parsed)
      : [];

  // Assemble the graph for consumers that want it.
  const graph = new Map<string, GraphNode>();
  for (const file of parsed) {
    graph.set(file.file, {
      file: file.file,
      symbols: file.symbols,
      imports: file.imports,
      exports: file.exports,
      outgoing: (edges.get(file.file) ?? []).map((edge) => edge.to),
    });
  }

  const stats: AnalysisStats = {
    filesAnalyzed: parsed.length,
    symbolsDiscovered: parsed.reduce((sum, file) => sum + file.symbols.length, 0),
    importsResolved,
    importsUnresolved,
    durationMs: Date.now() - started,
  };

  void warnings;

  return {
    root,
    files: sourceFiles,
    graph,
    reachable: reachability.reachable,
    entryPoints: reachability.seeds.map((seed) => seed.path),
    findings: filtered,
    dependencies,
    stats,
  };
}

/**
 * Which names each file is imported for.
 *
 * A file is not "used" merely because something points at it: a barrel that
 * re-exports everything keeps every symbol alive forever, which hides real dead
 * code. The index therefore records the specific names each live file pulls out
 * of each other file, which is what a symbol has to match to be considered used.
 *
 * `export *` cannot be resolved without evaluating the target, so a star
 * re-export contributes every exported name of its target. That is the correct
 * conservative answer: the whole point of a barrel is that it re-exports
 * everything.
 */
function buildImporterIndex(
  parsed: readonly ParsedFile[],
  mapping: PathMapping,
  root: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  const byPath = new Map(parsed.map((file) => [file.file, file]));
  const add = (file: string, name: string): void => {
    let set: Set<string> | undefined = index.get(file);
    if (!set) {
      set = new Set<string>();
      index.set(file, set);
    }
    set.add(name);
  };

  // The symbol index must agree with the file graph about what a specifier
  // points at, so it uses the same resolver. An earlier version kept a private
  // relative-only copy here, which meant any specifier that was not literally
  // starting with a dot -- every tsconfig `paths` alias -- resolved at the file
  // level but not at the symbol level. The result was a symbol reported as
  // "no file in the project imports it" on the very file the graph had just
  // marked reachable, which is the exact contradiction that loses a user's
  // trust in the tool.
  const resolveTarget = (from: string, specifier: string): string | null => {
    const resolution = resolveSpecifier(specifier, from, root, mapping);
    if (resolution.kind !== 'file' && resolution.kind !== 'directory') return null;
    return byPath.has(resolution.path) ? resolution.path : null;
  };

  // Every parsed file contributes, not only the reachable ones. A symbol used
  // by a file that is itself unreachable is still used, and filtering by
  // reachability here produced a cascade: the module that used the helper was
  // unreachable, so the helper looked unused, so the file that used the helper
  // looked unused, and so on down the import chain.
  for (const file of parsed) {
    for (const entry of file.imports) {
      if (entry.dynamic) continue;
      const target = resolveTarget(file.file, entry.from);
      if (!target) continue;
      add(target, entry.local === entry.imported ? entry.imported : entry.local);
    }

    // A re-export is a use of the target's symbol.
    for (const entry of file.exports) {
      if (!entry.from) continue;
      const target = resolveTarget(file.file, entry.from);
      if (!target) continue;
      if (entry.exported === '*') {
        const targetFile = byPath.get(target);
        for (const symbol of targetFile?.symbols ?? []) add(target, symbol.name);
        // Star through a chain: keep following until nothing new appears.
        const direct = targetFile?.exports ?? [];
        for (const nested of direct) {
          if (nested.exported !== '*') continue;
          const next: string | null = nested.from ? resolveTarget(target, nested.from) : null;
          if (!next || next === target) continue;
          const nestedFile = byPath.get(next);
          for (const symbol of nestedFile?.symbols ?? []) add(next, symbol.name);
        }
      } else {
        add(target, entry.local ?? entry.exported);
      }
    }
  }

  return index;
}

/** Convenience for callers that only want the findings. */
export async function scan(root: string): Promise<readonly Finding[]> {
  return (await analyse({ root })).findings;
}