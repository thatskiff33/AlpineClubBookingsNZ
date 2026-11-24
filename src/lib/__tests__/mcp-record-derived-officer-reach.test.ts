/**
 * Officer reach read from records, not roles (`INV-MCP-006`).
 *
 * `memberOnlySessionUser` strips a connection's officer roles and permission
 * matrix, but some officer powers are worked out from database rows: an
 * active committee seat, a hut-leader assignment, being an applicant's
 * nominator, or a food-order officer setting. A connection keeps those rows,
 * so each predicate that reads them must sit behind a connection check before
 * it can widen what an AI app sees.
 *
 * This census follows every call of each predicate through `src/app/api` and
 * `src/lib`. A call is safe when the function around it carries the guard;
 * otherwise that function is followed to its own callers, until each path
 * reaches either a guarded function or a route method that is not an AI app
 * action. An unguarded path into a catalogued action fails, as does a
 * guarded site that moves without this list being updated.
 */
import { readdirSync, readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MCP_ACTIONS, mcpActionRouteFile } from "@/lib/mcp/catalogue";
import { STEP_UP_HTTP_METHODS } from "@/lib/step-up-routes";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";


const RECORD_DERIVED_OFFICER_PREDICATES = [
  // An active committee seat lets a member create events and see meeting links.
  { predicate: "canManageCalendarEvents", guard: "arrivesAsMcpConnection" },
  // Food-order officer and hut-leader reach over other members' orders.
  { predicate: "resolveFoodOrderViewer", guard: "ownOrdersOnlyFoodOrderViewer" },
  // A hut-leader assignment lets a member sign off others' inductions.
  { predicate: "hasActiveHutLeaderAssignment", guard: "arrivesAsMcpConnection" },
  // The nominator role: an applicant's nominators sign off their induction.
  { predicate: "resolveSignerRole", guard: "arrivesAsMcpConnection" },
] as const;

/** Where each predicate is held back from a connection: `file#function`. */
const GUARDED_SITES: Record<(typeof RECORD_DERIVED_OFFICER_PREDICATES)[number]["predicate"], string[]> = {
  canManageCalendarEvents: ["src/app/api/calendar/events/route.ts#GET"],
  resolveFoodOrderViewer: ["src/lib/food-order-route.ts#requireFoodOrderViewer"],
  hasActiveHutLeaderAssignment: ["src/lib/induction.ts#inductionSignerContext"],
  resolveSignerRole: [
    "src/app/api/inductions/[id]/route.ts#GET",
    "src/app/api/inductions/route.ts#GET",
  ],
};

const HTTP_METHODS: ReadonlySet<string> = new Set(STEP_UP_HTTP_METHODS);
const CATALOGUED = new Set(MCP_ACTIONS.map((action) => `${mcpActionRouteFile(action)}#${action.method}`));

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

const FILES = [...sourceFiles("src/app/api"), ...sourceFiles("src/lib")].sort();
const TEXT = new Map<string, string>();
function textOf(file: string): string {
  let text = TEXT.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    TEXT.set(file, text);
  }
  return text;
}

/** The name of the top-level function or `const` a node sits in, and its text. */
function enclosingTopLevel(node: ts.Node, source: ts.SourceFile): { name: string; text: string } | null {
  let current: ts.Node = node;
  while (current.parent && current.parent !== source) current = current.parent;
  if (ts.isFunctionDeclaration(current) && current.name) {
    return { name: current.name.text, text: current.getText(source) };
  }
  if (ts.isVariableStatement(current)) {
    const declaration = current.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) {
      return { name: declaration.name.text, text: current.getText(source) };
    }
  }
  return null;
}

interface CallSite {
  readonly file: string;
  readonly caller: string | null;
  readonly text: string;
}

function callSitesOf(name: string): CallSite[] {
  const sites: CallSite[] = [];
  const called = new RegExp(`\\b${name}\\s*\\(`);
  for (const file of FILES) {
    const text = textOf(file);
    if (!called.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        const around = enclosingTopLevel(node, source);
        sites.push({ file, caller: around?.name ?? null, text: around?.text ?? "" });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

function trace(predicate: string, guard: string) {
  const guarded = new Set<string>();
  const unguarded: string[] = [];
  const followed = new Set<string>([predicate]);
  const queue = [predicate];
  while (queue.length > 0) {
    const name = queue.shift()!;
    for (const site of callSitesOf(name)) {
      const where = `${site.file}#${site.caller ?? "<top level>"}`;
      if (site.caller === null) {
        unguarded.push(`${where} calls ${name}`);
      } else if (site.text.includes(guard)) {
        guarded.add(where);
      } else if (site.file.endsWith("/route.ts") && HTTP_METHODS.has(site.caller)) {
        // A route method no AI app action runs: a connection cannot reach it.
        if (CATALOGUED.has(where)) unguarded.push(`${where} calls ${name}`);
      } else if (!followed.has(site.caller)) {
        followed.add(site.caller);
        queue.push(site.caller);
      }
    }
  }
  return { guarded: [...guarded].sort(), unguarded };
}

describe("record-derived officer reach is held back from an AI app connection (INV-MCP-006)", () => {
  it.each(RECORD_DERIVED_OFFICER_PREDICATES)(
    "$predicate reaches a catalogued action only behind $guard",
    ({ predicate, guard }) => {
      const { guarded, unguarded } = trace(predicate, guard);
      expect(unguarded).toEqual([]);
      expect(guarded).toEqual(GUARDED_SITES[predicate]);
    },
    CENSUS_TIMEOUT_MS,
  );

  it("sees an unguarded path into a catalogued action", () => {
    // The census's own probe: the calendar's GET calls the committee check
    // behind its guard, so the same trace with a guard it lacks must fail it.
    const { unguarded } = trace("canManageCalendarEvents", "aGuardNoRouteCarries");
    expect(unguarded).toContain("src/app/api/calendar/events/route.ts#GET calls canManageCalendarEvents");
  }, CENSUS_TIMEOUT_MS);
});
