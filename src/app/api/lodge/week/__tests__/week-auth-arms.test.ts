/**
 * #2801 — the week endpoint's authorisation arms, pinned at route level.
 *
 * WHY THIS EXISTS. `resolveWeekAuth` used to hand the caller
 * `{ authResult, authDate }` on every path, including the two refusal paths,
 * where the date was `dates[0]` — a value nothing reads, because the caller
 * returns the refusal before it looks at it. Under stricter indexed access that
 * `dates[0]` is `string | undefined`, and the fix was to make the shape say
 * what was already true: the date exists only on the ACCEPTED arm.
 *
 * That touched the one thing this stage is not allowed to move — who gets a
 * week payload — so it is pinned here rather than reasoned about. `accepted` is
 * `!authResult.error`, computed at the same three points the caller used to
 * read it, and these tests hold all three: a week whose every day is forbidden,
 * a week refused with a non-403 status, and a week granted on a later day than
 * the first (the case that proves the accepted date is the day authorisation
 * was actually granted for, not the start of the strip).
 *
 * Frozen clock discipline: the week is anchored to 2026-07-01, never the real
 * calendar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const lodgeAuthMocks = vi.hoisted(() => ({
  checkLodgeAuth: vi.fn(),
  resolveKioskLodgeId: vi.fn(),
}));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: lodgeAuthMocks.checkLodgeAuth,
  resolveKioskLodgeId: lodgeAuthMocks.resolveKioskLodgeId,
  kioskLodgeAuthErrorResponse: vi.fn(() => null),
}));

const kioskAccessMocks = vi.hoisted(() => ({
  getKioskDateRange: vi.fn(),
}));
// Partial mock with `importOriginal`: `@/lib/kiosk-access` is read by more of
// this route's module graph than the one function under test, and replacing the
// whole module breaks the file at import (the shape `test:related` exists to
// catch — docs/TESTING.md).
vi.mock("@/lib/kiosk-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kiosk-access")>()),
  getKioskDateRange: kioskAccessMocks.getKioskDateRange,
}));

import { GET as getWeek } from "@/app/api/lodge/week/route";

const WEEK_START = "2026-07-01";
const WEEK_DAYS = [
  "2026-07-01",
  "2026-07-02",
  "2026-07-03",
  "2026-07-04",
  "2026-07-05",
  "2026-07-06",
  "2026-07-07",
];

async function week(start = WEEK_START) {
  const url = `http://localhost/api/lodge/week?start=${start}`;
  return getWeek({ url, nextUrl: new URL(url) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.booking.findMany.mockResolvedValue([]);
  mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  lodgeAuthMocks.resolveKioskLodgeId.mockResolvedValue("lodge-1");
  kioskAccessMocks.getKioskDateRange.mockResolvedValue(null);
});

describe("GET /api/lodge/week authorisation arms", () => {
  it("refuses the whole week with 403 when every day is forbidden", async () => {
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({
      error: "Forbidden",
      status: 403,
      tier: "none",
      session: null,
    });

    const response = await week();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    // Every day was tried before the refusal — a member whose window covers
    // only the Friday must not be turned away by the Monday.
    expect(lodgeAuthMocks.checkLodgeAuth).toHaveBeenCalledTimes(
      WEEK_DAYS.length,
    );
    // Refused means refused: no lodge was resolved and nothing was read.
    expect(lodgeAuthMocks.resolveKioskLodgeId).not.toHaveBeenCalled();
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("returns a non-403 refusal on the day that produced it, without trying the rest", async () => {
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
      tier: "none",
      session: null,
    });

    const response = await week();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(lodgeAuthMocks.checkLodgeAuth).toHaveBeenCalledTimes(1);
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("grants the week on a later day, and resolves the member's window from THAT day", async () => {
    const member = { id: "member-1" };
    lodgeAuthMocks.checkLodgeAuth.mockImplementation(async (date: string) =>
      date === "2026-07-04"
        ? { error: null, tier: "member", member, session: null }
        : { error: "Forbidden", status: 403, tier: "none", session: null },
    );
    // A window that covers only the granting day, so an accepted date taken
    // from the wrong end of the strip would show up as the wrong days being
    // accessible rather than as a silent pass.
    kioskAccessMocks.getKioskDateRange.mockResolvedValue({
      minDate: "2026-07-04",
      maxDate: "2026-07-04",
    });

    const response = await week();

    expect(response.status).toBe(200);
    const { days } = (await response.json()) as {
      days: Array<{ date: string; accessible: boolean }>;
    };
    expect(days.map((day) => day.date)).toEqual(WEEK_DAYS);
    expect(
      days.filter((day) => day.accessible).map((day) => day.date),
    ).toEqual(["2026-07-04"]);

    const [, grantedDate] =
      kioskAccessMocks.getKioskDateRange.mock.calls[0] ?? [];
    expect(grantedDate).toEqual(new Date("2026-07-04T00:00:00.000Z"));
  });
});
