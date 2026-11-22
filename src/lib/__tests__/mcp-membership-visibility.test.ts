/**
 * ALP-720 (`INV-MCP-006`): the Membership actions reach only an officer who
 * holds the Membership area. Anyone else is not shown them in `tools/list` or
 * `find_actions`, cannot have one described, and is told a call to one does
 * not exist, before anything runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/dispatch", () => ({
  runMcpAction: run,
  websiteOnlyAnswer: () => ({ isError: false, text: "Open the website." }),
}));

import type { Session } from "next-auth";

import { emptyAdminPermissionMatrix, type AdminPermissionLevel } from "@/lib/admin-permissions";
import { MEMBERSHIP_MCP_ACTIONS } from "@/lib/mcp/catalogue/membership";
import { callMcpTool, listMcpTools, type McpServerContext } from "@/lib/mcp/server";

import { adminSession } from "./helpers/sessions";

const MEMBERSHIP_IDS = new Set(MEMBERSHIP_MCP_ACTIONS.map((action) => action.id));
const MEMBERSHIP_READ_IDS = MEMBERSHIP_MCP_ACTIONS.filter((action) => action.kind === "read").map(
  (action) => action.id,
);

/** An officer whose matrix grants `membership` at `level` and the bookings area in full. */
function officerWithMembership(level: AdminPermissionLevel): Session {
  return adminSession({
    accessRoles: ["USER", "ADMIN_BOOKINGS"],
    adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), bookings: "edit", membership: level },
  });
}

function context(session: Session): McpServerContext {
  return {
    session,
    caller: {
      grantId: "grant-1",
      memberId: session.user.id,
      clientName: "Example Assistant",
      scope: "READ_WRITE",
      clientIp: "203.0.113.9",
      userAgent: null,
    },
  };
}

async function foundIds(session: Session): Promise<string[]> {
  const outcome = await callMcpTool(context(session), "find_actions", { query: "" });
  const { actions } = JSON.parse(outcome.text) as { actions: Array<{ id: string }> };
  return actions.map((action) => action.id);
}

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ isError: false, text: "ran" });
});

describe("an officer without the Membership area", () => {
  const session = officerWithMembership("none");

  it("is shown no Membership action in tools/list or find_actions", async () => {
    const listed = listMcpTools(context(session)).map((tool) => tool.name);
    expect(listed.filter((id) => MEMBERSHIP_IDS.has(id))).toEqual([]);
    expect((await foundIds(session)).filter((id) => MEMBERSHIP_IDS.has(id))).toEqual([]);
  });

  it("cannot have one described or run, and nothing is dispatched", async () => {
    for (const id of ["list_members", "get_member", "create_induction", "assign_committee_role"]) {
      expect((await callMcpTool(context(session), "describe_action", { id })).isError, id).toBe(true);
      expect((await callMcpTool(context(session), "run_action", { id, arguments: {} })).isError, id).toBe(true);
      expect((await callMcpTool(context(session), id, {})).isError, id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("an officer with the Membership area", () => {
  it("at view level is shown its reads and none of its changes", async () => {
    const found = (await foundIds(officerWithMembership("view"))).filter((id) => MEMBERSHIP_IDS.has(id));
    expect(found.sort()).toEqual([...MEMBERSHIP_READ_IDS].sort());
  });

  it("at edit level is shown every Membership action, and the core ones as tools", async () => {
    const session = officerWithMembership("edit");
    const found = (await foundIds(session)).filter((id) => MEMBERSHIP_IDS.has(id));
    expect(found.sort()).toEqual([...MEMBERSHIP_IDS].sort());

    const listed = listMcpTools(context(session)).map((tool) => tool.name);
    const core = MEMBERSHIP_MCP_ACTIONS.filter((action) => action.core).map((action) => action.id);
    expect(core.length).toBeGreaterThan(0);
    for (const id of core) expect(listed, id).toContain(id);
  });
});
