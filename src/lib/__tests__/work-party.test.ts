import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

const mocks = vi.hoisted(() => ({
  prisma: {
    workPartyEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import {
  workPartyWindowOverlapsStay,
  restrictPerNightRatesToWindow,
  resolveWorkPartyEventPromoForBooking,
  getWorkPartyNightWindowForPromo,
  workPartyEventDatesError,
  generateWorkPartyPromoCode,
  WORK_PARTY_PROMO_CODE_PREFIX,
} from "../work-party";

const d = parseDateOnly;

describe("workPartyWindowOverlapsStay", () => {
  const window = { startDate: d("2026-07-10"), endDate: d("2026-07-14") };

  it("returns true when the stay is fully inside the window", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-11"), d("2026-07-13"))).toBe(true);
  });

  it("returns true when the stay partially overlaps the start of the window", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-08"), d("2026-07-11"))).toBe(true);
  });

  it("returns true when the stay partially overlaps the end of the window", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-14"), d("2026-07-18"))).toBe(true);
  });

  it("returns true when the stay's last night is exactly the window start", () => {
    // checkOut is exclusive, so a stay checkIn=09, checkOut=11 has its last
    // night on the 10th, which is the window's start date.
    expect(workPartyWindowOverlapsStay(window, d("2026-07-09"), d("2026-07-11"))).toBe(true);
  });

  it("returns true when the stay's first night is exactly the window end", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-14"), d("2026-07-16"))).toBe(true);
  });

  it("returns false when the stay ends before the window starts", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-05"), d("2026-07-10"))).toBe(false);
  });

  it("returns false when the stay starts after the window ends", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-15"), d("2026-07-18"))).toBe(false);
  });

  it("returns false for a zero-night stay (checkOut <= checkIn)", () => {
    expect(workPartyWindowOverlapsStay(window, d("2026-07-12"), d("2026-07-12"))).toBe(false);
  });
});

describe("restrictPerNightRatesToWindow", () => {
  const window = { startDate: d("2026-07-10"), endDate: d("2026-07-14") };

  it("keeps all nights when the stay is fully inside the window", () => {
    const rates = [5000, 5000, 5000];
    const firstNight = d("2026-07-11");
    expect(restrictPerNightRatesToWindow(rates, firstNight, window)).toEqual([5000, 5000, 5000]);
  });

  it("drops nights before the window start", () => {
    // Stay starts 2026-07-08 for 5 nights (08, 09, 10, 11, 12); window is
    // 10..14 inclusive, so only the last 3 nights (10, 11, 12) count.
    const rates = [1000, 1000, 2000, 2000, 2000];
    const firstNight = d("2026-07-08");
    expect(restrictPerNightRatesToWindow(rates, firstNight, window)).toEqual([2000, 2000, 2000]);
  });

  it("drops nights after the window end", () => {
    // Stay starts 2026-07-12 for 5 nights (12, 13, 14, 15, 16); window ends
    // on the 14th, so only 12, 13, 14 count.
    const rates = [3000, 3000, 3000, 4000, 4000];
    const firstNight = d("2026-07-12");
    expect(restrictPerNightRatesToWindow(rates, firstNight, window)).toEqual([3000, 3000, 3000]);
  });

  it("returns an empty array when the stay does not overlap the window at all", () => {
    const rates = [5000, 5000];
    const firstNight = d("2026-08-01");
    expect(restrictPerNightRatesToWindow(rates, firstNight, window)).toEqual([]);
  });
});

describe("resolveWorkPartyEventPromoForBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const db = mocks.prisma as unknown as Parameters<typeof resolveWorkPartyEventPromoForBooking>[0];

  it("resolves an active event whose window overlaps the stay", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      name: "Spring clean-up",
      active: true,
      startDate: d("2026-07-10"),
      endDate: d("2026-07-14"),
      promoCode: { code: "WORKPARTY-AB3X7K2M", active: true, archivedAt: null },
    });

    const result = await resolveWorkPartyEventPromoForBooking(
      db,
      "event-1",
      d("2026-07-11"),
      d("2026-07-13")
    );

    expect(result).toEqual({
      ok: true,
      promoCodeStr: "WORKPARTY-AB3X7K2M",
      eventName: "Spring clean-up",
    });
  });

  it("rejects an unknown event id", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue(null);

    const result = await resolveWorkPartyEventPromoForBooking(
      db,
      "missing",
      d("2026-07-11"),
      d("2026-07-13")
    );

    expect(result).toEqual({ ok: false, error: "Working bee event not found" });
  });

  it("rejects a deactivated event", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      name: "Spring clean-up",
      active: false,
      startDate: d("2026-07-10"),
      endDate: d("2026-07-14"),
      promoCode: { code: "WORKPARTY-AB3X7K2M", active: true, archivedAt: null },
    });

    const result = await resolveWorkPartyEventPromoForBooking(
      db,
      "event-1",
      d("2026-07-11"),
      d("2026-07-13")
    );

    expect(result).toEqual({
      ok: false,
      error: "This working bee event is no longer active",
    });
  });

  it("rejects when the booking dates do not overlap the event window", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      name: "Spring clean-up",
      active: true,
      startDate: d("2026-07-10"),
      endDate: d("2026-07-14"),
      promoCode: { code: "WORKPARTY-AB3X7K2M", active: true, archivedAt: null },
    });

    const result = await resolveWorkPartyEventPromoForBooking(
      db,
      "event-1",
      d("2026-08-01"),
      d("2026-08-05")
    );

    expect(result).toEqual({
      ok: false,
      error: "This working bee event does not overlap your booking dates",
    });
  });
});

describe("getWorkPartyNightWindowForPromo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const db = mocks.prisma as unknown as Parameters<typeof getWorkPartyNightWindowForPromo>[0];

  it("returns the event window for a linked internal promo", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue({
      startDate: d("2026-07-10"),
      endDate: d("2026-07-14"),
    });

    const result = await getWorkPartyNightWindowForPromo(db, "promo-1");
    expect(result).toEqual({ startDate: d("2026-07-10"), endDate: d("2026-07-14") });
  });

  it("returns null when the promo has no linked event", async () => {
    mocks.prisma.workPartyEvent.findUnique.mockResolvedValue(null);

    const result = await getWorkPartyNightWindowForPromo(db, "promo-1");
    expect(result).toBeNull();
  });
});

describe("workPartyEventDatesError", () => {
  it("returns null when end date is on or after start date", () => {
    expect(
      workPartyEventDatesError({ startDate: d("2026-07-10"), endDate: d("2026-07-10") })
    ).toBeNull();
    expect(
      workPartyEventDatesError({ startDate: d("2026-07-10"), endDate: d("2026-07-14") })
    ).toBeNull();
  });

  it("returns an error when end date is before start date", () => {
    expect(
      workPartyEventDatesError({ startDate: d("2026-07-14"), endDate: d("2026-07-10") })
    ).toBe("End date must be on or after the start date");
  });
});

describe("generateWorkPartyPromoCode", () => {
  it("generates codes with the expected prefix and an unambiguous suffix", () => {
    const code = generateWorkPartyPromoCode();
    expect(code.startsWith(WORK_PARTY_PROMO_CODE_PREFIX)).toBe(true);
    const suffix = code.slice(WORK_PARTY_PROMO_CODE_PREFIX.length);
    expect(suffix).toHaveLength(8);
    // No ambiguous characters (I, L, O, 0, 1).
    expect(suffix).not.toMatch(/[ILO01]/);
  });

  it("generates distinct codes across calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateWorkPartyPromoCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
