/**
 * Configuration loading.
 *
 * Resolution order, later wins:
 *   1. built-in defaults
 *   2. `deadcode.config.json` / `.js` / `.cjs` / `.mjs` / `.ts`
 *   3. CLI flags
 *
 * An unknown key is a warning rather than an error. A config file that refuses
 * to load because of a typo in a key name is a config file nobody edits again,
 * and silently ignoring the typo would be worse.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALL_EXTENSIONS,
  DEFAULT_CONFIG,
  DEFAULT_SEVERITY,
  TEST_FILE_PATTERN,
} from './defaults.js';
import type { DeadcodeConfig, SeverityOverrides } from '../types.js';
import { compileGlob, isInsideDirectory, normalisePath } from '../utils/path.js';

/** Config file names, in the order they are tried. */
const CONFIG_FILENAMES = [
  'deadcode.config.json',
  'deadcode.config.js',
  'deadcode.config.mjs',
  'deadcode.config.cjs',
  'deadcode.config.ts',
  '.deadcoderc.json',
];

export interface LoadedConfig {
  readonly config: DeadcodeConfig;
  /** Absolute path of the file that was used, or null for defaults only. */
  readonly sourceFile: string | null;
  readonly warnings: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a config file. `.ts` is handled by stripping types through Node's own
 * loader when it is available, and refused with a clear message when it is not.
 */
function readConfigFile(path: string): { value: unknown; warning: string | null } {
  if (path.endsWith('.json')) {
    return { value: JSON.parse(readFileSync(path, 'utf8')), warning: null };
  }

  if (path.endsWith('.ts')) {
    // Node 22.6+ and 23+ run TypeScript directly. On older runtimes a .ts config
    // cannot be loaded without a transpiler, and pretending otherwise would
    // produce a confusing syntax error from the user's own config.
    const major = Number(process.versions.node.split('.')[0] ?? '0');
    const minor = Number(process.versions.node.split('.')[1] ?? '0');
    const canRunTypeScript = major >= 23 || (major === 22 && minor >= 6);
    if (!canRunTypeScript) {
      return {
        value: null,
        warning:
          `${path} needs a TypeScript loader, and this Node (${process.versions.node}) ` +
          'cannot run TypeScript directly. Use deadcode.config.json instead.',
      };
    }
  }

  try {
    // import() is async, but reading config has to be synchronous so that the
    // public API can stay synchronous. A config file is therefore read with a
    // CommonJS require where possible, and .mjs is not supported for that reason.
    const required = require(path);
    return { value: required.default ?? required, warning: null };
  } catch (error) {
    return {
      value: null,
      warning: `could not load ${path}: ${(error as Error).message}`,
    };
  }
}

/** Validate and normalise one config object. */
function validate(raw: unknown, warnings: string[]): DeadcodeConfig {
  if (!isPlainObject(raw)) {
    warnings.push('config is not an object; using defaults');
    return { ...DEFAULT_CONFIG, severity: { ...DEFAULT_SEVERITY } };
  }

  const strings = (key: string, fallback: readonly string[]): readonly string[] => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      warnings.push(`"${key}" must be an array of strings; using the default`);
      return fallback;
    }
    return value as string[];
  };

  const bool = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      warnings.push(`"${key}" must be a boolean; using the default`);
      return fallback;
    }
    return value;
  };

  const severity: SeverityOverrides = { ...DEFAULT_SEVERITY };
  const rawSeverity = raw['severity'];
  if (rawSeverity !== undefined) {
    if (!isPlainObject(rawSeverity)) {
      warnings.push('"severity" must be an object; using the defaults');
    } else {
      for (const [key, value] of Object.entries(rawSeverity)) {
        if (value === 'error' || value === 'warning' || value === 'info') {
          (severity as Record<string, string>)[key] = value;
        } else {
          warnings.push(`severity.${key} must be error, warning or info; ignoring it`);
        }
      }
    }
  }

  const known = new Set([
    'include', 'exclude', 'ignore', 'entryPoints', 'detectDependencies',
    'detectUnusedFiles', 'severity', 'includeInfo', '$schema',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push(`unknown config key "${key}"; ignoring it`);
    }
  }

  return {
    include: strings('include', DEFAULT_CONFIG.include),
    exclude: strings('exclude', DEFAULT_CONFIG.exclude),
    ignore: strings('ignore', DEFAULT_CONFIG.ignore),
    entryPoints: strings('entryPoints', DEFAULT_CONFIG.entryPoints),
    detectDependencies: bool('detectDependencies', DEFAULT_CONFIG.detectDependencies),
    detectUnusedFiles: bool('detectUnusedFiles', DEFAULT_CONFIG.detectUnusedFiles),
    severity,
    includeInfo: bool('includeInfo', DEFAULT_CONFIG.includeInfo),
  };
}

/** Merge CLI overrides onto a loaded config. */
export function mergeCliOverrides(
  config: DeadcodeConfig,
  overrides: {
    include?: readonly string[];
    exclude?: readonly string[];
    entryPoints?: readonly string[];
    detectDependencies?: boolean;
    detectUnusedFiles?: boolean;
    includeInfo?: boolean;
  },
): DeadcodeConfig {
  return {
    include: overrides.include ?? config.include,
    exclude: overrides.exclude ?? config.exclude,
    ignore: config.ignore,
    entryPoints: overrides.entryPoints ?? config.entryPoints,
    detectDependencies: overrides.detectDependencies ?? config.detectDependencies,
    detectUnusedFiles: overrides.detectUnusedFiles ?? config.detectUnusedFiles,
    severity: config.severity,
    includeInfo: overrides.includeInfo ?? config.includeInfo,
  };
}

/**
 * Load configuration for a project root.
 *
 * @param root absolute path of the project
 * @param explicit path to a config file, from `--config`
 */
export function loadConfig(root: string, explicit?: string): LoadedConfig {
  const warnings: string[] = [];
  let raw: unknown = null;
  let sourceFile: string | null = null;

  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : join(root, explicit);
    if (!existsSync(path)) {
      return {
        config: { ...DEFAULT_CONFIG, severity: { ...DEFAULT_SEVERITY } },
        sourceFile: null,
        warnings: [`config file not found: ${explicit}`],
      };
    }
    const result = readConfigFile(path);
    raw = result.value;
    sourceFile = path;
    if (result.warning) warnings.push(result.warning);
  } else {
    for (const name of CONFIG_FILENAMES) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      const result = readConfigFile(path);
      sourceFile = path;
      raw = result.value;
      if (result.warning) warnings.push(result.warning);
      break;
    }
  }

  // No config file at all is the normal case, not a problem worth a warning.
  // `validate` exists to check a file that exists and may be wrong; calling it
  // with null produced "config is not an object; using defaults" on every
  // project that simply had no deadcode.config.json, which is most of them.
  if (raw === null || raw === undefined) {
    return {
      config: { ...DEFAULT_CONFIG, severity: { ...DEFAULT_SEVERITY } },
      sourceFile: null,
      warnings,
    };
  }

  return { config: validate(raw, warnings), sourceFile, warnings };
}

/**
 * Decide whether a project-relative path should be analysed.
 *
 * Excludes are checked twice, for two different shapes of pattern: `dist/**`
 * is a path glob, while the bare `dist` is a directory name that has to match a
 * segment anywhere in the path. Getting only one of them right is how a tool
 * ends up scanning its own build output.
 */
export function shouldAnalyse(
  relativePath: string,
  config: DeadcodeConfig,
): boolean {
  const path = normalisePath(relativePath);
  if (path === '') return false;

  const extension = extensionOf(path);
  if (!extension || !ALL_EXTENSIONS.includes(extension)) return false;
  // A declaration file describes someone else's API. Reporting unused members
  // inside it produces noise about code that cannot be edited.
  if (extension === '.ts' && path.endsWith('.d.ts')) return false;

  if (isInsideDirectory(config.exclude, path)) return false;
  for (const pattern of config.exclude) {
    if (compileGlob(pattern)(path)) return false;
  }
  // An `include` pattern that matches nothing means the file is out of scope,
  // but only when the user narrowed include to something specific.
  if (config.include.length > 0) {
    const included = config.include.some(
      (pattern) => compileGlob(pattern)(path) || compileGlob(pattern)(`${path}/`),
    );
    if (!included && !config.include.includes('**/*')) return false;
  }

  return true;
}

/** The extension including the dot, or '' when there is none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** True for test and spec files, which are entry points by nature. */
export function isTestFile(relativePath: string): boolean {
  return TEST_FILE_PATTERN.test(relativePath);
}

/** Absolute path resolution helper used by the scanner. */
export function absolute(root: string, relativePath: string): string {
  return resolve(root, relativePath);
}

/** Exposed so callers can build a file:// URL for dynamic import. */
export function asModuleUrl(path: string): string {
  return pathToFileURL(path).href;
}