/**
 * Client calls that must go through `fetchWithRecentAuth` (#4619).
 *
 * A `fetch(` whose URL and method are on `STEP_UP_ROUTES` is a gap, including
 * when the URL is a string constant or is passed into a local helper that
 * then calls `fetch`. The member-export anchor is allowed only in the branch
 * where `OFFICER_SIGN_IN_ENFORCED` is false. `fetchWithRecentAuth` itself is
 * not a caller.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { STEP_UP_ROUTES, adminRouteApiPath } from "@/lib/step-up-routes";

const SKIP_FILE = "src/components/confirm-its-you.tsx";

export type StepUpClientGap = {
  file: string;
  line: number;
  detail: string;
};

type StepUpFetchSite = {
  file: string;
  start: number;
  end: number;
  detail: string;
};

type Scope = {
  file: string;
  source: ts.SourceFile;
  imports: Map<string, { scope: Scope; name: string }>;
};

const routes = STEP_UP_ROUTES.map((route) => ({
  method: route.method,
  re: routePathRegex(adminRouteApiPath(route.file)),
}));

export function findStepUpClientGaps(): StepUpClientGap[] {
  const { gaps } = scanClients();
  return gaps;
}

function scanClients(): { gaps: StepUpClientGap[]; sites: StepUpFetchSite[] } {
  const scopes = loadScopes();
  linkImports(scopes);
  const gaps: StepUpClientGap[] = [];
  const sites: StepUpFetchSite[] = [];
  const forwards: Forward[] = [];

  for (const scope of scopes.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const ident = fetchIdentifier(node.expression);
        if (ident && node.arguments[0]) {
          const resolved = resolveUrls(node.arguments[0], scope, new Set());
          if (resolved.kind === "param") {
            const fn = enclosingFunction(node);
            const name = fn ? functionName(fn) : null;
            if (fn && name) {
              forwards.push({
                scope,
                fn,
                name,
                urlIndex: parameterIndex(fn, resolved.name),
                methods: methodsOfFetch(node, scope),
                ident,
              });
            }
          } else if (resolved.kind === "urls" && matchesListed(resolved.urls, methodsOfFetch(node, scope))) {
            recordFetch(scope, ident, resolved.urls, sites, gaps);
          }
        }
      }
      if (isAnchor(node)) {
        const href = anchorHref(node);
        const resolved = href ? resolveUrls(href, scope, new Set()) : null;
        if (resolved?.kind === "urls" && matchesListed(resolved.urls, ["GET"]) && !inSwitchOffBranch(node)) {
          const line = scope.source.getLineAndCharacterOfPosition(node.getStart(scope.source)).line + 1;
          gaps.push({
            file: scope.file,
            line,
            detail: `link ${resolved.urls.join(" | ")} is not limited to the switch-off branch`,
          });
        }
        if (resolved?.kind === "param" && !inSwitchOffBranch(node)) {
          const fn = enclosingFunction(node);
          const name = fn ? functionName(fn) : null;
          if (name && jsxAttrMatchesListedGet(name, resolved.name, scopes)) {
            const line = scope.source.getLineAndCharacterOfPosition(node.getStart(scope.source)).line + 1;
            gaps.push({
              file: scope.file,
              line,
              detail: `link prop ${resolved.name} is not limited to the switch-off branch`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope.source);
  }

  for (const forward of forwards) {
    if (!forwardedCallMatches(forward, scopes)) continue;
    recordFetch(forward.scope, forward.ident, [forward.name], sites, gaps);
  }

  return { gaps, sites };
}

type Forward = {
  scope: Scope;
  fn: ts.SignatureDeclaration;
  name: string;
  urlIndex: number;
  methods: string[] | null;
  ident: ts.Identifier;
};

function recordFetch(
  scope: Scope,
  ident: ts.Identifier,
  detail: string[],
  sites: StepUpFetchSite[],
  gaps: StepUpClientGap[],
): void {
  const start = ident.getStart(scope.source);
  if (sites.some((site) => site.file === scope.file && site.start === start)) return;
  const line = scope.source.getLineAndCharacterOfPosition(start).line + 1;
  const text = detail.join(" | ");
  sites.push({ file: scope.file, start, end: ident.end, detail: text });
  gaps.push({ file: scope.file, line, detail: text });
}

function forwardedCallMatches(forward: Forward, scopes: Map<string, Scope>): boolean {
  for (const scope of scopes.values()) {
    const calls = callsOf(scope, forward);
    for (const call of calls) {
      const arg = call.arguments[forward.urlIndex];
      if (!arg) continue;
      const resolved = resolveUrls(arg, scope, new Set());
      if (resolved.kind !== "urls") continue;
      const methods = forward.methods ?? methodsFromInit(call.arguments[1], scope);
      if (methods == null) continue;
      if (matchesListed(resolved.urls, methods)) return true;
    }
  }
  return false;
}

function jsxAttrMatchesListedGet(component: string, attr: string, scopes: Map<string, Scope>): boolean {
  for (const scope of scopes.values()) {
    let matched = false;
    const visit = (node: ts.Node) => {
      if (matched) return;
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === component) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.text !== attr || !attribute.initializer) continue;
          const expr = ts.isStringLiteral(attribute.initializer)
            ? attribute.initializer
            : ts.isJsxExpression(attribute.initializer)
              ? attribute.initializer.expression
              : undefined;
          if (!expr) continue;
          const resolved = resolveUrls(expr, scope, new Set());
          if (resolved.kind === "urls" && matchesListed(resolved.urls, ["GET"])) matched = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope.source);
    if (matched) return true;
  }
  return false;
}

function callsOf(scope: Scope, forward: Forward): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calleeNamesFunction(node.expression, forward, scope)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope.source);
  return found;
}

function calleeNamesFunction(expr: ts.Expression, forward: Forward, scope: Scope): boolean {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) {
    if (node.text !== forward.name) return false;
    if (scope === forward.scope) return true;
    const imported = scope.imports.get(node.text);
    return imported?.scope === forward.scope && imported.name === forward.name;
  }
  if (
    scope === forward.scope &&
    (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) &&
    node.name.text === forward.name
  ) {
    return true;
  }
  return false;
}

function matchesListed(urls: string[], methods: string[] | null): boolean {
  return urls.some((url) => {
    const sample = normalizeUrl(url.replaceAll("§", "id"));
    return routes.some((route) => route.re.test(sample) && (methods == null || methods.includes(route.method)));
  });
}

function methodsOfFetch(call: ts.CallExpression, scope: Scope): string[] | null {
  return methodsFromInit(call.arguments[1], scope);
}

function methodsFromInit(init: ts.Expression | undefined, scope: Scope): string[] | null {
  if (!init) return ["GET"];
  const node = unwrap(init);
  if (ts.isIdentifier(node) && (node.text === "undefined" || node.text === "null")) return ["GET"];
  const resolved = resolveUrls(init, scope, new Set());
  if (resolved.kind === "param") return null;
  if (!ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name !== "method") continue;
    return methodValues(property.initializer);
  }
  return ["GET"];
}

function methodValues(expr: ts.Expression): string[] | null {
  const node = unwrap(expr);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text.toUpperCase()];
  if (ts.isConditionalExpression(node)) {
    const yes = methodValues(node.whenTrue);
    const no = methodValues(node.whenFalse);
    if (!yes || !no) return null;
    return [...yes, ...no];
  }
  return null;
}

function resolveUrls(
  expr: ts.Expression,
  scope: Scope,
  stack: Set<string>,
): { kind: "urls"; urls: string[] } | { kind: "param"; name: string } | { kind: "unknown" } {
  const node = unwrap(expr);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "urls", urls: [node.text] };
  if (ts.isTemplateExpression(node)) return { kind: "urls", urls: expandTemplate(node, scope, stack) };
  if (ts.isConditionalExpression(node)) {
    const yes = resolveUrls(node.whenTrue, scope, stack);
    const no = resolveUrls(node.whenFalse, scope, stack);
    if (yes.kind === "urls" && no.kind === "urls") return { kind: "urls", urls: [...yes.urls, ...no.urls] };
    return { kind: "unknown" };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = segmentsOf(node.left, scope, stack);
    const right = segmentsOf(node.right, scope, stack);
    const urls: string[] = [];
    for (const prefix of left) for (const suffix of right) urls.push(prefix + suffix);
    return { kind: "urls", urls };
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee) && callee.text === "buildExportUrl") {
      return { kind: "urls", urls: ["/api/admin/members/export"] };
    }
  }
  if (ts.isIdentifier(node)) return resolveName(node, node.text, scope, stack);
  return { kind: "unknown" };
}

function expandTemplate(node: ts.TemplateExpression, scope: Scope, stack: Set<string>): string[] {
  let acc = [node.head.text];
  for (const span of node.templateSpans) {
    const pieces = segmentsOf(span.expression, scope, stack);
    const next: string[] = [];
    for (const prefix of acc) for (const piece of pieces) next.push(prefix + piece + span.literal.text);
    acc = next;
  }
  return acc;
}

function segmentsOf(expr: ts.Expression, scope: Scope, stack: Set<string>): string[] {
  const resolved = resolveUrls(expr, scope, stack);
  if (resolved.kind === "urls" && resolved.urls.length > 0) return resolved.urls;
  if (ts.isConditionalExpression(unwrap(expr))) {
    const node = unwrap(expr) as ts.ConditionalExpression;
    return [...segmentsOf(node.whenTrue, scope, stack), ...segmentsOf(node.whenFalse, scope, stack)];
  }
  return ["§"];
}

function resolveName(
  use: ts.Node,
  name: string,
  scope: Scope,
  stack: Set<string>,
): { kind: "urls"; urls: string[] } | { kind: "param"; name: string } | { kind: "unknown" } {
  const key = `${scope.file}#${name}#${use.pos}`;
  if (stack.has(key)) return { kind: "unknown" };
  stack.add(key);
  let current: ts.Node | undefined = use.parent;
  while (current) {
    if (ts.isFunctionLike(current)) {
      if (parameterHit(current, name)) {
        stack.delete(key);
        return { kind: "param", name };
      }
    }
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) {
      const decl = findConst(current, name);
      if (decl?.initializer && decl !== use.parent) {
        const resolved = resolveUrls(decl.initializer, scope, stack);
        stack.delete(key);
        return resolved.kind === "param" ? { kind: "unknown" } : resolved;
      }
    }
    current = current.parent;
  }
  const imported = scope.imports.get(name);
  if (imported) {
    const decl = findConst(imported.scope.source, imported.name);
    if (decl?.initializer) {
      const resolved = resolveUrls(decl.initializer, imported.scope, stack);
      stack.delete(key);
      return resolved.kind === "param" ? { kind: "unknown" } : resolved;
    }
  }
  stack.delete(key);
  return { kind: "unknown" };
}

function findConst(block: ts.Node, name: string): ts.VariableDeclaration | null {
  const statements =
    ts.isSourceFile(block) || ts.isBlock(block) || ts.isModuleBlock(block) ? block.statements : [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
    }
  }
  return null;
}

function loadScopes(): Map<string, Scope> {
  const scopes = new Map<string, Scope>();
  for (const file of clientSourceFiles()) {
    const text = readFileSync(file, "utf8");
    scopes.set(file, {
      file,
      source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
      imports: new Map(),
    });
  }
  return scopes;
}

function linkImports(scopes: Map<string, Scope>): void {
  for (const scope of scopes.values()) {
    for (const statement of scope.source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const resolved = resolveImport(scope.file, statement.moduleSpecifier.text);
      const other = resolved ? scopes.get(resolved) : undefined;
      if (!other || !statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) {
        continue;
      }
      for (const element of statement.importClause.namedBindings.elements) {
        scope.imports.set(element.name.text, {
          scope: other,
          name: (element.propertyName ?? element.name).text,
        });
      }
    }
  }
}

function clientSourceFiles(): string[] {
  const found: string[] = [];
  for (const root of ["src/app", "src/components", "src/hooks"]) walkClient(root, found);
  return found;
}

function walkClient(dir: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "api") continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkClient(full, found);
    else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".d.ts") &&
      full !== SKIP_FILE
    ) {
      found.push(full);
    }
  }
}

function resolveImport(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return resolveFile(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return resolveFile(path.posix.normalize(`${path.posix.dirname(from)}/${specifier}`));
  return null;
}

function resolveFile(stem: string): string | null {
  let base = stem;
  if (/\.(mjs|cjs|js)$/.test(base)) base = base.replace(/\.(mjs|cjs|js)$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next suffix
    }
  }
  return null;
}

function fetchIdentifier(expr: ts.Expression): ts.Identifier | null {
  const node = unwrap(expr);
  if (ts.isIdentifier(node) && node.text === "fetch") return node;
  if ((ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) && node.name.text === "fetch") {
    const object = unwrap(node.expression);
    if (ts.isIdentifier(object) && (object.text === "window" || object.text === "globalThis")) return node.name;
  }
  return null;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) && current.body) return current;
    current = current.parent;
  }
  return null;
}

function functionName(fn: ts.SignatureDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if ((ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return null;
}

function parameterHit(fn: ts.SignatureDeclaration, name: string): boolean {
  for (const param of fn.parameters) {
    if (ts.isIdentifier(param.name) && param.name.text === name) return true;
    if (!ts.isObjectBindingPattern(param.name)) continue;
    for (const element of param.name.elements) {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
      if (element.name.text === name) return true;
    }
  }
  return false;
}

function parameterIndex(fn: ts.SignatureDeclaration, name: string): number {
  return fn.parameters.findIndex((param) => ts.isIdentifier(param.name) && param.name.text === name);
}

function isAnchor(node: ts.Node): node is ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const name = node.tagName;
  return ts.isIdentifier(name) && (name.text === "a" || name.text === "Link");
}

function anchorHref(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ts.Expression | null {
  for (const attribute of node.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.text !== "href" || !attribute.initializer) continue;
    if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
    if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) return attribute.initializer.expression;
  }
  return null;
}

function inSwitchOffBranch(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    const parent = current.parent;
    if (ts.isConditionalExpression(parent)) {
      if (contains(parent.whenFalse, node) && isSwitchOn(parent.condition)) return true;
      if (contains(parent.whenTrue, node) && isSwitchOff(parent.condition)) return true;
    }
    if (ts.isIfStatement(parent)) {
      if (parent.elseStatement && contains(parent.elseStatement, node) && isSwitchOn(parent.expression)) return true;
      if (contains(parent.thenStatement, node) && isSwitchOff(parent.expression)) return true;
    }
    current = parent;
  }
  return false;
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end && inner.getSourceFile() === outer.getSourceFile();
}

function isSwitchOn(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  return ts.isIdentifier(node) && node.text === "OFFICER_SIGN_IN_ENFORCED";
}

function isSwitchOff(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return isSwitchOn(node.operand);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return (
      (isSwitchOn(node.left) && node.right.kind === ts.SyntaxKind.FalseKeyword) ||
      (isSwitchOn(node.right) && node.left.kind === ts.SyntaxKind.FalseKeyword)
    );
  }
  return false;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function normalizeUrl(sample: string): string {
  if (sample.startsWith("http://") || sample.startsWith("https://")) {
    try {
      const url = new URL(sample);
      return `${url.pathname}${url.search}`;
    } catch {
      return sample;
    }
  }
  return sample;
}

function routePathRegex(apiPath: string): RegExp {
  const body = apiPath
    .split("/")
    .map((part) => (part.startsWith("[") && part.endsWith("]") ? "[^/?#]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}(?:\\?[^#]*)?$`);
}
