import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  MCP_ACTIONS,
  MCP_WEBSITE_ONLY_ACTIONS,
  mcpActionAdminRequirement,
  mcpActionRouteFile,
} from "@/lib/mcp/catalogue";
import {
  classifyMcpRoute,
  MCP_EXACT_EXCLUDED_ROUTES,
  MCP_FINANCE_NOT_YET_ROUTES,
  MCP_NOT_YET_TASKS,
  MCP_PERMANENT_EXCLUSION_REASONS,
  mcpPermanentExclusion,
} from "@/lib/mcp/exclusions";
import { fileExists, hasExport, unwrap, walkDir } from "@/lib/step-up-route-census-ast";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
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

  // ALP-718 decided its member routes; ALP-719 the Bookings & Beds officer routes.
  it.each(["ALP-718", "ALP-719"])("leaves no route waiting on %s, which decided its routes", (task) => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain(task);
    const waiting = routeMethods
      .filter((route) => {
        const result = classifyMcpRoute(route.file, route.method);
        return result.kind === "excluded" && result.reason === `not-yet:${task}`;
      })
      .map((route) => stepUpRouteKey(route.file, route.method));
    expect(waiting).toEqual([]);
  });

  it("brings every Bookings & Beds officer route in, or keeps it website-only for a stated reason", () => {
    const bookingsRoutes = routeMethods.filter(
      (route) => getAdminRouteRequirement(adminRouteApiPath(route.file), route.method)?.area === "bookings",
    );
    expect(bookingsRoutes.length).toBeGreaterThan(90);
    for (const route of bookingsRoutes) {
      const result = classifyMcpRoute(route.file, route.method);
      const key = stepUpRouteKey(route.file, route.method);
      // Only the money routes the owner handed to the Finance lane wait on it
      // (#5305 comment 7093303964, item 3).
      if (MCP_FINANCE_NOT_YET_ROUTES.includes(`${route.method} ${adminRouteApiPath(route.file)}`)) {
        expect(result, key).toEqual({ kind: "excluded", reason: "not-yet:ALP-721" });
        continue;
      }
      expect(result.kind === "action" || (result.kind === "excluded" && !result.reason.startsWith("not-yet:")), key).toBe(true);
    }
    expect(MCP_FINANCE_NOT_YET_ROUTES).toEqual(["POST /api/admin/bookings/[id]/additional-payment/withdraw"]);
    // A new route in a decided area is not covered by a neighbour's decision.
    expect(classifyMcpRoute("src/app/api/admin/bookings/[id]/brand-new/route.ts", "POST")).toEqual({
      kind: "unclassified",
    });
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
    const mismatched = MCP_ACTIONS.filter((action) => mcpActionAdminRequirement(action) !== null).flatMap((action) => {
      const file = mcpActionRouteFile(action);
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

  it("decides every lodge-life route (ALP-796), handing its officer powers to the officer stages", () => {
    expect(Object.values(MCP_NOT_YET_TASKS)).not.toContain("ALP-796");
    const officer = (file: string, method: string) => classifyMcpRoute(`src/app/api/${file}/route.ts`, method);
    expect(officer("calendar/events", "POST")).toEqual({ kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.lodge}` });
    expect(officer("calendar/events/[id]/join", "POST")).toEqual({ kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.lodge}` });
    // Lodge edit, the area `canEditCalendarEvents` checks, as for `/admin/calendar`.
    expect(officer("calendar/events/[id]", "DELETE")).toEqual({ kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.lodge}` });
    expect(officer("food-orders/[id]/price", "PATCH")).toEqual({ kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.lodge}` });
    expect(officer("chores/roster/[date]/print", "GET")).toEqual({ kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.lodge}` });
    // The member's side of the same routes is an action.
    expect(officer("calendar/events", "GET").kind).toBe("action");
    expect(mcpPermanentExclusion("src/app/api/inductions/[id]/sign-off/route.ts", "POST")).toBe("declaration");
    expect(mcpPermanentExclusion("src/app/api/club-posts/images/route.ts", "POST")).toBe("needs-browser");
    // Exact, not a prefix: a new route beside an officer one is undecided.
    expect(officer("calendar/events/[id]/attendees", "GET")).toEqual({ kind: "unclassified" });
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
    expect(MCP_EXACT_EXCLUDED_ROUTES).toContain("POST /api/calendar/events");
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
