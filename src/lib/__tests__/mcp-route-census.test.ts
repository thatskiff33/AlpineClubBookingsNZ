import { readdirSync, readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import {
  MCP_ACTIONS,
  MCP_WEBSITE_ONLY_ACTIONS,
  mcpActionAdminRequirement,
  mcpActionRouteFile,
} from "@/lib/mcp/catalogue";
import { MEMBERSHIP_MCP_ACTIONS } from "@/lib/mcp/catalogue/membership";
import {
  classifyMcpRoute,
  MCP_NOT_YET_TASKS,
  MCP_PERMANENT_EXCLUSION_REASONS,
  mcpPermanentExclusion,
} from "@/lib/mcp/exclusions";
import { MCP_STATIC_SIBLING_SEGMENTS } from "@/lib/mcp/static-route-segments";
import { fileExists, hasExport, unwrap, walkDir } from "@/lib/step-up-route-census-ast";
import {
  adminRouteApiPath,
  STEP_UP_HTTP_METHODS,
  STEP_UP_ROUTES,
  stepUpRouteKey,
} from "@/lib/step-up-routes";

// The census parses every API route file once: a few seconds on an idle
// machine and several times that on a busy CI runner.
const CENSUS_TIMEOUT_MS = 90_000;

const HTTP_METHODS: ReadonlySet<string> = new Set(STEP_UP_HTTP_METHODS);

/**
 * The only `POST`s that may run as a `read` (`preview: true`): each changes
 * no member's data, which a reviewer checked against the route. A view-only
 * connection runs them and the dispatcher writes no `MCP_ACTION_CALLED` audit
 * row, so adding one here is a decision.
 */
const PREVIEW_ROUTE_KEYS: readonly string[] = [
  // ALP-795: looks a member up by exact email; writes only its own audit row
  // and its rate-limit counters.
  "POST src/app/api/members/guest-candidates/resolve/route.ts",
];

/** The HTTP methods a route file exports, however it spells the export. */
function exportedMethods(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const addName = (name: ts.BindingName | ts.ModuleExportName) => {
    // `export { handler as "GET" }` names its export with a string literal.
    if (ts.isStringLiteral(name)) {
      if (HTTP_METHODS.has(name.text)) found.add(name.text);
      return;
    }
    if (ts.isIdentifier(name)) {
      if (HTTP_METHODS.has(name.text)) found.add(name.text);
      return;
    }
    // `export const { GET, POST } = handlers`
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) addName(element.name);
    }
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExport(statement)) {
      addName(statement.name);
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) addName(declaration.name);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      // `export { GET, POST } from "./handlers"`
      for (const element of statement.exportClause.elements) addName(element.name);
    }
  }
  return [...found].sort();
}

/**
 * Functions that decide officer reach from a person's roles or admin matrix
 * (`access-roles.ts`, `admin-permissions.ts`, `on-behalf-booking.ts`). A
 * connection's session carries the member's real roles, so a catalogued route
 * hands these only the user `memberOnlySessionUser` returned (INV-MCP-006).
 */
const OFFICER_PREDICATES: ReadonlySet<string> = new Set([
  "authorizationRoleFromAccessRoles",
  "bookingManagementAuthorizationRole",
  "canOpenAdminPath",
  "canSeeBookingAdminTools",
  "getAdminPermissionLevel",
  "getAdminPermissionMatrix",
  "getFirstAccessibleAdminHref",
  "hasAccessRole",
  "hasAdminAccess",
  "hasAdminAreaAccess",
  "hasAdminPortalAccess",
  "hasFinanceManagerAccess",
  "hasFinanceViewerAccess",
  "hasLodgeAccess",
  "hasPrivilegedAccess",
  "isFullAdmin",
  "legacyRoleFromAccessRoles",
  "refuseOnBehalfUnlessBookingOfficer",
]);

/** The session fields an officer decision reads, which a raw session user still carries. */
const ROLE_FIELDS: ReadonlySet<string> = new Set(["accessRoles", "adminPermissionMatrix", "role"]);

function isMemberOnlyCall(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "memberOnlySessionUser";
}

/** `session.user`, `guard.session.user`, `session!.user` and the like. */
function isRawSessionUser(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "user") return false;
  const owner = unwrap(node.expression);
  return (
    (ts.isIdentifier(owner) && owner.text === "session") ||
    (ts.isPropertyAccessExpression(owner) && owner.name.text === "session")
  );
}

/**
 * Where a catalogued route file decides officer reach on anything but the
 * member-only user: each officer predicate call must take a variable set from
 * `memberOnlySessionUser(...)`, or that call itself, and no role field is read
 * off a raw session user. `hasAccessRole(x, "USER")` is a member check, which
 * the member-only user keeps, so it may take any user.
 *
 * Textual, so it has limits. It reads the route file only, not the helpers it
 * calls: a lib function handed `session` or `session.user` that decides
 * officer reach inside is not seen. It follows a variable only when it is set
 * directly from the call (not reassigned, destructured or spread). It skips
 * the exported handlers of methods the catalogue does not list, since a
 * connection never reaches them, but reads every other line in the file,
 * including shared helpers. A predicate legitimately asked about someone
 * else's record would be reported too, and needs a reviewed change here.
 */
function officerReachOffMemberOnly(file: string, catalogued: ReadonlySet<string>): {
  decided: string[];
  violations: string[];
} {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const skipped = new Set<ts.Node>();
  const memberOnly = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExport(statement)) {
      const method = statement.name.text;
      if (HTTP_METHODS.has(method) && !catalogued.has(method)) skipped.add(statement);
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const method = ts.isIdentifier(declaration.name) ? declaration.name.text : "";
        if (HTTP_METHODS.has(method) && !catalogued.has(method)) skipped.add(declaration);
      }
    }
  }
  const collectNames = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isMemberOnlyCall(node.initializer)
    ) {
      memberOnly.add(node.name.text);
    }
    ts.forEachChild(node, collectNames);
  };
  collectNames(source);

  const decided: string[] = [];
  const violations: string[] = [];
  const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (skipped.has(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      const [subject, role] = node.arguments;
      if (OFFICER_PREDICATES.has(name) && subject) {
        const memberCheck = name === "hasAccessRole" && role !== undefined && ts.isStringLiteral(role) && role.text === "USER";
        let target = unwrap(subject);
        // `sessionPrivilegeInput(user)` only reshapes the user it is given.
        if (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "sessionPrivilegeInput" && target.arguments[0]) {
          target = unwrap(target.arguments[0]);
        }
        const fromMemberOnly = (ts.isIdentifier(target) && memberOnly.has(target.text)) || isMemberOnlyCall(target);
        if (fromMemberOnly) decided.push(`${where(node)} ${name}`);
        else if (!memberCheck) violations.push(`${where(node)} ${name}(${subject.getText(source)})`);
      }
    } else if (ts.isPropertyAccessExpression(node) && ROLE_FIELDS.has(node.name.text) && isRawSessionUser(node.expression)) {
      violations.push(`${where(node)} reads ${node.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { decided, violations };
}

/** The exported handler of `method` in a route file, as source text, or null. */
function handlerSource(file: string, method: string): string | null {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExport(statement) && statement.name?.text === method) {
      return statement.getText(source);
    }
    if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === method) return declaration.getText(source);
      }
    }
  }
  return null;
}

function allRouteMethods(): Array<{ file: string; method: string }> {
  const files = new Set<string>();
  walkDir("src/app/api", files);
  return [...files].sort().flatMap((file) => exportedMethods(file).map((method) => ({ file, method })));
}

describe("AI app action census (ALP-653, INV-MCP-006)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const routeMethods = allRouteMethods();
  const routeKeys = new Set(routeMethods.map((route) => stepUpRouteKey(route.file, route.method)));

  it("finds the API routes", () => {
    expect(routeMethods.length).toBeGreaterThan(500);
    expect(routeKeys.has("GET src/app/api/availability/route.ts")).toBe(true);
    // The destructured export in the sign-in route is read, not skipped.
    expect(routeKeys.has("POST src/app/api/auth/[...nextauth]/route.ts")).toBe(true);
  });

  it("holds every route method to a catalogue entry or a reasoned exclusion", () => {
    const unclassified = routeMethods
      .filter((route) => classifyMcpRoute(route.file, route.method).kind === "unclassified")
      .map((route) => stepUpRouteKey(route.file, route.method));
    expect(unclassified).toEqual([]);
  });

  it("names a real reason on every exclusion", () => {
    const tasks = new Set<string>(Object.values(MCP_NOT_YET_TASKS));
    const permanent = new Set<string>(Object.keys(MCP_PERMANENT_EXCLUSION_REASONS));
    for (const route of routeMethods) {
      const result = classifyMcpRoute(route.file, route.method);
      if (result.kind !== "excluded") continue;
      const known = result.reason.startsWith("not-yet:")
        ? tasks.has(result.reason.slice("not-yet:".length))
        : permanent.has(result.reason);
      expect(known, `${route.method} ${route.file}: ${result.reason}`).toBe(true);
    }
  });

  it("leaves no route waiting on ALP-718, which decided its member routes", () => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain("ALP-718");
    const waiting = routeMethods.filter((route) => {
      const result = classifyMcpRoute(route.file, route.method);
      return result.kind === "excluded" && result.reason === "not-yet:ALP-718";
    });
    expect(waiting).toEqual([]);
  });

  it("leaves no route waiting on ALP-720, which decided the Membership admin area", () => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain("ALP-720");
    const membership = routeMethods.filter(
      (route) => getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area === "membership",
    );
    expect(membership.length).toBeGreaterThan(100);
    for (const route of membership) {
      const result = classifyMcpRoute(route.file, route.method);
      expect(result.kind, `${route.method} ${route.file}`).not.toBe("unclassified");
      if (result.kind === "excluded") expect(result.reason, `${route.method} ${route.file}`).not.toMatch(/^not-yet:/);
    }
    // The area is finished: a new membership route has to be decided, not deferred.
    expect(classifyMcpRoute("src/app/api/admin/lockers/brand-new/route.ts", "GET")).toEqual({ kind: "unclassified" });
  });

  it("runs every Membership action on a route the area gates, answering a connection through its shape", () => {
    expect(MEMBERSHIP_MCP_ACTIONS.length).toBeGreaterThan(0);
    for (const action of MEMBERSHIP_MCP_ACTIONS) {
      expect(mcpActionAdminRequirement(action)?.area, action.id).toBe("membership");
      // Without the projection the whole website answer, with every field the
      // screen uses, would reach the AI provider.
      const handler = handlerSource(mcpActionRouteFile(action), action.method) ?? "";
      expect(handler.includes("connectionJson("), `${action.id} answers through connectionJson`).toBe(true);
    }
  });

  it("points every catalogue entry at a route method that exists", () => {
    const stale = MCP_ACTIONS.filter(
      (action) => !routeKeys.has(stepUpRouteKey(mcpActionRouteFile(action), action.method)),
    ).map((action) => action.id);
    expect(stale).toEqual([]);
  });

  it("decides officer reach in a member action's route only on the member-only user", () => {
    const methodsByFile = new Map<string, Set<string>>();
    // An officer action runs with the officer's real permissions on a route its
    // admin area gates; the test above holds it to that area instead.
    for (const action of MCP_ACTIONS.filter((entry) => mcpActionAdminRequirement(entry) === null)) {
      const file = mcpActionRouteFile(action);
      methodsByFile.set(file, (methodsByFile.get(file) ?? new Set<string>()).add(action.method));
    }
    const decided: string[] = [];
    const violations: string[] = [];
    for (const [file, methods] of [...methodsByFile].sort(([a], [b]) => a.localeCompare(b))) {
      const result = officerReachOffMemberOnly(file, methods);
      decided.push(...result.decided);
      violations.push(...result.violations);
    }
    // The scan sees the member-only decisions the booking routes already make.
    expect(decided.length).toBeGreaterThan(0);
    expect(
      violations,
      "A catalogued route decides officer reach on the raw session user. A connection's session carries the " +
        "member's real roles: pass the user through memberOnlySessionUser(request, session.user) first (INV-MCP-006).",
    ).toEqual([]);
  });

  it("offers no action on a route that is never an action", () => {
    const refused = MCP_ACTIONS.filter(
      (action) => mcpPermanentExclusion(mcpActionRouteFile(action), action.method) !== null,
    ).map((action) => action.id);
    expect(refused).toEqual([]);
  });

  it("excludes every fresh-proof route from the list that defines them", () => {
    for (const route of STEP_UP_ROUTES) {
      if (!fileExists(route.file)) continue;
      expect(classifyMcpRoute(route.file, route.method)).toEqual({
        kind: "excluded",
        reason: "fresh-proof",
      });
    }
    // A fresh-proof route stays excluded even if someone adds it to the catalogue.
    expect(mcpPermanentExclusion("src/app/api/admin/modules/route.ts", "PUT")).toBe("fresh-proof");
    expect(mcpPermanentExclusion("src/app/api/admin/modules/route.ts", "GET")).toBeNull();
  });

  it("keeps connection management and sign-in off the action list", () => {
    for (const file of [
      "src/app/api/mcp/route.ts",
      "src/app/api/mcp/oauth/token/route.ts",
      "src/app/api/member/mcp-grants/[id]/route.ts",
      "src/app/api/admin/mcp/settings/route.ts",
      "src/app/api/auth/change-password/route.ts",
    ]) {
      expect(mcpPermanentExclusion(file, "POST"), file).toBe("auth-flow");
    }
  });

  it("fails a route in an area nobody has decided about", () => {
    expect(classifyMcpRoute("src/app/api/brand-new-area/route.ts", "POST")).toEqual({
      kind: "unclassified",
    });
  });

  it("gives every action one destination for each argument", () => {
    const ids = [...MCP_ACTIONS, ...MCP_WEBSITE_ONLY_ACTIONS].map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reserved of ["who_am_i", "find_actions", "describe_action", "run_action"]) {
      expect(ids).not.toContain(reserved);
    }

    for (const action of MCP_ACTIONS) {
      expect(action.id).toMatch(/^[a-z][a-z0-9_]{2,62}$/);
      const segments = [...action.path.matchAll(/\[([A-Za-z]+)\]/g)].map((match) => match[1]);
      expect(Object.keys(action.params?.shape ?? {}).sort(), action.id).toEqual(segments.sort());

      const keys = [
        ...Object.keys(action.params?.shape ?? {}),
        ...Object.keys(action.query?.shape ?? {}),
        ...Object.keys(action.body?.shape ?? {}),
      ];
      expect(new Set(keys).size, action.id).toBe(keys.length);
      for (const fixed of Object.keys(action.fixedBody ?? {})) {
        expect(keys, action.id).not.toContain(fixed);
      }
      // A GET carries no body, and only a GET or a pinned preview is ever a read.
      if (action.method === "GET") {
        expect(action.body, action.id).toBeUndefined();
        expect(action.fixedBody, action.id).toBeUndefined();
        expect(action.preview, action.id).toBeUndefined();
      } else if (action.preview) {
        expect(action.kind, action.id).toBe("read");
      } else {
        expect(action.kind, action.id).not.toBe("read");
      }
    }
  });

  it("runs as a read only the POSTs pinned as side-effect free", () => {
    const previews = MCP_ACTIONS.filter((action) => action.preview)
      .map((action) => stepUpRouteKey(mcpActionRouteFile(action), action.method))
      .sort();
    expect(previews).toEqual([...PREVIEW_ROUTE_KEYS].sort());
  });

  it("says what every action answers with", () => {
    for (const action of MCP_ACTIONS) {
      expect(Object.keys(action.returns).length, action.id).toBeGreaterThan(0);
    }
  });

  it("refuses as an address argument every static route name beside a folder an action fills", () => {
    // `get_member` with an `id` of `export` would otherwise reach the export route.
    const siblings = new Set<string>();
    for (const action of MCP_ACTIONS) {
      const segments = action.path.split("/").filter(Boolean);
      segments.forEach((segment, index) => {
        if (!/^\[.+\]$/.test(segment)) return;
        const dir = `src/app/${segments.slice(0, index).join("/")}`;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith("[") && entry.name !== "__tests__") {
            siblings.add(entry.name);
          }
        }
      });
    }
    expect([...MCP_STATIC_SIBLING_SEGMENTS].sort()).toEqual([...siblings].sort());
  });

  it("lists each permanently excluded member route by its exact method", () => {
    // The reason covers the method named, not a neighbour added beside it.
    expect(mcpPermanentExclusion("src/app/api/notices/[id]/acknowledge/route.ts", "POST")).toBe("declaration");
    expect(mcpPermanentExclusion("src/app/api/notices/[id]/acknowledge/route.ts", "DELETE")).toBeNull();
    expect(mcpPermanentExclusion("src/app/api/contact/route.ts", "POST")).toBe("public-visitor");
    expect(mcpPermanentExclusion("src/app/api/contact/extra/route.ts", "POST")).toBeNull();
    // ALP-795: confirming a partnership is the member's own; reading and ending one are actions.
    expect(mcpPermanentExclusion("src/app/api/members/partner-link/route.ts", "PUT")).toBe("declaration");
    expect(classifyMcpRoute("src/app/api/members/partner-link/route.ts", "DELETE").kind).toBe("action");
    expect(mcpPermanentExclusion("src/app/api/member/membership-cancellation-requests/route.ts", "POST")).toBe(
      "declaration",
    );
    expect(
      mcpPermanentExclusion("src/app/api/member/membership-cancellation-requests/confirm/route.ts", "POST"),
    ).toBe("needs-browser");
  });

  it("leaves nothing under the member family and cancellation routes undecided", () => {
    // ALP-795 removed their not-yet rule: a new route there fails the census until decided.
    expect(classifyMcpRoute("src/app/api/members/brand-new/route.ts", "GET")).toEqual({ kind: "unclassified" });
  });

  it("keeps the lodge door codes website-only for good", () => {
    // Not a lodge-life action waiting to be built: access details never go to an AI provider.
    expect(classifyMcpRoute("src/app/api/lodge-instructions/route.ts", "GET")).toEqual({
      kind: "excluded",
      reason: "access-secrets",
    });
  });
});
