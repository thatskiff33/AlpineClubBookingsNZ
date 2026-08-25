import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): the arrival-time gate on the club's clock, not the container's.
 *
 * The route asks two different temporal questions on adjacent lines, and before
 * this change both were answered by the environment:
 *
 *  - **"what day is it?"** — a real zone question, whose answer is the club's
 *    PERSISTED `ClubTimeSettings.timeZone` (INV-CONFIG-002, INV-DATE-019); and
 *  - **"which day does this booking start?"** — NOT a zone question at all.
 *    `Booking.checkIn` is `@db.Date`, a calendar day encoded as UTC midnight and
 *    never a moment (INV-DATE-010), read back in UTC under INV-DATE-019's first
 *    exact boundary with INV-DATE-026 — the citation for a decode, where
 *    INV-DATE-010 is not (#3080). The old
 *    `normalizeDateOnlyForTimeZone` projected it into the environment's zone,
 *    which is the identity for a club ahead of Greenwich and the PREVIOUS day
 *    for one behind it.
 *
 * ## How this file discriminates, stated plainly
 *
 * `APP_TIME_ZONE` — the container's `TZ`, and the only thing the replaced
 * helpers ever read — is pinned to `America/Denver`, BEHIND UTC, because that is
 * the side of Greenwich where both defects are visible. The persisted club zone
 * is then varied per test. Under the frozen clock (`2026-07-01T00:00:00.000Z`)
 * the club's day is 1 July in Auckland and 30 June in Denver, so the two never
 * agree and no assertion here can pass by coincidence.
 *
 * Each case names the mutant it kills:
 *
 *  1. a stay starting on the club's own day is editable → kills "read the stored
 *     check-in through a zone", which moves it to 30 June and locks the editor a
 *     day early;
 *  2. a stay that started yesterday is locked → kills "take today from
 *     `APP_TIME_ZONE`", which would call 30 June today and leave it open;
 *  3. the SAME booking flips from locked to editable when only the persisted
 *     zone changes → kills "ignore the persisted value" in every form,
 *     including a hard-coded `Pacific/Auckland`.
 *
 * Nothing here depends on the host's own `TZ`: `APP_TIME_ZONE` is mocked, and
 * the environment seed inside `getClubTimeZone` is never reached because a
 * persisted row is always supplied. The assertions hold with `TZ` unset (CI) and
 * with it set to anything.
 */

// Spelled out literally inside the factory because `vi.mock` is hoisted above
// every const in this file; the exported constant below is what the assertions
// compare against, and the premise test pins the two to the same string.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const ENVIRONMENT_ZONE = "America/Denver";

const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockBookingFindUnique,
  mockTransaction,
  mockLogAudit,
  mockClubTimeSettingsFindUnique,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockLogAudit: vi.fn(),
  mockClubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));
/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. `getClubTimeZone`
  is fail-soft in three places — no delegate, a throwing query, no row — and
  every one of them degrades silently to the environment. A prisma mock without
  it therefore passes for exactly the reason this file exists to rule out.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mockBookingFindUnique },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { clubToday } from "@/lib/club-time";
import { requireClubTimeZone } from "@/lib/club-time";
import { APP_TIME_ZONE } from "@/config/operational";

const OWNER = {
  user: { id: "owner-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

/** The day the frozen clock reads as in a given zone. */
function todayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

/** A live booking whose stored check-in is the given `@db.Date` calendar day. */
function bookingCheckingInOn(day: string) {
  return {
    memberId: OWNER.user.id,
    checkIn: new Date(`${day}T00:00:00.000Z`),
    status: "CONFIRMED",
    deletedAt: null,
  };
}

async function put(booking: unknown) {
  mockAuth.mockResolvedValue(OWNER);
  mockBookingFindUnique.mockResolvedValue(booking);
  const { PUT } = await import("@/app/api/bookings/[id]/arrival-time/route");
  return PUT(
    new NextRequest("http://localhost/api/bookings/booking-1/arrival-time", {
      method: "PUT",
      body: JSON.stringify({ expectedArrivalTime: "18:00" }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireActiveSessionUser.mockResolvedValue(null);
  mockTransaction.mockImplementation(async () => ({
    previous: { expectedArrivalTime: null },
    updated: { id: "booking-1", expectedArrivalTime: "18:00" },
  }));
});

describe("the arrival-time date gate runs on club time (CT-4, #2870)", () => {
  it("PREMISE: the environment's zone and the club's give different days here", () => {
    /*
      An IDENTIFIER inequality would not do. `America/Chicago` is a different
      string from `America/Denver` and gives the same answers for most fixtures,
      so a guard written that way passes while every assertion below goes
      vacuous. What has to differ is the ANSWER.
    */
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(todayIn("Pacific/Auckland")).toBe("2026-07-01");
    expect(todayIn(ENVIRONMENT_ZONE)).toBe("2026-06-30");
    expect(todayIn(ENVIRONMENT_ZONE)).not.toBe(todayIn("Pacific/Auckland"));
  });

  it("lets a stay that starts on the club's own day still be edited", async () => {
    // MUTANT KILLED: reading the stored `@db.Date` check-in through a zone.
    // Projected into America/Denver, 2026-07-01T00:00:00Z is 30 June, which is
    // before the club's 1 July — so the editor answers 400 and a member cannot
    // tell the lodge when they will arrive on the morning they arrive.
    persistClubZone("Pacific/Auckland");

    const response = await put(bookingCheckingInOn("2026-07-01"));

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
  });

  it("locks a stay that started on the club's yesterday", async () => {
    // MUTANT KILLED: taking "today" from APP_TIME_ZONE. Denver's 30 June would
    // make this booking's check-in today rather than yesterday, and the gate
    // would let it through — the complement that stops the case above being
    // satisfied by a route that simply never refuses.
    persistClubZone("Pacific/Auckland");

    const response = await put(bookingCheckingInOn("2026-06-30"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Cannot update arrival time after check-in date has passed",
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("follows the PERSISTED zone: the same booking flips when only that changes", async () => {
    // MUTANT KILLED: ignoring the persisted value — a hard-coded
    // "Pacific/Auckland", a `process.env` read, a stale cached zone. Nothing
    // about the request or the booking differs between this case and the one
    // above; the only change is the row in ClubTimeSettings, and the answer has
    // to change with it.
    persistClubZone(ENVIRONMENT_ZONE);

    const response = await put(bookingCheckingInOn("2026-06-30"));

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
  });

  it("reads the club zone from the persisted row on every call", async () => {
    // The delegate really is consulted — so a later refactor that drops the
    // read and falls back to the environment fails here rather than passing
    // quietly on a deployment where the two agree.
    persistClubZone("Pacific/Auckland");
    await put(bookingCheckingInOn("2026-07-01"));

    expect(mockClubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
