# deadcode

Find unused code in JavaScript and TypeScript projects.

A dead-code tool is only worth having if you believe it when it says something is
unused. That constraint drives the whole design: a rule that cannot prove its
claim reports nothing, and every finding carries the evidence that produced it
along with an honest note about how it could still be wrong.

## Install

```sh
npm install --save-dev deadcode
```

## Use

```sh
deadcode .                     # scan a project
deadcode . --json              # machine-readable
deadcode files .               # only files nothing reaches
deadcode deps .                # only unused and missing dependencies
deadcode report .              # every finding, grouped by severity
deadcode . --fail-on error     # exit 1 on errors, for CI
```

Run `deadcode --help` for the full list. Exit codes: `0` nothing at or above the
threshold, `1` findings at or above it, `2` the tool could not run.

## What it finds

`unused-file`, `unreachable-code`, `unused-import`, `unused-export`,
`unused-variable`, `unused-function`, `unused-class`, `unused-interface`,
`unused-type`, `unused-dependency`, `unused-dev-dependency`,
`missing-dependency`, `duplicate-dependency`.

## What it will not call dead

Most files that look unreferenced are not. A file is only reported when no import
path reaches it from any entry point, and the entry points are deliberately
generous: conventional names (`index.*`, `main.*`, `cli.*`), every path in
`package.json` (`main`, `module`, `types`, `bin`, `exports`, and the paths named
inside `scripts`), and the config files a tool reads rather than code imports
(`vite.config.*`, `jest.config.*`, `tsconfig*.json`, `.github/workflows/*.yml`,
and the rest).

A `scripts` entry is a shell command, not a path, so it is pulled apart before
anything is matched: `node "scripts/build.js"`, `cmd && node scripts/other.js`
and `node scripts\win.js` all name a real file, while `tsc -p .`, an absolute
path such as `/opt/x.js` and a bare package name do not, because a candidate
that matched a local file by accident would hide real dead code instead.

Within a file, a symbol is only reported when its name is imported by nothing
*and* is not referenced inside its own file. A barrel that re-exports everything
does not keep a helper alive, because the check is per-name rather than
"something points at this file".

## Resolution

Turning `./used.js` into a file is where this kind of tool usually goes wrong,
so resolution is explicit and reports which rule it applied:

- the TypeScript emit rewrite, so `./used.js` finds `used.ts`
- extension search, then `index.*` inside a directory
- `tsconfig.json` `paths` and `baseUrl`, including a single `*` in a pattern
- bare specifiers, treated as npm packages rather than as project files

One detail worth knowing, because it was a real bug here: the file graph and the
symbol index must resolve a specifier to the *same* file. They previously kept
separate copies of the resolver, and the symbol-level one only understood
relative paths. Every aliased import therefore resolved at the file level and
not at the symbol level, so the tool would mark a file reachable and then
report the symbols inside it as *"no file in the project imports it"*. Both
levels now share one resolver.

## Configuration

`deadcode.config.json` at the project root:

```json
{
  "exclude": ["node_modules", "dist", "fixtures"],
  "entryPoints": ["src/index.ts", "src/cli/index.ts"]
}
```

## Output

A real run against this repository's `fixtures/simple`:

```
  5 files analysed
  12 symbols discovered
  4 imports resolved

  UNUSED FUNCTIONS          3
  UNUSED CLASSES            1
  UNUSED INTERFACES         1
  UNUSED FILES              1
  UNUSED DEPENDENCIES       3

  1:1      ERROR    unused-file

  src/orphan-file.ts
      no import path reaches this file from any entry point
      may still be used: it may be loaded at runtime, by a plugin registry, or by a path this tool cannot resolve
```

Every finding says how it might still be wrong. A tool that reports dead code
without admitting it is guessing gets uninstalled after the first false positive.

## Tests

```sh
npm test
```

The tests run against the real fixture projects under `fixtures/`, not against
string literals, because the interesting failures happen in module resolution
and reachability rather than in parsing.

`npm test` builds first, then hands the compiled test files to
`scripts/run-tests.mjs`, which collects them from the filesystem and passes
explicit paths to `node --test`. The script exists because
`node --test "dist/tests/**/*.test.js"` only understands the glob from Node 22
onwards: on Node 20 the pattern is treated as a literal filename and the run
dies with `Could not find .../dist/tests/**/*.test.js`. Passing the directory
does not work either, since Node 26 tries to load a directory as a module.
`npm run test:list` prints the discovered files without running them.

## Licence

MIT