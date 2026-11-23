/**
 * ALP-721 (`INV-MCP-009`): an officer without the Finance admin area is never
 * shown a Finance action, and one holding it only at view is never shown an
 * action whose route needs edit. Not in the tool list, not from
 * `find_actions` or `describe_action`, and `run_action` answers as if the
 * action did not exist, without calling the site.
 *
 * Each finance action's requirement comes from the admin route map, or from
 * its own `requires` for `/api/finance` (held to the route's guard by the
 * census), so this walks every one rather than a sample.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ runMcpAction: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/dispatch", () => ({
  runMcpAction: h.runMcpAction,
  websiteOnlyAnswer: vi.fn(),
}));
vi.mock("@/lib/app-url", () => ({ getAppBaseUrl: () => "https://club.example.test" }));
vi.mock("@/lib/app-version", () => ({ getAppVersion: () => "test" }));

import { adminSession, memberSession } from "@/lib/__tests__/helpers/sessions";
import { MCP_ACTIONS, type McpAction } from "@/lib/mcp/catalogue";
import { mcpActionAdminRequirement } from "@/lib/mcp/officer-actions";
import { callMcpTool, listMcpTools, type McpServerContext } from "@/lib/mcp/server";
import type { Session } from "next-auth";

const FINANCE_ACTIONS = MCP_ACTIONS.filter((action) => mcpActionAdminRequirement(action)?.area === "finance");
const VIEW_ACTIONS = FINANCE_ACTIONS.filter((action) => mcpActionAdminRequirement(action)?.level === "view");
const EDIT_ACTIONS = FINANCE_ACTIONS.filter((action) => mcpActionAdminRequirement(action)?.level === "edit");

function context(session: Session): McpServerContext {
  return {
    session,
    caller: {
      grantId: "grant-1",
      memberId: session.user.id,
      clientName: "Test app",
      scope: "READ_WRITE",
      clientIp: "203.0.113.9",
      userAgent: null,
    },
  };
}

async function visibleFinanceIds(session: Session): Promise<string[]> {
  const found = await callMcpTool(context(session), "find_actions", { query: "" });
  const listed = (JSON.parse(found.text) as { actions: Array<{ id: string }> }).actions.map((action) => action.id);
  const tools = listMcpTools(context(session)).map((tool) => tool.name);
  const ids = new Set(FINANCE_ACTIONS.map((action) => action.id));
  return [...new Set([...listed, ...tools])].filter((id) => ids.has(id)).sort();
}

const ids = (actions: readonly McpAction[]) => actions.map((action) => action.id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  h.runMcpAction.mockResolvedValue({ isError: false, text: "ran" });
});

describe("who is shown the Finance actions", () => {
  it("has finance actions at both levels to check", () => {
    expect(VIEW_ACTIONS.length).toBeGreaterThan(0);
    expect(EDIT_ACTIONS.length).toBeGreaterThan(0);
  });

  it("shows none to an officer of another area, or to a member", async () => {
    const contentOfficer = adminSession({ id: "content-1", accessRoles: ["USER", "ADMIN_CONTENT"] });
    for (const session of [contentOfficer, memberSession()]) {
      expect(await visibleFinanceIds(session)).toEqual([]);
      for (const action of FINANCE_ACTIONS) {
        const described = await callMcpTool(context(session), "describe_action", { id: action.id });
        expect(described.isError, action.id).toBe(true);
        const ran = await callMcpTool(context(session), "run_action", { id: action.id, arguments: {} });
        expect(ran.text, action.id).toContain("There is no action called");
      }
    }
    expect(h.runMcpAction).not.toHaveBeenCalled();
  });

  it("shows a finance viewer only the actions at view", async () => {
    const viewer = adminSession({ id: "viewer-1", accessRoles: ["USER", "FINANCE_USER"] });
    expect(await visibleFinanceIds(viewer)).toEqual(ids(VIEW_ACTIONS));
    for (const action of EDIT_ACTIONS) {
      const ran = await callMcpTool(context(viewer), "run_action", { id: action.id, arguments: {} });
      expect(ran.text, action.id).toContain("There is no action called");
    }
    expect(h.runMcpAction).not.toHaveBeenCalled();
  });

  // Pinned by id, not read back from `mcpActionAdminRequirement`: the sync
  // status is a read whose route guards at edit, which the admin route map
  // (by method) would call view.
  it("never offers a finance viewer a change, nor the sync status its route refuses them", async () => {
    const viewer = adminSession({ id: "viewer-1", accessRoles: ["USER", "FINANCE_USER"] });
    const visible = await visibleFinanceIds(viewer);
    for (const id of visible) expect(MCP_ACTIONS.find((action) => action.id === id)?.kind, id).toBe("read");
    expect(visible).toContain("get_finance_booking_metrics");
    expect(visible).not.toContain("get_finance_sync_status");
    const manager = adminSession({ id: "treasurer-1", accessRoles: ["USER", "FINANCE_ADMIN"] });
    expect(await visibleFinanceIds(manager)).toContain("get_finance_sync_status");
  });

  it("shows a finance manager every finance action", async () => {
    const manager = adminSession({ id: "treasurer-1", accessRoles: ["USER", "FINANCE_ADMIN"] });
    expect(await visibleFinanceIds(manager)).toEqual(ids(FINANCE_ACTIONS));
  });
});
