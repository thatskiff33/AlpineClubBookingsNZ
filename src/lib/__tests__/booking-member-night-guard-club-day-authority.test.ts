import { BookingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The person-night guard takes the club's day as a VALUE and never reads it
 * (#3123 review; `INV-LOCK-004`, `INV-CONFIG-002`).
 *
 * ## The defect this pins, in plain English
 *
 * `findBookingMemberNightConflicts` is the authoritative "is this member
 * already booked on one of these nights" check. Nine writers reach it, and
 * every one of them is mid-transaction when it does: a booking create, a date
 * modification, a guest add, a booking-request approval, a school approval, a
 * quote conversion. By the time the guard runs, that transaction holds
 * `pg_advisory_xact_lock(1)`, the per-lodge capacity key from
 * `acquireLodgeCapacityLock`, and — added by `assertNoBookingMemberNight-
 * Conflicts` itself — one transaction-scoped advisory lock per member-linked
 * guest.
 *
 * The first #3123 pass replaced a pure, zero-IO `new Date()` projection inside
 * that function with `await readClubTimeZoneOutsideRequest()`, which queries
 * `ClubTimeSettings` on the MODULE-level Prisma client — not the `db` the
 * function was handed. That needs a SECOND pooled connection while all of the
 * above is held. With the pool at N and N concurrent booking creates in flight,
 * every transaction holds one connection and waits for another that only a
 * commit can free, so all N reach `pool_timeout` (P2024) together.
 *
 * WHAT MAKES IT WORSE THAN AN OUTAGE. `readPersistedClubTimeZoneRow` swallows
 * that failure (`catch { return { ok: false } }`), falls back to the
 * environment seed, and warns at most once per minute per process. So the
 * visible result is not an error: it is the WRONG club day silently reaching
 * `evaluateGuestSelfRemoval`, deciding whether a member may take themselves off
 * somebody else's booking — with the log going quiet after the first minute.
 *
 * ## What each leg here would have caught
 *
 * 1. **Zero reads.** The guard must not touch `clubTimeSettings` at all. Before
 *    the fix this counter was 1 per call. This is the leg that fails on the
 *    defect itself rather than on a symptom of it.
 * 2. **The supplied day is the one used.** Zero reads is satisfied perfectly by
 *    a guard that ignores `today` and calls `new Date()`, so the day threaded in
 *    has to be observably the day the answer turns on. The fixture below is
 *    chosen to straddle BOTH fallbacks — see `SUPPLIED_CLUB_DAY`.
 * 3. **No default.** A defaulted parameter would let a future caller silently
 *    reacquire whatever the default reads, which is how the container's zone got
 *    into fifteen call sites in the first place (#2682).
 *
 * The prisma mock deliberately CARRIES `clubTimeSettings.findUnique`. A mock
 * that omitted it would make `readPersistedClubTimeZoneRow` return
 * `{ ok: true, value: null }` — "no such table yet" — and fall through to the
 * environment seed with nothing to count, so the suite would pass identically
 * before and after the fix. Fail-soft in three directions is exactly why this
 * has to be measured at the query and not at the answer.
 */
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const h = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: h.clubTimeSettingsFindUnique },
  },
}));

import { parseDateOnly } from "@/lib/date-only";
import {
  assertNoBookingMemberNightConflicts,
  findBookingMemberNightConflicts,
} from "@/lib/booking-member-night-conflicts";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

/**
 * The club's persisted zone for this suite. NOT `Pacific/Auckland`, which is
 * both the environment seed's value under the frozen clock and the documented
 * fallback a lost read degrades to — a test that used it could not tell the
 * club's own answer from either substitute.
 */
const PERSISTED_CLUB_ZONE = "America/Denver";

/**
 * The day the CALLER resolved and threaded in.
 *
 * Deliberately neither of the two days the guard could reach for itself. Under
 * the root frozen clock (2026-07-01T00:00:00Z) the environment seed's day is
 * 2026-07-01 and the persisted `America/Denver` day is 2026-06-30. Supplying
 * 2026-06-25 means the assertions below distinguish the threaded value from
 * BOTH — a straddle against the fix's own fallback, not only against the
 * container's zone.
 */
const SUPPLIED_CLUB_DAY = dateOnlyInstantOf(requireCalendarDate("2026-06-25"));

/**
 * The clashing stay's check-in, chosen so `evaluateGuestSelfRemoval`'s
 * `storedDateOnly(bookingCheckIn) <= today` gate answers DIFFERENTLY on the
 * supplied day and on either day the guard could have read:
 *
 *   - supplied 2026-06-25 -> 28 June is still future -> self-removal offered;
 *   - persisted-zone 2026-06-30 -> 28 June has passed -> `STAY_NOT_FUTURE`;
 *   - environment-seed 2026-07-01 -> likewise refused.
 */
const CLASHING_CHECK_IN = "2026-06-28";

function clashingGuestRow() {
  return {
    id: "guest-2",
    memberId: "member-2",
    firstName: "Bob",
    lastName: "Jones",
    stayStart: null,
    stayEnd: null,
    nights: [],
    member: { firstName: "Bob", lastName: "Jones" },
    booking: {
      id: "booking-2",
      // Somebody ELSE's booking: self-removal is the path off another member's
      // party, so an owner match short-circuits before the date gate.
      memberId: "member-9",
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: parseDateOnly(CLASHING_CHECK_IN),
      checkOut: parseDateOnly("2026-06-30"),
      member: { firstName: "Carol", lastName: "Owner" },
      guests: [
        { id: "guest-2", memberId: "member-2" },
        { id: "guest-3", memberId: "member-3" },
      ],
    },
  };
}

function conflictDb() {
  return {
    bookingGuest: { findMany: vi.fn().mockResolvedValue([clashingGuestRow()]) },
  };
}

const guardInput = {
  actorMemberId: "member-2",
  actorRole: "USER",
  checkIn: parseDateOnly(CLASHING_CHECK_IN),
  checkOut: parseDateOnly("2026-06-30"),
  guests: [{ memberId: "member-2" }],
};

describe("the person-night guard never reads the club's timezone (#3123)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: PERSISTED_CLUB_ZONE,
    });
  });

  it("runs the whole guard without one `clubTimeSettings` query", async () => {
    await findBookingMemberNightConflicts(conflictDb() as never, {
      ...guardInput,
      today: SUPPLIED_CLUB_DAY,
    });

    expect(
      h.clubTimeSettingsFindUnique,
      "`findBookingMemberNightConflicts` runs inside nine booking-write " +
        "transactions holding `pg_advisory_xact_lock(1)`, the per-lodge " +
        "capacity key and a per-member night lock per linked guest. A " +
        "`clubTimeSettings` read here goes to the MODULE client, not the `db` " +
        "the function was handed, so it needs a second pooled connection while " +
        "all of that is held — the P2024 pile-up `INV-LOCK-004` exists to " +
        "prevent. The caller resolves the day and threads it in.",
    ).not.toHaveBeenCalled();
  });

  it("also takes no zone read on the authoritative locking path", async () => {
    const db = {
      ...conflictDb(),
      $executeRaw: vi.fn().mockResolvedValue(undefined),
    };

    await assertNoBookingMemberNightConflicts(db as never, {
      ...guardInput,
      // A different actor, so the conflict is somebody else's row and the
      // assertion throws rather than returning — the throwing path must be as
      // read-free as the returning one.
      actorMemberId: "member-1",
      today: SUPPLIED_CLUB_DAY,
    }).catch(() => undefined);

    // The per-member advisory lock really was taken, so this is the locked path
    // and not a vacuous run through a client that skipped it.
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(h.clubTimeSettingsFindUnique).not.toHaveBeenCalled();
  });

  it("answers self-removal on the SUPPLIED day, not on either day it could read", async () => {
    const conflicts = await findBookingMemberNightConflicts(
      conflictDb() as never,
      { ...guardInput, today: SUPPLIED_CLUB_DAY },
    );

    expect(conflicts).toHaveLength(1);
    expect(
      conflicts[0].canSelfRemove,
      `On the supplied day (2026-06-25) the clashing stay starting ` +
        `${CLASHING_CHECK_IN} is still future, so the member may take ` +
        "themselves off it. On the persisted zone's day (2026-06-30) and on " +
        "the environment seed's (2026-07-01) it has already started and the " +
        "answer is `STAY_NOT_FUTURE`. A guard that ignored `today` — or " +
        "resolved one for itself — would report false here while reading zero " +
        "settings rows, which is why 'no query' is not the whole property.",
    ).toBe(true);
  });

  it("the same fixture flips when the caller threads a LATER day", async () => {
    // Not vacuous: the leg above must be reading `today` and not simply
    // returning true for this shape.
    const conflicts = await findBookingMemberNightConflicts(
      conflictDb() as never,
      {
        ...guardInput,
        today: dateOnlyInstantOf(requireCalendarDate("2026-06-30")),
      },
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].canSelfRemove).toBe(false);
  });

  it("has no default for `today` — the compiler enumerates the callers", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.resolve(__dirname, "../booking-member-night-conflicts.ts"),
      "utf8",
    );

    expect(source).toContain("today: Date;");
    expect(
      source,
      "An optional or defaulted `today` lets a future caller silently " +
        "reacquire whatever the default reads. That is exactly how the " +
        "container's timezone reached fifteen 'today' call sites in #2682, and " +
        "why every #3123 site takes the day as a REQUIRED parameter.",
    ).not.toMatch(/today\?:|today\s*=\s*/);
  });
});
