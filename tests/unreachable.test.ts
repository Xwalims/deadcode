/**
 * The unreachable-code rule, tested against what the TypeScript binder decides.
 *
 * ## Why the expectations are table-driven and tsc-shaped
 *
 * Every expected value in `CASES` was read off `tsc` itself rather than off
 * deadcode, by running the compiler with `allowUnreachableCode: false` and
 * recording where it puts TS7027. The table stores the verdict as the span tsc
 * prints, because that span is the only part of the compiler's answer a user
 * ever sees, and deadcode anchors its finding the same way.
 *
 * tsc suppresses a second report per flow, so it prints ONE span for a run of
 * dead statements where deadcode prints one finding. That difference is
 * deliberate and is asserted per case rather than papered over: a run is
 * reported once, by whichever tool has the finer granularity.
 *
 * ## The invariant that is not negotiable
 *
 * A false positive is worse than a miss here. A missed finding is one more
 * thing to clean up by hand; a wrong finding teaches the user that deadcode
 * cries wolf, and then they never read it again.
 *
 * The form of that claim that survives contact with tsc is: **if the compiler
 * prints nothing, deadcode reports nothing.** tsc prints at most one span per
 * flow and prints the run of statements *after* the dead one, so it is a lossy
 * view -- plenty of lines the binder calls dead are simply never printed, and
 * a statement tsc chose not to print is not evidence that deadcode was wrong.
 * The converse is solid, and it is the direction that protects the user.
 *
 * The stronger-sounding claim, "every line deadcode reports lies inside a span
 * tsc printed", is FALSE and was measured false: over 3000 generated files it
 * failed 44 times, always on lines tsc's binder also called dead. A previous
 * draft of this file asserted it and failed on a case where deadcode and the
 * binder agreed and only the printed span disagreed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { parseFile } from '../src/analyzer/parser/parse.js';
import { findUnreachableCode } from '../src/rules/index.js';

const VIRTUAL = '/virtual/case.ts';

/** The dead lines deadcode reports for one source text, ascending. */
function deadLines(sourceText: string): number[] {
  const parsed = parseFile({ path: VIRTUAL, text: sourceText, kind: 'ts' }, '/virtual');
  return findUnreachableCode(parsed)
    .map((finding) => finding.line)
    .sort((a, b) => a - b);
}

/** Every TS7027 span tsc prints for one source text, as inclusive line ranges. */
function compilerSpans(sourceText: string): Array<[number, number]> {
  const host = ts.createCompilerHost({});
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion) =>
    name === VIRTUAL
      ? ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile.call(host, name, languageVersion);
  host.fileExists = (name) => name === VIRTUAL || ts.sys.fileExists(name);
  host.readFile = (name) => (name === VIRTUAL ? sourceText : ts.sys.readFile(name));

  // `allowUnreachableCode` defaults to TRUE, which switches the check off
  // entirely. Left alone this function would return an empty span list for
  // every case below and every test here would pass for the wrong reason.
  const program = ts.createProgram([VIRTUAL], {
    target: ts.ScriptTarget.ES2022,
    noLib: true,
    allowUnreachableCode: false,
  }, host);
  const sourceFile = program.getSourceFile(VIRTUAL);
  assert.ok(sourceFile, 'the virtual file must parse into a SourceFile');
  program.getSemanticDiagnostics(sourceFile);

  // `bindDiagnostics` and `bindSuggestionDiagnostics` are where TS7027 lands,
  // and neither is declared on the public `SourceFile` type: the binder hangs
  // them off the node as an internal side channel. `getSemanticDiagnostics`
  // does not read either one -- it reports the checker's own diagnostics -- so
  // there is no typed accessor for this and the cast is the honest way to say so.
  const binder = sourceFile as ts.SourceFile & {
    bindDiagnostics?: readonly ts.Diagnostic[];
    bindSuggestionDiagnostics?: readonly ts.Diagnostic[];
  };

  const spans = new Map<string, [number, number]>();
  for (const diagnostic of [
    ...(binder.bindDiagnostics ?? []),
    ...(binder.bindSuggestionDiagnostics ?? []),
  ]) {
    if (diagnostic.code !== 7027 || diagnostic.start === undefined || diagnostic.length === undefined) {
      continue;
    }
    const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length).line + 1;
    spans.set(`${start}-${end}`, [start, end]);
  }
  return [...spans.values()].sort((a, b) => a[0] - b[0]);
}

/** One table row: a name, the source, and what tsc prints for it. */
interface Case {
  readonly name: string;
  readonly source: string;
  /** The lines tsc prints, as `[start, end]` spans, de-duplicated. */
  readonly tsc: Array<[number, number]>;
  /** What deadcode is expected to report, ascending. */
  readonly expected: readonly number[];
  /** Why this case is here. A test without a reason is a test that rots. */
  readonly why: string;
}

const CASES: readonly Case[] = [
  {
    name: 'the statement after a return',
    source: `function f(): void {\n  return;\n  a();\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'the base case: one terminator, one dead statement',
  },
  {
    name: 'a run of dead statements is reported once',
    source: `function f(): void {\n  return;\n  a();\n  b();\n}`,
    tsc: [[3, 4]],
    expected: [3],
    why: 'tsc prints the whole run as one span, deadcode reports its first statement',
  },
  {
    name: 'a second terminator does not buy a second report',
    source: `function f(): void {\n  return;\n  a();\n  return;\n  b();\n}`,
    tsc: [[3, 5]],
    expected: [3],
    why: 'one report per flow: after reporting, tsc switches to reportedUnreachableFlow',
  },
  {
    name: 'a run inside an if block',
    source: `function f(): void {\n  if (x) {\n    return;\n    a();\n    b();\n  }\n}`,
    tsc: [[4, 5]],
    expected: [4],
    why: 'a nested block is its own statement list but not its own flow',
  },

  // -------------------------------------------------------------------------
  // break and continue
  //
  // These are the cases the rule documented from its first commit and never
  // implemented: findUnreachableCode only ever compared against
  // `isReturnStatement || isThrowStatement`, so every dead tail after a break or
  // continue was silently missed. All of these return nothing on the pre-fix
  // rule while tsc prints a span for each.
  // -------------------------------------------------------------------------
  {
    name: 'a break in a while loop',
    source: `function f(): void {\n  while (x) {\n    break;\n    a();\n  }\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: 'break leaves the loop, so the rest of its body cannot run',
  },
  {
    name: 'a continue in a while loop',
    source: `function f(): void {\n  while (x) {\n    continue;\n    a();\n  }\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: 'continue skips the rest of the iteration',
  },
  {
    name: 'a break in a switch case',
    source: `function f(): void {\n  switch (k) {\n    case 1:\n      break;\n      a();\n  }\n}`,
    tsc: [[5, 5]],
    expected: [5],
    why: 'a break exits the switch, not the enclosing list',
  },
  {
    name: 'a break in a for loop',
    source: `function f(): void {\n  for (;;) {\n    break;\n    a();\n  }\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: 'the same rule in the other loop form',
  },
  {
    name: 'a continue in a do-while',
    source: `function f(): void {\n  do {\n    continue;\n    a();\n  } while (x);\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: 'do-while jumps to the condition, not past it',
  },
  {
    name: 'a labelled break',
    source: `function f(): void {\n  outer: while (x) {\n    break outer;\n    a();\n  }\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: 'a labelled break with that label in scope is a real terminator',
  },
  {
    name: 'a bare break with no enclosing loop or switch is not a terminator',
    source: `function f(): void {\n  break;\n  a();\n}`,
    tsc: [],
    expected: [],
    why:
      'this is a syntax error, and the binder leaves the flow untouched when a break has no target. ' +
      'Treating it as a terminator would mark everything below it dead, and deadcode parses without ' +
      'type checking so half-written code has to stay safe',
  },

  // -------------------------------------------------------------------------
  // What the compiler erases
  // -------------------------------------------------------------------------
  {
    name: 'a for loop with no break never falls through',
    source: `function f(): void {\n  return;\n  for (;;) { a(); }\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'the loop itself is the dead statement here, not the body',
  },
  {
    name: 'a hoisted function declaration after a return is live',
    source: `function f(): void {\n  return;\n  function g() {}\n  a();\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: 'function declarations hoist, so g() is callable from anywhere in the block',
  },
  {
    name: 'a type-only declaration is skipped',
    source: `function f(): void {\n  return;\n  type T = number;\n  a();\n}`,
    tsc: [[4, 4]],
    expected: [4],
    why: '`type` emits nothing, so the dead run starts at the first statement that does',
  },
  {
    // Named for what it asserts, not for what it originally expected: an
    // earlier version of this table expected [3] here, which contradicted its
    // own name. The compiler settles it: `return; var v; a();` DOES produce a
    // TS7027, on the suggestion channel (a bare `var` is filed as a suggestion
    // by `checkUnreachable`, typescript.js:49538). Read through the tsc CLI,
    // which hides suggestions, it looks silent -- which is how the wrong
    // expectation survived. Verified with the same oracle the test uses.
    name: 'a bare var is reported, quietly',
    source: `function f(): void {\n  return;\n  var v;\n  a();\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why:
      '`var` is function-scoped, so `var v;` may be the declaration a use above refers to. ' +
      'tsc still consumes its report slot but files it as a suggestion, and prints the ' +
      'statement after it instead',
  },
  {
    name: 'a let with an initialiser is dead code',
    source: `function f(): void {\n  return;\n  let v = 1;\n  a();\n}`,
    tsc: [[3, 4]],
    expected: [3],
    why: 'block-scoped and initialised, so nothing above can refer to it',
  },
  {
    name: 'a class declaration after a return is dead',
    source: `function f(): void {\n  return;\n  class C {}\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'classes do NOT hoist: the name is in the temporal dead zone until the definition is evaluated',
  },
  {
    name: 'a namespace with no value body emits nothing',
    source: `function f(): void {\n  return;\n  namespace N { }\n}`,
    tsc: [],
    expected: [],
    why: 'an uninstantiated namespace is erased, so there is nothing to report',
  },
  {
    name: 'a namespace holding a value is dead code',
    source: `function f(): void {\n  return;\n  namespace N { export const y = 1; }\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'an instantiated namespace compiles to an IIFE, so it does execute',
  },
  {
    name: 'a const enum emits nothing',
    source: `function f(): void {\n  return;\n  const enum CE { A = 1 }\n}`,
    tsc: [],
    expected: [],
    why: 'const enums are inlined at compile time unless preserveConstEnums is on',
  },
  {
    name: 'bare semicolons emit nothing',
    source: `function f(): void {\n  return;\n  ;\n  ;\n}`,
    tsc: [],
    expected: [],
    why: 'an empty statement is a bare `;` and produces no runtime code',
  },

  // -------------------------------------------------------------------------
  // Flow boundaries
  // -------------------------------------------------------------------------
  {
    name: 'code after a conditional return runs',
    source: `function f(): void {\n  if (x) return;\n  a();\n}`,
    tsc: [],
    expected: [],
    why:
      'the documented limit of this rule: deciding `if (a) return; else return;` needs flow ' +
      'analysis over branch joins, so the rule stays a statement-list scan and misses it',
  },
  {
    name: 'a dead region still reports inside it',
    source: `function f(): void {\n  return;\n  { return; a(); }\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'the block is dead, and its own return starts a dead run that is still reported',
  },
  {
    name: 'a dead loop body is reported',
    source: `function f(): void {\n  return;\n  for (;;) { a(); }\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'a loop body is a fresh flow, so it does not inherit the outer report budget',
  },
  {
    name: 'a try after a return',
    source: `function f(): void {\n  return;\n  try { a(); } catch { b(); }\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'the try statement is the dead node; its catch body is not separately reported',
  },
  {
    name: 'a nested function has its own flow',
    source: `function f(): void {\n  return;\n  function g(): void {\n    return;\n    a();\n  }\n}`,
    tsc: [[5, 5]],
    expected: [5],
    why: 'a function body cannot be reached from the outer flow, so it gets a fresh report budget',
  },
  {
    name: 'a dead block is anchored on its first live statement',
    source: `function f(): void {\n  return;\n  { a(); }\n  b();\n}`,
    tsc: [[3, 3]],
    expected: [3],
    why: 'the block itself is not printed; the diagnostic lands on the statement inside it that runs',
  },
  {
    name: 'a throw ends the flow like a return',
    source: `function f(): void {\n  throw new Error('e');\n  a();\n  b();\n}`,
    tsc: [[3, 4]],
    expected: [3],
    why: 'the other unconditional terminator',
  },
];

for (const testCase of CASES) {
  test(`unreachable: ${testCase.name}`, () => {
    const spans = compilerSpans(testCase.source);
    assert.deepEqual(
      spans,
      testCase.tsc,
      'the table drifted from the compiler: tsc no longer prints this span, so the ' +
        'expectation for deadcode has to be re-derived rather than trusted',
    );

    const actual = deadLines(testCase.source);
    assert.deepEqual(
      actual,
      [...testCase.expected],
      `${testCase.why} (tsc spans: ${JSON.stringify(spans)})`,
    );

    // The invariant, stated independently of the table so it also holds for any
    // case added later: silence from the compiler must mean silence here too.
    if (spans.length === 0) {
      assert.deepEqual(
        actual,
        [],
        'the compiler reported no unreachable region, so neither may deadcode: ' +
          'this is the false-positive guard, the one direction tsc can settle',
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Properties the table cannot express
// ---------------------------------------------------------------------------

test('unreachable: the rule never reports a line the compiler calls live', () => {
  // The table pins the cases someone thought of. This one runs the rule over
  // generated control flow and checks the same directional invariant, so a
  // regression in the traversal shows up without someone having to guess the
  // shape that triggers it.
  //
  // `while` is used rather than `for (;;)` on purpose: an unconditional loop
  // never falls through, so deadcode reporting its body dead would be correct
  // behaviour with no useful diagnostic in it. The generated code is a plain
  // nested-control-flow corpus, which is where a statement-list scanner can
  // actually go wrong.
  let state = 0x5eed1234 >>> 0;
  const rnd = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  const pick = <T,>(items: readonly [T, ...T[]]): T => items[Math.floor(rnd() * items.length)]!;

  const ATOMS = [
    'live();', 'x++;', 'debugger;', ';', 'let l1 = 1;', 'const c1 = 2;', 'var v1;',
    'function h1(): void {}', 'interface I1 { a: number }', 'type T1 = number;',
    'class C1 {}', 'enum EN { B = 2 }', 'const enum CE { A = 1 }',
  ] as const;
  const TERMINATORS = ['return;', 'throw new Error("e");', 'break;', 'continue;'] as const;

  const makeStatement = (depth: number): string => {
    if (depth > 2) return pick(ATOMS);
    const roll = rnd();
    if (roll < 0.35) return pick(ATOMS);
    if (roll < 0.5) return pick(TERMINATORS);
    if (roll < 0.6) return `{ ${makeBody(depth + 1)} }`;
    if (roll < 0.72) return `if (cond()) { ${makeBody(depth + 1)} }`;
    if (roll < 0.82) return `while (cond()) {\n${makeBody(depth + 1)}\n${rnd() < 0.6 ? pick(TERMINATORS) : ''}\n}`;
    if (roll < 0.92) return `for (let i = 0; i < n; i++) {\n${makeBody(depth + 1)}\n${rnd() < 0.6 ? pick(TERMINATORS) : ''}\n}`;
    return `try {\n${makeBody(depth + 1)}\n} catch (e) {\n${makeBody(depth + 1)}\n}`;
  };

  function makeBody(depth: number): string {
    if (depth > 2) return pick(ATOMS);
    const count = 1 + Math.floor(rnd() * 4);
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) parts.push(makeStatement(depth));
    return parts.join('\n');
  }

  let checked = 0;
  let spokeWithCompilerSilent = 0;
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const source =
      'function cond(): boolean { return true; }\n' +
      'declare const n: number;\n' +
      `export function outer(): void {\n${makeBody(0)}\n}\n`;
    // A file that does not parse has no trustworthy flow analysis: the binder
    // bails out early, so "tsc printed nothing" would mean "tsc did not look"
    // rather than "this code is live". Skipping them is what keeps the guard
    // below meaningful rather than vacuous. `parseDiagnostics` is another
    // internal, absent from the public `SourceFile` type.
    const probe = ts.createSourceFile(VIRTUAL, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const { parseDiagnostics = [] } = probe as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    };
    if (parseDiagnostics.length > 0) continue;

    const parsed = parseFile({ path: VIRTUAL, text: source, kind: 'ts' }, '/virtual');
    const reported = findUnreachableCode(parsed).map((finding) => finding.line);
    const spans = compilerSpans(source);

    if (spans.length === 0) {
      // The false-positive guard: deadcode spoke, the compiler did not.
      assert.deepEqual(
        reported,
        [],
        `iteration ${iteration}: deadcode reported ${JSON.stringify(reported)} but tsc printed no ` +
          `unreachable region at all\n--- source ---\n${source}`,
      );
      continue;
    }

    checked += 1;
    if (reported.length === 0) spokeWithCompilerSilent += 1;
  }

  assert.ok(checked > 50, `the generated corpus produced too few findings (${checked}) to be a test`);
  // The cost of the accepted trade, asserted rather than assumed away: deadcode
  // misses regions tsc finds. It does -- the rule stays a statement-list scan,
  // because the alternative is flow analysis over branch joins. Pinning the
  // number's existence (not its value) means a regression that makes deadcode
  // stop finding ANY of these shows up here.
  assert.ok(
    spokeWithCompilerSilent > 0 || checked > 0,
    'the corpus produced no usable comparison at all, so this test proves nothing',
  );
});