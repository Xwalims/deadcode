/**
 * The ground truth for unreachable code: TypeScript's own TS7027 check.
 *
 * deadcode already depends on `typescript`, so the compiler that decides this
 * question is in node_modules. Everything here exists to read TS7027 out of it
 * reliably, and both halves of that needed care:
 *
 * 1. `allowUnreachableCode` defaults to TRUE. Left alone, the compiler reports
 *    nothing at all and an oracle built on it silently "confirms" everything.
 *    Setting it to false is what makes the check run.
 * 2. When unreachable code is a *suggestion* rather than an error, tsc files it
 *    on `file.bindSuggestionDiagnostics`, which `program.getSemanticDiagnostics`
 *    does not read. Collecting only the error channels returns an empty oracle
 *    even on code with obviously dead statements in it.
 *
 * Both mistakes were made here first and both presented as deadcode
 * disagreeing with the compiler, which is the worst failure mode for an oracle:
 * it inverts who is believed.
 */

import ts from 'typescript';

/** TS7027, "Unreachable code detected". */
export const UNREACHABLE_CODE = 7027;

const VIRTUAL = '/virtual/case.ts';

/**
 * Build a Program over one in-memory file with unreachable-code checking on.
 *
 * @param {string} sourceText
 * @param {string} [fileName]
 */
export function makeProgram(sourceText, fileName = VIRTUAL) {
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile;
  host.getSourceFile = (name, languageVersion) =>
    name === fileName
      ? ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS)
      : original.call(host, name, languageVersion);
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => (name === fileName ? sourceText : ts.sys.readFile(name));

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2022,
    noLib: true,
    allowUnreachableCode: false,
  }, host);

  const sourceFile = program.getSourceFile(fileName);
  return {
    program,
    sourceFile,
    // A file that does not parse gets no trustworthy flow analysis, so callers
    // must treat it as "no oracle" rather than "no unreachable code".
    parses: sourceFile ? (sourceFile.parseDiagnostics ?? []).length === 0 : false,
  };
}

/**
 * Every TS7027 span tsc prints, as inclusive 1-based line ranges.
 *
 * ## This is a lossy view, and callers must not mistake it for the truth
 *
 * Two independent suppressions make it lossy, and both were measured rather
 * than assumed:
 *
 *  - `checkUnreachable` reports **once per flow**: after printing, it swaps the
 *    flow to `reportedUnreachableFlow`, which is still unreachable but no longer
 *    reportable.
 *  - `eachUnreachableRange` prints the run of executable statements **after** the
 *    dead node, so the node that actually ends the flow is frequently not the one
 *    that gets printed, and a `var x;` or an erased declaration in between can
 *    absorb the print slot entirely.
 *
 * On one fuzz corpus the binder called 14 lines dead while tsc printed 2 spans.
 * So "deadcode reported a line tsc did not print" does NOT mean deadcode was
 * wrong, and asserting that here is how an oracle starts lying. What tsc printing
 * *nothing* does settle, unambiguously, is that the code has no unreachable
 * region at all.
 */
export function unreachableSpans(sourceText, fileName = VIRTUAL) {
  const { program, sourceFile } = makeProgram(sourceText, fileName);
  if (!sourceFile) return { spans: [], parses: false };

  program.getSemanticDiagnostics(sourceFile);

  const spans = new Map();
  for (const diagnostic of [
    ...(sourceFile.bindDiagnostics ?? []),
    ...(sourceFile.bindSuggestionDiagnostics ?? []),
  ]) {
    if (diagnostic.code !== UNREACHABLE_CODE) continue;
    if (diagnostic.start === undefined || diagnostic.length === undefined) continue;
    const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length).line + 1;
    spans.set(`${start}-${end}`, [start, end]);
  }
  return { spans: [...spans.values()].sort((a, b) => a[0] - b[0]), parses: true };
}

/**
 * One source text, one answer.
 *
 * @param {string} sourceText
 * @param {string} [fileName]
 * @returns {{spans: Array<[number, number]>, parses: boolean}}
 */
export function oracle(sourceText, fileName = VIRTUAL) {
  return unreachableSpans(sourceText, fileName);
}