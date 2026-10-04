/**
 * Defaults.
 *
 * One frozen object, because every module needs to agree on what "default"
 * means and a second definition is always worse than the first.
 */
import type { DeadcodeConfig, SeverityOverrides } from '../types.js';

/**
 * Directories never worth scanning. A dependency's own `node_modules` is not
 * dead code, it is another project, and scanning it turns a one-second run into
 * a one-minute one with the same findings.
 */
export const DEFAULT_EXCLUDE: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.git',
  'vendor',
];

/** Extensions the analyser treats as source. `.d.ts` is deliberately separate. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * JavaScript extensions. Only `.mjs`/`.cjs`/`.js` are scanned; a `.json` file is
 * data, and treating it as a module produces findings nobody can act on.
 */
export const JS_EXTENSIONS: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs'];

export const ALL_EXTENSIONS: readonly string[] = [
  ...SOURCE_EXTENSIONS,
  ...JS_EXTENSIONS,
];

/**
 * Files that are entry points by convention, regardless of who imports them.
 *
 * This list is the single largest defence against false positives. A file that
 * is only ever loaded at runtime -- a test file, a config, a CLI entry, a
 * migration -- has no importer to find, so the import graph alone would call it
 * dead. That is the failure that makes a tool like this get uninstalled.
 */
export const DEFAULT_ENTRY_POINTS: readonly string[] = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'main.ts',
  'main.js',
  'cli.ts',
  'cli.js',
];

/**
 * Paths, relative to the project root, that are read by a tool rather than by
 * code. Reaching them proves the code is live.
 *
 * `*` matches one path segment, `**` matches any number. Entries are matched
 * against the root-relative path with forward slashes.
 */
export const CONFIG_PATHS: readonly string[] = [
  'package.json',
  'tsconfig*.json',
  'jsconfig*.json',
  '*.config.js',
  '*.config.cjs',
  '*.config.mjs',
  '*.config.ts',
  '*.config.mts',
  '*.config.cts',
  '.eslintrc*',
  '.eslintrc.*',
  '.prettierrc*',
  '.prettierrc.*',
  '.babelrc*',
  'babel.config.*',
  'rollup.config.*',
  'vite.config.*',
  'vitest.config.*',
  'jest.config.*',
  'webpack.config.*',
  'webpack.*.js',
  'karma.conf.*',
  'postcss.config.*',
  'tailwind.config.*',
  'turbo.json',
  'nx.json',
  'lerna.json',
  'next.config.*',
  'nuxt.config.*',
  'svelte.config.*',
  'commitlint.config.*',
  'lint-staged.config.*',
  'playwright.config.*',
  'cypress.config.*',
  'nodemon.json',
  'typedoc.json',
  'renovate.json*',
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
];

/**
 * Directories whose contents are tool configuration rather than application
 * code. A dependency named here is "used", but only by tooling, which the
 * reporter says rather than hiding.
 */
export const CONFIG_DIRECTORIES: readonly string[] = [
  'scripts',
  'tools',
  'config',
  'configs',
  'build',
  '.github',
];

/** How a symbol's kind maps to a finding kind, before severity is applied. */
export const DEFAULT_SEVERITY: SeverityOverrides = {
  'unused-file': 'error',
  'unreachable-code': 'error',
  'unused-dependency': 'warning',
  'unused-dev-dependency': 'warning',
  'missing-dependency': 'error',
  'duplicate-dependency': 'warning',
  'unused-import': 'warning',
  'unused-export': 'warning',
  'unused-variable': 'warning',
  'unused-function': 'warning',
  'unused-class': 'warning',
  'unused-interface': 'warning',
  'unused-type': 'warning',
};

export const DEFAULT_CONFIG: DeadcodeConfig = {
  include: ['**/*'],
  exclude: DEFAULT_EXCLUDE,
  ignore: [],
  entryPoints: [...DEFAULT_ENTRY_POINTS],
  detectDependencies: true,
  detectUnusedFiles: true,
  severity: { ...DEFAULT_SEVERITY },
  includeInfo: true,
};

/**
 * Files that are read by a runner rather than imported, where an unused-looking
 * export is not dead. `*.test.*` and `*.spec.*` are covered separately.
 */
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Generated code, where findings are noise rather than signal. */
export const GENERATED_PATTERN =
  /(?:\.d\.ts$|\.generated\.|\.min\.[cm]?js$|\.pb\.[jt]s$|_pb\.[jt]s$|__generated__\/)/i;