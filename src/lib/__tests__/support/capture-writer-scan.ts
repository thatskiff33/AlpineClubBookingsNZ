import ts from "typescript";

/** Classify every transaction mutation, including dynamic data, so a computed status cannot hide a capture. */
export function captureWriterSites(file: string, text: string): string[] {
  const raw = [...text.matchAll(/\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|COPY)\s+(?:public\.)?"?PaymentTransaction\b/g)].map(() => `${file}|raw-sql|write`);
  if (!/paymentTransaction|upsertPaymentIntentTransaction|recordInternetBankingPaymentTransaction|transactions/.test(text)) return raw;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: string[] = [...raw];
  const literalBindings = new Map<string, string>();
  const literals = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)) literalBindings.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, literals);
  };
  literals(source);
  const property = (node: ts.Expression): string | undefined => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : ts.isElementAccessExpression(node) && ts.isIdentifier(node.argumentExpression) ? literalBindings.get(node.argumentExpression.text) : undefined;
  const name = (node: ts.Node): string => {
    for (let p: ts.Node | undefined = node; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
    }
    return "top-level";
  };
  const delegates = new Set<string>();
  const gather = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && (property(node.initializer) === "paymentTransaction" || ts.isIdentifier(node.initializer) && delegates.has(node.initializer.text))) delegates.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
        if ((binding.propertyName?.getText(source) ?? binding.name.getText(source)) === "paymentTransaction" && ts.isIdentifier(binding.name)) delegates.add(binding.name.text);
      }
    }
    ts.forEachChild(node, gather);
  };
  gather(source);
  const statuses = (node: ts.Node): string => {
    const found = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && n.name.getText(source).replace(/["']/g, "") === "status") {
        found.add(ts.isIdentifier(n.initializer) || ts.isPropertyAccessExpression(n.initializer) || ts.isStringLiteral(n.initializer)
          ? n.initializer.getText(source) : "computed");
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return [...found].sort().join(",") || "dynamic-or-no-status";
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ["upsertPaymentIntentTransaction", "recordInternetBankingPaymentTransaction"].includes(node.expression.text)) {
      sites.push(`${file}|${name(node)}|${node.expression.text}|${statuses(node)}`);
    }
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const method = property(node.expression);
      const receiver = node.expression.expression;
      if (["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].includes(method ?? "")
        && (property(receiver) === "paymentTransaction" || ts.isIdentifier(receiver) && delegates.has(receiver.text))) {
        sites.push(`${file}|${name(node)}|${method}|${statuses(node)}`);
      }
      // Relation writes are an independent route to a capture; force an explicit classification.
      if (["create", "update", "upsert"].includes(method ?? "") && ["payment", "booking"].includes(property(receiver) ?? "")
        && node.arguments.some((a) => /\btransactions\s*:\s*\{\s*(?:create|upsert|update)/.test(a.getText(source)))) {
        sites.push(`${file}|${name(node)}|nested-transactions|${statuses(node)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites.sort();
}
