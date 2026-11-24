/**
 * Who is offered the Bookings & Beds officer actions (ALP-719): only someone
 * holding that admin area, at the level the route itself demands. Anyone else
 * never meets them in `tools/list`, `find_actions` or `describe_action`, and
 * cannot run one by name. The last block holds every officer action in the
 * catalogue, whatever its area, to the officer's own approval.
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

import {
  ADMIN_PERMISSION_AREAS,
  getAdminRouteRequirement,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { MCP_ACTIONS, mcpActionAdminRequirement } from "@/lib/mcp/catalogue";
import { classifyMcpRoute } from "@/lib/mcp/exclusions";
import {
  callMcpTool,
  listMcpTools,
  MCP_OFFICER_RECONNECT_MESSAGE,
  type McpServerContext,
} from "@/lib/mcp/server";

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

  it("offers an action on a Bookings & Beds route at the permission its handler names", async () => {
    const familyRead = AREA_ROUTE_ACTIONS.find((action) => action.id === "get_member_family_for_booking");
    expect(familyRead && mcpActionAdminRequirement(familyRead)).toEqual({ area: "bookings", level: "edit" });

    const viewOnly = new Set(await foundIds(context({ bookings: "view" })));
    expect(viewOnly.has("get_member_family_for_booking")).toBe(false);
    expect(viewOnly.has("search_non_member_contacts")).toBe(false);
    // And below it: the bed previews' own guard asks only view, as on the board.
    expect(viewOnly.has("preview_bed_allocation_move")).toBe(true);
    expect(viewOnly.has("preview_bed_allocation_removal")).toBe(true);
  });

  it("leaves withdrawing an extra payment request to the Finance lane, even for a Finance editor", async () => {
    // Owner decision, #5305 comment 7093303964, item 3: a money action, ALP-721.
    expect(classifyMcpRoute("src/app/api/admin/bookings/[id]/additional-payment/withdraw/route.ts", "POST")).toEqual({
      kind: "excluded", reason: "not-yet:ALP-721",
    });
    const found = await foundIds(context({ bookings: "edit", finance: "edit" }));
    // The officer's own member actions (ALP-794) withdraw their own requests; no officer action withdraws.
    const officerIds = new Set(
      MCP_ACTIONS.filter((action) => mcpActionAdminRequirement(action) !== null).map((action) => action.id),
    );
    expect(found.filter((id) => officerIds.has(id) && id.includes("withdraw"))).toEqual([]);
    // Every requires-pinned action in this area asks for the area itself.
    for (const action of AREA_ROUTE_ACTIONS) {
      expect(mcpActionAdminRequirement(action)?.area, action.id).toBe("bookings");
    }
  });

  it("keeps the open member search switch website-only, even for a Bookings & Beds editor", async () => {
    // Owner decision D-18: nothing automated widens who can browse member names.
    expect(classifyMcpRoute("src/app/api/admin/member-guest-settings/route.ts", "PUT")).toEqual({
      kind: "excluded", reason: "privacy-posture",
    });
    const found = await foundIds(context({ bookings: "edit" }));
    expect(found).toContain("get_member_guest_settings");
    expect(found.filter((id) => id.startsWith("update_member_guest"))).toEqual([]);
  });

  it("keeps the school contact editor website-only: its save asks for fresh proof", () => {
    // #5245: the read and the Xero retry serve the editor; Xero retries are the Finance lane's (ALP-721).
    const file = "src/app/api/admin/organisations/[id]/contact/route.ts";
    expect(classifyMcpRoute(file, "PATCH")).toEqual({ kind: "excluded", reason: "fresh-proof" });
    expect(classifyMcpRoute(file, "GET")).toEqual({ kind: "excluded", reason: "website-flow" });
    expect(classifyMcpRoute("src/app/api/admin/organisations/[id]/contact/retry/route.ts", "POST")).toEqual({
      kind: "excluded", reason: "website-flow",
    });
  });

  it("keeps the guest dietary edit website-only: an app never reads the value it would overwrite", async () => {
    // INV-PRIV-022: dietary needs are never sent to an app, so no blind write.
    expect(classifyMcpRoute("src/app/api/admin/bookings/[id]/guest-dietary/route.ts", "PATCH")).toEqual({
      kind: "excluded", reason: "unread-value",
    });
    const found = await foundIds(context({ bookings: "edit" }));
    expect(found.filter((id) => id.includes("dietary"))).toEqual([]);
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

// Owner decisions on #5305: an action that notifies other people, or
// overwrites another person's record, is `destructive` (item 2, comment
// 7092977781), and so is every change to club-wide configuration (item 2,
// comment 7093303964), so the app asks the officer first and the call is
// audited as important. Only a lookup that changes nothing stays `write`; a new
// change action on a Bookings & Beds route is `destructive` unless it is
// reviewed onto this list.
const LOOKUP_WRITES = [
  // A POST lookup: changes no record and notifies no one.
  "find_member_guest_by_email",
];

// Every club-wide configuration change this area catalogues.
const CLUB_CONFIGURATION_CHANGES = [
  // Bed allocation settings and the lodge's rooms and beds.
  "update_bed_allocation_settings",
  "create_lodge_room",
  "create_lodge_rooms_in_bulk",
  "import_rooms_and_beds_from_config",
  "update_lodge_room",
  "delete_lodge_room",
  "create_lodge_bed",
  "update_lodge_bed",
  "delete_lodge_bed",
  // Seasons and hut rates, booking policies, age groups and settings.
  "create_season",
  "update_season",
  "delete_season",
  "update_cancellation_policy",
  "create_booking_period",
  "update_booking_period",
  "delete_booking_period",
  "create_minimum_stay_policy",
  "update_minimum_stay_policy",
  "deactivate_minimum_stay_policy",
  "update_group_discount_policy",
  "update_adult_member_hosting_policy",
  "update_age_tier_settings",
  "update_booking_request_settings",
  // Promo codes.
  "create_promo_code",
  "update_promo_code",
  "restore_promo_code",
  "delete_promo_code",
];

describe("Bookings & Beds officer actions: kinds", () => {
  it("keeps `write` only for a lookup that changes no record and notifies no one", () => {
    const writes = AREA_ROUTE_ACTIONS.filter((action) => action.kind === "write").map((action) => action.id);
    expect(writes.sort()).toEqual(LOOKUP_WRITES);
  });

  it("marks every club-wide configuration change destructive, so the app asks the officer first", () => {
    const kindOf = new Map(AREA_ROUTE_ACTIONS.map((action) => [action.id, action.kind]));
    for (const id of CLUB_CONFIGURATION_CHANGES) expect(kindOf.get(id), id).toBe("destructive");
  });

  it("marks every action that changes a member's booking, request, bed or promo code, or notifies someone, destructive", () => {
    const kindOf = new Map(AREA_ROUTE_ACTIONS.map((action) => [action.id, action.kind]));
    for (const id of [
      "allocate_guest_bed_night", "allocate_guest_bed_nights", "assign_guest_bed_range", "move_bed_allocation",
      "auto_allocate_beds", "approve_bed_allocations", "remove_bed_allocations",
      "set_booking_no_emails", "set_booking_requested_room", "clear_booking_requested_room",
      "force_confirm_waitlisted_booking", "return_booking_to_waitlist", "send_fresh_booking_email_copy",
      "send_additional_payment_reminder", "price_booking_request", "send_booking_request_quote",
    ]) {
      expect(kindOf.get(id), id).toBe("destructive");
    }
  });
});

// Owner decision, #5305 comment 7093303964, item 1: a connection approved
// before the officer screen, or by someone who was not then an officer, runs
// no officer action until its officer approves again (`INV-MCP-009`).
describe("Bookings & Beds officer actions: an officer approves again", () => {
  const ids = new Set(BOOKINGS_ACTIONS.map((action) => action.id));

  it("shows a connection without that approval none of them, and says how to get them", async () => {
    const ctx = context({ bookings: "edit" }, false);
    expect(listMcpTools(ctx).filter((tool) => ids.has(tool.name))).toEqual([]);
    const found = JSON.parse((await callMcpTool(ctx, "find_actions", {})).text) as {
      actions: Array<{ id: string }>; officerActions?: string;
    };
    expect(found.actions.filter((action) => ids.has(action.id))).toEqual([]);
    expect(found.officerActions).toBe(MCP_OFFICER_RECONNECT_MESSAGE);
    const who = JSON.parse((await callMcpTool(ctx, "who_am_i", {})).text) as { officerActions?: string };
    expect(who.officerActions).toBe(MCP_OFFICER_RECONNECT_MESSAGE);
  });

  it("refuses to describe or run one, by name or through run_action, and runs nothing", async () => {
    const ctx = context({ bookings: "edit" }, false);
    for (const action of BOOKINGS_ACTIONS) {
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

  it("keeps the officer's member actions working meanwhile", async () => {
    const ctx = context({ bookings: "edit" }, false);
    const member = MCP_ACTIONS.find((action) => action.id === "list_my_bookings");
    expect(member && mcpActionAdminRequirement(member)).toBeNull();
    expect(await foundIds(ctx)).toContain("list_my_bookings");
    await callMcpTool(ctx, "run_action", { id: "list_my_bookings", arguments: {} });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "list_my_bookings" }), {}, ctx.caller);
  });

  it("offers and runs them once the officer has approved on the officer screen", async () => {
    const ctx = context({ bookings: "edit" }, true);
    const found = await foundIds(ctx);
    expect(BOOKINGS_ACTIONS.filter((action) => !found.includes(action.id))).toEqual([]);
    const outcome = JSON.parse((await callMcpTool(ctx, "find_actions", {})).text) as { officerActions?: string };
    expect(outcome.officerActions).toBeUndefined();
    await callMcpTool(ctx, "run_action", { id: "search_bookings", arguments: {} });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "search_bookings" }), {}, ctx.caller);
  });

  it("leaves a member's connection, which never had that approval, exactly as it was", async () => {
    const ctx = context({}, false);
    const outcome = JSON.parse((await callMcpTool(ctx, "find_actions", {})).text) as {
      actions: Array<{ id: string }>; officerActions?: string;
    };
    expect(outcome.officerActions).toBeUndefined();
    expect(outcome.actions.map((action) => action.id)).toContain("list_my_bookings");
    const describeOfficer = await callMcpTool(ctx, "describe_action", { id: "search_bookings" });
    expect(describeOfficer.text).toContain("There is no action called");
    const who = JSON.parse((await callMcpTool(ctx, "who_am_i", {})).text) as { officerActions?: string };
    expect(who.officerActions).toBeUndefined();
  });
});

// Owner decision, #5305 comment 7131483847: one approval, worded generally,
// covers every officer area, later ones included. So the consent gate must
// hold for every officer action in the catalogue, not only Bookings & Beds:
// an officer holding every area at edit, on a connection without that
// approval, meets none of them and runs none (`INV-MCP-009`).
describe("every officer action in the catalogue: needs the officer's approval", () => {
  const OFFICER_ACTIONS = MCP_ACTIONS.filter((action) => mcpActionAdminRequirement(action) !== null);
  const officerIds = new Set(OFFICER_ACTIONS.map((action) => action.id));
  const EVERY_AREA_EDIT = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "edit"]),
  ) as AdminPermissionMatrix;

  it("has reads, changes and listed tools to check, each offered once the officer approves", async () => {
    expect(OFFICER_ACTIONS.some((action) => action.kind === "read")).toBe(true);
    expect(OFFICER_ACTIONS.some((action) => action.kind !== "read")).toBe(true);
    expect(OFFICER_ACTIONS.some((action) => action.core)).toBe(true);
    // The same officer, approved, is offered every one, so the refusals below
    // come from the missing approval and nothing else.
    const found = await foundIds(context(EVERY_AREA_EDIT, true));
    expect(OFFICER_ACTIONS.filter((action) => !found.includes(action.id)).map((action) => action.id)).toEqual([]);
  });

  it("lists none of them in tools/list or find_actions", async () => {
    const ctx = context(EVERY_AREA_EDIT, false);
    expect(listMcpTools(ctx).filter((tool) => officerIds.has(tool.name)).map((tool) => tool.name)).toEqual([]);
    expect((await foundIds(ctx)).filter((id) => officerIds.has(id))).toEqual([]);
  });

  it("refuses each through describe_action, run_action and by name, saying to reconnect, and runs nothing", async () => {
    const ctx = context(EVERY_AREA_EDIT, false);
    for (const action of OFFICER_ACTIONS) {
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
