/**
 * Output rendering.
 *
 * The text form is the product's face, and it has one job above all: a reader
 * must be able to tell, from the output alone, why a thing was called unused.
 * A finding with no stated reason is not actionable, and a tool that produces
 * those gets switched off.
 *
 * Colour is used only where it carries meaning, and every coloured line has an
 * uncoloured equivalent, because output piped into a file should stay readable.
 */
import { relative } from 'node:path';
import type { Analysis, Finding, FindingKind, Severity } from '../types.js';

export interface RenderOptions {
  readonly json?: boolean;
  /** Print every finding, including `info`. */
  readonly verbose?: boolean;
  /** Print one line per file with only file-level findings. */
  readonly summaryOnly?: boolean;
  /** Suppress the header and the timing footer. */
  readonly quiet?: boolean;
  /** Colour, or no colour. Detected from NO_COLOR and TTY by the caller. */
  readonly colour?: boolean;
  /** Minimum severity to print. */
  readonly minSeverity?: Severity;
}

/** Display names, grouped the way the sample output groups them. */
const KIND_LABELS: Record<FindingKind, string> = {
  'unused-variable': 'UNUSED VARIABLES',
  'unused-function': 'UNUSED FUNCTIONS',
  'unused-class': 'UNUSED CLASSES',
  'unused-interface': 'UNUSED INTERFACES',
  'unused-type': 'UNUSED TYPES',
  'unused-export': 'UNUSED EXPORTS',
  'unused-import': 'UNUSED IMPORTS',
  'unused-file': 'UNUSED FILES',
  'unreachable-code': 'UNREACHABLE CODE',
  'unused-dependency': 'UNUSED DEPENDENCIES',
  'unused-dev-dependency': 'UNUSED DEV DEPENDENCIES',
  'missing-dependency': 'MISSING DEPENDENCIES',
  'duplicate-dependency': 'DUPLICATE DEPENDENCIES',
};

/** Order the groups appear in: files last, because they are the ones to think about. */
const KIND_ORDER: readonly FindingKind[] = [
  'unreachable-code',
  'unused-variable',
  'unused-function',
  'unused-class',
  'unused-interface',
  'unused-type',
  'unused-export',
  'unused-import',
  'missing-dependency',
  'unused-dependency',
  'unused-dev-dependency',
  'duplicate-dependency',
  'unused-file',
];

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** ANSI codes, or empty strings when colour is off. */
function palette(enabled: boolean): Record<string, string> {
  if (!enabled) {
    return { reset: '', bold: '', dim: '', red: '', yellow: '', blue: '', cyan: '', grey: '' };
  }
  return {
    reset: '[0m',
    bold: '[1m',
    dim: '[2m',
    red: '[31m',
    yellow: '[33m',
    blue: '[34m',
    cyan: '[36m',
    grey: '[90m',
  };
}

const SEVERITY_COLOUR: Record<Severity, string> = {
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
};

/** Group thousands, because a file count is easier to read with separators. */
function thousands(value: number): string {
  return value.toLocaleString('en-US');
}

/** A short, stable relative path for display. */
function display(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === '' ? path : rel.split('\\').join('/');
}

/** One finding, as a single line plus its reason. */
function renderOne(
  finding: Finding,
  root: string,
  colours: Record<string, string>,
  useColour: boolean,
): string[] {
  const lines: string[] = [];
  const severityColour = colours[SEVERITY_COLOUR[finding.severity]] ?? '';
  const tag = useColour
    ? `${severityColour}${finding.severity.toUpperCase().padEnd(7)}${colours.reset}`
    : finding.severity.toUpperCase().padEnd(7);

  const where = finding.line > 0 ? `${finding.line}:${finding.column}` : '1:1';
  const location = useColour
    ? `${colours.grey}${where}${colours.reset}`
    : where;

  lines.push(`  ${location.padEnd(9)}${tag}  ${finding.kind}`);

  const file = display(root, finding.file);
  if (finding.kind === 'unused-file') {
    // For a file finding the symbol already is the path, so printing it again
    // would show the same string twice under the same block.
    lines.push('');
    lines.push(`  ${useColour ? colours.bold : ''}${file}${useColour ? colours.reset : ''}`);
  } else {
    const fileText = useColour ? `${colours.dim}${file}${colours.reset}` : file;
    lines.push(`      ${fileText}`);
    const name = useColour ? `${colours.bold}${finding.symbol}${colours.reset}` : finding.symbol;
    lines.push(`      ${name}`);
  }

  const detail = `      ${finding.reason.detail}`;
  lines.push(useColour ? `${colours.dim}${detail}${colours.reset}` : detail);

  if (finding.reason.escape) {
    const escape = `      may still be used: ${finding.reason.escape}`;
    lines.push(useColour ? `${colours.dim}${escape}${colours.reset}` : escape);
  }

  return lines;
}

/** The full text report. */
export function renderText(analysis: Analysis, options: RenderOptions = {}): string {
  const useColour = options.colour ?? false;
  const colours = palette(useColour);
  const lines: string[] = [];

  const minSeverity = options.minSeverity ?? 'info';
  const floor = SEVERITY_RANK[minSeverity];

  let findings = analysis.findings.filter((f) => SEVERITY_RANK[f.severity] <= floor);
  if (!options.verbose) {
    // Without --verbose the tool hides `info`, because an unfamiliar tool that
    // shouts about everything is a tool nobody reads.
    findings = findings.filter((f) => f.severity !== 'info');
  }

  if (!options.quiet) {
    const version = '1.0.0';
    lines.push(useColour ? `${colours.bold}deadcode${colours.reset} v${version}` : `deadcode v${version}`);
    lines.push('');
    lines.push(`  ${thousands(analysis.stats.filesAnalyzed)} files analysed`);
    lines.push(`  ${thousands(analysis.stats.symbolsDiscovered)} symbols discovered`);
    lines.push(`  ${thousands(analysis.stats.importsResolved)} imports resolved`);
    if (analysis.stats.importsUnresolved > 0) {
      lines.push(
        `  ${thousands(analysis.stats.importsUnresolved)} imports unresolved`,
      );
    }
    lines.push('');
  }

  // Dependency findings, which are about package.json rather than about files.
  const dependencyFindings: string[] = [];
  for (const dependency of analysis.dependencies) {
    if (dependency.usedIn.length === 0) {
      const label = dependency.kind === 'dev' ? 'unused-dev-dependency' : 'unused-dependency';
      dependencyFindings.push(`  ${dependency.name}  (${label.replace('unused-', '').replace('-dependency', '')})`);
    }
  }

  const grouped = new Map<FindingKind, Finding[]>();
  for (const finding of findings) {
    const list = grouped.get(finding.kind) ?? [];
    list.push(finding);
    grouped.set(finding.kind, list);
  }

  if (grouped.size === 0 && dependencyFindings.length === 0) {
    lines.push(useColour ? `${colours.green ?? ''}  no findings${colours.reset}` : '  no findings');
  }

  for (const kind of KIND_ORDER) {
    const list = grouped.get(kind);
    if (!list || list.length === 0) continue;
    const label = KIND_LABELS[kind];
    lines.push(`  ${useColour ? colours.bold : ''}${label.padEnd(22)}${String(list.length).padStart(5)}${useColour ? colours.reset : ''}`);
  }
  if (dependencyFindings.length > 0) {
    lines.push(`  ${useColour ? colours.bold : ''}${'UNUSED DEPENDENCIES'.padEnd(22)}${String(dependencyFindings.length).padStart(5)}${useColour ? colours.reset : ''}`);
  }

  if (grouped.size > 0 || dependencyFindings.length > 0) {
    lines.push('');
    lines.push('  ' + '─'.repeat(66));
    lines.push('');
  }

  // File-level findings first, because they are the ones worth acting on.
  const fileFindings = findings.filter((f) => f.kind === 'unused-file');
  const rest = findings.filter((f) => f.kind !== 'unused-file');

  if (!options.summaryOnly) {
    for (const finding of fileFindings) {
      lines.push(...renderOne(finding, analysis.root, colours, useColour));
      lines.push('');
    }
  }

  if (!options.summaryOnly) {
    let current = '';
    for (const finding of rest) {
      const file = display(analysis.root, finding.file);
      if (file !== current) {
        if (current !== '') lines.push('');
        current = file;
        lines.push(`  ${useColour ? colours.bold : ''}${file}${useColour ? colours.reset : ''}`);
        lines.push('');
      }
      lines.push(...renderOne(finding, analysis.root, colours, useColour));
      // One blank line after each finding. renderOne emits no trailing blank of
      // its own, and adding one here as well is what produced doubled spacing.
      lines.push('');
    }
  }

  if (dependencyFindings.length > 0 && !options.summaryOnly) {
    lines.push(`  ${useColour ? colours.bold : ''}package.json${useColour ? colours.reset : ''}`);
    lines.push('');
    for (const line of dependencyFindings) {
      lines.push(`  ${line}`);
    }
    lines.push('');
  }

  const total = findings.length + dependencyFindings.length;
  lines.push('  ' + '─'.repeat(66));
  lines.push('');
  lines.push(
    `  ${useColour ? colours.bold : ''}Total:${useColour ? colours.reset : ''} ${total} finding${total === 1 ? '' : 's'}`,
  );

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  if (errors > 0 || warnings > 0) {
    lines.push(`  ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
  }

  if (!options.quiet) {
    lines.push('');
    lines.push(
      useColour
        ? `${colours.dim}  completed in ${(analysis.stats.durationMs / 1000).toFixed(2)}s${colours.reset}`
        : `  completed in ${(analysis.stats.durationMs / 1000).toFixed(2)}s`,
    );
  }

  // One blank line is the separator, never two. Both the group-header path and
  // the per-finding path emit a blank line, and where they meet that produced a
  // doubled gap in the output.
  const collapsed = lines.reduce<string[]>((out, line, index) => {
    if (line === '' && out.length > 0 && out[out.length - 1] === '') return out;
    if (line === '' && index === lines.length - 1) return out;
    out.push(line);
    return out;
  }, []);

  return collapsed.join('\n').replace(/\n+$/, '');
}

/** Machine-readable output. */
export function renderJson(analysis: Analysis, options: RenderOptions = {}): string {
  let findings = analysis.findings;
  if (!options.verbose) findings = findings.filter((f) => f.severity !== 'info');

  const payload = {
    version: '1.0.0',
    root: analysis.root,
    stats: analysis.stats,
    entryPoints: analysis.entryPoints.map((path) => display(analysis.root, path)),
    reachable: [...analysis.reachable]
    .map((path) => display(analysis.root, path))
    .sort(),
    findings: findings.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      file: display(analysis.root, finding.file),
      absoluteFile: finding.file,
      line: finding.line,
      column: finding.column,
      symbol: finding.symbol,
      reason: finding.reason,
      confidence: finding.confidence,
    })),
    dependencies: analysis.dependencies.map((dependency) => ({
      name: dependency.name,
      kind: dependency.kind,
      usedIn: dependency.usedIn,
      configOnly: dependency.configOnly,
    })),
  };
  return JSON.stringify(payload, null, 2);
}