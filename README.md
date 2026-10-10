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

`exports` is read to any depth, because the modern form nests one level per
condition:

```json
{
  "exports": {
    "./plugin": { "types": "./src/plugin-types.ts", "import": "./src/plugin.ts" }
  }
}
```

Node resolves that subpath for real, so both files are shipped API surface and
neither may be called dead code. Only the string values name files: `"./plugin"`,
`"types"` and `"node"` are a subpath and two conditions, and treating a key as a
path would mark an unrelated file reachable by accident.

A `scripts` entry is a shell command, not a path, so it is pulled apart before
anything is matched: `node "scripts/build.js"`, `cmd && node scripts/other.js`
and `node scripts\win.js` all name a real file, while `tsc -p .`, an absolute
path such as `/opt/x.js` and a bare package name do not, because a candidate
that matched a local file by accident would hide real dead code instead.

A CommonJS project gets the same treatment as an ES module one. `require()` is
a load and builds an edge in all three of its shapes, and a declaration is
public when `module.exports = { a }` or `exports.a = ...` names it -- without
that, no symbol in a CommonJS file was ever recognised as exported and the
symbol rule had nothing to say about the whole codebase.

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
- `require('./x')`, which is a load, in all three of its shapes:
  destructured (`const { a } = require('./x')`), whole-module
  (`const x = require('./x')`) and member access
  (`require('./x').main()`)

One detail worth knowing, because it was a real bug here: the file graph and the
symbol index must resolve a specifier to the *same* file. They previously kept
separate copies of the resolver, and the symbol-level one only understood
relative paths. Every aliased import therefore resolved at the file level and
not at the symbol level, so the tool would mark a file reachable and then
report the symbols inside it as *"no file in the project imports it"*. Both
levels now share one resolver.

`require.resolve()` and `require.main` are deliberately *not* treated as loads.
They return a path and a module id; neither executes anything, so following
them would mark a file reachable that never runs.

A whole-module binding -- `import * as ns from './x'` or `const x =
require('./x')` -- keeps *every* export of the target alive, because there is no
type information here to tell `ns.helper()` from `ns.other()`. A destructured
one names a single member, and only that member survives.

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

## Why the parser is the TypeScript compiler

Not a hand-written parser, and not a regular expression pretending to be one.

A JavaScript parser has to handle template literals nested inside template
literals, regex literals that look like division, JSX, type annotations, and
every combination. Every such tool eventually mis-parses something, and a
mis-parse in a dead-code detector produces a **confident finding about code
that is actually used**. Using the same parser `tsc` uses means the tool
agrees with the compiler about what the code means, which is the property that
matters. It is also the only realistic way to support TypeScript at all.

`typescript` is the only runtime dependency.

## Limitations

Stated plainly, because a tool that hides these is worse than one that does not.

**No type information.** Each file is read on its own, with no `Program`.
"Unused" therefore means *no syntactic reference exists*, not *the compiler
proved nothing uses this*. It is why findings carry a severity instead of
claiming certainty.

**On a published library `unused-export` will be noisy.** An exported symbol
is part of the public API by definition, and by definition nothing inside your
own project imports it. Every finding says so; expect volume, and use `ignore`
or `entryPoints`.

**Runtime string loading is invisible.** `import(modulePath)` with a computed
path cannot be followed. The importing file stays alive; the target is not
proved dead.

**Dynamic property access is invisible.** `obj[methodName]()` is identical to
a static call as far as the syntax goes.

**It never runs your code.** No sandbox, no `eval`, no coverage. That is a
safety property and also a limit: nothing dynamic can be discovered.

## Performance

Nothing here is claimed without a measurement.

- One directory walk, then file reads. Excludes are checked **before**
  descending, so a large `dist` costs one stat call rather than thousands.
- Each file is parsed once with `setParentNodes`, and the rules reuse that AST
  rather than re-parsing.
- Reachability walks an explicit queue, not recursion, so a deep import chain
  cannot overflow the stack.
- The graph walk uses a `Set` for membership. An earlier version used
  `Array.includes` inside the loop, which is quadratic in file count — exactly
  the cost profile a tool is judged on for a large repository.

  The seed-collection pass above it still uses `Array.includes`, because it runs
  once per configured pattern rather than once per edge. That asymmetry is
  deliberate and is the only reason it is tolerable.

## Architecture

```
src/
├── types.ts                     every type that crosses a module boundary
├── config/
│   ├── defaults.ts              one frozen defaults object
│   └── load.ts                  discovery, validation, path filtering
├── scanner/files.ts             asynchronous tree walk
├── analyzer/
│   ├── analyse.ts               the pipeline, assembled
│   ├── parser/parse.ts          the TypeScript compiler API
│   ├── imports/resolve.ts       .js→.ts, index files, aliases, bare specifiers
│   ├── reachability/compute.ts  seeds and graph traversal
│   └── dependencies/analyse.ts  package.json against the imports
├── rules/index.ts               imports, symbols, unreachable code
├── reporter/text.ts             text and JSON rendering
├── cli/index.ts                 command parsing and exit codes
└── index.ts                     the public API
```

The core is usable as a library:

```js
import { analyse, renderText } from 'deadcode';

const analysis = await analyse({ root: process.cwd() });
console.log(renderText(analysis, { colour: false }));
```

`cli/`, `reporter/` and `config/` depend on the analyzer; the analyzer depends on
none of them. That direction is what keeps the CLI replaceable.

## Numbers from this repository's own scan

```sh
$ node dist/src/cli/bin.js . --json | jq '.stats, (.findings | length)'
{
  "filesAnalyzed": 19,
  "symbolsDiscovered": 160,
  "importsResolved": 84,
  "importsUnresolved": 0
}
4
```

Four findings out of 160 symbols, each confirmed by hand to be genuinely unused.

## Development

```sh
git clone https://github.com/Xwalims/deadcode.git
cd deadcode
npm install
npm run build      # tsc
npm test           # build, then node --test
npm run typecheck
```

The fixtures under `fixtures/` are real projects, not string literals:

| Fixture | What it is for |
| --- | --- |
| `fixtures/simple` | dead code next to live code |
| `fixtures/traps` | barrels, CommonJS, JSX, config files |
| `fixtures/aliases` | `tsconfig` `paths`, wildcard and exact aliases |
| `fixtures/commonjs` | `require()`, destructuring, namespace, member access |

Run the tool on its own source as a sanity check:

```sh
node dist/src/cli/bin.js . --json
```

## Contributing

Issues and pull requests are welcome. Please include the output of
`deadcode . --json` and `deadcode --version`; without the first, a false positive
cannot be investigated.

If you are reporting a false positive, the `reason` and `escape` fields say what
the tool believed. That is the first thing to check.

## Licence

MIT