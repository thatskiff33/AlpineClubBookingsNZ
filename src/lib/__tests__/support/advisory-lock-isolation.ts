import ts from "typescript";
import { ADVISORY_LOCK_CALL, maskedSource } from "./advisory-lock-source";

type Source = { file: string; text: string };

/**
 * Infer lock helpers from their bodies instead of maintaining another list.
 * Names are deliberately conservative: duplicate function names share their
 * lock effect. Named import aliases are normalised before following calls.
 * This is a source census, not runtime dispatch analysis: computed property
 * calls, functions supplied dynamically and mutable/imported options are outside
 * its proof. Immutable local bindings are resolved in their lexical scope.
 */
export function incompatibleLockTransactions(sources: readonly Source[]): string[] {
  const functions = new Map<string, Set<string>>();
  const directLocks = new Set<string>();
  const transactions: Array<{ site: string; calls: Set<string>; rawLock: boolean }> = [];
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const masked = maskedSource(text);
    const bindings = new Map<ts.Node, Map<string, ts.Expression | undefined>>();
    const scopeOf = (node: ts.Node): ts.Node => {
      for (let scope = node.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isFunctionLike(scope)) return scope;
      }
      return source;
    };
    const collectBindings = (node: ts.Node) => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
        const scope = scopeOf(node);
        const locals = bindings.get(scope) ?? new Map<string, ts.Expression | undefined>();
        const immutable = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) &&
          (node.parent.flags & ts.NodeFlags.Const);
        locals.set(node.name.text, immutable ? node.initializer : undefined);
        bindings.set(scope, locals);
      }
      ts.forEachChild(node, collectBindings);
    };
    // Bindings only feed option resolution, so skip the walk where no option can be set.
    if (text.includes("isolationLevel")) collectBindings(source);
    const resolve = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Expression => {
      if (seen.has(expression)) return expression;
      seen.add(expression);
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
        return resolve(expression.expression, seen);
      }
      if (ts.isIdentifier(expression)) {
        for (let scope: ts.Node | undefined = expression.parent; scope; scope = scope.parent) {
          const locals = bindings.get(scope);
          if (locals?.has(expression.text)) {
            const initializer = locals.get(expression.text);
            return initializer ? resolve(initializer, seen) : expression;
          }
        }
      }
      return expression;
    };
    const aliases = new Map<string, string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
      }
    }
    const callName = (node: ts.Expression): string | undefined => {
      const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
      return name && (aliases.get(name) ?? name);
    };
    // One walk per file. Each call is credited to every enclosing collector
    // (named function bodies and snapshot transaction callbacks), so nested
    // closures still count toward their outer function without re-walking it.
    // Re-walking each body and re-scanning its masked slice was quadratic in
    // nesting and timed this census out across all of src.
    // Same SQL restoration as the inventory, including separately bound SQL.
    const lockOffsets = [...masked.matchAll(ADVISORY_LOCK_CALL)].map(match => match.index);
    const rawLockWithin = (root: ts.Node): boolean => {
      const start = root.getStart(source);
      let low = 0;
      let high = lockOffsets.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (lockOffsets[mid] < start) low = mid + 1;
        else high = mid;
      }
      return low < lockOffsets.length && lockOffsets[low] < root.end;
    };
    const visit = (node: ts.Node, collectors: ReadonlyArray<Set<string>>) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (name) for (const calls of collectors) calls.add(name);
      }
      // At most two children (a function body, a transaction callback) get extra collectors.
      let extended: Array<[ts.Node, ReadonlyArray<Set<string>>]> | undefined;
      const collectorsFor = (child: ts.Node) => extended?.find(([node]) => node === child)?.[1];
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text
          : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
        if (name && node.body) {
          const calls = functions.get(name) ?? new Set<string>();
          functions.set(name, calls);
          if (rawLockWithin(node.body)) directLocks.add(name);
          (extended ??= []).push([node.body, [...collectors, calls]]);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "$transaction") {
        const [callback, optionsArgument] = node.arguments;
        const options = optionsArgument && resolve(optionsArgument);
        if (callback && options && ts.isObjectLiteralExpression(options)) {
          const isolation = options.properties.find(property =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            property.name.getText(source).replace(/["']/g, "") === "isolationLevel");
          if (isolation && (ts.isPropertyAssignment(isolation) || ts.isShorthandPropertyAssignment(isolation))) {
            const value = resolve(ts.isPropertyAssignment(isolation) ? isolation.initializer : isolation.name);
            const level = ts.isStringLiteral(value) ? value.text : ts.isPropertyAccessExpression(value) ? value.name.text : "";
            if (["Serializable", "RepeatableRead"].includes(level)) {
              const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
              const calls = new Set<string>();
              if (ts.isIdentifier(callback)) calls.add(aliases.get(callback.text) ?? callback.text);
              transactions.push({ site: `${file}:${line + 1}`, calls, rawLock: rawLockWithin(callback) });
              (extended ??= []).push([callback, [...(collectorsFor(callback) ?? collectors), calls]]);
            }
          }
        }
      }
      if (!extended) ts.forEachChild(node, child => visit(child, collectors));
      else ts.forEachChild(node, child => visit(child, collectorsFor(child) ?? collectors));
    };
    visit(source, []);
  }
  // Fixed point includes wrappers of wrappers, including the anonymise helper.
  for (;;) {
    const size = directLocks.size;
    for (const [name, calls] of functions) if ([...calls].some(call => directLocks.has(call))) directLocks.add(name);
    if (directLocks.size === size) break;
  }
  return transactions.filter(tx => tx.rawLock || [...tx.calls].some(call => directLocks.has(call))).map(tx => tx.site);
}
