/**
 * Who is offered the Bookings & Beds officer actions (ALP-719): only someone
 * holding that admin area, at the level the route itself demands. Anyone else
 * never meets them in `tools/list`, `find_actions` or `describe_action`, and
 * cannot run one by name.
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
import { callMcpTool, listMcpTools, type McpServerContext } from "@/lib/mcp/server";

// Every action on a Bookings & Beds route, and those of them the area alone
// unlocks: a route may name a stricter permission of its own (`requires`).
const AREA_ROUTE_ACTIONS = MCP_ACTIONS.filter(
  (action) => getAdminRouteRequirement(action.path, action.method)?.area === "bookings",
);
const BOOKINGS_ACTIONS = AREA_ROUTE_ACTIONS.filter((action) => mcpActionAdminRequirement(action)?.area === "bookings");

const NO_AREAS: AdminPermissionMatrix = {
  overview: "none", bookings: "none", membership: "none", finance: "none",
  lodge: "none", content: "none", support: "none",
};

function context(matrix: Partial<AdminPermissionMatrix>): McpServerContext {
  return {
    caller: {
      grantId: "grant-1", memberId: "officer-1", clientName: "Example Assistant",
      scope: "READ_WRITE", clientIp: "203.0.113.9", userAgent: null,
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

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ isError: false, text: "ran" });
});

describe("Bookings & Beds officer actions: who is offered them", () => {
  it("covers both reads and changes, so the checks below mean something", () => {
    expect(BOOKINGS_ACTIONS.some((action) => action.kind === "read" && action.core)).toBe(true);
    expect(BOOKINGS_ACTIONS.some((action) => action.kind !== "read")).toBe(true);
  });

  it("never shows them to an officer who holds every other area but not Bookings & Beds", async () => {
    const ctx = context({
      overview: "edit", membership: "edit", finance: "edit", lodge: "edit", content: "edit", support: "edit",
    });
    const ids = new Set(BOOKINGS_ACTIONS.map((action) => action.id));

    expect(listMcpTools(ctx).filter((tool) => ids.has(tool.name))).toEqual([]);
    expect((await foundIds(ctx)).filter((id) => ids.has(id))).toEqual([]);
    for (const action of BOOKINGS_ACTIONS) {
      expect((await callMcpTool(ctx, "describe_action", { id: action.id })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, "run_action", { id: action.id, arguments: {} })).isError, action.id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("never shows them to a member with no admin area", async () => {
    const ctx = context({});
    const ids = new Set(BOOKINGS_ACTIONS.map((action) => action.id));
    expect((await foundIds(ctx)).filter((id) => ids.has(id))).toEqual([]);
    expect(listMcpTools(ctx).filter((tool) => ids.has(tool.name))).toEqual([]);
  });

  it("offers a view-only officer the reads and none of the changes the screens need edit for", async () => {
    const ctx = context({ bookings: "view" });
    const found = new Set(await foundIds(ctx));
    for (const action of BOOKINGS_ACTIONS) {
      const needsEdit = mcpActionAdminRequirement(action)?.level === "edit";
      expect(found.has(action.id), action.id).toBe(!needsEdit);
    }
  });

  it("offers an action on a Bookings & Beds route at the stricter permission its route names", async () => {
    const withdraw = AREA_ROUTE_ACTIONS.find((action) => action.id === "withdraw_additional_payment_request");
    expect(withdraw && mcpActionAdminRequirement(withdraw)).toEqual({ area: "finance", level: "edit" });
    expect(await foundIds(context({ bookings: "edit" }))).not.toContain("withdraw_additional_payment_request");
    expect(await foundIds(context({ bookings: "edit", finance: "edit" }))).toContain("withdraw_additional_payment_request");

    const viewOnly = new Set(await foundIds(context({ bookings: "view" })));
    expect(viewOnly.has("get_member_family_for_booking")).toBe(false);
    expect(viewOnly.has("search_non_member_contacts")).toBe(false);
  });

  it("offers an officer with Bookings & Beds edit every action, and runs one by name", async () => {
    const ctx = context({ bookings: "edit" });
    const found = new Set(await foundIds(ctx));
    expect(BOOKINGS_ACTIONS.filter((action) => !found.has(action.id))).toEqual([]);

    const core = BOOKINGS_ACTIONS.filter((action) => action.core).map((action) => action.id);
    const listed = listMcpTools(ctx).map((tool) => tool.name);
    for (const id of core) expect(listed).toContain(id);

    const first = BOOKINGS_ACTIONS[0];
    await callMcpTool(ctx, "run_action", { id: first?.id, arguments: {} });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: first?.id }), {}, ctx.caller);
  });
});
