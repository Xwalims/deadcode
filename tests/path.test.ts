/**
 * Glob and path tests.
 *
 * These are the foundation: a wrong glob silently changes which files are
 * scanned, and a wrong `isInsideDirectory` lets `node_modules` be analysed, so
 * both are tested directly rather than only through the scanner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileGlob,
  isInsideDirectory,
  normalisePath,
  relative,
  isInside,
} from '../src/utils/path.js';

test('a literal path matches only itself', () => {
  const match = compileGlob('src/index.ts');
  assert.equal(match('src/index.ts'), true);
  assert.equal(match('src/other.ts'), false);
  assert.equal(match('other/src/index.ts'), false);
});

test('* matches within one segment and never across a slash', () => {
  const match = compileGlob('src/*.ts');
  assert.equal(match('src/a.ts'), true);
  assert.equal(match('src/a/b.ts'), false, '* must not cross a segment boundary');
  assert.equal(match('srcx/a.ts'), false);
});

test('** crosses any number of segments, including none', () => {
  const match = compileGlob('src/**/*.ts');
  assert.equal(match('src/a.ts'), true, '** must match zero segments');
  assert.equal(match('src/a/b.ts'), true);
  assert.equal(match('src/a/b/c/d.ts'), true);
  assert.equal(match('test/a.ts'), false);
});

test('** matches a bare directory name anywhere in the path', () => {
  const match = compileGlob('**/generated/**');
  assert.equal(match('src/generated/x.ts'), true);
  assert.equal(match('a/b/generated/c.ts'), true);
  assert.equal(match('src/generated.ts'), false);
});

test('a trailing slash makes the pattern match the directory and its contents', () => {
  // This is what makes the default `dist` exclude work at all.
  const match = compileGlob('dist/');
  assert.equal(match('dist'), true);
  assert.equal(match('dist/app.js'), true);
  assert.equal(match('dist/a/b.js'), true);
  assert.equal(match('src/dist/x.js'), false, 'the match must be anchored at the start');
});

test('a question mark matches exactly one character', () => {
  const match = compileGlob('a?c.ts');
  assert.equal(match('abc.ts'), true);
  assert.equal(match('ac.ts'), false);
  assert.equal(match('abbc.ts'), false);
});

test('braces expand to alternatives', () => {
  const match = compileGlob('*.config.{js,ts}');
  assert.equal(match('vite.config.js'), true);
  assert.equal(match('vite.config.ts'), true);
  assert.equal(match('vite.config.md'), false);
});

test('regular expression characters in a path are literal', () => {
  // Without escaping, a file named app[2].ts would match a single character.
  const match = compileGlob('my.file[2].ts');
  assert.equal(match('my.file[2].ts'), true);
  assert.equal(match('my.fileX2X.ts'), false);
});

test('a leading exclamation negates the pattern', () => {
  const match = compileGlob('!src/keep.ts');
  assert.equal(match('src/keep.ts'), false);
  assert.equal(match('src/drop.ts'), true);
});

test('isInsideDirectory matches a bare directory name at any depth', () => {
  const match = isInsideDirectory(['node_modules'], 'a/b/node_modules/c/d.js');
  assert.equal(match, true);
  assert.equal(isInsideDirectory(['node_modules'], 'src/a.ts'), false);
});

test('isInsideDirectory ignores negated patterns', () => {
  const patterns = ['!node_modules'];
  assert.equal(
    isInsideDirectory(patterns, 'node_modules/x.js'),
    false,
    'a negated pattern must not exclude anything',
  );
});

test('normalisePath strips a leading ./ and converts separators', () => {
  assert.equal(normalisePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalisePath('src\\a.ts'), 'src/a.ts');
});

test('relative returns null when the target is outside', () => {
  assert.equal(relative('/root', '/root/src/a.ts'), 'src/a.ts');
  assert.equal(relative('/root', '/other/a.ts'), null);
  assert.equal(relative('/root/', '/root/a.ts'), 'a.ts');
  assert.equal(relative('/root', '/root'), '');
});

test('isInside treats a null relative path as outside', () => {
  assert.equal(isInside('/root', '/root/src/a.ts'), true);
  assert.equal(isInside('/root', '/root'), true);
  assert.equal(isInside('/root', '/other/a.ts'), false);
});