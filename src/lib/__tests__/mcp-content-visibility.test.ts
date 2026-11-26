/**
 * ALP-723 (`INV-MCP-006`, `INV-MCP-009`): the Content actions reach only an
 * officer who holds the Content area, on a connection they approved for
 * officer actions. Anyone else is not shown them in `tools/list` or
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
import { CONTENT_MCP_ACTIONS } from "@/lib/mcp/catalogue/content";
import { callMcpTool, listMcpTools, type McpServerContext } from "@/lib/mcp/server";

import { adminSession } from "./helpers/sessions";

const CONTENT_IDS = new Set(CONTENT_MCP_ACTIONS.map((action) => action.id));
const CONTENT_READ_IDS = CONTENT_MCP_ACTIONS.filter((action) => action.kind === "read").map((action) => action.id);

/** An officer whose matrix grants `content` at `level` and the Membership area in full. */
function officerWithContent(level: AdminPermissionLevel): Session {
  return adminSession({
    accessRoles: ["USER", "ADMIN_MEMBERSHIP"],
    adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), membership: "edit", content: level },
  });
}

/** A connection the officer approved for officer actions, unless `officerConsent` is false. */
function context(session: Session, officerConsent = true): McpServerContext {
  return {
    session,
    caller: {
      officerConsent,
      grantId: "grant-1",
      memberId: session.user.id,
      clientName: "Example Assistant",
      scope: "READ_WRITE",
      clientIp: "203.0.113.9",
      userAgent: null,
    },
  };
}

async function foundIds(ctx: McpServerContext): Promise<string[]> {
  const outcome = await callMcpTool(ctx, "find_actions", { query: "" });
  const { actions } = JSON.parse(outcome.text) as { actions: Array<{ id: string }> };
  return actions.map((action) => action.id).filter((id) => CONTENT_IDS.has(id));
}

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ isError: false, text: "ran" });
});

describe("an officer without the Content area", () => {
  const session = officerWithContent("none");

  it("is shown no Content action in tools/list or find_actions", async () => {
    const listed = listMcpTools(context(session)).map((tool) => tool.name);
    expect(listed.filter((id) => CONTENT_IDS.has(id))).toEqual([]);
    expect(await foundIds(context(session))).toEqual([]);
  });

  it("cannot have one described or run, and nothing is dispatched", async () => {
    for (const id of CONTENT_IDS) {
      expect((await callMcpTool(context(session), "describe_action", { id })).isError, id).toBe(true);
      expect((await callMcpTool(context(session), "run_action", { id, arguments: {} })).isError, id).toBe(true);
    }
    expect((await callMcpTool(context(session), "list_site_pages", {})).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("an officer with the Content area on a connection not approved for officer actions", () => {
  it("is shown none of them and runs none (INV-MCP-009)", async () => {
    const unapproved = context(officerWithContent("edit"), false);
    const listed = listMcpTools(unapproved).map((tool) => tool.name);
    expect(listed.filter((id) => CONTENT_IDS.has(id))).toEqual([]);
    expect(await foundIds(unapproved)).toEqual([]);
    for (const id of CONTENT_IDS) {
      expect((await callMcpTool(unapproved, "run_action", { id, arguments: {} })).isError, id).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("an officer with the Content area", () => {
  it("at view level is shown its reads and none of its changes", async () => {
    const found = await foundIds(context(officerWithContent("view")));
    expect(found.sort()).toEqual([...CONTENT_READ_IDS].sort());
  });

  it("at edit level is shown every Content action, and the core ones as tools", async () => {
    const ctx = context(officerWithContent("edit"));
    expect((await foundIds(ctx)).sort()).toEqual([...CONTENT_IDS].sort());

    const listed = listMcpTools(ctx).map((tool) => tool.name);
    const core = CONTENT_MCP_ACTIONS.filter((action) => action.core).map((action) => action.id);
    expect(core.sort()).toEqual(["list_site_banners", "list_site_pages"]);
    for (const id of core) expect(listed, id).toContain(id);
  });
});

/**
 * Owner decision, #5305 item 2: an action that notifies anyone or overwrites
 * another person's record is `destructive`, and so is every change to
 * club-wide configuration (comment 7111359405). Every Content change shows on
 * the public website at once, replacing what another officer may have
 * written, so all are destructive bar adding an empty photo folder, which
 * shows nothing until a photo is uploaded into it on the website. Every
 * change action is pinned here, so a new one has to be classified on purpose.
 */
const CHANGE_ACTION_KINDS: Record<string, "write" | "destructive"> = {
  create_image_folder: "write",
  // Pages, footer sections and banners: live on the public website.
  create_site_page: "destructive",
  update_site_page: "destructive",
  set_site_page_published: "destructive",
  delete_site_page: "destructive",
  update_footer_section: "destructive",
  create_site_banner: "destructive",
  update_site_banner: "destructive",
  delete_site_banner: "destructive",
  // Club-wide settings the public website shows.
  update_club_identity: "destructive",
  set_contact_page_role: "destructive",
  update_public_content_settings: "destructive",
  update_privacy_hosting_disclosure: "destructive",
  update_site_style: "destructive",
  refresh_mountain_conditions_report: "destructive",
  replace_mountain_conditions_report: "destructive",
  update_mountain_conditions_settings: "destructive",
  // Take photos off public pages; cannot be undone from the app.
  rename_image_folder: "destructive",
  delete_image_folder: "destructive",
  delete_folder_photo: "destructive",
  delete_library_image: "destructive",
};

describe("the kind of each Content change action", () => {
  it("matches the owner's rule for every action that changes something", () => {
    const actual = Object.fromEntries(
      CONTENT_MCP_ACTIONS.filter((action) => action.kind !== "read").map((action) => [action.id, action.kind]),
    );
    expect(actual).toEqual(CHANGE_ACTION_KINDS);
  });
});
