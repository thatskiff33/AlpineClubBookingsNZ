import fs from "node:fs";
import path from "node:path";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminAccessRequirement,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

import {
  adminApiRouteFiles,
  toResolverPathname,
} from "./admin-route-enumeration";

/**
 * WHAT EACH `/api/admin` HANDLER ACTUALLY PASSES TO `requireAdmin` (#2975).
 *
 * ## Why a source reader, and not the route map
 *
 * `requireAdmin`'s `permission` option is a SECOND definition of a route's
 * authorization, and on the routes that pass one it is the definition that wins:
 * `inferAdminAccessRequirement` consults `getAdminRouteRequirement` only when no
 * explicit permission was given. Most `/api/admin` routes pass an explicit
 * literal, so a sweep that calls a bare `requireAdmin()` for every route measures
 * the path map and never the gate the request actually meets.
 *
 * That is not a theoretical gap. Before this module existed, the authorization
 * proof asserted that a finance-only grid "is refused EVERY admin API route
 * outside finance", and that a `support:view` grid is admitted to
 * `/api/admin/club-time-zone` — and BOTH were false in production, because those
 * routes pass explicit permissions the sweep never saw. A proof that asserts
 * false things about the application is worse than no proof, so the sweep reads
 * the literal each handler passes and hands it to the real guard.
 *
 * ## What it resolves
 *
 * This is a source reader, not a type checker. It resolves the shapes this
 * repository actually writes:
 *
 *   - `requireAdmin()`, or an options object with no `permission` key
 *                                                      -> `{ kind: "inferred" }`
 *   - `permission: { area: "finance", level: "view" }`  -> that requirement
 *   - `permission: false`                               -> Full Admin only
 *   - `permission: "any-admin"`                         -> admitted to the portal
 *   - `requireAdmin(viewGuardOptions)`, where the module declares the options
 *     object as a constant
 *   - `permission: SOME_CONST` / `{ area: AREA, level: "edit" }`, where the
 *     module declares the value as a constant
 *   - a handler that delegates to a local `gate("view")`-style helper, with the
 *     helper's string parameters bound from the call site
 *   - a handler that delegates to one of the allowlisted shared wrappers below,
 *     followed into its defining module and resolved the same way
 *
 * ## Anything else is `unparsed`, and that is deliberate
 *
 * A shape it does not understand comes back `{ kind: "unparsed" }`, which
 * `admin-route-authorization-proof.test.ts` treats as a HARD FAILURE rather than
 * falling back to path inference. The direction matters, and it is not
 * hypothetical: the first cut of this reader treated
 * `requireAdmin(viewGuardOptions)` as "no permission given" and quietly reported
 * five `/api/admin/page-content` handlers as path-inferred when every one of them
 * passes an explicit `content:` literal. It happened to agree with the map, so
 * nothing would have gone red — a reader that degrades silently reintroduces
 * exactly the blindness it exists to remove, and does it invisibly.
 *
 * ## It reads only what a request would reach
 *
 * Comments go through the tree's one `stripComments` before anything is matched,
 * because several of these route files DISCUSS `permission: false` and
 * `permission: "any-admin"` at length in their docblocks — including routes that
 * pass neither. Matching raw text would read the prose as the gate.
 *
 * ## The limit worth stating: this is the ADMISSION gate, not the whole handler
 *
 * What is modelled here is what `requireAdmin` itself resolves. A handler that
 * narrows FURTHER after it — `requireFullAdminForConfigTransfer` re-checks
 * `isFullAdmin`, the backup-restore route gates its destination on Full Admin —
 * is stricter in production than this reader reports. Narrowing can only remove
 * callers, never add them, so every refusal the proof observes is sound and every
 * admission means "cleared the admission gate and reached the handler".
 */

export type ExplicitAdminPermission =
  | { kind: "requirement"; requirement: AdminAccessRequirement }
  | { kind: "full-admin" }
  | { kind: "any-admin" };

export type RouteMethodGate =
  | { kind: "inferred" }
  | { kind: "explicit"; permission: ExplicitAdminPermission }
  | { kind: "unparsed"; detail: string };

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The shared admin-guard wrappers, and the module each is defined in.
 *
 * ONE HOME, imported by both readers of it (`INV-SSOT-001`):
 * `api-route-boundaries.test.ts` uses it to prove every admin handler reaches an
 * admission guard, and this module follows the same wrappers to find WHICH
 * permission that guard is given. Two copies of this list would let one suite
 * accept a wrapper the other cannot read, which is a route whose gate nobody
 * measures.
 *
 * Adding an entry is a deliberate widening of what counts as reaching the guard;
 * `api-route-boundaries.test.ts` asserts each defining module really calls
 * `requireAdmin`, so an entry cannot become a bypass by pointing at a file that
 * does not.
 */
export const SHARED_ADMIN_GUARD_WRAPPERS: Record<string, string> = {
  requireBedAllocationRead: "src/lib/admin-bed-allocation-routes.ts",
  requireBedAllocationWrite: "src/lib/admin-bed-allocation-routes.ts",
  requireBedInventoryRead: "src/lib/admin-bed-allocation-routes.ts",
  requireBedInventoryWrite: "src/lib/admin-bed-allocation-routes.ts",
  requireFullAdminForConfigTransfer: "src/lib/config-transfer/route-helpers.ts",
};

type LocalFunction = { name: string; params: string[]; body: string };

type ModuleScope = {
  constants: Map<string, string>;
  locals: LocalFunction[];
};

const AREA_KEYS = new Set<string>(
  ADMIN_PERMISSION_AREAS.map((area) => area.key),
);

function isArea(value: string): value is AdminPermissionArea {
  return AREA_KEYS.has(value);
}

/**
 * Slice a route file into per-method segments, so a mixed-method file is read one
 * exported handler at a time — the same shape `api-route-boundaries.test.ts` uses
 * for its per-method guard census. Every admin handler in this tree is an
 * `export async function METHOD`, and that census is what keeps it so: a handler
 * written any other way fails it for not reaching `requireAdmin`.
 */
function extractMethodBodies(code: string): Partial<Record<HttpMethod, string>> {
  const methodPattern =
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  const matches = [...code.matchAll(methodPattern)];
  const bodies: Partial<Record<HttpMethod, string>> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? code.length)
        : code.length;
    bodies[matches[index][1] as HttpMethod] = code.slice(start, end);
  }
  return bodies;
}

/** Top-level function and const-arrow definitions, so a delegation can be traced. */
function extractLocalFunctions(code: string): LocalFunction[] {
  const definitionPattern =
    /(?:^|\n)(?:export\s+)?(?:async\s+function\s+(\w+)|function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?)\(([^)]*)\)/g;
  const matches = [...code.matchAll(definitionPattern)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? code.length)
        : code.length;
    return {
      name: match[1] ?? match[2] ?? match[3] ?? "",
      params: match[4]
        .split(",")
        .map((param) => param.split(":")[0].trim())
        .filter(Boolean),
      body: code.slice(start, end),
    };
  });
}

/** Module-scope `const NAME = <expression>;` values, for the alias shapes. */
function moduleConstants(code: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of code.matchAll(/(?:^|\n)const\s+(\w+)\s*=\s*([^;]+);/g)) {
    constants.set(match[1], match[2].trim());
  }
  return constants;
}

function scopeOf(code: string): ModuleScope {
  return { constants: moduleConstants(code), locals: extractLocalFunctions(code) };
}

/** The balanced `(...)` argument text of the first `requireAdmin(` in `body`. */
function requireAdminArgument(body: string): string | null {
  const marker = /\brequireAdmin\s*\(/.exec(body);
  if (!marker) return null;
  let depth = 0;
  let index = marker.index + marker[0].length - 1;
  const start = index + 1;
  for (; index < body.length; index += 1) {
    const character = body[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(start, index);
    }
  }
  return null;
}

/** The text of the `permission:` property inside an options-object literal. */
function permissionExpression(objectText: string): string | null {
  const marker = /(?:^|[{,\s])permission\s*:/.exec(objectText);
  if (!marker) return null;
  let depth = 0;
  const start = marker.index + marker[0].length;
  let index = start;
  for (; index < objectText.length; index += 1) {
    const character = objectText[index];
    if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (character === "," && depth === 0) break;
  }
  return objectText.slice(start, index).trim();
}

function unquote(value: string): string | null {
  const match = /^["'`]([^"'`]*)["'`]$/.exec(value.trim());
  return match ? match[1] : null;
}

function withoutAsConst(value: string): string {
  return value.trim().replace(/\s+as\s+const$/, "");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Follow an identifier through the call-site bindings, then module constants. */
function lookup(
  name: string,
  scope: ModuleScope,
  bindings: Map<string, string>,
): string | undefined {
  return bindings.get(name) ?? scope.constants.get(name);
}

/**
 * One `key: value` of an object literal, with identifiers resolved. Shorthand
 * (`{ area, level }`) carries no value expression, so the property name is the
 * identifier to resolve.
 */
function readObjectField(
  objectText: string,
  key: string,
  scope: ModuleScope,
  bindings: Map<string, string>,
): string | null {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const pattern = new RegExp(`(?:^|[{,\\s])${key}\\s*(?::\\s*([^,}]+))?\\s*[,}]`);
  const match = pattern.exec(objectText);
  if (!match) return null;
  let expression = withoutAsConst(match[1] ?? key);
  for (let hop = 0; hop < 4; hop += 1) {
    const literal = unquote(expression);
    if (literal !== null) return literal;
    if (!IDENTIFIER.test(expression)) return null;
    const resolved = lookup(expression, scope, bindings);
    if (resolved === undefined) return null;
    expression = withoutAsConst(resolved);
  }
  return null;
}

/** Resolve the expression a `permission:` property is set to. */
function resolvePermission(
  expression: string,
  scope: ModuleScope,
  bindings: Map<string, string>,
  depth = 0,
): RouteMethodGate {
  const text = withoutAsConst(expression);

  if (text === "false") {
    return { kind: "explicit", permission: { kind: "full-admin" } };
  }
  if (unquote(text) === "any-admin") {
    return { kind: "explicit", permission: { kind: "any-admin" } };
  }

  if (text.startsWith("{")) {
    const area = readObjectField(text, "area", scope, bindings);
    const level = readObjectField(text, "level", scope, bindings);
    if (area === null || level === null || !isArea(area)) {
      return { kind: "unparsed", detail: text };
    }
    if (level !== "view" && level !== "edit") {
      return { kind: "unparsed", detail: text };
    }
    return {
      kind: "explicit",
      permission: { kind: "requirement", requirement: { area, level } },
    };
  }

  if (IDENTIFIER.test(text) && depth < 4) {
    const resolved = lookup(text, scope, bindings);
    if (resolved !== undefined) {
      return resolvePermission(resolved, scope, bindings, depth + 1);
    }
  }
  return { kind: "unparsed", detail: text };
}

/** Resolve the whole options argument of a `requireAdmin(...)` call. */
function resolveOptions(
  argument: string,
  scope: ModuleScope,
  bindings: Map<string, string>,
  depth = 0,
): RouteMethodGate {
  const text = withoutAsConst(argument);

  // `requireAdmin()` — no options at all, so the requirement is path-inferred.
  if (text === "") return { kind: "inferred" };

  if (text.startsWith("{")) {
    const expression = permissionExpression(text);
    // An options object that sets other fields but no `permission` is still
    // path-inferred; `page-content`'s `forbiddenResponse`-only sibling is one.
    if (expression === null) return { kind: "inferred" };
    return resolvePermission(expression, scope, bindings);
  }

  if (IDENTIFIER.test(text) && depth < 4) {
    const resolved = lookup(text, scope, bindings);
    if (resolved !== undefined) {
      return resolveOptions(resolved, scope, bindings, depth + 1);
    }
  }
  return { kind: "unparsed", detail: text };
}

/** String-literal arguments at a call site, bound to a callee's parameters. */
function bindArguments(
  callee: LocalFunction,
  argumentText: string,
  bindings: Map<string, string>,
): Map<string, string> {
  const args = argumentText
    .split(",")
    .map((arg) => arg.trim())
    .filter(Boolean);
  const bound = new Map(bindings);
  callee.params.forEach((param, index) => {
    const value = args[index];
    // Stored as the EXPRESSION (quotes intact) so the resolvers below can
    // unquote it exactly as they would a literal written in place.
    if (value !== undefined && unquote(value) !== null) bound.set(param, value);
  });
  return bound;
}

const wrapperScopeCache = new Map<string, ModuleScope>();

function wrapperScope(definingFile: string): ModuleScope {
  const cached = wrapperScopeCache.get(definingFile);
  if (cached) return cached;
  const source = fs.readFileSync(path.join(process.cwd(), definingFile), "utf8");
  const scope = scopeOf(stripComments(source));
  wrapperScopeCache.set(definingFile, scope);
  return scope;
}

/**
 * The gate a handler body reaches: its own `requireAdmin` call if it makes one,
 * otherwise the local helper or allowlisted shared wrapper that does, with string
 * parameters bound from the call site.
 */
function gateFor(
  body: string,
  scope: ModuleScope,
  bindings: Map<string, string>,
  depth: number,
): RouteMethodGate {
  const argument = requireAdminArgument(body);
  if (argument !== null) return resolveOptions(argument, scope, bindings);

  if (depth >= 3) {
    return { kind: "unparsed", detail: "no requireAdmin call within three hops" };
  }

  for (const local of scope.locals) {
    if (!local.body.includes("requireAdmin")) continue;
    if (local.body === body) continue;
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const call = new RegExp(`\\b${local.name}\\s*\\(([^)]*)\\)`).exec(body);
    if (!call) continue;
    return gateFor(
      local.body,
      scope,
      bindArguments(local, call[1], bindings),
      depth + 1,
    );
  }

  for (const [wrapper, definingFile] of Object.entries(
    SHARED_ADMIN_GUARD_WRAPPERS,
  )) {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const call = new RegExp(`\\b${wrapper}\\s*\\(([^)]*)\\)`).exec(body);
    if (!call) continue;
    const outer = wrapperScope(definingFile);
    const definition = outer.locals.find((local) => local.name === wrapper);
    if (!definition) {
      return {
        kind: "unparsed",
        detail: `${wrapper} not found in ${definingFile}`,
      };
    }
    return gateFor(
      definition.body,
      outer,
      bindArguments(definition, call[1], new Map()),
      depth + 1,
    );
  }

  return { kind: "unparsed", detail: "no requireAdmin call reachable" };
}

export type RouteGates = {
  /** The HTTP methods this file exports. */
  methods: HttpMethod[];
  /** The gate each exported method reaches. */
  gates: Partial<Record<HttpMethod, RouteMethodGate>>;
};

export function extractRouteGates(source: string): RouteGates {
  const code = stripComments(source);
  const scope = scopeOf(code);
  const bodies = extractMethodBodies(code);
  const methods = Object.keys(bodies) as HttpMethod[];

  const gates: Partial<Record<HttpMethod, RouteMethodGate>> = {};
  for (const method of methods) {
    gates[method] = gateFor(bodies[method] ?? "", scope, new Map(), 0);
  }
  return { methods, gates };
}

/** Resolver pathname -> the gates its `route.ts` declares. */
export const adminApiRouteGates: ReadonlyMap<string, RouteGates> = new Map(
  adminApiRouteFiles.map(
    (file) =>
      [
        toResolverPathname(file),
        extractRouteGates(fs.readFileSync(file, "utf8")),
      ] as const,
  ),
);
