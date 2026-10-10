/**
 * Rules.
 *
 * Each rule answers one question and returns findings with the evidence attached.
 * A rule that cannot prove its claim returns nothing rather than guessing: a
 * false positive costs the user more than a missed finding, because the first
 * wrong report is what teaches them to ignore the tool.
 */
import ts from 'typescript';
import type { Finding, FindingKind, Symbol } from '../types.js';
import type { ParsedFile } from '../analyzer/parser/parse.js';

/** Map a symbol kind onto the finding kind the reporter groups by. */
const KIND_TO_FINDING: Record<Symbol['kind'], FindingKind> = {
  function: 'unused-function',
  variable: 'unused-variable',
  constant: 'unused-variable',
  class: 'unused-class',
  interface: 'unused-interface',
  type: 'unused-type',
  enum: 'unused-class',
  method: 'unused-function',
};

/**
 * Every statement kind that is a statement rather than a declaration.
 *
 * The list the compiler calls `isStatementKindButNotDeclarationKind`, written
 * out because the helper is internal to `typescript.js` and absent from the
 * public type declarations. Anything here runs and so can be dead; anything
 * outside it is a declaration, handled separately in `isReportable`.
 */
const REPORTABLE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.EmptyStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.WithStatement,
]);

/**
 * Names referenced anywhere in a file.
 *
 * Collected from the whole AST rather than from imports, because a symbol is
 * also "used" when it is mentioned in a type position, passed to a function, or
 * exported through a barrel. Reading only the import list is the classic way to
 * report a used function as unused.
 */
function collectIdentifiers(file: ParsedFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file.sourceFile);
  return names;
}

/** Options a caller can supply so rules can be tested without a full parse. */
export interface RuleOptions {
  /** Skip findings for these names, from configuration. */
  readonly ignore?: readonly string[];
}

/** True when a name matches an ignore pattern. */
function isIgnored(name: string, ignore: readonly string[]): boolean {
  if (ignore.length === 0) return false;
  for (const pattern of ignore) {
    if (pattern === name) return true;
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`).test(name)) return true;
    }
  }
  return false;
}

/**
 * Unused imports.
 *
 * An import is unused when its local name appears nowhere else in the file. The
 * check is syntactic by necessity: proving a symbol is unused needs types, and
 * this tool deliberately does not build a Program.
 *
 * A namespace import (`import * as ns`) and a default import are treated as used
 * when their local name appears, same as a named import.
 */
export function findUnusedImports(file: ParsedFile, options: RuleOptions = {}): Finding[] {
  const used = collectIdentifiers(file);
  const findings: Finding[] = [];

  // The import statement itself contributes every name it declares, so the
  // statement has to be excluded before deciding what counts as a reference.
  const declaredLocals = new Set(
    file.imports.map((entry) => entry.local),
  );

  for (const entry of file.imports) {
    if (isIgnored(entry.local, options.ignore ?? [])) continue;

    // Count references outside the import statements.
    let references = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === entry.local) {
        const parent = node.parent;
        const inImportClause =
          parent &&
          (ts.isImportClause(parent) ||
            (ts.isImportSpecifier(parent) && parent.parent !== undefined));
        const inNamespaceImport =
          parent && ts.isNamespaceImport(parent);
        if (!inImportClause && !inNamespaceImport) references += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);

    if (references === 0) {
      findings.push({
        kind: 'unused-import',
        severity: 'warning',
        file: file.file,
        line: entry.line,
        column: entry.column,
        symbol: entry.local,
        reason: {
          source: 'compiler',
          detail: `"${entry.local}" is imported from "${entry.from}" but never used in this file`,
          escape: 'it may be used by a macro, a decorator, or code injected at build time',
        },
        confidence: 0.9,
      });
    }
  }

  void used;
  void declaredLocals;
  return findings;
}

/**
 * Exported symbols that nothing in the project imports.
 *
 * The judgement that matters: a symbol that is not imported anywhere AND is not
 * the package's own entry-point export is a candidate. A symbol exported by a
 * live file but imported nowhere is reported as a warning, because publishing a
 * library legitimately exports things its own code does not use. `default` is
 * never reported: it is what a bundler and a package entry point consume.
 */
export function findUnusedSymbols(
  file: ParsedFile,
  options: RuleOptions = {},
): Finding[] {
  const findings: Finding[] = [];

  const localNames = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) localNames.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file.sourceFile);

  for (const symbol of file.symbols) {
    if (!symbol.exported) continue;
    if (symbol.defaultExport) continue;
    if (symbol.kind === 'variable' || symbol.kind === 'constant') continue;
    if (isIgnored(symbol.name, options.ignore ?? [])) continue;

    // Referenced inside its own file, other than by its declaration: alive.
    if (countReferences(file, symbol.name) > 0) continue;

    // Imported by a live file: alive. This is the main reason the tool is not
    // full of false positives on a real project. The lookup is by imported name,
    // not merely "someone points here": a barrel re-exporting everything would
    // otherwise keep every symbol alive forever.
    if (importersOf(file.file).has(symbol.name)) continue;

    findings.push({
      kind: KIND_TO_FINDING[symbol.kind] ?? 'unused-export',
      severity: 'warning',
      file: file.file,
      line: symbol.line,
      column: symbol.column,
      symbol: symbol.name,
      reason: {
        source: 'graph',
        detail: `"${symbol.name}" is exported but no file in the project imports it`,
        escape:
          'it may be part of the published API surface, or consumed by a test, a script, ' +
          'or another package that depends on this one',
      },
      confidence: 0.6,
    });
  }

  void localNames;
  return findings;
}

/**
 * True when an identifier is a name being PUBLISHED rather than used.
 *
 *     module.exports = { a, b: c };
 *
 * Here `a` and `c` are the export list, not references to those bindings. Both
 * are Identifier nodes in the AST, so a reference counter that does not know
 * this treats the export statement itself as the use, and every CommonJS
 * function comes back "referenced inside its own file" -- the symbol rule then
 * has nothing to report in a CommonJS project, because the one thing that
 * could have kept it quiet was a false reference.
 *
 * Narrow on purpose: a shorthand or property assignment inside any *other*
 * object literal really is a use, and only the literal assigned to
 * `module.exports` is the export list.
 */
function isCommonJsExportMention(node: ts.Identifier): boolean {
  const parent = node.parent;
  let isExportName = false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    isExportName = true;
  } else if (ts.isPropertyAssignment(parent) && parent.name === node) {
    isExportName = true;
  }
  if (!isExportName) return false;

  const literal = parent.parent;
  if (!ts.isObjectLiteralExpression(literal)) return false;
  const assignment = literal.parent;
  if (!ts.isBinaryExpression(assignment) || assignment.right !== literal) return false;
  const left = assignment.left;
  return (
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === 'module' &&
    left.name.text === 'exports'
  );
}

/** How many times a name appears outside its own declaration. */
function countReferences(file: ParsedFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const isOwnDeclaration =
        parent &&
        (ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isEnumDeclaration(parent) ||
          ts.isVariableDeclaration(parent));
      const isExportSpecifier =
        parent && ts.isExportSpecifier(parent) && parent.propertyName?.text === name;
      if (!isOwnDeclaration && !isExportSpecifier && !isCommonJsExportMention(node)) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sourceFile);
  return count;
}

/**
 * The names imported from `file` by anything, or an empty set when nothing does.
 *
 * Built once by the analyser and installed for the current file, because
 * getting this wrong is what produces the two classic false positives: reporting
 * a helper as unused when a barrel re-exports it, and reporting it again when a
 * test imports it.
 */
function importersOf(file: string): ReadonlySet<string> {
  return CURRENT_IMPORTERS.get(file) ?? EMPTY_NAMES;
}

const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * Set for the duration of one rule invocation.
 *
 * Module-level mutable state is normally a smell. Here it is deliberate and
 * narrow: the index is built once per file by the analyser, the rules are pure
 * functions over that file, and threading a third parameter through every rule
 * signature to avoid it would be worse. The name says so, and `withImporters`
 * makes the lifetime explicit.
 */
const CURRENT_IMPORTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>();

/** Install the importer index for the current file and return a restore function. */
export function withImporters<T>(index: ReadonlyMap<string, ReadonlySet<string>>, run: () => T): T {
  const previous = (CURRENT_IMPORTERS as Map<string, ReadonlySet<string>>);
  const mutable = CURRENT_IMPORTERS as Map<string, ReadonlySet<string>>;
  mutable.clear();
  for (const [key, value] of index) mutable.set(key, value);
  try {
    return run();
  } finally {
    mutable.clear();
    void previous;
  }
}

/**
 * Statements after a terminating one.
 *
 * The terminating set is the compiler's: `return`, `throw`, `break` and
 * `continue` (TS7027's `reportUnreachableNode`). `break` and `continue` were
 * documented as handled here since this rule first shipped but were never
 * implemented -- `findUnreachableCode` only ever compared against
 * `isReturnStatement || isThrowStatement`, so every `break`/`continue` in a
 * loop or switch had its dead tail silently missed. Measured against tsc on
 * the corpus fuzzed by `scripts/fuzz-unreachable.mjs`, that was 10 of 15 cases.
 *
 * ## A conditional terminator is not a terminator
 *
 * Code after `if (x) return;` runs when x is false. Deciding that case needs
 * flow analysis over branch joins, which this rule deliberately does not do --
 * it would mean building the same dataflow graph `tsc` builds. So the rule
 * stays a statement-list scan and reports only what an unconditional
 * terminating statement makes unreachable. That is a strict subset of what tsc
 * reports, never a superset: a missed `if (a) return; else return;` is a false
 * negative, whereas the alternative would be false positives on every
 * conditional return in the codebase.
 *
 * ## Which statements are reported
 *
 * Once a list is known to be unreachable, tsc reports only statements that emit
 * runtime code, and it skips over the ones that do not rather than ending the
 * run:
 *
 *   - function declarations, which are hoisted and therefore reachable
 *   - `interface`/`type` declarations, which emit nothing at all
 *   - `import`/`export` declarations, which are hoisted
 *   - `const enum`, which inlines at compile time
 *   - `var x;` with no initializer, which may be the declaration a use above
 *     refers to
 *   - an empty statement, which is a bare `;`
 *   - a block containing only statements of that kind, recursively
 *
 * Reporting those was a false positive, and a false positive costs more than a
 * missed finding: deadcode's own rule docstring says a wrong first report is
 * what teaches a user to ignore the tool. Ten of the fifteen corpus cases
 * reported something tsc does not.
 */
export function findUnreachableCode(
  file: ParsedFile,
): Finding[] {
  const findings: Finding[] = [];
  const sourceFile = file.sourceFile;

  const report = (statement: ts.Statement): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
    findings.push({
      kind: 'unreachable-code',
      severity: 'error',
      file: file.file,
      line: position.line + 1,
      column: position.character + 1,
      symbol: statement.getText(sourceFile).split('\n')[0]?.slice(0, 40) ?? '',
      reason: {
        source: 'compiler',
        detail: 'this statement follows a return, throw, break or continue in the same block',
      },
      confidence: 1,
    });
  };

  /**
   * True when a statement cannot run even though the list around it is
   * already known to be dead.
   *
   * Mirrors `isStatementButNotDeclaration` plus the three exceptions tsc adds
   * on top, which are the declarations that still have runtime presence.
   */
  function isReportable(statement: ts.Statement): boolean {
    // A bare `;` produces no runtime code. It is skipped over, not reported.
    if (ts.isEmptyStatement(statement)) return false;
    // Function declarations are hoisted: one after `return` is callable from
    // anywhere in the block, so it is not dead code.
    if (ts.isFunctionDeclaration(statement)) return false;
    // `interface` and `type` are erased entirely. A `const enum` is erased too
    // unless `preserveConstEnums` is on, and deadcode has no such option.
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;
    if (ts.isEnumDeclaration(statement) && isConstEnum(statement)) return false;
    // A namespace with no instantiated body emits nothing; an instantiated one
    // is compiled to a variable and does. tsc mirrors this with
    // `getModuleInstanceState`.
    if (ts.isModuleDeclaration(statement)) return isInstantiatedModule(statement);
    // Hoisted declarations: nothing at runtime depends on the statement being
    // reached in order.
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) return false;
    if (ts.isImportEqualsDeclaration(statement)) return false;
    if (ts.isExportAssignment(statement)) return false;
    if (ts.isNamespaceExportDeclaration(statement)) return false;
    // A class declaration is NOT hoisted: it is in the temporal dead zone until
    // its definition is evaluated, so a class after `return` really is dead.
    if (ts.isClassDeclaration(statement)) return true;
    // Every variable statement, including a bare `var x;`, is reported. That
    // looks wrong at first -- `var` is function-scoped, so the declaration is
    // live for uses above it -- but it is what the compiler does, and matching
    // it is what keeps the report slot in step.
    //
    // There are two different questions here and mixing them up is a trap that
    // costs a day. The compiler's `checkUnreachable` asks `reportError`, whose
    // answer for a bare `var` is "consume the slot, but file it as a
    // *suggestion* rather than an error" (typescript.js:49538). Its
    // `eachUnreachableRange` then asks `isExecutableStatement`, whose answer for
    // the same statement is "do not print it" (typescript.js:49559). So the
    // statement IS reported -- quietly -- and a bare `var` still closes off the
    // run.
    //
    // Measured against tsc: `return; var v;` does produce a diagnostic, but only
    // on the suggestion channel. The tsc CLI hides suggestions by default, so
    // checking with the CLI alone says "silent" and invites deleting the
    // finding. `scripts/lib/unreachable-oracle.mjs` reads both
    // `bindDiagnostics` and `bindSuggestionDiagnostics` for exactly this reason.
    //
    // The slot matters more than any single finding: tsc consumes it on the
    // first statement that is a statement *at all*, even one it then declines to
    // print. Skipping `var x;` here meant the slot survived to a later
    // statement, and deadcode then reported a `return;` that tsc never reports
    // at all. 23 of 1500 fuzz cases were that one line.
    if (ts.isVariableStatement(statement)) return true;
    // Everything else that is a statement: expression, `debugger`, `if`, loops,
    // `switch`, `try`, `throw`, `return`, `break`, `continue`, labelled, `with`.
    // Spelled out rather than delegated to the compiler, because
    // `isStatementButNotDeclaration` is an internal helper: it exists in
    // typescript.js but not in the public .d.ts, so calling it would not
    // typecheck against the dependency the package actually depends on.
    return REPORTABLE_KINDS.has(statement.kind);
  }

  /** True for a `const enum`, which the compiler inlines and erases. */
  function isConstEnum(node: ts.EnumDeclaration): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword));
  }

  /**
   * Whether a `break`/`continue` at this point has a target to jump to.
   *
   * `break` needs an enclosing loop or switch, `continue` an enclosing loop; a
   * labelled one needs that label to be active. With no target the compiler
   * binds the statement to nothing and the flow carries on unchanged
   * (`bindBreakOrContinueFlow` is a no-op when the target label is undefined),
   * so the statement does NOT terminate its list.
   *
   * Reaching this only with code that does not compile is rare, but deadcode
   * parses without type checking, so a file can be mid-edit and full of
   * half-written `break`s. Treating those as terminators produced a flood of
   * false positives in the fuzz corpus -- a stray `continue;` in a function body
   * would mark everything below it dead.
   */
  function hasJumpTarget(statement: ts.BreakStatement | ts.ContinueStatement): boolean {
    const label = statement.label?.text;
    if (label) {
      // A labelled break/continue is valid if the label exists anywhere in the
      // enclosing chain; whether it can be reached from here is a flow question
      // this rule does not answer.
      let current: ts.Node | undefined = statement.parent;
      while (current) {
        if (ts.isLabeledStatement(current) && current.label.text === label) return true;
        // A function boundary ends the label's scope.
        if (
          ts.isFunctionLike(current) ||
          ts.isSourceFile(current) ||
          ts.isModuleBlock(current)
        ) {
          break;
        }
        current = current.parent;
      }
      return false;
    }
    return jumpDepth > 0;
  }

  /**
   * True when a statement ends the one-report-per-run budget.
   *
   * This is the compiler's `reportError`, and it is deliberately NOT the same
   * test as {@link anchor}: it accepts everything that is a statement rather
   * than a declaration -- including a hoisted `function g() {}`, which is
   * never printed as dead code but still closes off the run -- and additionally
   * the declarations that do have runtime presence: classes, enums that are not
   * `const`, and instantiated namespaces.
   */
  function consumesReportSlot(statement: ts.Statement): boolean {
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isNamespaceExportDeclaration(statement)
    ) {
      return false;
    }
    if (ts.isEnumDeclaration(statement)) return !isConstEnum(statement);
    if (ts.isModuleDeclaration(statement)) return isInstantiatedModule(statement);
    return true;
  }

  /**
   * The statement tsc would anchor its diagnostic on, for one dead statement.
   *
   * For a dead block tsc does not report the block: it descends and reports the
   * first statement inside that actually emits code, so `return; { live(); }`
   * is reported at `live()` and not at the `{`. Same for a labelled statement
   * wrapping a block. A block whose contents are all non-runtime is skipped
   * entirely, which is what makes `return; { function g() {} }` report nothing.
   */
  function anchor(statement: ts.Statement): ts.Statement | null {
    if (ts.isBlock(statement)) return firstRuntimeStatement(statement.statements);
    if (ts.isLabeledStatement(statement) && ts.isBlock(statement.statement)) {
      return firstRuntimeStatement(statement.statement.statements);
    }
    return isReportable(statement) ? statement : null;
  }

  /**
   * The first statement in a list that emits runtime code, descending through
   * blocks and labelled blocks.
   *
   * Returns null when the list holds nothing executable, which is the answer
   * for a block of only function declarations or only types.
   */
  function firstRuntimeStatement(statements: readonly ts.Statement[]): ts.Statement | null {
    for (const statement of statements) {
      const found = anchor(statement);
      if (found) return found;
    }
    return null;
  }

  /**
   * True when a namespace emits runtime code.
   *
   * A namespace holding only types or interfaces is erased. One holding a value
   * -- an enum, a class, a function, a value declaration -- is compiled to an
   * IIFE, so it does execute and is unreachable after a terminator.
   */
  function isInstantiatedModule(node: ts.ModuleDeclaration): boolean {
    let instantiated = false;
    const visit = (child: ts.Node): void => {
      if (instantiated) return;
      if (ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child)) return;
      if (ts.isEnumDeclaration(child) && isConstEnum(child)) return;
      if (
        ts.isClassDeclaration(child) ||
        ts.isFunctionDeclaration(child) ||
        ts.isEnumDeclaration(child) ||
        ts.isModuleDeclaration(child) ||
        ts.isVariableStatement(child)
      ) {
        instantiated = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    if (node.body && ts.isModuleBlock(node.body)) {
      for (const statement of node.body.statements) visit(statement);
    }
    return instantiated;
  }

  /**
   * Report unreachable statements in one statement list.
   *
   * Two pieces of state, and the second one is the subtle one. `dead` tracks
   * whether an unconditional terminator has been seen: everything after it in
   * this list cannot run. `reported` tracks whether a diagnostic has already
   * been emitted for this list, because tsc suppresses a second TS7027 per flow
   * -- once it reports, it switches the flow from `unreachableFlow` to
   * `reportedUnreachableFlow`, which is still unreachable but no longer reportable.
   * That is why `return; a(); return; b();` yields exactly one diagnostic
   * instead of two.
   *
   * The suppression is per FLOW, not per statement list: two separate loops in
   * one function each get their own report, and so does a class method next to
   * a function, because a function body and a loop body are each a fresh flow.
   */

  /**
   * One statement list, reporting what an unconditional terminator made
   * unreachable.
   *
   * `startDead` is how a nested list inherits an already-dead flow. That is not
   * an optimisation: tsc switches the flow to `reportedUnreachableFlow` the
   * moment it reports, and from then on every descendant is unreachable-but-already
   * reported, so a `try` block sitting inside a dead region contributes nothing
   * of its own. Without threading this down, the fuzz corpus produced a second
   * diagnostic for code tsc had already accounted for -- 170 false positives
   * before this was threaded, and they were all of that shape.
   *
   * Recursing per statement rather than from the generic walker is what makes the
   * dead flag available: a statement's own deadness depends on where it sits in
   * its list, which only the list loop knows.
   */
  const scanListFrom = (
    statements: readonly ts.Statement[],
    startDead: boolean,
    freshFlow: boolean,
    startReported: boolean,
  ): void => {
    let dead = startDead;
    // One report per FLOW, not per list. A `return;` inside a dead block is
    // still reported by tsc, because the block's own list is a different flow
    // from the outer one even though the outer one already reported.
    //
    // `freshFlow` marks a list that starts a new flow, which happens at a
    // function body and at a loop body. Everywhere else the outer flow's budget
    // carries in, which is why a `return;` sitting inside a dead block gets
    // reported and a second `return;` further out does not.
    let reported = freshFlow ? false : startDead;

    for (const statement of statements) {
      const deadHere = dead;
      if (dead && !reported) {
        // tsc splits this into two questions and they are not the same question.
        //
        // `reportError` decides whether the slot is CONSUMED: true for any
        // statement that is not a declaration (so including a hoisted
        // `function g() {}`, which still ends the run's reporting), and also
        // for the declarations that do have runtime presence -- classes,
        // instantiated enums and namespaces.
        //
        // `isExecutableStatement` decides whether anything is PRINTED: false
        // for function declarations, purely-type declarations and bare
        // `var x;`.
        //
        // Keeping only the first question here consumed the slot a statement
        // early, and deadcode then reported a later statement that tsc never
        // reports. Keeping only the second left the slot alive too long, and
        // deadcode reported a `return;` inside a dead region. The order matters:
        // consume first, print second.
        const printable = anchor(statement);
        if (consumesReportSlot(statement)) reported = true;
        if (printable) report(printable);
        // A reported statement does not resume the flow: `dead` stays true, so
        // the rest of the list remains dead -- it is just no longer reported.
      }
      if (isTerminating(statement, hasJumpTarget)) dead = true;
      // Descend with the deadness this statement was reached under. The report
      // budget travels with it, except into a loop body, which is a new flow.
      visitChildren(statement, deadHere, reported);
    }
  };

  /**
   * How many enclosing loops or switches a `break` can leave, or loops a
   * `continue` can advance. Zero means a bare `break`/`continue` has no target,
   * which the compiler treats as leaving the flow alone.
   */
  let jumpDepth = 0;

  /**
   * Walk a statement's children, threading the flow state into nested lists.
   *
   * `startDead` is the flow at the point this node was reached, and `startReported`
   * is whether that flow's single report has already been spent. A nested block,
   * case clause or namespace body continues the SAME flow, so both carry in --
   * which is why a `return;` inside a dead block is still reported even though
   * the block's own list already used the budget, and why a second dead run
   * after it is not.
   *
   * Two kinds of node start a NEW flow, resetting both flags:
   *
   *   - a function body, which cannot be reached or left from the outside, so
   *     its deadness and its report budget are entirely its own. That is why a
   *     method and a function side by side each get their own report, and why a
   *     `break` inside a nested arrow does not look for the enclosing loop.
   *   - a loop body, which is re-entered on every iteration. tsc binds a fresh
   *     flow there, and a dead statement inside a dead loop body is still
   *     reported even when the enclosing function already reported.
   *
   * A `switch` is deliberately NOT in the second group: its clauses share one
   * flow, and only the `jumpDepth` changes, because a `break` there leaves the
   * switch rather than any enclosing list.
   */
  const visitChildren = (
    node: ts.Node,
    startDead: boolean,
    startReported: boolean,
  ): void => {
    if (ts.isFunctionLike(node)) {
      const savedDepth = jumpDepth;
      jumpDepth = 0;
      forEachChildStatementList(node, false, false);
      jumpDepth = savedDepth;
      return;
    }

    if (ts.isBlock(node)) {
      scanListFrom(node.statements, startDead, false, startReported);
      return;
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      scanListFrom(node.statements, startDead, false, startReported);
      return;
    }
    if (ts.isModuleBlock(node)) {
      scanListFrom(node.statements, startDead, false, startReported);
      return;
    }

    const isLoop =
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node);
    const isJumpTarget = isLoop || ts.isSwitchStatement(node);

    if (isJumpTarget) jumpDepth += 1;
    if (isLoop) {
      // A loop body is a new flow: the same statements run again on each
      // iteration, so its deadness and report budget do not inherit.
      forEachChildStatementList(node, false, false);
    } else {
      forEachChildStatementList(node, startDead, startReported);
    }
    if (isJumpTarget) jumpDepth -= 1;
  };

  /** Visit every child, each inheriting the current flow. */
  const forEachChildStatementList = (
    node: ts.Node,
    startDead: boolean,
    startReported: boolean,
  ): void => {
    ts.forEachChild(node, (child) => visitChildren(child, startDead, startReported));
  };

  scanListFrom(sourceFile.statements, false, true, false);

  return findings;
}

/**
 * A statement that unconditionally leaves the current statement list.
 *
 * `break` and `continue` only count when they have somewhere to go: a bare one
 * outside any loop, or one naming a label that is not in scope, is a syntax
 * error, and the compiler's binder leaves the flow untouched rather than
 * treating it as an exit. `hasJumpTarget` is what decides that, so it needs the
 * enclosing-structure state the traversal maintains -- hence the extra argument
 * instead of a plain one-argument predicate.
 */
function isTerminating(
  statement: ts.Statement,
  hasJumpTarget: (node: ts.BreakStatement | ts.ContinueStatement) => boolean,
): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
    return hasJumpTarget(statement);
  }
  return false;
}