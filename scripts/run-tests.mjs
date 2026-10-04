#!/usr/bin/env node
// Run the compiled test suite on every Node.js version deadcode claims to
// support (>= 20).
//
// Why this exists instead of a one-liner in package.json:
//
//   node --test "dist/tests/**/*.test.js"
//
// only understands the glob pattern from Node 22 onwards. On Node 20 the
// pattern is taken as a literal path, the runner exits 1 with
//   Could not find '<repo>/dist/tests/**/*.test.js'
// and the Node 20 CI matrix entry goes red while the tests themselves are fine.
// Passing the directory instead does not help either: `node --test dist/tests`
// works on Node 20, but Node 26 tries to load the directory as a module and
// fails with ERR_MODULE_NOT_FOUND. Neither form is portable, so the file list
// is built here, from the filesystem, and node is handed explicit paths. That
// behaves identically on every version.
//
// `--list` prints the discovered files, one per line, without running them.
// `--dir <path>` points the search at another directory, which is how the tests
// check the discovery rules without touching dist.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const defaultTestsRoot = join(repoRoot, 'dist', 'tests');

// Every compiled test file under `dir`, sorted, absolute paths.
// A directory that does not exist yields nothing rather than throwing: the
// caller decides whether an empty list is an error.
export function findTestFiles(dir) {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) return [];

  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const dirIndex = argv.indexOf('--dir');
const testsRoot =
  dirIndex === -1 || !argv[dirIndex + 1]
    ? defaultTestsRoot
    : resolve(repoRoot, argv[dirIndex + 1]);

const list = findTestFiles(testsRoot);

if (listOnly) {
  for (const file of list) console.log(relative(repoRoot, file));
  process.exit(0);
}

if (list.length === 0) {
  console.error(
    `No compiled tests under ${relative(repoRoot, testsRoot)}.\n` +
      'Run the build first: npm run build',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...list], {
  cwd: repoRoot,
  stdio: 'inherit',
});
process.exit(result.status === null ? 1 : result.status);