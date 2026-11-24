/**
 * Who is offered the Lodge Operations officer actions (ALP-722): only someone
 * holding that admin area, at the level the route itself demands. Anyone else
 * never meets them in `tools/list`, `find_actions` or `describe_action`, and
 * cannot run one by name. Also pins their kinds: every change is
 * `destructive` (owner decision, #5305).
 */
import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/dispatch", () => ({
  runMcpAction: run,
  websiteOnlyAnswer: () => ({ isError: false, text: "Nothing was done. Open the website." }),
}));

import { getAdminRouteRequirement, type AdminPermissionMatrix } from "@/lib/admin-permissions";
import { MCP_ACTIONS, mcpActionAdminRequirement } from "@/lib/mcp/catalogue";
import { LODGE_MCP_ACTIONS } from "@/lib/mcp/catalogue/lodge";
import { callMcpTool, listMcpTools, type McpServerContext } from "@/lib/mcp/server";

const NO_AREAS: AdminPermissionMatrix = {
  overview: "none", bookings: "none", membership: "none", finance: "none",
  lodge: "none", content: "none", support: "none",
};

/** An officer's connection, approved on the officer screen. */
function context(matrix: Partial<AdminPermissionMatrix>): McpServerContext {
  return {
    caller: {
      grantId: "grant-1", memberId: "officer-1", clientName: "Example Assistant",
      scope: "READ_WRITE", officerConsent: true, clientIp: "203.0.113.9", userAgent: null,
    },
    session: {
      user: {
        id: "officer-1", name: "Ana Reid", email: "ana@example.test", role: "USER",
        canLogin: true, adminPermissionMatrix: { ...NO_AREAS, ...matrix },
      },
      expires: "2026-07-02T00:00:00.000Z",
    } as unknown as Session,
  };
}

async function foundIds(ctx: McpServerContext): Promise<string[]> {
  const outcome = await callMcpTool(ctx, "find_actions", {});
  return (JSON.parse(outcome.text) as { actions: Array<{ id: string }> }).actions.map((action) => action.id);
}

const ids = new Set(LODGE_MCP_ACTIONS.map((action) => action.id));

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ isError: false, text: "ran" });
});

describe("Lodge Operations officer actions: who is offered them", () => {
  it("is every catalogued action on a Lodge Operations route, and each needs that area", () => {
    const onLodgeRoutes = MCP_ACTIONS.filter(
      (action) => getAdminRouteRequirement(action.path, action.method)?.area === "lodge",
    );
    expect(onLodgeRoutes.filter((action) => !ids.has(action.id)).map((action) => action.id)).toEqual([]);
    for (const action of LODGE_MCP_ACTIONS) {
      expect(mcpActionAdminRequirement(action)?.area, action.id).toBe("lodge");
    }
    expect(LODGE_MCP_ACTIONS.some((action) => action.kind === "read" && action.core)).toBe(true);
    expect(LODGE_MCP_ACTIONS.some((action) => action.kind !== "read")).toBe(true);
  });

  it("never shows them to an officer who holds every other area but not Lodge Operations", async () => {
    const ctx = context({
      overview: "edit", bookings: "edit", membership: "edit", finance: "edit", content: "edit", support: "edit",
    });
    expect(listMcpTools(ctx).filter((tool) => ids.has(tool.name))).toEqual([]);
    expect((await foundIds(ctx)).filter((id) => ids.has(id))).toEqual([]);
    for (const action of LODGE_MCP_ACTIONS) {
      expect((await callMcpTool(ctx, "describe_action", { id: action.id })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, "run_action", { id: action.id, arguments: {} })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, action.id, {})).isError, action.id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("never shows them to a member with no admin area, the calendar edits included", async () => {
    const found = await foundIds(context({}));
    expect(found.filter((id) => ids.has(id))).toEqual([]);
    // The member's own calendar read stays.
    expect(found).toContain("list_club_events");
  });

  it("offers a view-only officer the reads and none of the changes", async () => {
    const found = new Set(await foundIds(context({ lodge: "view" })));
    for (const action of LODGE_MCP_ACTIONS) {
      expect(found.has(action.id), action.id).toBe(action.kind === "read");
    }
    expect(found.has("create_calendar_event")).toBe(false);
  });

  it("offers an officer with Lodge Operations edit every action, lists the core one, and runs one by name", async () => {
    const ctx = context({ lodge: "edit" });
    const found = new Set(await foundIds(ctx));
    expect(LODGE_MCP_ACTIONS.filter((action) => !found.has(action.id)).map((action) => action.id)).toEqual([]);
    const listed = listMcpTools(ctx).map((tool) => tool.name);
    expect(listed).toContain("list_hut_leaders");

    await callMcpTool(ctx, "run_action", { id: "create_calendar_event", arguments: {} });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "create_calendar_event" }), {}, ctx.caller);
  });
});

// Owner decisions on #5305: an action that notifies other people or
// overwrites another person's record is `destructive` (comment 7092977781),
// and so is every change to club-wide configuration (comment 7093303964).
// Lodge Operations changes are all one or the other: hut leader assignments
// and rosters (another member's record, often emailed), chores, work parties,
// lodges and their settings, maintenance reports, the calendar.
describe("Lodge Operations officer actions: kinds", () => {
  it("has no `write`: every change asks the officer first", () => {
    expect(LODGE_MCP_ACTIONS.filter((action) => action.kind === "write").map((action) => action.id)).toEqual([]);
  });

  it("runs as a read only a GET", () => {
    for (const action of LODGE_MCP_ACTIONS) {
      expect(action.kind === "read", action.id).toBe(action.method === "GET");
    }
  });
});
