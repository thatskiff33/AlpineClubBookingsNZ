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

/**
 * Owner decision, #5305 item 2: an action that emails or notifies anyone else,
 * or overwrites another person's record, is `destructive`, so the app confirms
 * first and the call is logged as important. Every change action is pinned
 * here, so a new one has to be classified on purpose.
 */
const CHANGE_ACTION_KINDS: Record<string, "write" | "destructive"> = {
  // Change only the club's own lists, notify no one, overwrite no person.
  create_committee_role: "write",
  update_committee_role: "write",
  hide_family_suggestion: "write",
  create_locker: "write",
  bulk_create_lockers: "write",
  // Email or notify a member, applicant, nominator or officer.
  create_notice: "destructive",
  update_notice: "destructive",
  create_induction: "destructive",
  refresh_application_nominations: "destructive",
  replace_application_nominator: "destructive",
  request_member_archive: "destructive",
  request_membership_cancellation: "destructive",
  resend_cancellation_confirmation: "destructive",
  link_member_partner: "destructive",
  remove_member_partner_link: "destructive",
  review_family_group_request: "destructive",
  // Change a member's record, role, family group, application or belongings.
  set_member_lodge_access: "destructive",
  link_member_dependant: "destructive",
  unlink_member_dependant: "destructive",
  create_family_group: "destructive",
  create_family_group_from_suggestion: "destructive",
  update_family_group: "destructive",
  delete_family_group: "destructive",
  revoke_partner_invite: "destructive",
  assign_committee_role: "destructive",
  update_committee_assignment: "destructive",
  deactivate_committee_assignment: "destructive",
  reassign_induction_signers: "destructive",
  void_induction: "destructive",
  moderate_message_board_post: "destructive",
  remove_message_board_post: "destructive",
  update_locker: "destructive",
  // Cannot be undone from the app.
  delete_notice: "destructive",
  run_message_board_cleanup: "destructive",
  reset_hidden_family_suggestions: "destructive",
  delete_committee_role: "destructive",
  delete_locker: "destructive",
};

describe("the kind of each Membership change action", () => {
  it("matches the owner's rule for every action that changes something", () => {
    const actual = Object.fromEntries(
      MEMBERSHIP_MCP_ACTIONS.filter((action) => action.kind !== "read").map((action) => [action.id, action.kind]),
    );
    expect(actual).toEqual(CHANGE_ACTION_KINDS);
  });

  it("is what an officer's app is told, so it confirms a destructive one first", async () => {
    const session = officerWithMembership("edit");
    const outcome = await callMcpTool(context(session), "find_actions", { query: "" });
    const { actions } = JSON.parse(outcome.text) as { actions: Array<{ id: string; kind: string }> };
    for (const [id, kind] of Object.entries(CHANGE_ACTION_KINDS)) {
      expect(actions.find((action) => action.id === id)?.kind, id).toBe(kind);
    }
  });
});
