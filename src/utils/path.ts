/**
 * Glob matching and path helpers.
 *
 * Written rather than pulled in because the semantics needed here are narrower
 * than a general glob library, and a narrow implementation is easier to prove
 * correct than a dependency is to configure.
 *
 * ## Supported syntax
 *
 * - `*`   any run of characters within one path segment
 * - `**`  any number of segments, including none
 * - `?`   one character
 * - `{a,b}` alternation, one level deep, which is all any real config uses
 *
 * A leading `!` negates. Patterns are matched against **root-relative paths with
 * forward slashes**, never absolute paths: a pattern written in a config file
 * should not depend on where the project happens to live on disk.
 */

/**
 * Escape every character that has meaning in a regular expression, so a path
 * like `src/my.file[2].ts` is matched literally rather than as a pattern.
 */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand `{a,b}` alternation into the concrete strings it stands for.
 *
 * Kept separate from the regex build because alternation has to expand to whole
 * alternatives, not become a character class.
 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];

  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '{') depth += 1;
    else if (pattern[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];

  const inner = pattern.slice(open + 1, close);
  const parts: string[] = [];
  let current = '';
  depth = 0;
  for (const char of inner) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out: string[] = [];
  for (const part of parts) {
    for (const expanded of expandBraces(`${prefix}${part}${suffix}`)) out.push(expanded);
  }
  return out;
}

/**
 * Compile one brace-free glob into an anchored regular expression.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    // noUncheckedIndexedAccess: a bounds-checked index is `string | undefined`,
    // and letting `undefined` into the escape would silently produce "undefined"
    // in the pattern rather than failing.
    const char = pattern[i] as string;

    if (char === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        // `**/` must also match zero segments, so `**/foo` matches `foo` as well
        // as `a/b/foo`. That is what a config author means and what most glob
        // libraries do; getting it wrong is why `**/test` never matches `test`.
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        source += '.*';
        i += 2;
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }

    source += escapeLiteral(char);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

/**
 * Compile a pattern into a predicate, expanding braces first.
 *
 * A trailing `/` is treated as "this directory and everything under it", which
 * is how exclude patterns are written in practice.
 */
export function compileGlob(pattern: string): (path: string) => boolean {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;

  const expanded = expandBraces(body);
  const matchers = expanded.map((one) => {
    const asDirectory = one.endsWith('/');
    const clean = asDirectory ? one.slice(0, -1) : one;
    const regex = globToRegExp(clean);
    return { regex, asDirectory };
  });

  return (path: string): boolean => {
    const hit = matchers.some(({ regex, asDirectory }) => {
      if (regex.test(path)) return true;
      if (!asDirectory) return false;
      // A directory pattern matches everything beneath it, so `dist/` has to
      // match the *prefix* `dist/app.js`, not the whole path. Testing
      // `path + '/'` against `^dist$` never matches anything, which would leave
      // the default `dist/` exclude silently doing nothing.
      const prefixPattern = new RegExp(`^${regex.source.slice(1, -1)}(?:/|$)`);
      return prefixPattern.test(path);
    });
    return negated ? !hit : hit;
  };
}

/** True when any pattern matches. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => compileGlob(pattern)(path));
}

/**
 * True when the path is inside a directory named by any pattern.
 *
 * `exclude: ['node_modules']` must exclude `node_modules/foo/index.js`, which a
 * plain path match does not do: the pattern has no slash, so it never matches a
 * nested path. This walks the path segments instead.
 */
export function isInsideDirectory(patterns: readonly string[], path: string): boolean {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i).join('/');
    for (const pattern of patterns) {
      if (pattern.startsWith('!')) continue;
      const clean = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
      if (!clean.includes('/') && clean === prefix) return true;
      if (!clean.includes('/') && clean === segments[i - 1]) return true;
    }
  }
  return false;
}

/** Normalise a path to forward slashes with no leading `./`. */
export function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * True when `child` is inside `parent`. Used for project-boundary checks.
 *
 * A null from `relative` means "not inside", which is the answer, so the null
 * case is handled here rather than pushed at every call site.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === null) return false;
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

/**
 * A relative path, or null when `target` is not inside `from`.
 *
 * Returns null rather than a `../..` path on purpose: an escaping path means
 * "outside the project", and callers have to treat that as a different case
 * from "inside but far away".
 */
export function relative(from: string, target: string): string | null {
  const a = normalisePath(from).replace(/\/+$/, '');
  const b = normalisePath(target);
  if (b === a) return '';
  if (b.startsWith(`${a}/`)) return b.slice(a.length + 1);
  return null;
}