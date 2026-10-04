// Tests for the test runner itself: scripts/run-tests.mjs.
//
// This file earns its keep. The runner exists because
//
//   node --test "dist/tests/**/*.test.js"
//
// dies on Node 20 with `Could not find '.../dist/tests/**/*.test.js'` while the
// same command passes on Node 22, 24 and 26. The failure is invisible locally
// when the local node is new enough, so it only shows up as a red CI matrix
// cell, and it reads as "node 20 is broken" rather than "this invocation is
// version dependent". Locking the discovery rules down here keeps a rewrite of
// the runner from quietly reintroducing a glob.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const runner = join(repoRoot, 'scripts', 'run-tests.mjs');

/** Run the runner with `--list`, returning its stdout lines. */
function list(dir: string): string[] {
  const result = spawnSync(process.execPath, [runner, '--list', '--dir', dir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `runner failed: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
}

/** Build a throwaway tree of test-ish files and return its root. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'deadcode-runner-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test('the runner finds .test.js files, recursively, and nothing else', () => {
  const root = tree({
    'a.test.js': '',
    'nested/b.test.js': '',
    'nested/deeper/c.test.js': '',
    'nested/helper.js': '',
    'nested/d.test.mjs': '',
    'nested/e.spec.js': '',
    'notes.txt': '',
  });
  try {
    // --list prints paths relative to the repository root, so slice the temp
    // root off by resolving back to an absolute path first.
    const found = list(root).map((p) => relative(root, resolve(repoRoot, p)).split('\\').join('/'));
    assert.deepEqual(found.sort(), [
      'a.test.js',
      'nested/b.test.js',
      'nested/deeper/c.test.js',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the runner reports nothing for a directory that does not exist', () => {
  // A missing dist/tests must look like an empty suite, not a crash: the build
  // step decides whether that is an error.
  const found = list(join(repoRoot, 'dist', 'tests', 'definitely-not-here'));
  assert.deepEqual(found, []);
});

test('the runner exits non-zero with a build hint when it finds no tests', () => {
  const root = tree({ 'README.md': '' });
  try {
    const result = spawnSync(process.execPath, [runner, '--dir', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every path the runner hands to node is a real file, not a pattern', () => {
  // The regression itself, checked on real output. Node only expands a glob in
  // --test arguments from v22; on v20 the pattern is taken literally and the
  // run dies with "Could not find". So anything printed by --list has to be a
  // path that exists: a leftover '*' or '?' is the bug coming back.
  const found = list(join(repoRoot, 'dist', 'tests'));
  assert.ok(found.length > 0, 'the real suite must not be empty');
  for (const entry of found) {
    assert.ok(!/[*?[\]]/.test(entry), `pattern leaked through: ${entry}`);
    assert.ok(existsSync(join(repoRoot, entry)), `listed file does not exist: ${entry}`);
  }
});

test('the discovered suite really contains the analyser tests', () => {
  // A negative control: "nothing to complain about" must not be
  // indistinguishable from "found nothing", which is exactly how the original
  // failure looked from the outside.
  const found = list(join(repoRoot, 'dist', 'tests'));
  assert.ok(found.length >= 3, `expected the real suite, found ${found.length}`);
  assert.ok(
    found.some((p) => p.endsWith('analyse.test.js')),
    'analyse.test.js must be discovered',
  );
  assert.ok(
    found.some((p) => p.endsWith('path.test.js')),
    'path.test.js must be discovered',
  );
});