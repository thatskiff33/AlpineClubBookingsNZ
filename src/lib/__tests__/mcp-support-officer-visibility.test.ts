/**
 * Who is offered the Support & System and Admin Overview officer actions
 * (ALP-724): only someone holding that admin area, at the level the route
 * itself demands. Anyone else never meets them in `tools/list`,
 * `find_actions` or `describe_action`, and cannot run one by name; nor does
 * an officer whose connection lacks their approval for officer actions
 * (`INV-MCP-009`). Also pins their kinds: every change that reaches members or
 * another person's record, and every club-wide setting, is `destructive`
 * (owner decision, #5305).
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
import { MCP_ACTIONS } from "@/lib/mcp/catalogue";
import { SUPPORT_MCP_ACTIONS } from "@/lib/mcp/catalogue/support";
import { MCP_OFFICER_RECONNECT_MESSAGE, mcpActionAdminRequirement } from "@/lib/mcp/officer-actions";
import { callMcpTool, listMcpTools, type McpServerContext } from "@/lib/mcp/server";

const NO_AREAS: AdminPermissionMatrix = {
  overview: "none", bookings: "none", membership: "none", finance: "none",
  lodge: "none", content: "none", support: "none",
};

/** An officer's connection, approved on the officer screen unless `officerConsent` says otherwise. */
function context(matrix: Partial<AdminPermissionMatrix>, officerConsent = true): McpServerContext {
  return {
    caller: {
      grantId: "grant-1", memberId: "officer-1", clientName: "Example Assistant",
      scope: "READ_WRITE", officerConsent, clientIp: "203.0.113.9", userAgent: null,
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

const ids = new Set(SUPPORT_MCP_ACTIONS.map((action) => action.id));
const OVERVIEW_IDS = ["get_officer_work_queue_counts"];
const supportActions = SUPPORT_MCP_ACTIONS.filter((action) => !OVERVIEW_IDS.includes(action.id));

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ isError: false, text: "ran" });
});

describe("Support & System and Admin Overview officer actions: who is offered them", () => {
  it("is every catalogued action on a Support or Admin Overview route, each needing that area", () => {
    const onTheseRoutes = MCP_ACTIONS.filter((action) => {
      const area = getAdminRouteRequirement(action.path, action.method)?.area;
      return area === "support" || area === "overview";
    });
    expect(onTheseRoutes.filter((action) => !ids.has(action.id)).map((action) => action.id)).toEqual([]);
    for (const action of SUPPORT_MCP_ACTIONS) {
      expect(mcpActionAdminRequirement(action)?.area, action.id).toBe(
        OVERVIEW_IDS.includes(action.id) ? "overview" : "support",
      );
    }
  });

  it("never shows them to an officer who holds every other area", async () => {
    const ctx = context({ bookings: "edit", membership: "edit", finance: "edit", lodge: "edit", content: "edit" });
    expect(listMcpTools(ctx).filter((tool) => ids.has(tool.name))).toEqual([]);
    expect((await foundIds(ctx)).filter((id) => ids.has(id))).toEqual([]);
    for (const action of SUPPORT_MCP_ACTIONS) {
      expect((await callMcpTool(ctx, "describe_action", { id: action.id })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, "run_action", { id: action.id, arguments: {} })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, action.id, {})).isError, action.id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("never shows them to a member with no admin area", async () => {
    expect((await foundIds(context({}))).filter((id) => ids.has(id))).toEqual([]);
  });

  it("stops offering and running actions when the officer loses the area after discovery", async () => {
    const ctx = context({ support: "edit", overview: "view" });
    expect((await foundIds(ctx)).filter((id) => ids.has(id))).toHaveLength(ids.size);

    // A refreshed session no longer carries either area. Discovery must not
    // become a cached permission to use an action later on this connection.
    ctx.session.user.adminPermissionMatrix = { ...NO_AREAS };
    expect((await foundIds(ctx)).filter((id) => ids.has(id))).toEqual([]);
    for (const action of SUPPORT_MCP_ACTIONS) {
      expect((await callMcpTool(ctx, "run_action", { id: action.id, arguments: {} })).isError, action.id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("offers Admin Overview alone only the work-queue counts", async () => {
    const found = new Set(await foundIds(context({ overview: "view" })));
    expect(SUPPORT_MCP_ACTIONS.filter((action) => found.has(action.id)).map((action) => action.id)).toEqual(
      OVERVIEW_IDS,
    );
  });

  it("offers a Support viewer the reads and the previews, and none of the changes", async () => {
    const found = new Set(await foundIds(context({ support: "view" })));
    for (const action of supportActions) {
      expect(found.has(action.id), action.id).toBe(action.kind === "read");
    }
    expect(found.has("preview_email_template")).toBe(true);
    expect(found.has("update_email_template")).toBe(false);
  });

  it("offers a Support editor every Support action, lists the core one, and runs one by name", async () => {
    const ctx = context({ support: "edit" });
    const found = new Set(await foundIds(ctx));
    expect(supportActions.filter((action) => !found.has(action.id)).map((action) => action.id)).toEqual([]);
    expect(listMcpTools(ctx).map((tool) => tool.name)).toContain("get_system_health");

    await callMcpTool(ctx, "run_action", { id: "resolve_issue_report", arguments: { id: "report-1" } });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "resolve_issue_report" }),
      { id: "report-1" },
      ctx.caller,
    );
  });

  it("refuses every change by name for a Support viewer, even on a read-write connection", async () => {
    const ctx = context({ support: "view", overview: "view" });
    for (const action of supportActions.filter((entry) => entry.kind !== "read")) {
      expect((await callMcpTool(ctx, "describe_action", { id: action.id })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, "run_action", { id: action.id, arguments: {} })).isError, action.id).toBe(true);
      expect((await callMcpTool(ctx, action.id, {})).isError, action.id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

// A connection approved before the officer screen existed, or by someone who
// was not then an officer, runs none of them until its officer approves
// again: the one gate in `officer-actions.ts` (`INV-MCP-009`).
describe("Support & System and Admin Overview officer actions: an officer approves again", () => {
  it("shows an unapproved connection none of them, and says how to get them", async () => {
    const ctx = context({ support: "edit", overview: "view" }, false);
    expect(listMcpTools(ctx).filter((tool) => ids.has(tool.name))).toEqual([]);
    const found = JSON.parse((await callMcpTool(ctx, "find_actions", {})).text) as {
      actions: Array<{ id: string }>; officerActions?: string;
    };
    expect(found.actions.filter((action) => ids.has(action.id))).toEqual([]);
    expect(found.officerActions).toBe(MCP_OFFICER_RECONNECT_MESSAGE);
  });

  it("refuses to describe or run each of them, by name or through run_action, and runs nothing", async () => {
    const ctx = context({ support: "edit", overview: "view" }, false);
    for (const action of SUPPORT_MCP_ACTIONS) {
      for (const outcome of [
        await callMcpTool(ctx, "describe_action", { id: action.id }),
        await callMcpTool(ctx, "run_action", { id: action.id, arguments: {} }),
        await callMcpTool(ctx, action.id, {}),
      ]) {
        expect(outcome, action.id).toEqual({ isError: true, text: MCP_OFFICER_RECONNECT_MESSAGE });
      }
    }
    expect(run).not.toHaveBeenCalled();
  });
});

// Owner decisions on #5305: an action that notifies other people or
// overwrites another person's record is `destructive` (comment 7092977781),
// and so is every change to club-wide configuration (comment 7093303964).
describe("Support & System officer actions: kinds", () => {
  /** The only changes that reach no member and no one else's record, and can be undone or repeated. */
  const HOUSEKEEPING_WRITES = ["update_setup_step", "finish_setup", "test_provider_connection", "run_backup_now"];

  it("keeps `write` to the club's own housekeeping", () => {
    expect(
      SUPPORT_MCP_ACTIONS.filter((action) => action.kind === "write").map((action) => action.id).sort(),
    ).toEqual([...HOUSEKEEPING_WRITES].sort());
  });

  it.each([
    "retry_failed_email",
    "update_officer_alerts",
    "resolve_issue_report",
    "update_email_template",
    "update_privacy_retention",
    "reset_setup_progress",
    "send_monitoring_test_event",
  ])("marks %s destructive", (id) => {
    expect(SUPPORT_MCP_ACTIONS.find((action) => action.id === id)?.kind).toBe("destructive");
  });

  it("runs as a read only a GET or a pinned preview", () => {
    for (const action of SUPPORT_MCP_ACTIONS) {
      expect(action.kind === "read", action.id).toBe(action.method === "GET" || action.preview === true);
    }
  });
});
