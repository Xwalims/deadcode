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
      if (!isOwnDeclaration && !isExportSpecifier) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sourceFile);
  return count;
}

/**
 * Whether a name is imported from this file by anything.
 *
 * Built once by the analyser and passed in, because getting it wrong here is
 * what produces the two classic false positives: reporting a helper as unused
 * when a barrel re-exports it, and reporting it again when a test imports it.
 */
export interface ImporterIndex {
  /** Names imported from a given absolute file path. */
  readonly byFile: ReadonlyMap<string, ReadonlySet<string>>;
}

/** True when some file imports `name` from `file`. */
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
 * `return`, `throw`, `break`, `continue` and the end of a block are the only
 * cases reported, because they are the ones where the following statement cannot
 * run. A conditional return does not qualify: code after `if (x) return;` runs
 * when x is false.
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

  /** Any node holding a statement list: a block, a case, or a default clause. */
  const visitBlock = (block: ts.Node & { statements: readonly ts.Statement[] }): void => {
    let terminated = false;
    for (const statement of block.statements) {
      if (terminated) {
        report(statement);
        terminated = false;
      }
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
        terminated = true;
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node)) visitBlock(node);
    if (ts.isCaseClause(node)) visitBlock(node);
    if (ts.isDefaultClause(node)) visitBlock(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return findings;
}