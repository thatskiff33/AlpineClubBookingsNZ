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
import { classifyMcpRoute } from "@/lib/mcp/exclusions";
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

  it("offers an action on a Bookings & Beds route at the permission its handler names", async () => {
    const withdraw = AREA_ROUTE_ACTIONS.find((action) => action.id === "withdraw_additional_payment_request");
    expect(withdraw && mcpActionAdminRequirement(withdraw)).toEqual({ area: "finance", level: "edit" });
    expect(await foundIds(context({ bookings: "edit" }))).not.toContain("withdraw_additional_payment_request");
    expect(await foundIds(context({ bookings: "edit", finance: "edit" }))).toContain("withdraw_additional_payment_request");

    const viewOnly = new Set(await foundIds(context({ bookings: "view" })));
    expect(viewOnly.has("get_member_family_for_booking")).toBe(false);
    expect(viewOnly.has("search_non_member_contacts")).toBe(false);
    // And below it: the bed previews' own guard asks only view, as on the board.
    expect(viewOnly.has("preview_bed_allocation_move")).toBe(true);
    expect(viewOnly.has("preview_bed_allocation_removal")).toBe(true);
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

// Owner decision, #5305 item 2 (23 Nov 2026): an action that notifies other
// people, or overwrites another person's record, is `destructive`, so the app
// asks first and the call is audited as important. What stays `write` is club
// setup (or a lookup that changes nothing); a new change action on a Bookings &
// Beds route is `destructive` unless it is reviewed onto this list.
const CLUB_SETUP_WRITES = [
  // A POST lookup: changes no record and notifies no one.
  "find_member_guest_by_email",
  // Bed allocation settings and the lodge's rooms and beds.
  "update_bed_allocation_settings",
  "create_lodge_room",
  "create_lodge_rooms_in_bulk",
  "import_rooms_and_beds_from_config",
  "update_lodge_room",
  "create_lodge_bed",
  "update_lodge_bed",
  // Seasons, booking policies, age groups and booking-request settings.
  "create_season",
  "update_season",
  "update_cancellation_policy",
  "create_booking_period",
  "update_booking_period",
  "create_minimum_stay_policy",
  "update_minimum_stay_policy",
  "update_group_discount_policy",
  "update_age_tier_settings",
  "update_booking_request_settings",
].sort();

describe("Bookings & Beds officer actions: kinds", () => {
  it("keeps `write` only for club setup that notifies no one and overwrites no one's record", () => {
    const writes = AREA_ROUTE_ACTIONS.filter((action) => action.kind === "write").map((action) => action.id);
    expect(writes.sort()).toEqual(CLUB_SETUP_WRITES);
  });

  it("marks every action that changes a member's booking, request, bed or promo code, or notifies someone, destructive", () => {
    const kindOf = new Map(AREA_ROUTE_ACTIONS.map((action) => [action.id, action.kind]));
    for (const id of [
      "allocate_guest_bed_night", "allocate_guest_bed_nights", "assign_guest_bed_range", "move_bed_allocation",
      "auto_allocate_beds", "approve_bed_allocations", "remove_bed_allocations",
      "set_booking_no_emails", "set_booking_requested_room", "clear_booking_requested_room",
      "force_confirm_waitlisted_booking", "return_booking_to_waitlist", "send_fresh_booking_email_copy",
      "send_additional_payment_reminder", "price_booking_request", "send_booking_request_quote",
      "create_promo_code", "update_promo_code", "restore_promo_code", "delete_promo_code",
      "update_adult_member_hosting_policy",
    ]) {
      expect(kindOf.get(id), id).toBe("destructive");
    }
  });
});
