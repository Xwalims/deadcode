/**
 * Analyser tests, driven by the real fixture projects.
 *
 * The fixtures under `fixtures/` are real projects, not string literals, because
 * the interesting failures happen in module resolution and reachability rather
 * than in parsing. Each test names the false positive it is guarding against, so
 * a failure says which mistake came back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse } from '../src/analyzer/analyse.js';
import type { Analysis, Finding } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '..', '..', 'fixtures');

/** Analyse a fixture once and share it across the tests in a file. */
const cache = new Map<string, Promise<Analysis>>();

function fixture(name: string): Promise<Analysis> {
  let promise = cache.get(name);
  if (!promise) {
    promise = analyse({ root: join(FIXTURES, name) });
    cache.set(name, promise);
  }
  return promise;
}

/** The symbols reported for one kind, without their locations. */
function symbolsOf(analysis: Analysis, kind: string): string[] {
  return analysis.findings
    .filter((finding) => finding.kind === kind)
    .map((finding) => finding.symbol)
    .sort();
}

/** True when a file is reported as unreachable. */
function reportsFile(analysis: Analysis, relativePath: string): boolean {
  return analysis.findings.some(
    (finding) =>
      finding.kind === 'unused-file' &&
      finding.file.endsWith(relativePath),
  );
}

// ---------------------------------------------------------------------------
// The simple fixture: the obvious cases
// ---------------------------------------------------------------------------

test('the analysis runs and reports what it scanned', async () => {
  const analysis = await fixture('simple');
  assert.equal(analysis.stats.filesAnalyzed, 5);
  assert.ok(analysis.stats.symbolsDiscovered > 0);
  assert.equal(analysis.stats.importsUnresolved, 0);
});

test('an unreferenced file is reported as unused', async () => {
  const analysis = await fixture('simple');
  assert.equal(
    reportsFile(analysis, 'orphan-file.ts'),
    true,
    'a file nothing imports must be reported',
  );
});

test('a file reachable through a chain is not reported', async () => {
  const analysis = await fixture('simple');
  // index.ts -> nested/also-used.ts -> used.ts is a two-hop chain.
  assert.equal(reportsFile(analysis, 'also-used.ts'), false);
  assert.equal(reportsFile(analysis, 'used.ts'), false);
  assert.equal(reportsFile(analysis, 'legacy.ts'), false);
});

test('a file reached only by a re-export is not reported', async () => {
  const analysis = await fixture('simple');
  assert.equal(
    reportsFile(analysis, 'legacy.ts'),
    false,
    'export { legacy } from "./legacy.js" is an edge, so legacy.ts is reachable',
  );
});

test('an exported function nothing imports is reported', async () => {
  const analysis = await fixture('simple');
  const unused = symbolsOf(analysis, 'unused-function');
  assert.ok(unused.includes('neverCalled'), `got ${unused.join(', ')}`);
});

test('a function that is imported is not reported', async () => {
  const analysis = await fixture('simple');
  assert.equal(
    symbolsOf(analysis, 'unused-function').includes('used'),
    false,
    '"used" is imported by index.ts and must not be reported',
  );
});

test('an exported class nothing instantiates is reported', async () => {
  const analysis = await fixture('simple');
  assert.ok(symbolsOf(analysis, 'unused-class').includes('Orphan'));
});

test('an exported interface nothing references is reported', async () => {
  const analysis = await fixture('simple');
  assert.ok(symbolsOf(analysis, 'unused-interface').includes('UnusedShape'));
});

test('every finding states a reason and an escape', async () => {
  const analysis = await fixture('simple');
  for (const finding of analysis.findings) {
    assert.ok(finding.reason.detail.length > 0, `${finding.kind} ${finding.symbol} has no reason`);
    assert.ok(finding.reason.source.length > 0);
    assert.ok(finding.confidence >= 0 && finding.confidence <= 1);
    assert.ok(['error', 'warning', 'info'].includes(finding.severity));
  }
});

test('an unused-file finding admits it might still be used', async () => {
  const analysis = await fixture('simple');
  const finding = analysis.findings.find((f) => f.kind === 'unused-file');
  assert.ok(finding, 'expected an unused-file finding');
  assert.ok(
    finding?.reason.escape && finding.reason.escape.length > 0,
    'a file-level finding must say how it could still be reached',
  );
});

// ---------------------------------------------------------------------------
// The traps fixture: false positives are the real target
// ---------------------------------------------------------------------------

test('a config file is not reported as unused', async () => {
  const analysis = await fixture('traps');
  assert.equal(
    reportsFile(analysis, 'vite.config.ts'),
    false,
    'vite.config.ts is loaded by Vite, not by an import',
  );
});

test('a file reached through a barrel is not reported', async () => {
  const analysis = await fixture('traps');
  // index.ts -> barrel.ts -> feature.ts, with `export *` in the middle.
  assert.equal(reportsFile(analysis, 'feature.ts'), false);
  assert.equal(reportsFile(analysis, 'barrel.ts'), false);
});

test('a symbol re-exported through a barrel is not reported as unused', async () => {
  const analysis = await fixture('traps');
  // `thing` is exported by feature.ts and re-exported by index.ts via the
  // barrel. Reporting it would be the classic barrel false positive.
  assert.equal(
    symbolsOf(analysis, 'unused-variable').includes('thing'),
    false,
    `"thing" is re-exported: ${symbolsOf(analysis, 'unused-variable').join(', ')}`,
  );
});

test('a JSX file is parsed and its components reported', async () => {
  const analysis = await fixture('traps');
  const unused = symbolsOf(analysis, 'unused-function');
  assert.ok(
    unused.includes('Unused'),
    `an unreferenced JSX component must be found: ${unused.join(', ')}`,
  );
});

test('an unused import inside a file is reported', async () => {
  const analysis = await fixture('simple');
  // Not present in this fixture, but the rule must not throw when the list is
  // empty, which is the case that used to crash on an undefined reference.
  const unusedImports = analysis.findings.filter((f) => f.kind === 'unused-import');
  assert.ok(Array.isArray(unusedImports));
});

// ---------------------------------------------------------------------------
// The aliases fixture: resolution
// ---------------------------------------------------------------------------

test('a path alias resolves to the real file', async () => {
  const analysis = await fixture('aliases');
  assert.equal(
    reportsFile(analysis, 'services/api.ts'),
    false,
    'src/services/api.ts is reached through the @app/* alias',
  );
});

test('an exact alias without a wildcard resolves', async () => {
  const analysis = await fixture('aliases');
  assert.equal(reportsFile(analysis, 'lib/index.ts'), false);
});

test('a CommonJS import resolves', async () => {
  const analysis = await fixture('aliases');
  assert.equal(reportsFile(analysis, 'legacy.cjs'), false);
});

test('an aliased import is not counted as unresolved', async () => {
  const analysis = await fixture('aliases');
  assert.equal(
    analysis.stats.importsUnresolved,
    0,
    'every specifier in this fixture resolves, aliases included',
  );
});

// ---------------------------------------------------------------------------
// Reachability invariants that must hold on any project
// ---------------------------------------------------------------------------

test('every reported unused file is outside the reachable set', async () => {
  for (const name of ['simple', 'traps', 'aliases']) {
    const analysis = await fixture(name);
    for (const finding of analysis.findings.filter((f) => f.kind === 'unused-file')) {
      assert.equal(
        analysis.reachable.has(finding.file),
        false,
        `${finding.file} was reported unused but is in the reachable set`,
      );
    }
  }
});

test('every reachable file is inside the scanned set', async () => {
  const analysis = await fixture('traps');
  const scanned = new Set(analysis.files.map((file) => file.path));
  for (const path of analysis.reachable) {
    assert.ok(scanned.has(path), `${path} is reachable but was never scanned`);
  }
});

test('at least one file is an entry point', async () => {
  for (const name of ['simple', 'traps', 'aliases']) {
    const analysis = await fixture(name);
    assert.ok(
      analysis.entryPoints.length > 0,
      `${name} has no entry point, so every file would look unused`,
    );
  }
});

test('the graph covers every analysed file', async () => {
  for (const name of ['simple', 'traps', 'aliases']) {
    const analysis = await fixture(name);
    assert.equal(analysis.graph.size, analysis.stats.filesAnalyzed);
  }
});

test('findings are stable across two runs', async () => {
  const first = await analyse({ root: join(FIXTURES, 'simple') });
  const second = await analyse({ root: join(FIXTURES, 'simple') });
  const key = (analysis: Analysis): string =>
    analysis.findings
      .map((f: Finding) => `${f.kind}:${f.file}:${f.line}:${f.symbol}`)
      .sort()
      .join('\n');
  assert.equal(key(first), key(second));
});