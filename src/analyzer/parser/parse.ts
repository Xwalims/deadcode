/**
 * Parsing via the TypeScript compiler's own API.
 *
 * ## Why not a parser of my own
 *
 * A hand-written parser for JavaScript has to handle template literals nested
 * inside template literals, regex literals that look like division, JSX, type
 * annotations, and every combination. Every such tool eventually mis-parses
 * something, and a mis-parse in a dead-code detector produces a confident
 * finding about code that is actually used.
 *
 * The TypeScript compiler already implements the full grammar, including
 * TypeScript and JSX, and is the same parser `tsc` uses. Using it means the tool
 * agrees with the compiler about what the code means, which is the property that
 * matters. It is also the only realistic way to support TypeScript at all.
 *
 * ## Why not ts-morph or another wrapper
 *
 * They add a layer between the AST and the caller for convenience this tool
 * does not need. The raw compiler API is a little more verbose and completely
 * predictable, and the surface actually used here is small.
 *
 * ## One deliberate limitation
 *
 * The tool reads each file on its own, with no type information. That is why
 * "unused" means "no syntactic reference exists" rather than "the compiler
 * proved nothing uses this". It is enough for reachability, which is what this
 * tool is about, and it is why findings carry a severity instead of claiming
 * certainty.
 */
import ts from 'typescript';
import { relative as pathRelative } from 'node:path';
import type {
  ExportRef,
  ImportRef,
  SourceFile,
  Symbol,
} from '../../types.js';

/** Everything one file declares, imports, and exports. */
export interface ParsedFile {
  readonly file: string;
  readonly path: string;
  /** The parsed AST, so rules can walk references rather than re-parse. */
  readonly sourceFile: ts.SourceFile;
  readonly symbols: readonly Symbol[];
  readonly imports: readonly ImportRef[];
  readonly exports: readonly ExportRef[];
  /** Specifiers this file imports, including ones that failed to resolve. */
  readonly specifiers: readonly { specifier: string; kind: 'static' | 'dynamic' | 'type-only' | 're-export' }[];
  /** Line index, for reporting positions without re-reading the file. */
  readonly lineOf: (position: number) => { line: number; column: number };
}

/** Map an extension to the compiler's script kind. */
function scriptKindOf(file: SourceFile): ts.ScriptKind {
  switch (file.kind) {
    case 'ts':
    case 'd.ts':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    case 'jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.TS;
  }
}

/** A 1-based line/column pair, counted by scanning newlines once. */
function makeLineIndex(text: string): (position: number) => { line: number; column: number } {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (position: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= position) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: position - (starts[low] ?? 0) + 1 };
  };
}

/** The declared name of a node, or null for anonymous or computed forms. */
function nameOf(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    const name = node.name;
    // A `declare`d or ambient name is an Identifier; a dotted one is not a
    // name this tool can report usefully.
    return name && ts.isIdentifier(name) ? name.text : null;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

/** Map a declaration onto the symbol kind the reporter groups by. */
function symbolKindOf(node: ts.Node): Symbol['kind'] | null {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableDeclaration(node)) {
    const parent = node.parent;
    if (parent && ts.isVariableDeclarationList(parent) && parent.flags & ts.NodeFlags.Const) {
      return 'constant';
    }
    return 'variable';
  }
  return null;
}

/**
 * Whether a node carries any form of the `export` modifier.
 *
 * Read off the modifiers rather than the symbol table, because the symbol table
 * needs a Program and this deliberately avoids one.
 */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword ||
      modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

/**
 * Whether a declaration is exported *through* a statement rather than by a
 * modifier: `export { foo }`, `export default foo`, `export const a = 1`, and
 * CommonJS `module.exports = { foo }`.
 */
function isExported(node: ts.Node): boolean {
  if (hasExportModifier(node)) return true;
  if (isCommonJsExported(node)) return true;

  // For a variable, `export` can sit two levels up: the modifier belongs to the
  // VariableStatement (`export const a = 1`), and to the VariableDeclarationList
  // for the multi-declarator form (`export const a = 1, b = 2`). Every level has
  // to be checked defensively: the first version read `parent.parent.kind`
  // unguarded and crashed on the source file's own top-level declarations, where
  // `parent.parent` does not exist.
  let current: ts.Node | undefined = node.parent;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (hasExportModifier(current)) return true;
    if (
      !ts.isVariableDeclarationList(current) &&
      !ts.isVariableStatement(current)
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Whether a declaration is published through `module.exports` in this file.
 *
 * `commonJsExportNames` answers once for the whole file and the result is
 * attached to the source file, so the declaration lookup stays O(1) rather than
 * re-walking every statement for every symbol. `undefined` means the file
 * declares no CommonJS export at all, which is the common case.
 */
function isCommonJsExported(node: ts.Node): boolean {
  const sourceFile = node.getSourceFile();
  const cache = COMMONJS_EXPORTS.get(sourceFile);
  if (cache !== undefined) {
    return cache !== null && cache.has(identifierOf(node));
  }
  const names = commonJsExportNames(sourceFile);
  COMMONJS_EXPORTS.set(sourceFile, names);
  return names !== null && names.has(identifierOf(node));
}

/** The declared name of a declaration node, or '' when it has none. */
function identifierOf(node: ts.Node): string {
  const name = (node as { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? name.text : '';
}

/**
 * Per-file CommonJS export names, computed once.
 *
 * A WeakMap keyed by the source file: the cache dies with the parse, so holding
 * it does not keep an analysed file alive for the lifetime of the process.
 */
const COMMONJS_EXPORTS = new WeakMap<ts.SourceFile, Set<string> | null>();

/**
 * Names published through `module.exports` or `exports`, for the whole file.
 *
 * CommonJS has no `export` keyword: a declaration is public exactly when
 * `module.exports = { a, b }` or `exports.a = ...` names it. Without this, a
 * CommonJS project's symbols were never marked exported, so
 * `findUnusedSymbols` skipped every one of them (`if (!symbol.exported) continue`)
 * and the tool reported dead code in a CommonJS codebase only at file level.
 * That is not a conservative answer, it is a blind spot: the file is reachable,
 * its functions are public API, and the rule had nothing to say about them.
 *
 * Two shapes are recognised, and both are the whole of what real code uses:
 *
 *     module.exports = { a, b };   // one assignment of an object literal
 *     exports.a = a;               // property assignment, possibly repeated
 *
 * `module.exports.a = a` is the third real shape and is covered by the same
 * property walk, since `module.exports` is itself an object.
 *
 * Returns null for anything else, including `module.exports = someCall()`, which
 * exports values this tool cannot see and must not be guessed at.
 */
function commonJsExportNames(sourceFile: ts.SourceFile): Set<string> | null {
  const names = new Set<string>();
  let sawAny = false;

  const propertyNames = (object: ts.ObjectLiteralExpression): string[] => {
    const out: string[] = [];
    for (const property of object.properties) {
      if (ts.isShorthandPropertyAssignment(property)) out.push(property.name.text);
      else if (ts.isPropertyAssignment(property)) {
        const name = property.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) out.push(name.text);
      }
      // A spread, method or accessor in the literal exports values this tool
      // cannot name, so the whole literal is treated as unreadable below.
    }
    return out;
  };

  const visit = (node: ts.Node): void => {
    // exports.a = a;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      const right = node.right;
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        (left.expression.text === 'exports' || isModuleExports(left.expression)) &&
        ts.isIdentifier(left.name)
      ) {
        sawAny = true;
        names.add(left.name.text);
        if (ts.isIdentifier(right)) names.add(right.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(statement.expression.left) &&
      ts.isObjectLiteralExpression(statement.expression.right)
    ) {
      sawAny = true;
      for (const name of propertyNames(statement.expression.right)) names.add(name);
      continue;
    }
    visit(statement);
  }

  return sawAny ? names : null;
}

/** True for a `module.exports` reference. */
function isModuleExports(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  );
}

/** True when a declaration is `export default`. */
function isDefaultExport(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
    );
  }
  return false;
}

/** True when the declaration only exists at compile time. */
function isTypeOnlyDeclaration(node: ts.Node): boolean {
  // There is no `type` modifier on a declaration: `export type { A }` is an
  // export statement, handled separately. What can be checked here is the
  // `declare` modifier, which marks an ambient declaration that exists only for
  // the compiler.
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.typeParameters?.some(
      (typeParameter) => typeParameter.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword),
    )
  ) {
    return true;
  }
  return false;
}

/** A module specifier string, or null when the expression is not one. */
function specifierText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression)) return expression.text;
  // A template literal with no substitutions is still a static specifier.
  if (
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    (ts.isTemplateExpression(expression) && expression.templateSpans.length === 0)
  ) {
    return (expression as ts.NoSubstitutionTemplateLiteral).text;
  }
  return null;
}

/**
 * True when a callee is a bare `require` identifier.
 *
 * `require.resolve(x)` and `require.main` are property accesses, so they are
 * excluded here by construction rather than by a name list that would have to
 * be maintained. A *shadowed* `require` -- a local function parameter called
 * `require` -- is not distinguished: proving it is not the module loader needs
 * a scope analysis this tool deliberately does not build, and the cost of
 * assuming it is one is a false `unused-file` on a real module, which is the
 * worse of the two errors.
 */
function isBareRequire(callee: ts.Expression): boolean {
  return ts.isIdentifier(callee) && callee.text === 'require';
}

/**
 * The names a `require()` result is bound to in the enclosing declaration.
 *
 * Three shapes cover essentially every CommonJS file:
 *
 *     const { a, b } = require('./x');   // destructured names
 *     const x = require('./x');          // whole-module binding
 *     const { a: c } = require('./x');   // renamed
 *
 * The whole-module form is the important one for symbol findings: `require`
 * hands back the module object, so *every* export of the target is reachable
 * through it and none of them may be reported as imported by nobody. A
 * destructured import names exactly one member and only that one, so the two
 * forms have to be distinguished rather than both treated as a single name.
 *
 * `namespace` is true when the binding keeps the whole module object -- a plain
 * identifier binding, or a rest element, which does the same thing for the
 * remaining exports.
 *
 * Returns an empty list when the call is bound to nothing, which is a
 * side-effect require (`require('./side-effect')`): an edge with no names.
 */
function requireBindingNames(call: ts.CallExpression): { names: string[]; namespace: boolean } {
  const parent = call.parent;
  if (!parent || !ts.isVariableDeclaration(parent)) return { names: [], namespace: false };

  if (ts.isIdentifier(parent.name)) {
    return { names: [parent.name.text], namespace: true };
  }

  if (ts.isObjectBindingPattern(parent.name)) {
    const names: string[] = [];
    let namespace = false;
    for (const element of parent.name.elements) {
      if (element.dotDotDotToken) {
        // `const { a, ...rest } = require('./x')` keeps the module namespace in
        // `rest`, so every export survives and nothing here can be narrowed.
        namespace = true;
        continue;
      }
      const name = element.propertyName ?? element.name;
      if (!ts.isIdentifier(name)) continue;
      names.push(name.text);
    }
    return { names, namespace };
  }

  return { names: [], namespace: false };
}

/**
 * Parse one file into declarations, imports, and exports.
 *
 * @param file the file record produced by the scanner
 * @param root the project root, used to report root-relative paths
 */
export function parseFile(file: SourceFile, root: string): ParsedFile {
  const sourceFile = ts.createSourceFile(
    file.path,
    file.text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    /* setParentNodes */ true,
    scriptKindOf(file),
  );

  const lineOf = makeLineIndex(file.text);
  const symbols: Symbol[] = [];
  const imports: ImportRef[] = [];
  const exports: ExportRef[] = [];
  const specifiers: {
    specifier: string;
    kind: 'static' | 'dynamic' | 'type-only' | 're-export';
  }[] = [];

  /** Record one import declaration's bindings. */
  const readImport = (node: ts.ImportDeclaration): void => {
    const clause = node.importClause;
    if (!clause) {
      // A bare `import './styles.css'` has a side effect and no bindings.
      const specifier = specifierText(node.moduleSpecifier);
      if (specifier) {
        specifiers.push({ specifier, kind: clause0Kind(node) });
      }
      return;
    }

    const specifier = specifierText(node.moduleSpecifier);
    if (!specifier) return;
    const typeOnly = Boolean(clause.isTypeOnly);
    const { line, column } = lineOf(clause.getStart(sourceFile));

    if (clause.name) {
      imports.push({
        imported: 'default',
        local: clause.name.text,
        from: specifier,
        file: file.path,
        line,
        column,
        typeOnly,
        dynamic: false,
      });
    }

    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        imports.push({
          imported: '*',
          local: bindings.name.text,
          from: specifier,
          file: file.path,
          line,
          column,
          typeOnly,
          dynamic: false,
        });
      } else {
        for (const element of bindings.elements) {
          imports.push({
            imported: element.propertyName?.text ?? element.name.text,
            local: element.name.text,
            from: specifier,
            file: file.path,
            line,
            column,
            typeOnly: typeOnly || Boolean(element.isTypeOnly),
            dynamic: false,
          });
        }
      }
    }

    specifiers.push({ specifier, kind: typeOnly ? 'type-only' : 'static' });
  };

  /** A side-effect-only import is still an edge, but carries no binding. */
  const clause0Kind = (_node: ts.ImportDeclaration): 'static' => 'static';

  /** Record one export declaration. */
  const readExport = (node: ts.ExportDeclaration): void => {
    const position = lineOf(node.getStart(sourceFile));
    const specifier = node.moduleSpecifier ? specifierText(node.moduleSpecifier) : null;
    const typeOnly = Boolean(node.isTypeOnly);
    const clause = node.exportClause;

    if (specifier) {
      specifiers.push({ specifier, kind: 're-export' });
    }

    if (!clause) {
      // `export * from './x'` or `export * as ns from './x'`
      exports.push({
        exported: '*',
        local: null,
        from: specifier,
        file: file.path,
        line: position.line,
        typeOnly,
      });
      return;
    }

    if (ts.isNamespaceExport(clause)) {
      exports.push({
        exported: clause.name.text,
        local: null,
        from: specifier,
        file: file.path,
        line: position.line,
        typeOnly,
      });
      return;
    }

    for (const element of clause.elements) {
      exports.push({
        exported: element.name.text,
        local: element.propertyName?.text ?? element.name.text,
        from: specifier,
        file: file.path,
        line: position.line,
        typeOnly: typeOnly || Boolean(element.isTypeOnly),
      });
    }
  };

  /** Record `export =` and `import x = require(...)`. */
  const readImportEquals = (node: ts.ImportEqualsDeclaration): void => {
    const reference = node.moduleReference;
    if (!ts.isExternalModuleReference(reference)) return;
    const specifier = specifierText(reference.expression);
    if (!specifier) return;
    const { line, column } = lineOf(node.getStart(sourceFile));
    imports.push({
      imported: '=',
      local: node.name.text,
      from: specifier,
      file: file.path,
      line,
      column,
      typeOnly: node.isTypeOnly,
      dynamic: false,
    });
    specifiers.push({ specifier, kind: node.isTypeOnly ? 'type-only' : 'static' });
  };

  /**
   * Walk for declarations, and for the calls that can load a module at runtime.
   */
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      readImport(node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      readImportEquals(node);
    } else if (ts.isExportDeclaration(node)) {
      readExport(node);
    } else if (ts.isExportAssignment(node)) {
      const position = lineOf(node.getStart(sourceFile));
      exports.push({
        exported: 'default',
        local: ts.isIdentifier(node.expression) ? node.expression.text : null,
        from: null,
        file: file.path,
        line: position.line,
        typeOnly: false,
      });
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node)
    ) {
      // A declaration inside a function is local; the analyser reports unused
      // locals separately and they must not be treated as project symbols.
      if (isTopLevel(node, sourceFile)) {
        const name = nameOf(node);
        const kind = symbolKindOf(node);
        if (name && kind) {
          const position = lineOf(node.getStart(sourceFile));
          symbols.push({
            name,
            kind,
            file: file.path,
            line: position.line,
            column: position.column,
            exported: isExported(node),
            defaultExport: isDefaultExport(node),
            typeOnly: isTypeOnlyDeclaration(node),
          });
        }
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // `import('x')` is a CallExpression whose callee is the `import` keyword,
      // not an Identifier -- there is no ts.isImportCall in the compiler API,
      // which is worth writing down rather than rediscovering.
      const call = ts.isCallExpression(node) ? node : null;
      const callee = call?.expression;

      if (call && callee && callee.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = call.arguments[0] ? specifierText(call.arguments[0]) : null;
        if (specifier) specifiers.push({ specifier, kind: 'dynamic' });
      } else if (call && callee && ts.isPropertyAccessExpression(callee)) {
        // `require('./cli.js').main`
        //
        // The member-access form of the same load. The edge alone was already
        // recorded, but the NAME was not, so a CLI entry exported through
        // `module.exports = { main }` and invoked as `require('./cli.js').main`
        // was reported as "exported but no file in the project imports it" from
        // the one line that does exactly that. Seen in the wild on
        // `bin/cidr.js`: `require('../src/cli.js').main(process.argv.slice(2))`.
        //
        // The shape is three nodes deep and getting the level wrong is easy:
        // the outer CallExpression is `.main(...)`, its callee is the
        // PropertyAccessExpression `.main`, and `callee.expression` is the INNER
        // `require(...)` call -- not the `require` identifier. Reading the
        // identifier one level too high matches nothing at all, which is what
        // the first version did.
        const inner = callee.expression;
        if (
          ts.isCallExpression(inner) &&
          isBareRequire(inner.expression) &&
          ts.isIdentifier(callee.name)
        ) {
          const specifier = inner.arguments[0] ? specifierText(inner.arguments[0]) : null;
          if (specifier) {
            // The specifier is NOT pushed again: `ts.forEachChild` reaches the
            // inner `require(...)` on its own, and the bare-require branch below
            // already records it. Pushing it here as well duplicated every
            // member-accessed require in the specifier list, which doubled the
            // resolved-import count and made one edge look like two.
            const position = lineOf(node.getStart(sourceFile));
            imports.push({
              imported: callee.name.text,
              local: callee.name.text,
              from: specifier,
              file: file.path,
              line: position.line,
              column: position.column,
              typeOnly: false,
              dynamic: false,
            });
          }
        }
      } else if (call && callee) {
        // CommonJS `require('x')`.
        //
        // This used to be read as `require.resolve('x')` and `require.main('x')`
        // only, both of which are rare and neither of which loads the module --
        // they take a *request string*, not a module specifier, so both would
        // point the graph at whatever file happened to be named `resolve` or
        // `main`. Meanwhile the form every CommonJS file actually uses was
        // never recorded at all, so a `require('./thing.js')` built no edge:
        // the importing file and everything under it came back as unused-file.
        // Measured on a four-file CommonJS project where `main.js` requires two
        // live modules: both reported "no import path reaches this file", from
        // an entry point that requires them.
        //
        // A bare `require(...)` call is the load. `require.resolve` and
        // `require.main` are not, so they stay out: they name a resolved PATH
        // and the module id respectively, and treating them as loads would
        // invent an edge to a file that may never be executed.
        if (isBareRequire(callee)) {
          const specifier = call.arguments[0] ? specifierText(call.arguments[0]) : null;
          if (specifier) specifiers.push({ specifier, kind: 'static' });

          // The bound names are recorded too, so a symbol exported by the
          // required module is not reported as imported by nobody. A binding
          // that keeps the whole module object is recorded as `*`, exactly as
          // `import * as ns` is, because it has the same consequence: every
          // export of the target survives.
          const position = lineOf(node.getStart(sourceFile));
          const { names, namespace } = requireBindingNames(call);
          const bound: readonly { imported: string; local: string }[] = namespace
            ? [{ imported: '*', local: names[0] ?? '*' }]
            : names.map((name) => ({ imported: name, local: name }));
          for (const entry of bound) {
            imports.push({
              imported: entry.imported,
              local: entry.local,
              from: specifier ?? '',
              file: file.path,
              line: position.line,
              column: position.column,
              typeOnly: false,
              dynamic: false,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    file: file.path,
    path: pathRelative(root, file.path).split('\\').join('/'),
    sourceFile,
    symbols,
    imports,
    exports,
    specifiers,
    lineOf,
  };
}

/**
 * Whether a node sits at the top level of a file, ignoring a namespace block.
 *
 * A namespace is a container, not a scope that makes a declaration local, so a
 * symbol inside `namespace Foo {}` still counts as a project symbol.
 */
function isTopLevel(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current)
    ) {
      return false;
    }
    if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current)) {
      // `const { a } = x` inside a top-level block is still not a module symbol.
      if (!ts.isVariableDeclarationList(current)) return false;
    }
    current = current.parent;
  }
  return current === sourceFile;
}