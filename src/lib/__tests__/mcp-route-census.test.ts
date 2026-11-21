import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  MCP_ACTIONS,
  MCP_WEBSITE_ONLY_ACTIONS,
  mcpActionRouteFile,
} from "@/lib/mcp/catalogue";
import {
  classifyMcpRoute,
  MCP_NOT_YET_TASKS,
  MCP_PERMANENT_EXCLUSION_REASONS,
  mcpPermanentExclusion,
} from "@/lib/mcp/exclusions";
import { fileExists, hasExport, walkDir } from "@/lib/step-up-route-census-ast";
import {
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
 * nothing, which a reviewer checked against the route. A view-only connection
 * runs them and no audit row is written, so adding one here is a decision.
 */
const PREVIEW_ROUTE_KEYS: readonly string[] = [];

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

  it("points every catalogue entry at a route method that exists", () => {
    const stale = MCP_ACTIONS.filter(
      (action) => !routeKeys.has(stepUpRouteKey(mcpActionRouteFile(action), action.method)),
    ).map((action) => action.id);
    expect(stale).toEqual([]);
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

  it("lists each permanently excluded member route by its exact method", () => {
    // The reason covers the method named, not a neighbour added beside it.
    expect(mcpPermanentExclusion("src/app/api/notices/[id]/acknowledge/route.ts", "POST")).toBe("declaration");
    expect(mcpPermanentExclusion("src/app/api/notices/[id]/acknowledge/route.ts", "DELETE")).toBeNull();
    expect(mcpPermanentExclusion("src/app/api/contact/route.ts", "POST")).toBe("public-visitor");
    expect(mcpPermanentExclusion("src/app/api/contact/extra/route.ts", "POST")).toBeNull();
  });
});
