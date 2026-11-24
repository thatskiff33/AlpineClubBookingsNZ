/**
 * `GET /api/work-parties/active`: the booking form's "work parties during your
 * stay" list and the AI app action `find_work_parties_for_stay`. Owner
 * decision, #5305 comment 7092977781: members only, an empty list (not an
 * error) for anyone else, and the window capped at the booking horizon.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_HORIZON_DAYS } from "@/lib/booking-horizon";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";

import { memberSession } from "@/lib/__tests__/helpers/sessions";

const TODAY = new Date("2026-07-01T00:00:00.000Z");

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  findActiveWorkPartyEventsForRange: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (h.user ? { user: h.user } : null)) }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  rateLimiters: { bookingQuery: { id: "booking-query" } },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));
vi.mock("@/lib/work-party", () => ({
  findActiveWorkPartyEventsForRange: h.findActiveWorkPartyEventsForRange,
}));

import { GET } from "@/app/api/work-parties/active/route";

const EVENT = {
  id: "wp-1",
  name: "Spring working bee",
  description: "Paint the deck",
  startDate: new Date("2026-07-03T00:00:00.000Z"),
  endDate: new Date("2026-07-05T00:00:00.000Z"),
  discountPercent: 50,
  lodge: { name: "Lodge A" },
};

function request(checkIn: string, checkOut: string): NextRequest {
  return new NextRequest(
    `https://club.example.test/api/work-parties/active?checkIn=${checkIn}&checkOut=${checkOut}`,
  );
}

beforeEach(() => {
  h.findActiveWorkPartyEventsForRange.mockReset();
  h.findActiveWorkPartyEventsForRange.mockResolvedValue([EVENT]);
  h.user = memberSession().user as unknown as Record<string, unknown>;
});

describe("GET /api/work-parties/active", () => {
  it("lists a member the work parties their stay overlaps", async () => {
    const response = await GET(request("2026-07-03", "2026-07-05"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [
        {
          id: "wp-1",
          name: "Spring working bee",
          description: "Paint the deck",
          startDate: "2026-07-03",
          endDate: "2026-07-05",
          discountPercent: 50,
          lodgeName: "Lodge A",
        },
      ],
    });
    const [checkIn, checkOut] = h.findActiveWorkPartyEventsForRange.mock.calls[0] ?? [];
    expect([formatDateOnly(checkIn), formatDateOnly(checkOut)]).toEqual(["2026-07-03", "2026-07-05"]);
  });

  it.each([
    ["a non-member login", memberSession({ role: "NON_MEMBER", accessRoles: [] }).user],
    ["an organisation account", memberSession({ role: "SCHOOL", accessRoles: ["USER", "ORG"] }).user],
  ])("gives %s an empty list, not an error, and looks nothing up", async (_label, user) => {
    h.user = user as unknown as Record<string, unknown>;

    const response = await GET(request("2026-07-03", "2026-07-05"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
    expect(h.findActiveWorkPartyEventsForRange).not.toHaveBeenCalled();
  });

  it("caps a window that runs past the booking horizon", async () => {
    const response = await GET(request("2026-07-03", "2099-01-01"));

    expect(response.status).toBe(200);
    const [checkIn, checkOut] = h.findActiveWorkPartyEventsForRange.mock.calls[0] ?? [];
    expect(formatDateOnly(checkIn)).toBe("2026-07-03");
    // A stay may start on the horizon day, so that night is the last one looked at.
    expect(formatDateOnly(checkOut)).toBe(formatDateOnly(addDaysDateOnly(TODAY, BOOKING_HORIZON_DAYS + 1)));
  });

  it("looks nothing up for a stay that starts after the booking horizon", async () => {
    const start = formatDateOnly(addDaysDateOnly(TODAY, BOOKING_HORIZON_DAYS + 1));
    const end = formatDateOnly(addDaysDateOnly(TODAY, BOOKING_HORIZON_DAYS + 5));

    const response = await GET(request(start, end));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
    expect(h.findActiveWorkPartyEventsForRange).not.toHaveBeenCalled();
  });
});
