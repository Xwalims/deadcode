/**
 * The shared data shapes. Everything else in the tool agrees on these, so this
 * file is deliberately narrow: if a type here is awkward, that is a signal the
 * design is wrong, not that the type needs another optional field.
 */

/** How sure the analyser is, and therefore how loudly to complain. */
export type Severity = 'error' | 'warning' | 'info';

/** The categories the reporter groups by and `--strict` filters on. */
export type FindingKind =
  | 'unused-variable'
  | 'unused-function'
  | 'unused-class'
  | 'unused-interface'
  | 'unused-type'
  | 'unused-export'
  | 'unused-import'
  | 'unused-file'
  | 'unreachable-code'
  | 'unused-dependency'
  | 'unused-dev-dependency'
  | 'missing-dependency'
  | 'duplicate-dependency';

/**
 * Why the tool believes a finding. Reported verbatim to the user, because a
 * finding without a stated reason is not actionable and not trustworthy.
 */
export interface FindingReason {
  /** Which mechanism produced it, e.g. `graph` or `compiler`. */
  readonly source: 'graph' | 'compiler' | 'package-json' | 'config' | 'heuristic';
  /** A sentence a human can check. */
  readonly detail: string;
  /**
   * What stopped this from being reported as certain. Null when the tool is
   * confident. The presence of an `escape` is why most findings are warnings.
   */
  readonly escape?: string;
}

/** One problem, located precisely enough to jump to it. */
export interface Finding {
  readonly kind: FindingKind;
  readonly severity: Severity;
  /** Absolute path of the file the finding lives in. */
  readonly file: string;
  /** 1-based line and column, or 0 when the finding is about the whole file. */
  readonly line: number;
  readonly column: number;
  /**
   * The identifier. For a file-level finding this is the file's project-relative
   * path, because "which file" is the whole finding and a separate name would
   * only repeat it.
   */
  readonly symbol: string;
  readonly reason: FindingReason;
  /** 0..1. Kept separate from severity: something can be certain but harmless. */
  readonly confidence: number;
}

/** A declaration the analyser knows exists. */
export interface Symbol {
  readonly name: string;
  readonly kind:
    | 'function'
    | 'variable'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'constant'
    | 'method';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** True when the declaration carries `export` in some form. */
  readonly exported: boolean;
  /** True when the declaration is `export default`. */
  readonly defaultExport: boolean;
  /** True for `export type` / `interface`, which vanish at runtime. */
  readonly typeOnly: boolean;
}

/** One imported binding. */
export interface ImportRef {
  /** The name imported, or `default` / `*` for the namespace and default forms. */
  readonly imported: string;
  /** The local name in the importing file. */
  readonly local: string;
  readonly from: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly typeOnly: boolean;
  /** True for `import()` and `require()` resolved at runtime. */
  readonly dynamic: boolean;
}

/** One exported binding, including re-exports of other modules. */
export interface ExportRef {
  readonly exported: string;
  /** The local name it refers to, which differs for `export { a as b }`. */
  readonly local: string | null;
  readonly from: string | null;
  readonly file: string;
  readonly line: number;
  readonly typeOnly: boolean;
}

/** A module edge in the project graph. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'static' | 'dynamic' | 'type-only' | 're-export';
  readonly specifier: string;
}

/** A file the analyser decided to look at. */
export interface SourceFile {
  readonly path: string;
  /** Extension-based kind, needed because `.d.ts` is not a module. */
  readonly kind: 'ts' | 'tsx' | 'js' | 'jsx' | 'mjs' | 'cjs' | 'd.ts';
  /** Text, so the reporter can print a line without re-reading. */
  readonly text: string;
}

/** A node in the project graph. */
export interface GraphNode {
  readonly file: string;
  readonly symbols: readonly Symbol[];
  readonly imports: readonly ImportRef[];
  readonly exports: readonly ExportRef[];
  readonly outgoing: readonly string[];
}

/** One package.json entry the tool has an opinion about. */
export interface DependencyFinding {
  readonly name: string;
  readonly kind: 'runtime' | 'dev' | 'peer' | 'optional';
  /** Files whose text mentions the package. */
  readonly usedIn: readonly string[];
  /** True when the only mentions are in config, test, or script files. */
  readonly configOnly: boolean;
}

/** The whole analysis, ready for the reporter or the fixer. */
export interface Analysis {
  readonly root: string;
  readonly files: readonly SourceFile[];
  readonly graph: ReadonlyMap<string, GraphNode>;
  /** Files reachable from an entry point. The complement is `unused-file`. */
  readonly reachable: ReadonlySet<string>;
  readonly entryPoints: readonly string[];
  readonly findings: readonly Finding[];
  readonly dependencies: readonly DependencyFinding[];
  readonly stats: AnalysisStats;
}

export interface AnalysisStats {
  readonly filesAnalyzed: number;
  readonly symbolsDiscovered: number;
  readonly importsResolved: number;
  readonly importsUnresolved: number;
  readonly durationMs: number;
}

/** Per-finding severity overrides from configuration. */
export type SeverityOverrides = Partial<Record<FindingKind, Severity>>;

export interface DeadcodeConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Symbol names or globs never reported, for generated or vendored code. */
  readonly ignore: readonly string[];
  readonly entryPoints: readonly string[];
  readonly detectDependencies: boolean;
  readonly detectUnusedFiles: boolean;
  readonly severity: SeverityOverrides;
  /** Report `info` findings as well. */
  readonly includeInfo: boolean;
}