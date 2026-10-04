/**
 * The CLI.
 *
 * Commands, matching the documented interface:
 *   deadcode [path]           the default scan
 *   deadcode scan [path]      the same, named
 *   deadcode deps [path]      dependencies only
 *   deadcode files [path]     file reachability only
 *   deadcode graph [path]     the import graph
 *   deadcode report [path]    every finding, grouped by severity
 *   deadcode init [path]      write a starter config
 *
 * Exit codes are chosen so the tool composes in a shell pipeline:
 *   0  nothing at or above the failure threshold
 *   1  findings at or above it, so CI can fail on dead code
 *   2  the tool itself could not run
 */
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { analyse } from '../analyzer/analyse.js';
import { renderText, renderJson, type RenderOptions } from '../reporter/text.js';
import { loadConfig } from '../config/load.js';
import type { Analysis, Severity } from '../types.js';

export const VERSION = '1.0.0';

const USAGE = `deadcode v${VERSION} -- find unused code in JavaScript and TypeScript projects

Usage:
  deadcode [path]              scan a project and report unused code
  deadcode scan [path]         the same command, named explicitly
  deadcode deps [path]         report only unused and missing dependencies
  deadcode files [path]        report only files nothing reaches
  deadcode graph [path]        print the module graph
  deadcode report [path]       print every finding grouped by severity
  deadcode init [path]         write a starter deadcode.config.json
  deadcode --version           print the version
  deadcode --help              print this message

Options:
  --json                       machine-readable output
  --verbose                    include info-level findings
  --strict                     treat warnings as failures
  --quiet                      suppress the header and the footer
  --no-colour                  disable colour (also honours NO_COLOR)
  --fail-on <severity>         exit 1 at this severity: error, warning, info
  --include <glob>             restrict to paths matching a glob (repeatable)
  --exclude <glob>             skip paths matching a glob (repeatable)
  --entry-point <glob>         treat matching files as entry points (repeatable)
  --config <path>              use this config file instead of searching
  --no-dependencies            skip dependency analysis
  --no-unused-files            do not report unreachable files

Exit codes:
  0  nothing at or above the threshold
  1  findings at or above the threshold
  2  the tool could not run
`;

/** Commands the CLI recognises. Anything else in first position is a path. */
const COMMANDS = new Set(['scan', 'deps', 'files', 'graph', 'report', 'init']);

interface ParsedArgs {
  readonly command: string;
  readonly path: string | null;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly strict: boolean;
  readonly quiet: boolean;
  readonly colour: boolean | null;
  readonly failOn: Severity | null;
  readonly include: string[];
  readonly exclude: string[];
  readonly entryPoints: string[];
  readonly config: string | null;
  readonly noDependencies: boolean;
  readonly noUnusedFiles: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly errors: string[];
}

/** Parse argv. Every unknown flag is reported rather than ignored. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command = '';
  let path: string | null = null;
  let json = false;
  let verbose = false;
  let strict = false;
  let quiet = false;
  let colour: boolean | null = null;
  let failOn: Severity | null = null;
  let config: string | null = null;
  let noDependencies = false;
  let noUnusedFiles = false;
  let help = false;
  let version = false;
  const include: string[] = [];
  const exclude: string[] = [];
  const entryPoints: string[] = [];
  const errors: string[] = [];

  const takesValue = new Set([
    '--fail-on', '--include', '--exclude', '--entry-point', '--config',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) {
        errors.push(`${arg} needs a value`);
        continue;
      }
      switch (arg) {
        case '--fail-on':
          if (value === 'error' || value === 'warning' || value === 'info') failOn = value;
          else errors.push(`--fail-on must be error, warning or info, got "${value}"`);
          break;
        case '--include': include.push(value); break;
        case '--exclude': exclude.push(value); break;
        case '--entry-point': entryPoints.push(value); break;
        default: config = value;
      }
      continue;
    }

    switch (arg) {
      case '--json': json = true; break;
      case '--verbose': case '-v': verbose = true; break;
      case '--strict': strict = true; break;
      case '--quiet': case '-q': quiet = true; break;
      case '--no-colour': case '--no-color': colour = false; break;
      case '--colour': case '--color': colour = true; break;
      case '--no-dependencies': noDependencies = true; break;
      case '--no-unused-files': noUnusedFiles = true; break;
      case '--config': break;
      case '-h': case '--help': help = true; break;
      case '-V': case '--version': version = true; break;
      default:
        if (arg.startsWith('-')) {
          errors.push(`unknown option ${arg}`);
        } else if (!command) {
          // `deadcode .` and `deadcode ./src` are the documented primary usage,
          // so a first argument that is not a command name is the path, not a
          // mistyped command. Treating it as a command made the most common
          // invocation fail with "unknown command".
          if (COMMANDS.has(arg)) command = arg;
          else path = arg;
        } else if (path === null) {
          path = arg;
        } else {
          errors.push(`unexpected argument "${arg}"`);
        }
    }
  }

  return {
    command, path, json, verbose, strict, quiet, colour, failOn,
    include, exclude, entryPoints, config, noDependencies, noUnusedFiles,
    help, version, errors,
  };
}

/** The default threshold: a warning is worth failing on, an info is not. */
function thresholdFor(args: ParsedArgs): Severity {
  if (args.failOn) return args.failOn;
  if (args.strict) return 'warning';
  return 'error';
}

/** Colour when stdout is a terminal and the environment has not opted out. */
function colourEnabled(args: ParsedArgs, stream: { isTTY?: boolean }): boolean {
  if (args.colour !== null) return args.colour;
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return Boolean(stream.isTTY);
}

/** Run one analysis with the parsed options applied. */
async function runAnalysis(args: ParsedArgs): Promise<Analysis> {
  const root = resolve(args.path ?? '.');
  const overrides: Record<string, unknown> = {};
  if (args.include.length > 0) overrides['include'] = args.include;
  if (args.exclude.length > 0) overrides['exclude'] = args.exclude;
  if (args.entryPoints.length > 0) overrides['entryPoints'] = args.entryPoints;
  if (args.noDependencies) overrides['detectDependencies'] = false;
  if (args.noUnusedFiles) overrides['detectUnusedFiles'] = false;

  return analyse({
    root,
    overrides: overrides as never,
    skipDependencies: args.noDependencies,
  });
}

/** `deadcode init`: write a starter configuration file. */
function commandInit(args: ParsedArgs, out: (text: string) => void): number {
  const root = resolve(args.path ?? '.');
  const target = resolve(root, 'deadcode.config.json');
  if (existsSync(target)) {
    out(`  deadcode.config.json already exists; leaving it alone\n`);
    return 0;
  }
  const config = {
    $schema: 'https://example.com/deadcode.schema.json',
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist', 'build'],
    ignore: [],
    entryPoints: ['src/index.ts'],
    detectDependencies: true,
    detectUnusedFiles: true,
    severity: {
      unusedVariable: 'warning',
      unusedFunction: 'warning',
      unusedFile: 'error',
    },
  };
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  out(`  wrote deadcode.config.json\n`);
  out('  edit the entryPoints to match your project before trusting the results\n');
  return 0;
}

/** `deadcode graph`: the module graph as an indented tree from each entry point. */
function commandGraph(args: ParsedArgs, analysis: Analysis, out: (text: string) => void): number {
  const relative = (path: string): string =>
    path.replace(analysis.root, '').replace(/^\//, '') || path;

  if (args.json) {
    const nodes = [...analysis.graph.values()].map((node) => ({
      file: relative(node.file),
      reachable: analysis.reachable.has(node.file),
      symbols: node.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`),
      exports: node.exports.map((entry) => entry.exported),
      imports: node.imports.map((entry) => `${entry.local}<-${entry.from}`),
      outgoing: node.outgoing.map(relative).sort(),
    }));
    out(`${JSON.stringify({ nodes }, null, 2)}\n`);
    return 0;
  }

  const edges = analysis.graph;
  const seen = new Set<string>();
  const walk = (path: string, depth: number, prefix: string): void => {
    const key = `${path}:${depth}`;
    if (seen.has(key)) {
      out(`${prefix}${relative(path)} (already shown)\n`);
      return;
    }
    seen.add(key);
    const node = edges.get(path);
    const outgoing = (node?.outgoing ?? []).filter((target) => edges.has(target)).sort();
    for (const [index, target] of outgoing.entries()) {
      const last = index === outgoing.length - 1;
      out(`${prefix}${last ? '└── ' : '├── '}${relative(target)}\n`);
      walk(target, depth + 1, `${prefix}${last ? '    ' : '│   '}`);
    }
  };

  out(`\n  ${analysis.entryPoints.length} entry point(s)\n\n`);
  for (const entry of [...analysis.entryPoints].sort()) {
    out(`  ${relative(entry)}\n`);
    walk(entry, 0, '  ');
    out('\n');
  }
  return 0;
}

/** `deadcode files`: reachability only. */
function commandFiles(args: ParsedArgs, analysis: Analysis, out: (text: string) => void): number {
  const relative = (path: string): string =>
    path.replace(analysis.root, '').replace(/^\//, '') || path;
  const live = [...analysis.reachable].sort();
  const dead = [...analysis.graph.keys()].filter((p) => !analysis.reachable.has(p)).sort();

  if (args.json) {
    out(
      `${JSON.stringify(
        { entryPoints: analysis.entryPoints.map(relative), reachable: live.map(relative), unreachable: dead.map(relative) },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  out(`\n  ${live.length} reachable file(s)\n`);
  for (const path of live) out(`    ✔ ${relative(path)}\n`);
  if (dead.length > 0) {
    out(`\n  ${dead.length} unreachable file(s)\n`);
    for (const path of dead) out(`    ✖ ${relative(path)}\n`);
  }
  out('\n');
  return 0;
}

/** `deadcode deps`: dependencies only. */
function commandDeps(args: ParsedArgs, analysis: Analysis, out: (text: string) => void): number {
  const unused = analysis.dependencies.filter((dependency) => dependency.usedIn.length === 0);
  const used = analysis.dependencies.filter((dependency) => dependency.usedIn.length > 0);

  if (args.json) {
    out(`${JSON.stringify({ unused, used }, null, 2)}\n`);
    return unused.length > 0 ? 1 : 0;
  }

  out('\n  dependencies\n');
  for (const dependency of used) {
    const note = dependency.configOnly ? ' (tooling only)' : '';
    out(`    ✔ ${dependency.name.padEnd(28)}${dependency.usedIn.join(', ')}${note}\n`);
  }
  if (unused.length > 0) {
    out(`\n  unused dependencies\n`);
    for (const dependency of unused) {
      out(`    ✖ ${dependency.name}  (${dependency.kind})\n`);
    }
  } else {
    out('\n  no unused dependencies\n');
  }
  out('\n');
  return unused.length > 0 ? 1 : 0;
}

/**
 * The entry point.
 *
 * Streams are parameters rather than direct references so the whole CLI can be
 * driven from a test without spawning a process or capturing global stdout.
 */
export async function main(
  argv: readonly string[],
  io: {
    out?: (text: string) => void;
    err?: (text: string) => void;
    colourStream?: { isTTY?: boolean };
  } = {},
): Promise<number> {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  const err = io.err ?? ((text: string) => process.stderr.write(text));
  const args = parseArgs(argv);

  if (args.errors.length > 0) {
    for (const message of args.errors) err(`  error: ${message}\n`);
    err(`\n${USAGE}`);
    return 2;
  }

  if (args.version) {
    out(`${VERSION}\n`);
    return 0;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }

  const command = args.command === '' ? 'scan' : args.command;

  if (command === 'init') return commandInit(args, out);

  const root = resolve(args.path ?? '.');
  if (!existsSync(root)) {
    err(`  error: ${root} does not exist\n`);
    return 2;
  }

  let analysis: Analysis;
  try {
    analysis = await runAnalysis(args);
  } catch (error) {
    err(`  error: ${(error as Error).message}\n`);
    return 2;
  }

  if (!args.quiet) {
    const loaded = loadConfig(root, args.config ?? undefined);
    for (const warning of loaded.warnings) {
      err(`  warning: ${warning}\n`);
    }
  }

  switch (command) {
    case 'graph':
      return commandGraph(args, analysis, out);
    case 'files':
      return commandFiles(args, analysis, out);
    case 'deps':
      return commandDeps(args, analysis, out);
    case 'scan':
    case 'report': {
      // `report` means "show me everything", so it implies verbose: the two
      // flags are about different things and neither should silently override
      // the other.
      const impliesVerbose = command === 'report';
      const options: RenderOptions = {
        json: args.json,
        verbose: args.verbose || impliesVerbose,
        quiet: args.quiet,
        colour: colourEnabled(args, io.colourStream ?? process.stdout),
        minSeverity: impliesVerbose ? 'info' : undefined,
      };

      out(command === 'report' || args.json
        ? `${args.json ? renderJson(analysis, options) : renderText(analysis, options)}\n`
        : `${renderText(analysis, options)}\n`);

      const threshold = thresholdFor(args);
      const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
      const offending = analysis.findings.filter(
        (finding) => rank[finding.severity] <= rank[threshold],
      );
      const unusedDependencies = analysis.dependencies.filter(
        (dependency) => dependency.usedIn.length === 0,
      ).length;
      return offending.length + unusedDependencies > 0 ? 1 : 0;
    }
    default:
      err(`  error: unknown command "${command}"\n\n${USAGE}\n`);
      return 2;
  }
}