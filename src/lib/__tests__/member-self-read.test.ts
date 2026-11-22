/**
 * What a member reads about their own bookings through the JSON API
 * (ALP-653): the fields `GET /api/bookings/mine` and `GET /api/bookings/[id]`
 * answer with, which an AI app connection then repeats to the member.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, findFirst, underReview } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  underReview: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { booking: { findMany, findFirst } } }));
vi.mock("@/lib/booking-financial-review-visibility", () => ({
  bookingsWithOpenFinancialReview: underReview,
}));

import {
  getMemberBookingSummary,
  listMemberBookingSummaries,
  MEMBER_BOOKING_LIST_LIMIT,
} from "@/lib/member-self-read";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: new Date("2026-07-10T00:00:00.000Z"),
    checkOut: new Date("2026-07-12T00:00:00.000Z"),
    finalPriceCents: 12_000,
    notes: "Arriving late",
    lodge: { id: "lodge-1", name: "Main Lodge" },
    guests: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  underReview.mockResolvedValue(new Set());
});

describe("a member's own booking", () => {
  it("carries its price, note and lodge nights as date-only strings", async () => {
    findFirst.mockResolvedValue(row());

    expect(await getMemberBookingSummary("member-1", "booking-1")).toMatchObject({
      id: "booking-1",
      checkIn: "2026-07-10",
      checkOut: "2026-07-12",
      finalPriceCents: 12_000,
      priceBeingChecked: false,
      madeByMe: true,
      notes: "Arriving late",
    });
  });

  it("says the price is being checked while money is held for review (#3033)", async () => {
    findFirst.mockResolvedValue(row());
    underReview.mockResolvedValue(new Set(["booking-1"]));

    const booking = await getMemberBookingSummary("member-1", "booking-1");

    expect(underReview).toHaveBeenCalledWith(["booking-1"]);
    expect(booking?.priceBeingChecked).toBe(true);
  });

  it("is null when the booking is not one the member is on", async () => {
    findFirst.mockResolvedValue(null);

    expect(await getMemberBookingSummary("member-1", "booking-9")).toBeNull();
    expect(underReview).not.toHaveBeenCalled();
  });
});

describe("a booking the member is only a guest on", () => {
  it("withholds the price as null, never as a price of zero, and the organiser's note", async () => {
    findFirst.mockResolvedValue(row({ memberId: "member-2" }));
    underReview.mockResolvedValue(new Set(["booking-1"]));

    expect(await getMemberBookingSummary("member-1", "booking-1")).toMatchObject({
      finalPriceCents: null,
      priceBeingChecked: false,
      madeByMe: false,
      notes: null,
    });
  });
});

describe("the member's booking list", () => {
  it("asks once for every listed booking's review state", async () => {
    findMany.mockResolvedValue([row(), row({ id: "booking-2" })]);
    underReview.mockResolvedValue(new Set(["booking-2"]));

    const list = await listMemberBookingSummaries("member-1");

    expect(underReview).toHaveBeenCalledTimes(1);
    expect(underReview).toHaveBeenCalledWith(["booking-1", "booking-2"]);
    expect(list.truncated).toBe(false);
    expect(list.bookings.map((booking) => booking.priceBeingChecked)).toEqual([false, true]);
  });

  it("says so when the member has more bookings than it lists", async () => {
    findMany.mockResolvedValue(
      Array.from({ length: MEMBER_BOOKING_LIST_LIMIT + 1 }, (_unused, index) =>
        row({ id: `booking-${index}` }),
      ),
    );

    const list = await listMemberBookingSummaries("member-1");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: MEMBER_BOOKING_LIST_LIMIT + 1 }),
    );
    expect(list.bookings).toHaveLength(MEMBER_BOOKING_LIST_LIMIT);
    expect(list.truncated).toBe(true);
  });
});
