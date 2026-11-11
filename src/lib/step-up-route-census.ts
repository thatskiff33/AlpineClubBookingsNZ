/**
 * Call-graph census for destructive admin routes (#4619, INV-AUTH-010).
 *
 * A handler reaches an operation when a call from that handler, including
 * through a helper or a callback, resolves to a named export in
 * `STEP_UP_OPERATIONS` or to a listed Prisma write. `saveXeroTokens` is not
 * entered. Comments are not calls: the walk uses the TypeScript AST.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  FACTOR_RESET_ROUTE,
  MEMBER_EXPORT_ROUTE,
  STEP_UP_OPERATIONS,
  STEP_UP_PRISMA_WRITES,
  STEP_UP_ROUTES,
  XERO_TOKEN_REFRESH,
  stepUpRouteKey,
  type StepUpRoute,
} from "@/lib/step-up-routes";

const ADMIN_ROUTE_ROOT = "src/app/api/admin";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const AUTH_CALLEES = new Set([
  "requireAdmin",
  "requireFullAdmin",
  "requireFullAdminForConfigTransfer",
]);
const PATCH_ID = "src/lib/member-contact-erasure.ts#MEMBER_CONTACT_ERASURE_PATCH";
const CSV_ID = `${MEMBER_EXPORT_ROUTE.csvFile}#${MEMBER_EXPORT_ROUTE.csvExport}`;
const STOP_ID = `${XERO_TOKEN_REFRESH.file}#${XERO_TOKEN_REFRESH.exportName}`;
const RECENT_AUTH_ID = "src/lib/require-recent-auth.ts#requireRecentAuth";
const KNOWN_BODY_READERS = new Set([
  "src/lib/api-json.ts#parseJsonRequestBody",
  "src/lib/capped-multipart.ts#readCappedMultipartFormData",
  "src/lib/config-transfer/route-helpers.ts#readBundleUpload",
]);

const OPERATIONS = new Set(
  STEP_UP_OPERATIONS.map((operation) => `${operation.file}#${operation.exportName}`),
);

const PRISMA_METHODS = new Map<string, ReadonlySet<string>>(
  Object.entries(STEP_UP_PRISMA_WRITES).map(([model, methods]) => [model, new Set(methods)]),
);

export type StepUpHit = {
  file: string;
  method: string;
  operations: string[];
};

export type StepUpOrderIssue = {
  file: string;
  method: string;
  reason: string;
};

export type StepUpCensusResult = {
  missing: StepUpHit[];
  stale: { file: string; method: string }[];
  order: StepUpOrderIssue[];
  unresolved: string[];
  exportCsv: string | null;
  factorReset: string | null;
  reached: StepUpHit[];
};

export type StepUpCensusOptions = {
  routes?: readonly StepUpRoute[];
  /** Shadows disk. Keys are repo-relative paths using `/`. */
  overlay?: ReadonlyMap<string, string>;
  /** When set, only these route files are handlers. Other files still resolve from disk. */
  onlyRouteFiles?: readonly string[];
};

type Binding =
  | { kind: "import"; specifier: string; exportName: string }
  | { kind: "namespace"; specifier: string }
  | { kind: "function"; id: string }
  | { kind: "alias"; expr: ts.Expression }
  | { kind: "unknown" };

type Target =
  | { kind: "fn"; id: string; node: ts.Node }
  | { kind: "op"; id: string }
  | { kind: "csv" }
  | { kind: "stop" }
  | { kind: "external" }
  | { kind: "unknown" }
  | { kind: "missing" }
  | { kind: "unresolved"; detail: string };

type Fn = {
  id: string;
  file: string;
  name: string;
  node: ts.SignatureDeclaration;
  params: Set<string>;
};

type FileInfo = {
  file: string;
  source: ts.SourceFile;
  locals: Map<string, Binding>;
  exports: Map<string, Binding>;
  stars: string[];
};

type Facts = {
  ops: Set<string>;
  readsBody: boolean;
  touchesCsv: boolean;
};

type Site = {
  pos: number;
  end: number;
  ops: string[];
  readsBody: boolean;
  touchesCsv: boolean;
  auth: boolean;
  stepUp: boolean;
};

const EMPTY_FACTS: Facts = { ops: new Set(), readsBody: false, touchesCsv: false };

export function runStepUpCensus(options: StepUpCensusOptions = {}): StepUpCensusResult {
  const session = new CensusSession(options.overlay ?? new Map());
  const routes = options.routes ?? STEP_UP_ROUTES;
  const listed = new Set(routes.map((route) => stepUpRouteKey(route.file, route.method)));
  const routeFiles = options.onlyRouteFiles ?? session.listAdminRoutes();
  const reached: StepUpHit[] = [];
  const order: StepUpOrderIssue[] = [];

  for (const file of routeFiles) {
    const info = session.load(file);
    if (!info) {
      session.unresolved.add(`${file} could not be read`);
      continue;
    }
    for (const method of HTTP_METHODS) {
      const binding = info.exports.get(method);
      if (!binding || binding.kind !== "function") continue;
      const fn = session.fnById.get(binding.id);
      if (!fn) continue;
      const facts = session.facts(fn.id);
      const operations = [...facts.ops].sort();
      const key = stepUpRouteKey(file, method);
      const isExport = file === MEMBER_EXPORT_ROUTE.file && method === MEMBER_EXPORT_ROUTE.method;
      if (operations.length > 0) {
        reached.push({ file, method, operations });
      }
      if (listed.has(key)) {
        order.push(...session.orderIssues(fn, facts, isExport));
      }
    }
  }

  const reachedByKey = new Map(reached.map((hit) => [stepUpRouteKey(hit.file, hit.method), hit]));
  const missing = reached
    .filter((hit) => !listed.has(stepUpRouteKey(hit.file, hit.method)))
    .sort(byRoute);
  const stale = routes
    .filter((route) => {
      if (route.file === MEMBER_EXPORT_ROUTE.file && route.method === MEMBER_EXPORT_ROUTE.method) {
        return false;
      }
      const hit = reachedByKey.get(stepUpRouteKey(route.file, route.method));
      return !hit || hit.operations.length === 0;
    })
    .map((route) => ({ file: route.file, method: route.method }));

  let exportCsv: string | null = null;
  const exportListed = routes.some(
    (route) => route.file === MEMBER_EXPORT_ROUTE.file && route.method === MEMBER_EXPORT_ROUTE.method,
  );
  if (exportListed) {
    const exportFn = session.exportedFunction(MEMBER_EXPORT_ROUTE.file, MEMBER_EXPORT_ROUTE.method);
    const touches = exportFn ? session.facts(exportFn.id).touchesCsv : false;
    if (!touches) {
      exportCsv = `${MEMBER_EXPORT_ROUTE.method} ${MEMBER_EXPORT_ROUTE.file} no longer calls escapeCsvCell`;
    }
  }

  let factorReset: string | null = null;
  if (session.overlay.has(FACTOR_RESET_ROUTE.file) || session.diskHas(FACTOR_RESET_ROUTE.file)) {
    const listedReset = routes.some(
      (route) => route.file === FACTOR_RESET_ROUTE.file && route.method === FACTOR_RESET_ROUTE.method,
    );
    if (!listedReset) {
      factorReset = `${FACTOR_RESET_ROUTE.method} ${FACTOR_RESET_ROUTE.file} exists and is not listed`;
    }
  }

  return {
    missing,
    stale,
    order,
    unresolved: [...session.unresolved].sort(),
    exportCsv,
    factorReset,
    reached: reached.sort(byRoute),
  };
}

function byRoute(left: { file: string; method: string }, right: { file: string; method: string }): number {
  return stepUpRouteKey(left.file, left.method).localeCompare(stepUpRouteKey(right.file, right.method));
}

class CensusSession {
  readonly unresolved = new Set<string>();
  readonly fnById = new Map<string, Fn>();
  private readonly files = new Map<string, FileInfo | null>();
  private readonly factsMemo = new Map<string, Facts>();
  private readonly exportMemo = new Map<string, Target>();
  private readonly stack = new Set<string>();
  private readonly exportStack = new Set<string>();

  constructor(readonly overlay: ReadonlyMap<string, string>) {}

  listAdminRoutes(): string[] {
    const found = new Set<string>();
    if (this.diskHas(ADMIN_ROUTE_ROOT)) {
      walkDir(ADMIN_ROUTE_ROOT, found);
    }
    for (const file of this.overlay.keys()) {
      if (file.startsWith(`${ADMIN_ROUTE_ROOT}/`) && file.endsWith("/route.ts") && !file.includes("/__tests__/")) {
        found.add(file);
      }
    }
    return [...found].sort();
  }

  diskHas(file: string): boolean {
    if (this.overlay.has(file)) return true;
    try {
      return statSync(file).isFile() || statSync(file).isDirectory();
    } catch {
      return false;
    }
  }

  load(file: string): FileInfo | null {
    const cached = this.files.get(file);
    if (cached !== undefined) return cached;
    const text = this.read(file);
    if (text == null) {
      this.files.set(file, null);
      return null;
    }
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const info: FileInfo = {
      file,
      source,
      locals: new Map(),
      exports: new Map(),
      stars: [],
    };
    this.files.set(file, info);
    this.indexFile(info);
    return info;
  }

  facts(id: string): Facts {
    const cached = this.factsMemo.get(id);
    if (cached) return cached;
    if (this.stack.has(id)) return EMPTY_FACTS;
    const fn = this.fnById.get(id);
    if (!fn) return EMPTY_FACTS;
    this.stack.add(id);
    const ops = new Set<string>();
    let readsBody = KNOWN_BODY_READERS.has(`${fn.file}#${fn.name}`) && fn.id === `${fn.file}#${fn.name}`;
    let touchesCsv = false;
    this.walk(fn, (site) => {
      for (const op of site.ops) ops.add(op);
      if (site.readsBody) readsBody = true;
      if (site.touchesCsv) touchesCsv = true;
    });
    this.stack.delete(id);
    const facts = { ops, readsBody, touchesCsv };
    this.factsMemo.set(id, facts);
    return facts;
  }

  orderIssues(fn: Fn, facts: Facts, isExport: boolean): StepUpOrderIssue[] {
    const sites: Site[] = [];
    const rejections: { end: number }[] = [];
    this.walk(fn, (site) => sites.push(site), (end) => rejections.push({ end }));
    const step = sites.find((site) => site.stepUp);
    const issue = (reason: string): StepUpOrderIssue => ({
      file: fn.file,
      method: fn.name,
      reason,
    });
    if (!step) return [issue("requireRecentAuth() is missing")];
    const reasons: StepUpOrderIssue[] = [];
    const auth = sites.find((site) => site.auth);
    if (!auth || auth.pos > step.pos) {
      reasons.push(issue("requireRecentAuth() is before the authorisation guard"));
    }
    const bodyOrOp = (site: Site) =>
      site.readsBody || site.ops.length > 0 || (isExport && site.touchesCsv);
    const firstEffect = sites
      .filter((site) => bodyOrOp(site) && !site.stepUp && !site.auth)
      .sort((left, right) => left.pos - right.pos)[0];
    const effectPos = firstEffect?.pos ?? Number.POSITIVE_INFINITY;
    for (const rejection of rejections) {
      if (rejection.end < effectPos && step.pos < rejection.end) {
        reasons.push(issue("requireRecentAuth() is before a Full Admin check that still rejects the caller"));
        break;
      }
    }
    for (const site of sites) {
      if (site === step || site.auth) continue;
      if (site.readsBody && site.pos < step.pos) {
        reasons.push(issue("requireRecentAuth() is after a body read"));
        break;
      }
    }
    for (const site of sites) {
      if (site.pos >= step.pos || site.auth || site.stepUp) continue;
      if (site.ops.length > 0) {
        reasons.push(issue(`requireRecentAuth() is after a call that reaches ${site.ops[0]}`));
        break;
      }
      if (isExport && site.touchesCsv) {
        reasons.push(issue("requireRecentAuth() is after escapeCsvCell"));
        break;
      }
    }
    if (facts.ops.size === 0 && isExport && !facts.touchesCsv) {
      reasons.push(issue("member export no longer calls escapeCsvCell"));
    }
    return reasons;
  }

  exportedFunction(file: string, method: string): Fn | null {
    const info = this.load(file);
    const binding = info?.exports.get(method);
    if (!binding || binding.kind !== "function") return null;
    return this.fnById.get(binding.id) ?? null;
  }

  private walk(
    fn: Fn,
    onSite: (site: Site) => void,
    onRejection?: (end: number) => void,
  ): void {
    const info = this.load(fn.file);
    if (!info) return;
    const requestNames = new Set(fn.params);
    requestNames.add("request");
    requestNames.add("req");
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && onRejection && isAuthRejection(node)) {
        onRejection(node.end);
      }
      if (ts.isCallExpression(node)) {
        onSite(this.callSite(node, fn, info));
      } else if (ts.isIdentifier(node) && isValueReference(node)) {
        const target = this.resolveName(node.text, fn, info);
        if (target.kind === "op" && target.id === PATCH_ID) {
          onSite(siteOf(node, { ops: [PATCH_ID] }));
        }
      } else if (isRequestBodyProperty(node, requestNames)) {
        onSite(siteOf(node, { readsBody: true }));
      }
      ts.forEachChild(node, visit);
    };
    if (fn.node.body) visit(fn.node.body);
  }

  private callSite(node: ts.CallExpression, fn: Fn, info: FileInfo): Site {
    const callee = unwrap(node.expression);
    const base = siteOf(node, {});
    if (ts.isIdentifier(callee)) {
      if (AUTH_CALLEES.has(callee.text)) base.auth = true;
      const target = this.resolveName(callee.text, fn, info);
      if (target.kind === "op" && target.id === RECENT_AUTH_ID) base.stepUp = true;
      if (target.kind === "fn" && target.id === RECENT_AUTH_ID) base.stepUp = true;
      return this.applyTarget(base, target, fn);
    }
    if (ts.isPropertyAccessExpression(callee) || ts.isPropertyAccessChain(callee)) {
      const prisma = prismaOperation(callee);
      if (prisma) {
        base.ops = [prisma];
        return base;
      }
      if (ts.isIdentifier(callee.expression)) {
        const container = this.lookup(callee.expression.text, fn, info);
        if (container?.kind === "namespace") {
          const resolved = this.resolveModule(info.file, container.specifier);
          if (!resolved) {
            if (isProjectSpecifier(container.specifier)) {
              this.unresolved.add(`${info.file} imports ${container.specifier}`);
            }
            return base;
          }
          return this.applyTarget(base, this.resolveExport(resolved, callee.name.text), fn);
        }
      }
      if (isRequestMethod(callee, fn.params)) base.readsBody = true;
    }
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return base;
    return base;
  }

  private applyTarget(site: Site, target: Target, owner: Fn): Site {
    if (target.kind === "op") {
      if (target.id === RECENT_AUTH_ID) site.stepUp = true;
      else site.ops = [target.id];
      return site;
    }
    if (target.kind === "csv") {
      site.touchesCsv = true;
      return site;
    }
    if (target.kind === "stop" || target.kind === "external" || target.kind === "unknown" || target.kind === "missing") {
      if (target.kind === "missing") {
        this.unresolved.add(`${owner.file} calls an export that does not resolve`);
      }
      return site;
    }
    if (target.kind === "unresolved") {
      this.unresolved.add(target.detail);
      return site;
    }
    if (target.id === RECENT_AUTH_ID) site.stepUp = true;
    if (isInside(target.node, owner.node)) return site;
    const inner = this.facts(target.id);
    if (inner.ops.size > 0) site.ops = [...inner.ops].sort();
    if (inner.readsBody || KNOWN_BODY_READERS.has(target.id)) site.readsBody = true;
    if (inner.touchesCsv) site.touchesCsv = true;
    return site;
  }

  private resolveName(name: string, fn: Fn | null, info: FileInfo): Target {
    const binding = this.lookup(name, fn, info);
    if (!binding) return { kind: "unknown" };
    return this.resolveBinding(binding, info);
  }

  private lookup(name: string, fn: Fn | null, info: FileInfo): Binding | undefined {
    if (fn?.params.has(name)) return { kind: "unknown" };
    return info.locals.get(name);
  }

  private resolveBinding(binding: Binding, info: FileInfo): Target {
    if (binding.kind === "unknown") return { kind: "unknown" };
    if (binding.kind === "namespace") return { kind: "unknown" };
    if (binding.kind === "function") {
      const fn = this.fnById.get(binding.id);
      if (!fn) return { kind: "missing" };
      return this.classifyFunction(fn);
    }
    if (binding.kind === "alias") return this.resolveExpr(binding.expr, info);
    const resolved = this.resolveModule(info.file, binding.specifier);
    if (!resolved) {
      if (isProjectSpecifier(binding.specifier)) {
        return { kind: "unresolved", detail: `${info.file} cannot resolve ${binding.specifier}` };
      }
      return { kind: "external" };
    }
    return this.resolveExport(resolved, binding.exportName);
  }

  private resolveExpr(expr: ts.Expression, info: FileInfo): Target {
    const unwrapped = unwrap(expr);
    if (ts.isIdentifier(unwrapped)) return this.resolveName(unwrapped.text, null, info);
    if (
      (ts.isPropertyAccessExpression(unwrapped) || ts.isPropertyAccessChain(unwrapped)) &&
      ts.isIdentifier(unwrapped.expression)
    ) {
      const container = info.locals.get(unwrapped.expression.text);
      if (container?.kind === "namespace") {
        const resolved = this.resolveModule(info.file, container.specifier);
        if (!resolved) {
          return isProjectSpecifier(container.specifier)
            ? { kind: "unresolved", detail: `${info.file} cannot resolve ${container.specifier}` }
            : { kind: "external" };
        }
        return this.resolveExport(resolved, unwrapped.name.text);
      }
    }
    return { kind: "unknown" };
  }

  private resolveExport(file: string, name: string): Target {
    const key = `${file}#${name}`;
    const remembered = this.exportMemo.get(key);
    if (remembered) return remembered;
    if (key === STOP_ID) return { kind: "stop" };
    if (OPERATIONS.has(key)) return { kind: "op", id: key };
    if (key === CSV_ID) return { kind: "csv" };
    if (key === RECENT_AUTH_ID) return { kind: "op", id: key };
    if (this.exportStack.has(key)) return { kind: "unresolved", detail: `export cycle at ${key}` };
    this.exportStack.add(key);
    const info = this.load(file);
    if (!info) {
      this.exportStack.delete(key);
      return { kind: "unresolved", detail: `${file} cannot be read` };
    }
    const binding = info.exports.get(name);
    let target: Target;
    if (binding) target = this.resolveBinding(binding, info);
    else {
      target = { kind: "missing" };
      for (const star of info.stars) {
        const found = this.resolveExport(star, name);
        if (found.kind !== "missing") {
          target = found;
          break;
        }
      }
    }
    this.exportStack.delete(key);
    this.exportMemo.set(key, target);
    return target;
  }

  private classifyFunction(fn: Fn): Target {
    const key = `${fn.file}#${fn.name}`;
    if (fn.id === key || fn.id.startsWith(`${key}@`)) {
      if (key === STOP_ID && fn.name === XERO_TOKEN_REFRESH.exportName) return { kind: "stop" };
      if (OPERATIONS.has(key) && fn.id === key) return { kind: "op", id: key };
      if (key === CSV_ID && fn.id === key) return { kind: "csv" };
      if (key === RECENT_AUTH_ID && fn.id === key) return { kind: "op", id: key };
    }
    return { kind: "fn", id: fn.id, node: fn.node };
  }

  private resolveModule(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith("@/")) return this.resolveFile(`src/${specifier.slice(2)}`);
    if (specifier.startsWith(".")) {
      return this.resolveFile(path.posix.normalize(`${path.posix.dirname(fromFile)}/${specifier}`));
    }
    return null;
  }

  private resolveFile(base: string): string | null {
    let stem = base;
    if (stem.endsWith(".js") || stem.endsWith(".mjs") || stem.endsWith(".cjs")) {
      stem = stem.replace(/\.(mjs|cjs|js)$/, "");
    }
    const candidates = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}/index.ts`, `${stem}/index.tsx`];
    for (const candidate of candidates) {
      if (candidate.includes("/__tests__/") || candidate.endsWith(".test.ts") || candidate.endsWith(".test.tsx")) {
        continue;
      }
      if (this.overlay.has(candidate) || fileExists(candidate)) return candidate;
    }
    return null;
  }

  private read(file: string): string | null {
    const overlaid = this.overlay.get(file);
    if (overlaid != null) return overlaid;
    if (!file.startsWith("src/") || file.includes("/__tests__/") || file.endsWith(".test.ts")) return null;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  private indexFile(info: FileInfo): void {
    const register = (name: string, node: ts.SignatureDeclaration, exported: boolean) => {
      if (!node.body) return;
      const id = `${info.file}#${name}`;
      const fn: Fn = {
        id,
        file: info.file,
        name,
        node,
        params: parameterNames(node),
      };
      this.fnById.set(id, fn);
      const binding: Binding = { kind: "function", id };
      info.locals.set(name, binding);
      if (exported) info.exports.set(name, binding);
    };

    const exportStatements: ts.ExportDeclaration[] = [];
    for (const statement of info.source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        register(statement.name.text, statement, hasExport(statement));
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const exported = hasExport(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const init = unwrap(declaration.initializer);
          if (isFnLike(init) && init.body) {
            register(declaration.name.text, init, exported);
          } else if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isPropertyAccessChain(init)) {
            const binding: Binding = { kind: "alias", expr: init };
            info.locals.set(declaration.name.text, binding);
            if (exported) info.exports.set(declaration.name.text, binding);
          } else if (exported) {
            info.exports.set(declaration.name.text, { kind: "unknown" });
          }
        }
        continue;
      }
      if (ts.isImportDeclaration(statement)) this.indexImport(info, statement);
      if (ts.isExportDeclaration(statement)) exportStatements.push(statement);
      if (ts.isExportAssignment(statement)) {
        const expr = unwrap(statement.expression);
        if (isFnLike(expr) && expr.body) register("default", expr, true);
        else info.exports.set("default", { kind: "alias", expr });
      }
    }
    for (const statement of exportStatements) this.indexExport(info, statement);
  }

  private indexImport(info: FileInfo, statement: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) {
      info.locals.set(clause.name.text, { kind: "import", specifier, exportName: "default" });
    }
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      info.locals.set(bindings.name.text, { kind: "namespace", specifier });
      return;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      info.locals.set(element.name.text, {
        kind: "import",
        specifier,
        exportName: (element.propertyName ?? element.name).text,
      });
    }
  }

  private indexExport(info: FileInfo, statement: ts.ExportDeclaration): void {
    if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const resolved = this.resolveModule(info.file, statement.moduleSpecifier.text);
      if (resolved) info.stars.push(resolved);
      else if (isProjectSpecifier(statement.moduleSpecifier.text)) {
        this.unresolved.add(`${info.file} cannot resolve ${statement.moduleSpecifier.text}`);
      }
      return;
    }
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const exported = (element.propertyName ?? element.name).text;
      const local = element.name.text;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        info.exports.set(local, {
          kind: "import",
          specifier: statement.moduleSpecifier.text,
          exportName: exported,
        });
        continue;
      }
      const binding = info.locals.get(exported);
      if (binding) info.exports.set(local, binding);
    }
  }
}

function siteOf(node: ts.Node, extra: Partial<Site>): Site {
  return {
    pos: node.getStart(),
    end: node.end,
    ops: [],
    readsBody: false,
    touchesCsv: false,
    auth: false,
    stepUp: false,
    ...extra,
  };
}

function isFnLike(node: ts.Node): node is ts.SignatureDeclaration {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

function hasExport(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

function parameterNames(node: ts.SignatureDeclaration): Set<string> {
  const names = new Set<string>();
  for (const parameter of node.parameters) {
    if (ts.isIdentifier(parameter.name)) names.add(parameter.name.text);
  }
  return names;
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

function isProjectSpecifier(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith(".");
}

function isInside(inner: ts.Node, outer: ts.Node): boolean {
  return (
    inner.getSourceFile() === outer.getSourceFile() &&
    inner.pos >= outer.pos &&
    inner.end <= outer.end &&
    inner !== outer
  );
}

function prismaOperation(callee: ts.PropertyAccessExpression): string | null {
  const method = callee.name.text;
  const modelAccess = unwrap(callee.expression);
  if (!ts.isPropertyAccessExpression(modelAccess) && !ts.isPropertyAccessChain(modelAccess)) return null;
  const methods = PRISMA_METHODS.get(modelAccess.name.text);
  if (!methods?.has(method)) return null;
  return `prisma:${modelAccess.name.text}.${method}`;
}

function isRequestMethod(callee: ts.PropertyAccessExpression, params: Set<string>): boolean {
  const name = callee.name.text;
  if (name !== "json" && name !== "formData" && name !== "text") return false;
  const receiver = unwrap(callee.expression);
  return ts.isIdentifier(receiver) && (params.has(receiver.text) || receiver.text === "request" || receiver.text === "req");
}

function isRequestBodyProperty(node: ts.Node, requestNames: Set<string>): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessChain(node)) return false;
  if (node.name.text !== "body") return false;
  const receiver = unwrap(node.expression);
  if (!ts.isIdentifier(receiver) || !requestNames.has(receiver.text)) return false;
  const parent = node.parent;
  return !parent || !ts.isCallExpression(parent);
}

function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) return parent.name !== node;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent) || ts.isParameter(parent)) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  return true;
}

function isAuthRejection(node: ts.IfStatement): boolean {
  if (!statementReturns(node.thenStatement)) return false;
  const names = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node.expression);
  if (names.has("recent")) return false;
  if (names.has("isFullAdmin") || names.has("actorIsFullAdmin")) return true;
  return names.has("ok") && node.expression.getText().includes("!");
}

function statementReturns(node: ts.Statement): boolean {
  if (ts.isReturnStatement(node)) return true;
  if (ts.isBlock(node)) return node.statements.some(statementReturns);
  return false;
}

function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function walkDir(dir: string, found: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkDir(full, found);
    else if (entry.name === "route.ts") found.add(full);
  }
}
