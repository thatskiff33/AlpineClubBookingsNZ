import ts from "typescript";
import { ADVISORY_LOCK_CALL } from "./advisory-lock-source";

type Source = { file: string; text: string };

/**
 * Infer lock helpers from their bodies instead of maintaining another list.
 * Names are deliberately conservative: duplicate function names share their
 * lock effect. Named import aliases are normalised before following calls.
 * This is a source census, not runtime dispatch analysis: computed property
 * calls and functions supplied dynamically are outside its proof.
 */
export function incompatibleLockTransactions(sources: readonly Source[]): string[] {
  const functions = new Map<string, Set<string>>();
  const directLocks = new Set<string>();
  const transactions: Array<{ site: string; calls: Set<string>; rawLock: boolean }> = [];
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
    const effects = (root: ts.Node) => {
      const calls = new Set<string>();
      let rawLock = false;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = callName(node.expression);
          if (name) calls.add(name);
        }
        // Only SQL supplied to a raw query counts; prose and comments do not.
        if ((ts.isTaggedTemplateExpression(node) || ts.isCallExpression(node)) &&
            /\$((execute|query)Raw)(Unsafe)?$/.test(callName(ts.isTaggedTemplateExpression(node) ? node.tag : node.expression) ?? "")) {
          rawLock ||= [...node.getText(source).matchAll(ADVISORY_LOCK_CALL)].length > 0;
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
      return { calls, rawLock };
    };
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text
          : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
        if (name && node.body) {
          const effect = effects(node.body);
          const calls = functions.get(name) ?? new Set<string>();
          effect.calls.forEach(call => calls.add(call));
          functions.set(name, calls);
          if (effect.rawLock) directLocks.add(name);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "$transaction") {
        const [callback, options] = node.arguments;
        if (callback && options && ts.isObjectLiteralExpression(options)) {
          const isolation = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source).replace(/["']/g, "") === "isolationLevel");
          if (isolation && ts.isPropertyAssignment(isolation)) {
            const value = isolation.initializer;
            const level = ts.isStringLiteral(value) ? value.text : ts.isPropertyAccessExpression(value) ? value.name.text : "";
            if (["Serializable", "RepeatableRead"].includes(level)) {
              const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
              const effect = effects(callback);
              if (ts.isIdentifier(callback)) effect.calls.add(aliases.get(callback.text) ?? callback.text);
              transactions.push({ site: `${file}:${line + 1}`, ...effect });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Fixed point includes wrappers of wrappers, including the anonymise helper.
  for (;;) {
    const size = directLocks.size;
    for (const [name, calls] of functions) if ([...calls].some(call => directLocks.has(call))) directLocks.add(name);
    if (directLocks.size === size) break;
  }
  return transactions.filter(tx => tx.rawLock || [...tx.calls].some(call => directLocks.has(call))).map(tx => tx.site);
}
