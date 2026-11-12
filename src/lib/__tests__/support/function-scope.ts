/**
 * The function-boundary walk the source censuses share (#4928): which function
 * a node runs in, and how often that function's own body makes a call. A census
 * that pairs an action with its required side effect pairs them per site and in
 * the same function, never per file.
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
 * How many times `scope` itself calls `name(...)`, by name. A call inside a
 * nested function does not count: that closure runs whenever it is called, if ever.
 */
export function callsInOwnBody(scope: ts.Node, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return count;
}
