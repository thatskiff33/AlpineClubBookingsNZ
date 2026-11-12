/**
 * The function-boundary walk the source censuses share (#4928): which function
 * a node runs in, and what that function's own body calls. A census that pairs
 * an action with its required side effect pairs them here, per site and in the
 * same function, never per file.
 */
import ts from "typescript";

/** The innermost function around `node`: its own scope, or the source file for top-level code. */
export function enclosingFunction(node: ts.Node): ts.Node {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) return at;
  }
  return node.getSourceFile();
}

/**
 * Does `scope` itself call `name(...)`? A call inside a nested function does
 * not count: that closure runs whenever it is called, if ever.
 */
export function callsInOwnBody(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}
