import ts from "typescript";

/**
 * Every place a source file creates a `ManualRefundTask` row (#5185), for the task-creation-site census. A text
 * pattern is easy to step around, so this is syntactic: a create, createMany or upsert called on the delegate
 * reached by `.manualRefundTask`, `["manualRefundTask"]`, a string constant naming it, an alias
 * (`const tasks = tx.manualRefundTask`) or a destructured binding; a nested relation write
 * (`manualRefundTasks: { create }`) under a booking or payment write; and raw SQL inserting into its table. A name
 * built at runtime from pieces is outside what any static scan can see.
 */
export interface TaskCreationSite {
  /** `file|function|method`; the census keys each by its count in the function too. */
  key: string;
  /** The enclosing function, for the check that it posts what its class says. */
  enclosing: ts.Node | null;
}

const DELEGATE = "manualRefundTask";
const CREATES = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
const RELATION = "manualRefundTasks";
const RAW_INSERT = /\bINSERT\s+INTO\s+(?:public\.)?"?ManualRefundTask"?/gi;

function enclosingFunction(node: ts.Node): { name: string; node: ts.Node | null } {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return { name: p.name.getText(), node: p };
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
      return { name: p.parent.name.text, node: p };
    }
  }
  return { name: "top-level", node: null };
}

export function manualRefundTaskCreationSites(file: string, text: string): TaskCreationSite[] {
  const sites: TaskCreationSite[] = [...text.matchAll(RAW_INSERT)].map(() => ({ key: `${file}|raw-sql|insert`, enclosing: null }));
  if (!text.includes(DELEGATE) && !text.includes(RELATION)) return sites;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const strings = new Map<string, string>();
  const aliases = new Set<string>();
  const nameOf = (node: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteralLike(argument)) return argument.text;
      if (ts.isIdentifier(argument)) return strings.get(argument.text);
    }
    return undefined;
  };
  const isDelegate = (node: ts.Expression) => nameOf(node) === DELEGATE || (ts.isIdentifier(node) && aliases.has(node.text));
  const gather = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && ts.isStringLiteralLike(node.initializer)) strings.set(node.name.text, node.initializer.text);
      if (ts.isIdentifier(node.name) && isDelegate(node.initializer)) aliases.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const binding of node.name.elements) {
          if ((binding.propertyName ?? binding.name).getText(source) === DELEGATE && ts.isIdentifier(binding.name)) aliases.add(binding.name.text);
        }
      }
    }
    ts.forEachChild(node, gather);
  };
  gather(source);
  const add = (node: ts.Node, method: string) => {
    const enclosing = enclosingFunction(node);
    sites.push({ key: `${file}|${enclosing.name}|${method}`, enclosing: enclosing.node });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const method = nameOf(node.expression);
      if (method && CREATES.has(method) && isDelegate(node.expression.expression)) add(node, method);
    }
    // `manualRefundTasks: { create: ... }` inside another model's write.
    if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") === RELATION && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        const key = property.name?.getText(source).replace(/["']/g, "");
        if (key && CREATES.has(key)) add(node, `nested-${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** The function or method named `name` in a source file, as `enclosingFunction` names one; null when there is none. */
export function namedFunction(file: string, text: string, name: string): ts.Node | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(source) === name) found = node;
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found = node.initializer;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether the function calls `callee` by name, anywhere in its body. */
export function functionCalls(fn: ts.Node, callee: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) found = true;
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}
