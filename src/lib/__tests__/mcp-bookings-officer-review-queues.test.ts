/**
 * ALP-719 (`INV-MCP-006`): the Bookings & Beds review-queue actions an
 * officer's AI app connection may run. Each route answers the browser as
 * before; the connection gets exactly the action's `returns` fields
 * (`expectActionContract`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  prisma: {
    lodge: { findUnique: vi.fn() },
    booking: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

import { GET as getOccupancy } from "@/app/api/admin/occupancy/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

function day(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
});

describe("get_lodge_occupancy", () => {
  it("answers with each night's guest count and the bookings behind it", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
    // One stay across the whole month, so every night carries a booking.
    h.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        status: "PAID",
        checkIn: day("2026-07-01"),
        checkOut: day("2026-08-01"),
        member: { firstName: "Ana", lastName: "Reid" },
        organisation: null,
        guests: [{ id: "guest-1", stayStart: day("2026-07-01"), stayEnd: day("2026-08-01"), nights: [] }],
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_occupancy",
      handler: getOccupancy,
      args: { month: "2026-07", lodgeId: "lodge-1" },
    });

    expect(h.requireAdmin).toHaveBeenCalledWith({ permission: { area: "bookings", level: "view" } });
    // Every field of this answer is already the officer's view, so both match.
    expect(connection).toEqual(browser);
    expect(connection).toMatchObject({
      month: "2026-07",
      bookings: [{ id: "booking-1", ownerName: "Ana Reid", guestCount: 1, status: "PAID" }],
    });
  });
});
