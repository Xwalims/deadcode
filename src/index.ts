/**
 * The public API.
 *
 * Re-exported from one place so `import { analyse } from 'deadcode'` works, and
 * so the internal module layout can change without breaking that.
 */
export { analyse, scan, type AnalyseOptions, type AnalysisContext } from './analyzer/analyse.js';
export { parseFile, type ParsedFile } from './analyzer/parser/parse.js';
export {
  loadPathMapping,
  resolveSpecifier,
  packageEntryPoints,
  isEntryPointName,
  type PathMapping,
  type Resolution,
} from './analyzer/imports/resolve.js';
export {
  computeReachability,
  type ReachabilityInput,
  type ReachabilityResult,
  type ReachabilityEdge,
} from './analyzer/reachability/compute.js';
export {
  analyseDependencies,
  findMissingDependencies,
  findDuplicateDependencies,
} from './analyzer/dependencies/analyse.js';
export { loadConfig, shouldAnalyse, mergeCliOverrides, type LoadedConfig } from './config/load.js';
export { scanProject, type ScanResult } from './scanner/files.js';
export {
  compileGlob,
  matchesAny,
  isInsideDirectory,
  normalisePath,
  relative,
  isInside,
} from './utils/path.js';
export {
  DEFAULT_CONFIG,
  DEFAULT_EXCLUDE,
  DEFAULT_ENTRY_POINTS,
  DEFAULT_SEVERITY,
  CONFIG_PATHS,
  CONFIG_DIRECTORIES,
  ALL_EXTENSIONS,
  SOURCE_EXTENSIONS,
  JS_EXTENSIONS,
} from './config/defaults.js';
export {
  findUnusedImports,
  findUnusedSymbols,
  findUnreachableCode,
  type RuleOptions,
} from './rules/index.js';
export { renderText, renderJson, type RenderOptions } from './reporter/text.js';
export type {
  Analysis,
  AnalysisStats,
  DeadcodeConfig,
  DependencyFinding,
  ExportRef,
  Finding,
  FindingKind,
  FindingReason,
  GraphEdge,
  GraphNode,
  ImportRef,
  Severity,
  SeverityOverrides,
  SourceFile,
  Symbol,
} from './types.js';