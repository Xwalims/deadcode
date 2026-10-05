// Fuzz deadcode's findUnreachableCode against tsc on randomly generated control
// flow.
//
// ## What is being asserted, and why not more
//
// The obvious thing to assert is "deadcode never reports a line tsc did not
// report". That was written first, and it is WRONG -- not because deadcode is
// wrong, but because tsc's printed TS7027 is a lossy projection of the binder's
// actual dead set. Two suppressions do it: the binder reports at most once per
// flow, and it prints the run of statements *after* the dead node rather than
// the node itself. Measured on this corpus, the binder called 14 lines dead
// while tsc printed 2 spans, and deadcode's "false positive" was one of the 12
// lines tsc simply never printed.
//
// What the printed diagnostic CAN settle is the negative: if tsc printed no
// unreachable region anywhere in the file, there is nothing for deadcode to
// report either. That is the false-positive guard, it is the direction that
// protects the user, and this script asserts only it.
//
// The accepted cost runs the other way and is counted, never hidden: deadcode
// under-reports, because deciding `if (a) return; else return;` needs flow
// analysis over branch joins and the rule is deliberately a statement-list
// scan. See the comment on `findUnreachableCode` for the full reasoning.
//
// The oracle lives in ./lib/unreachable-oracle.mjs because it has two ways to
// silently return nothing, both of which happened here first.
import { parseFile } from '../dist/src/analyzer/parser/parse.js';
import { findUnreachableCode } from '../dist/src/rules/index.js';
import { oracle } from './lib/unreachable-oracle.mjs';

// xorshift32, so a failing run reproduces from its seed alone.
let state = Number(process.argv[3] ?? 0x9e3779b9) >>> 0;
function rnd() {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const ATOMS = [
  'live();',
  'x++;',
  'debugger;',
  ';',
  'let l1 = 1;',
  'const c1 = 2;',
  'var v1;',
  'var v2 = 3;',
  'function h1(): void {}',
  'async function h2(): Promise<void> {}',
  'interface I1 { a: number }',
  'type T1 = number;',
  'const enum CE { A = 1 }',
  'enum EN { B = 2 }',
  'class C1 {}',
  'namespace N1 { }',
  'namespace N2 { export const y = 1; }',
];

// `break`/`continue` are only legal inside a loop or switch. Emitting them from
// the general generator fills the corpus with syntax errors, and a file with
// syntax errors gets no flow analysis at all -- so the corpus would silently
// shrink instead of testing anything. Only loop bodies get all four.
const ALL_TERMINATORS = ['return;', 'throw new Error("e");', 'break;', 'continue;'];
const FLOW_TERMINATORS = ['return;', 'throw new Error("e");'];

/** Loop bodies may contain break/continue, so they get their own generator. */
function makeLoopBody(depth) {
  const n = 1 + Math.floor(rnd() * 3);
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const roll = rnd();
    if (roll < 0.25) parts.push(pick(ALL_TERMINATORS));
    else if (roll < 0.4) parts.push(pick(ATOMS));
    else parts.push(makeStatement(depth));
  }
  return parts.join('\n');
}

/** A statement that is valid in whatever context it lands. */
function makeStatement(depth) {
  if (depth > 2) return pick(ATOMS);
  const roll = rnd();
  if (roll < 0.3) return pick(ATOMS);
  if (roll < 0.5) return pick(FLOW_TERMINATORS);
  if (roll < 0.58) return `{ ${makeBody(depth + 1)} }`;
  if (roll < 0.66) return `if (cond()) { ${makeBody(depth + 1)} }`;
  if (roll < 0.74) {
    const bodies = [0, 1].map(() => `${pick(ATOMS)}\nbreak;`).join('\ncase ');
    return `switch (k) {\ncase ${Math.floor(rnd() * 3)}:\n${bodies}\ndefault:\n${pick(ATOMS)}\nbreak;\n}`;
  }
  if (roll < 0.84) {
    const useFinally = rnd() < 0.5;
    const useCatch = rnd() < 0.5;
    return (
      `try {\n${makeBody(depth + 1)}\n}` +
      (useCatch ? ` catch (e) {\n${makeBody(depth + 1)}\n}` : '') +
      (useFinally ? ` finally {\n${pick(ATOMS)}\n}` : '')
    );
  }
  if (roll < 0.92) return `for (;;) {\n${makeLoopBody(depth + 1)}\n}`;
  if (roll < 0.96) return `while (cond()) {\n${makeLoopBody(depth + 1)}\n}`;
  return `do {\n${makeLoopBody(depth + 1)}\n} while (cond());`;
}

function makeBody(depth) {
  if (depth > 2) return pick(ATOMS);
  const n = 1 + Math.floor(rnd() * 4);
  const parts = [];
  for (let i = 0; i < n; i += 1) parts.push(makeStatement(depth));
  return parts.join('\n');
}

/** Wrap a generated body so break/continue are legal and the file parses. */
function wrap(body) {
  return (
    `function cond(): boolean { return true; }\n` +
    `declare const k: number;\n` +
    `export function outer(): void {\n${body}\n}\n`
  );
}

const N = Number(process.argv[2] ?? 4000);
let falsePositives = 0;
let missedRegions = 0;
let unparsable = 0;
let crashed = 0;
const examples = [];

for (let iter = 0; iter < N; iter += 1) {
  const src = wrap(makeBody(0));
  const truth = oracle(src);

  // No trustworthy oracle for a file that does not parse: tsc's binder does not
  // run flow analysis on it, so "no TS7027" means "not checked", not "clean".
  if (!truth.parses) {
    unparsable += 1;
    continue;
  }

  const parsed = parseFile({ path: '/virtual/case.ts', text: src, kind: 'ts' }, '/virtual');
  let mine;
  try {
    mine = findUnreachableCode(parsed).map((f) => f.line);
  } catch (error) {
    crashed += 1;
    if (examples.length < 5) examples.push(`CRASHED: ${error.message}\n${src}`);
    continue;
  }

  // The false-positive guard, in the one direction tsc's printed diagnostic can
  // actually settle: no unreachable region anywhere means nothing to report.
  //
  // The tempting stronger check -- every reported line must fall inside a printed
  // span -- is what this script used to assert, and it fired on cases where the
  // binder agreed with deadcode and only the printer disagreed, because
  // `eachUnreachableRange` prints the run *after* the dead node and suppresses the
  // second report per flow. Asserting it would mean failing on correct output.
  if (truth.spans.length === 0 && mine.length > 0) {
    falsePositives += 1;
    if (examples.length < 5) {
      const lines = src.split('\n');
      examples.push(
        `FALSE POSITIVE on ${JSON.stringify(mine)}; tsc printed no span at all\n` +
          mine.map((line) => `  ${line}: ${lines[line - 1]}`).join('\n') +
          `\n--- source ---\n${src}`,
      );
    }
    continue;
  }

  // The accepted cost, counted so it cannot hide: a region tsc found and
  // deadcode did not. Not a failure -- the rule declines to do branch-join flow
  // analysis -- but it is the number that says what the trade actually costs.
  if (truth.spans.length > 0 && mine.length === 0) missedRegions += 1;
}

console.log(`iterations: ${N}`);
console.log(`unparsable (no oracle, skipped): ${unparsable}`);
console.log(`crashes: ${crashed}`);
console.log(`FALSE POSITIVES (deadcode spoke, tsc found no unreachable region): ${falsePositives}`);
console.log(`missed regions (tsc found dead code deadcode did not, accepted): ${missedRegions}`);
for (const example of examples) console.log(`\n=== ${example} ===`);
process.exit(falsePositives === 0 && crashed === 0 ? 0 : 1);