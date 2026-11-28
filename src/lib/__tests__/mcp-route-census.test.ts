import { readdirSync, readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { getAdminRouteRequirement, type AdminAccessRequirement } from "@/lib/admin-permissions";
import {
  MCP_ACTIONS,
  MCP_WEBSITE_ONLY_ACTIONS,
  mcpActionRouteFile,
} from "@/lib/mcp/catalogue";
import { CONTENT_MCP_ACTIONS } from "@/lib/mcp/catalogue/content";
import { MEMBERSHIP_MCP_ACTIONS } from "@/lib/mcp/catalogue/membership";
import {
  classifyMcpRoute,
  MCP_EXACT_EXCLUDED_ROUTES,
  MCP_NOT_YET_TASKS,
  MCP_PERMANENT_EXCLUSION_REASONS,
  mcpPermanentExclusion,
} from "@/lib/mcp/exclusions";
import { mcpActionAdminRequirement } from "@/lib/mcp/officer-actions";
import { MCP_STATIC_SIBLING_SEGMENTS } from "@/lib/mcp/static-route-segments";
import { fileExists, hasExport, unwrap, walkDir } from "@/lib/step-up-route-census-ast";
import { extractRouteGates, type HttpMethod } from "@/lib/__tests__/helpers/admin-route-explicit-permissions";
import {
  adminRouteApiPath,
  STEP_UP_HTTP_METHODS,
  STEP_UP_ROUTES,
  stepUpRouteKey,
} from "@/lib/step-up-routes";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

// The census parses every API route file once: a few seconds on an idle
// machine and several times that on a busy CI runner.
// The budget is the shared CENSUS_TIMEOUT_MS (src/test/census-timeout.ts).

const HTTP_METHODS: ReadonlySet<string> = new Set(STEP_UP_HTTP_METHODS);

/**
 * The only `POST`s that may run as a `read` (`preview: true`): each changes
 * no member's data, bookings included, and writes only the counters and audit
 * rows listed beside it, which a reviewer checked against the route. A view-only
 * connection runs them and the dispatcher writes no `MCP_ACTION_CALLED` audit
 * row, so adding one here is a decision.
 */
const PREVIEW_ROUTE_KEYS: readonly string[] = [
  // ALP-719: bed allocation's move and removal previews, and the member-link
  // check a booking request's quote runs before it is saved.
  "POST src/app/api/admin/bed-allocation/allocations/move/route.ts",
  "POST src/app/api/admin/bed-allocation/allocations/removal/route.ts",
  "POST src/app/api/admin/booking-requests/[id]/link-conflicts/route.ts",
  // ALP-724: the booking message and email template previews render wording
  // with sample data. They write nothing, not even an audit row.
  "POST src/app/api/admin/booking-messages/preview/route.ts",
  "POST src/app/api/admin/email-templates/preview/route.ts",
  // ALP-795: looks a member up by exact email; writes only its own audit row
  // and its rate-limit counters.
  "POST src/app/api/members/guest-candidates/resolve/route.ts",
  // ALP-794: prices and checks. They change none of the member's bookings.
  // What they do write, as the website's own call does:
  // - a RateLimitCounter upsert on every call: `mcpCall` for the connection
  //   (src/app/api/mcp/route.ts), and `bookingQuery` on quote, the
  //   change-request quote and promo validate;
  // - on quote, modify-quote and promo validate, when a member guest outside
  //   the family is named: the `memberGuestAddProbe` and daily probe counters,
  //   and on a refusal the probe's audit row (#2388).
  "POST src/app/api/bookings/quote/route.ts",
  "POST src/app/api/bookings/[id]/modify-quote/route.ts",
  "POST src/app/api/bookings/[id]/change-requests/quote/route.ts",
  "POST src/app/api/promo-codes/validate/route.ts",
];

const LODGE_EDIT: AdminAccessRequirement = { area: "lodge", level: "edit" };

/**
 * Officer actions on routes outside `/api/admin` (ALP-722), whose path names
 * no area. Each handler decides with a predicate of its own, not
 * `requireAdmin`, so the census checks that the handler calls the predicate
 * named here and that the entry's `requires` is the admin leg that predicate
 * always admits. A new one is a reviewed decision.
 */
const OFFICER_ROUTES_OUTSIDE_ADMIN: Readonly<
  Record<string, { readonly predicate: string; readonly requires: AdminAccessRequirement }>
> = {
  // The calendar's create gate admits Lodge edit (`hasCalendarManageViaAdmin`)
  // or a committee seat; a connection is held to the first.
  "POST /api/calendar/events": { predicate: "canEditCalendarEvents", requires: LODGE_EDIT },
  // Edit and delete: Lodge edit only.
  "PATCH /api/calendar/events/[id]": { predicate: "canEditCalendarEvents", requires: LODGE_EDIT },
  "DELETE /api/calendar/events/[id]": { predicate: "canEditCalendarEvents", requires: LODGE_EDIT },
};

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

/** The calls that cut an answer down for a connection (`INV-MCP-006`). */
const PROJECTIONS: ReadonlySet<string> = new Set(["connectionJson", "connectionListJson", "projectForConnection"]);

interface RouteHandler {
  readonly source: ts.SourceFile;
  readonly body: ts.Node | undefined;
}

/** One exported method's function, by `export async function` or `export const`. */
function routeHandler(file: string, method: string): RouteHandler {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === method && hasExport(statement)) {
      return { source, body: statement };
    }
    if (ts.isVariableStatement(statement) && hasExport(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === method,
      );
      if (declaration) return { source, body: declaration.initializer };
    }
  }
  return { source, body: undefined };
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : null;
}

/** Whether `node`, or a top-level function of the same file it calls, calls one of `names`. */
function handlerCalls({ source, body }: RouteHandler, names: ReadonlySet<string>): boolean {
  const localFunctions = new Map<string, ts.Node>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) localFunctions.set(statement.name.text, statement);
  }
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Node | undefined): boolean => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    let found = false;
    const walk = (child: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(child)) {
        const name = calleeName(child);
        if (name && names.has(name)) found = true;
        else if (name && localFunctions.has(name)) found = visit(localFunctions.get(name));
      }
      if (!found) ts.forEachChild(child, walk);
    };
    walk(node);
    return found;
  };
  return visit(body);
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
/** The finance workspace's API, which guards itself rather than through `requireAdmin`. */
function underFinanceWorkspace(path: string): boolean {
  return path === "/api/finance" || path.startsWith("/api/finance/");
}

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

  // ALP-718 decided its member routes; ALP-719 the Bookings & Beds officer
  // routes; ALP-722 the Lodge Operations ones; ALP-724 the Support & System
  // and Admin Overview ones.
  it.each(["ALP-718", "ALP-719", "ALP-722", "ALP-724"])("leaves no route waiting on %s, which decided its routes", (task) => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain(task);
    const waiting = routeMethods
      .filter((route) => {
        const result = classifyMcpRoute(route.file, route.method);
        return result.kind === "excluded" && result.reason === `not-yet:${task}`;
      })
      .map((route) => stepUpRouteKey(route.file, route.method));
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
    }
  });

  it("leaves no route waiting on ALP-723, which decided the Content admin area", () => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain("ALP-723");
    const content = routeMethods.filter(
      (route) => getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area === "content",
    );
    expect(content.length).toBeGreaterThan(30);
    const excluded: string[] = [];
    for (const route of content) {
      const result = classifyMcpRoute(route.file, route.method);
      expect(result.kind, `${route.method} ${route.file}`).not.toBe("unclassified");
      if (result.kind === "excluded") excluded.push(`${route.method} ${adminRouteApiPath(route.file)} ${result.reason}`);
    }
    // Only the file uploads stay on the website; nothing in the area needs a fresh proof.
    expect(excluded.sort()).toEqual([
      "POST /api/admin/image-library needs-browser",
      "POST /api/admin/image-manager/upload needs-browser",
      "POST /api/admin/site-style/logo needs-browser",
    ]);
    // The area is finished: a new content route has to be decided, not deferred.
    expect(classifyMcpRoute("src/app/api/admin/site-banners/brand-new/route.ts", "GET")).toEqual({ kind: "unclassified" });
  });

  it("runs every Content action on a route the area gates", () => {
    expect(CONTENT_MCP_ACTIONS.length).toBeGreaterThan(30);
    for (const action of CONTENT_MCP_ACTIONS) {
      expect(mcpActionAdminRequirement(action)?.area, action.id).toBe("content");
    }
  });

  it("brings every Bookings & Beds officer route in, or keeps it website-only for a stated reason", () => {
    const bookingsRoutes = routeMethods.filter(
      (route) => getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area === "bookings",
    );
    expect(bookingsRoutes.length).toBeGreaterThan(90);
    for (const route of bookingsRoutes) {
      const result = classifyMcpRoute(route.file, route.method);
      const key = stepUpRouteKey(route.file, route.method);
      expect(result.kind === "action" || (result.kind === "excluded" && !result.reason.startsWith("not-yet:")), key).toBe(true);
    }
    // A new route in a decided area is not covered by a neighbour's decision.
    expect(classifyMcpRoute("src/app/api/admin/bookings/[id]/brand-new/route.ts", "POST")).toEqual({
      kind: "unclassified",
    });
  });

  it("brings every Lodge Operations officer route in, or keeps it website-only for a stated reason", () => {
    const lodgeRoutes = routeMethods.filter(
      (route) => getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area === "lodge",
    );
    expect(lodgeRoutes.length).toBeGreaterThan(70);
    const undecided = lodgeRoutes
      .filter((route) => {
        const result = classifyMcpRoute(route.file, route.method);
        return !(result.kind === "action" || (result.kind === "excluded" && !result.reason.startsWith("not-yet:")));
      })
      .map((route) => stepUpRouteKey(route.file, route.method));
    expect(undecided).toEqual([]);
    // The kiosk, its PIN and the display screens stay with the kiosk; door
    // codes and the links that let someone in stay on the website.
    const reason = (file: string, method: string) => classifyMcpRoute(`src/app/api/${file}/route.ts`, method);
    expect(reason("admin/display/devices/[id]/pairing", "POST")).toEqual({ kind: "excluded", reason: "kiosk" });
    expect(reason("admin/display/layouts", "GET")).toEqual({ kind: "excluded", reason: "kiosk" });
    expect(reason("admin/display/brand-new", "GET")).toEqual({ kind: "unclassified" });
    expect(reason("admin/hut-leaders/[id]/pin", "POST")).toEqual({ kind: "excluded", reason: "kiosk" });
    expect(reason("admin/lodge", "PUT")).toEqual({ kind: "excluded", reason: "kiosk" });
    expect(reason("admin/lodge", "POST")).toEqual({ kind: "excluded", reason: "fresh-proof" });
    expect(reason("admin/lodge-instructions", "GET")).toEqual({ kind: "excluded", reason: "access-secrets" });
    expect(reason("admin/lodge-instructions", "PUT")).toEqual({ kind: "excluded", reason: "access-secrets" });
    expect(reason("admin/maintenance-reports/tokens", "POST")).toEqual({ kind: "excluded", reason: "access-secrets" });
    expect(reason("admin/maintenance-reports/tokens", "PATCH").kind).toBe("action");
    // How much of each name a lodge's roster shows is a privacy posture, as the
    // member-guest save is (owner decision D-18): an app may read it, never save it.
    expect(reason("admin/lodges/[id]/roster-settings", "GET").kind).toBe("action");
    expect(reason("admin/lodges/[id]/roster-settings", "PUT")).toEqual({ kind: "excluded", reason: "privacy-posture" });
    // A new route in the decided area is not covered by a neighbour's decision.
    expect(classifyMcpRoute("src/app/api/admin/hut-leaders/brand-new/route.ts", "GET")).toEqual({
      kind: "unclassified",
    });
  });

  it("brings every Support & System and Admin Overview route in, or keeps it website-only for a stated reason", () => {
    const supportRoutes = routeMethods.filter((route) => {
      const area = getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area;
      return area === "support" || area === "overview";
    });
    expect(supportRoutes.length).toBeGreaterThan(70);
    const undecided = supportRoutes
      .filter((route) => {
        const result = classifyMcpRoute(route.file, route.method);
        return !(result.kind === "action" || (result.kind === "excluded" && !result.reason.startsWith("not-yet:")));
      })
      .map((route) => stepUpRouteKey(route.file, route.method));
    expect(undecided).toEqual([]);
    const reason = (file: string, method: string) => classifyMcpRoute(`src/app/api/${file}/route.ts`, method);
    // The AI app connection settings stay website-only for good.
    expect(reason("admin/mcp/settings", "GET")).toEqual({ kind: "excluded", reason: "auth-flow" });
    expect(reason("admin/mcp/grants", "GET")).toEqual({ kind: "excluded", reason: "auth-flow" });
    expect(reason("admin/mcp/grants/[id]", "DELETE")).toEqual({ kind: "excluded", reason: "auth-flow" });
    // Fresh proof: backup restore, config import, credentials, modules, sign-in rules.
    for (const [file, method] of [
      ["admin/backups/restore", "POST"],
      ["admin/config-transfer/apply", "POST"],
      ["admin/modules", "PUT"],
      ["admin/security/password-policy", "PUT"],
      ["admin/access-roles", "POST"],
    ] as const) {
      expect(reason(file, method), `${method} ${file}`).toEqual({ kind: "excluded", reason: "fresh-proof" });
    }
    // Full Admin only: the officer gate offers actions by area and level.
    expect(reason("admin/club-format", "PUT")).toEqual({ kind: "excluded", reason: "full-admin" });
    expect(reason("admin/club-format", "GET").kind).toBe("action");
    expect(reason("admin/club-time-zone", "GET")).toEqual({ kind: "excluded", reason: "full-admin" });
    expect(reason("admin/environment-safety", "PATCH")).toEqual({ kind: "excluded", reason: "full-admin" });
    // A new route in a decided area is not covered by a neighbour's decision.
    expect(classifyMcpRoute("src/app/api/admin/issue-reports/brand-new/route.ts", "GET")).toEqual({
      kind: "unclassified",
    });
  });

  it("gives the Full Admin reason only to handlers that admit only a Full Admin", () => {
    // `requireAdmin({ permission: false })`: no area and level can express it,
    // so no catalogue entry could gate it (`INV-MCP-009`).
    const fullAdmin = routeMethods.filter(
      (route) => classifyMcpRoute(route.file, route.method).kind === "excluded" &&
        mcpPermanentExclusion(route.file, route.method) === "full-admin",
    );
    expect(fullAdmin.length).toBeGreaterThan(0);
    for (const route of fullAdmin) {
      const gate = extractRouteGates(readFileSync(route.file, "utf8")).gates[route.method as HttpMethod];
      expect(gate, `${route.method} ${route.file}`).toEqual({ kind: "explicit", permission: { kind: "full-admin" } });
    }
  });

  it("answers a connection on every officer action only through the connection projection", () => {
    // A member action's route may answer with a complete shape (stage 1); an
    // officer route also feeds the admin screens, so each catalogued handler
    // must project, itself or through a function of its own file.
    const unprojected = MCP_ACTIONS.filter((action) => mcpActionAdminRequirement(action) !== null)
      .filter((action) => !handlerCalls(routeHandler(mcpActionRouteFile(action), action.method), PROJECTIONS))
      .map((action) => stepUpRouteKey(mcpActionRouteFile(action), action.method));
    expect(unprojected).toEqual([]);
  });

  it("offers each officer action at exactly the permission its handler demands", () => {
    // A handler that names its own `requireAdmin` permission, directly or
    // through a shared guard wrapper, overrides the path's rule; the entry must
    // carry it as `requires`, and only then. The gate is read by the one
    // reader the admin authorization proof uses (`INV-SSOT-001`).
    // The finance workspace's own guards are read by the test after this one.
    const mismatched = MCP_ACTIONS.filter(
      (action) => mcpActionAdminRequirement(action) !== null && !underFinanceWorkspace(action.path),
    ).flatMap((action) => {
      const file = mcpActionRouteFile(action);
      if (!action.path.startsWith("/api/admin/")) {
        // Outside `/api/admin` only a pinned route may be an officer action.
        const pinned = OFFICER_ROUTES_OUTSIDE_ADMIN[`${action.method} ${action.path}`];
        const ok =
          pinned !== undefined &&
          JSON.stringify(action.requires) === JSON.stringify(pinned.requires) &&
          handlerCalls(routeHandler(file, action.method), new Set([pinned.predicate]));
        return ok ? [] : [`${action.id}: outside /api/admin, pinned ${JSON.stringify(pinned)}`];
      }
      const gate = extractRouteGates(readFileSync(file, "utf8")).gates[action.method as HttpMethod];
      const ok = gate?.kind === "inferred"
        ? action.requires === undefined
        : gate?.kind === "explicit" && gate.permission.kind === "requirement"
          ? JSON.stringify(mcpActionAdminRequirement(action)) === JSON.stringify(gate.permission.requirement)
          // "any-admin" is looser than the path's rule: the catalogue keeps
          // the stricter path rule, failing closed. Full Admin only, or a gate
          // the reader cannot resolve, has no entry that could match it.
          : gate?.kind === "explicit" && gate.permission.kind === "any-admin" && action.requires === undefined;
      return ok ? [] : [`${action.id}: handler ${JSON.stringify(gate)}, entry ${JSON.stringify(action.requires)}`];
    });
    expect(mismatched).toEqual([]);
    // Every pinned outside route is a catalogued officer action.
    const officerRoutes = new Set(
      MCP_ACTIONS.filter((action) => action.requires !== undefined).map((action) => `${action.method} ${action.path}`),
    );
    expect(Object.keys(OFFICER_ROUTES_OUTSIDE_ADMIN).filter((route) => !officerRoutes.has(route))).toEqual([]);
  });

  it("offers each finance workspace action at the level its own guard enforces", () => {
    // `/api/finance` routes guard themselves rather than through `requireAdmin`,
    // and the path's rule goes by method alone, so `requires` must name the
    // level the handler's guard demands (ALP-721).
    const workspace = MCP_ACTIONS.filter((action) => underFinanceWorkspace(action.path));
    expect(workspace.length).toBeGreaterThan(0);
    for (const action of workspace) {
      const source = handlerSource(mcpActionRouteFile(action), action.method) ?? "";
      const guard = action.requires?.level === "view" ? "requireFinanceViewerApiAccess(" : "requireFinanceManagerApiAccess(";
      expect(action.requires?.area, action.id).toBe("finance");
      expect(source.includes(guard), `${action.id} calls ${guard}`).toBe(true);
    }
  });

  it("leaves no route waiting on ALP-721, which decided the Finance admin area", () => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain("ALP-721");
    const finance = routeMethods.filter(
      (route) => getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area === "finance",
    );
    expect(finance.length).toBeGreaterThan(60);
    for (const route of finance) {
      const result = classifyMcpRoute(route.file, route.method);
      expect(result.kind, `${route.method} ${route.file}`).not.toBe("unclassified");
      if (result.kind === "excluded") expect(result.reason, `${route.method} ${route.file}`).not.toMatch(/^not-yet:/);
    }
    // Finance is finished: a new finance route has to be decided, not deferred.
    expect(classifyMcpRoute("src/app/api/admin/xero/brand-new/route.ts", "GET")).toEqual({ kind: "unclassified" });
    expect(classifyMcpRoute("src/app/api/finance/brand-new/route.ts", "GET")).toEqual({ kind: "unclassified" });
  });

  it("keeps the Finance money and setup routes the owner kept website-only off the catalogue", () => {
    // #5305 comment 7131138226: item 1, Stripe-touching money; item 4, setup.
    // Comment 7200981104: a subscription marked paid by hand, as booking mark-paid.
    const ownerDecided: Array<[string, string, string]> = [
      ["src/app/api/admin/bookings/[id]/mark-paid/route.ts", "POST", "moves-money"],
      ["src/app/api/admin/bookings/[id]/additional-payment/withdraw/route.ts", "POST", "moves-money"],
      ["src/app/api/admin/subscriptions/[id]/manual-payment/route.ts", "POST", "moves-money"],
      ["src/app/api/admin/internet-banking-settings/route.ts", "PUT", "club-setup"],
      ["src/app/api/admin/fee-configuration/route.ts", "POST", "club-setup"],
      ["src/app/api/admin/club-tax/route.ts", "PUT", "club-setup"],
      ["src/app/api/admin/xero/account-mappings/route.ts", "PUT", "club-setup"],
      ["src/app/api/admin/xero/item-code-mappings/route.ts", "PUT", "club-setup"],
      ["src/app/api/admin/integrations/credentials/route.ts", "GET", "club-setup"],
      ["src/app/api/admin/xero/connect/route.ts", "GET", "club-setup"],
    ];
    for (const [file, method, reason] of ownerDecided) {
      expect(classifyMcpRoute(file, method), `${method} ${file}`).toEqual({ kind: "excluded", reason });
    }
  });

  it("excludes every handler that asks for a fresh proof itself", () => {
    // A connection never holds one (INV-MCP-005), so such a handler could only ever refuse it.
    const asking = routeMethods.filter((route) => handlerSource(route.file, route.method)?.includes("requireRecentAuth("));
    expect(asking.length).toBeGreaterThan(0);
    for (const route of asking) {
      expect(classifyMcpRoute(route.file, route.method), `${route.method} ${route.file}`).toEqual({
        kind: "excluded",
        reason: "fresh-proof",
      });
    }
  });

  it("gives the fresh-proof reason only to a route that still asks for one", () => {
    // The reverse: a hand-listed handler that stops asking for a fresh proof
    // must not stay excluded under a reason that is no longer true.
    const stepUp = new Set(STEP_UP_ROUTES.map((route) => stepUpRouteKey(route.file, route.method)));
    const freshProof = routeMethods.filter((route) => {
      const result = classifyMcpRoute(route.file, route.method);
      return result.kind === "excluded" && result.reason === "fresh-proof";
    });
    expect(freshProof.length).toBeGreaterThan(0);
    for (const route of freshProof) {
      const asks =
        stepUp.has(stepUpRouteKey(route.file, route.method)) ||
        Boolean(handlerSource(route.file, route.method)?.includes("requireRecentAuth("));
      expect(asks, `${route.method} ${route.file}`).toBe(true);
    }
  });

  it("points every catalogue entry at a route method that exists", () => {
    const stale = MCP_ACTIONS.filter(
      (action) => !routeKeys.has(stepUpRouteKey(mcpActionRouteFile(action), action.method)),
    ).map((action) => action.id);
    expect(stale).toEqual([]);
  });

  it("decides officer reach in a catalogued member route only on the member-only user", () => {
    const methodsByFile = new Map<string, Set<string>>();
    // An officer action's route decides with the officer's own permissions,
    // as the admin screen does: only member actions are read here.
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

  it.each([
    "post_to_message_board",
    "place_food_order",
    "report_maintenance_issue",
    "confirm_family_member_details",
    "request_whole_lodge",
    // Cannot be undone: a booking keeps its one group and its payment mode.
    "open_group_booking",
  ])(
    "marks %s destructive: it notifies other people or overwrites another person's record (#5305)",
    (id) => {
      // Owner decision, #5305 comment 7092977781: the app confirms with the
      // member first, and the call is audited as important.
      expect(MCP_ACTIONS.find((action) => action.id === id)?.kind).toBe("destructive");
    },
  );

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

  it("decides every lodge-life route (ALP-796) and its officer powers (ALP-722)", () => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain("ALP-796");
    const route = (file: string, method: string) => classifyMcpRoute(`src/app/api/${file}/route.ts`, method);
    const actionId = (file: string, method: string) => {
      const result = route(file, method);
      return result.kind === "action" ? result.action.id : result;
    };
    // Editing the calendar is a Lodge edit officer action, as on `/admin/calendar`.
    expect(actionId("calendar/events", "POST")).toBe("create_calendar_event");
    expect(actionId("calendar/events/[id]", "PATCH")).toBe("update_calendar_event");
    expect(actionId("calendar/events/[id]", "DELETE")).toBe("delete_calendar_event");
    // A meeting's host link carries shared host credentials.
    expect(route("calendar/events/[id]/join", "POST")).toEqual({ kind: "excluded", reason: "access-secrets" });
    // A connection reads only its member's own food orders, so it never sees the order it would change.
    expect(route("food-orders/[id]/price", "PATCH")).toEqual({ kind: "excluded", reason: "unread-value" });
    expect(route("food-orders/[id]/received", "POST")).toEqual({ kind: "excluded", reason: "unread-value" });
    expect(route("chores/roster/[date]/print", "GET")).toEqual({ kind: "excluded", reason: "needs-browser" });
    // The member's side of the same routes is an action.
    expect(route("calendar/events", "GET").kind).toBe("action");
    expect(mcpPermanentExclusion("src/app/api/inductions/[id]/sign-off/route.ts", "POST")).toBe("declaration");
    expect(mcpPermanentExclusion("src/app/api/club-posts/images/route.ts", "POST")).toBe("needs-browser");
    // Exact, not a prefix: a new route beside an excluded one is undecided.
    expect(route("calendar/events/[id]/attendees", "GET")).toEqual({ kind: "unclassified" });
    expect(route("food-orders/[id]/price", "PUT")).toEqual({ kind: "unclassified" });
  });

  it("leaves no member route waiting: stage 2 (ALP-718's five follow-ons) decided them all", () => {
    const stage2 = ["ALP-718", "ALP-794", "ALP-795", "ALP-796", "ALP-797"];
    for (const task of stage2) expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain(task);
    const waiting = routeMethods.filter((route) => {
      const result = classifyMcpRoute(route.file, route.method);
      return result.kind === "excluded" && stage2.some((task) => result.reason === `not-yet:${task}`);
    });
    expect(waiting).toEqual([]);
    // A new route beside the group and whole-lodge routes is undecided, not waiting.
    expect(classifyMcpRoute("src/app/api/group-bookings/[code]/brand-new/route.ts", "POST")).toEqual({
      kind: "unclassified",
    });
    expect(classifyMcpRoute("src/app/api/booking-requests/brand-new/route.ts", "GET")).toEqual({
      kind: "unclassified",
    });
  });

  it("decides every group-booking and whole-lodge route (ALP-797)", () => {
    const route = (file: string, method: string) => classifyMcpRoute(`src/app/api/${file}/route.ts`, method);
    const actionId = (file: string, method: string) => {
      const result = route(file, method);
      return result.kind === "action" ? result.action.id : result;
    };
    expect(actionId("booking-requests/whole-lodge", "GET")).toBe("list_my_whole_lodge_requests");
    expect(actionId("booking-requests/whole-lodge", "POST")).toBe("request_whole_lodge");
    expect(actionId("booking-requests/whole-lodge/[id]/withdraw", "POST")).toBe("withdraw_whole_lodge_request");
    expect(actionId("group-bookings", "POST")).toBe("open_group_booking");
    expect(actionId("group-bookings/[code]", "GET")).toBe("get_group_booking");
    expect(actionId("group-bookings/[code]", "PATCH")).toBe("set_group_booking_joining");
    // Joining a group and paying its combined bill move money.
    expect(route("group-bookings/[code]/join", "POST")).toEqual({ kind: "excluded", reason: "moves-money" });
    expect(route("group-bookings/[code]/settle", "POST")).toEqual({ kind: "excluded", reason: "moves-money" });
    // The visitor forms.
    for (const [file, method] of [
      ["booking-requests", "POST"],
      ["booking-requests/quote", "POST"],
      ["booking-requests/settings", "GET"],
      ["booking-requests/school", "POST"],
      ["group-bookings/[code]/join-request", "POST"],
    ] as const) {
      expect(route(file, method), `${method} ${file}`).toEqual({ kind: "excluded", reason: "public-visitor" });
    }
    // Emailed links.
    expect(route("school-bookings/confirm-attendees", "POST")).toEqual({ kind: "excluded", reason: "needs-browser" });
    expect(route("group-bookings/join/verify/[token]", "POST")).toEqual({ kind: "excluded", reason: "needs-browser" });
    expect(route("booking-requests/respond/[token]", "POST")).toEqual({ kind: "excluded", reason: "needs-browser" });
  });

  it("names only route methods that exist in every exact exclusion (ALP-796 review)", () => {
    // `METHOD /api/path` → the route file's key; a stale entry would excuse a
    // route that is gone, or hide a typo that leaves the real one undecided.
    expect(MCP_EXACT_EXCLUDED_ROUTES).toContain("POST /api/calendar/events/[id]/join");
    const stale = MCP_EXACT_EXCLUDED_ROUTES.filter((route) => {
      const [method = "", path = ""] = route.split(" ");
      return !routeKeys.has(stepUpRouteKey(`src/app${path}/route.ts`, method));
    });
    expect(stale).toEqual([]);
  });

  it("keeps the lodge door codes website-only for good", () => {
    // Not a lodge-life action waiting to be built: access details never go to an AI provider.
    expect(classifyMcpRoute("src/app/api/lodge-instructions/route.ts", "GET")).toEqual({
      kind: "excluded",
      reason: "access-secrets",
    });
  });
});
