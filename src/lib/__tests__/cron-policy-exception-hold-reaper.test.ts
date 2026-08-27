import { beforeEach, describe, expect, it, vi } from "vitest";

// #2553: the abandoned policy-exception capacity-hold reaper. These tests pin
// the three properties the issue turns on — the scan only ever sees holds, the
// deadline decides, and the release is the SHARED atomic terminal transition
// (never a forked delete) — plus idempotency across reruns and races.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  resolveTerminal: vi.fn(),
  createAuditLog: vi.fn(),
  sendExpiredEmail: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
    },
    // #3123 - NOT OPTIONAL. `readClubTimeZoneOutsideRequest` is fail-soft three
    // ways (no delegate, a throwing query, no row) and every one of them
    // degrades silently to the environment's zone, so a prisma mock without
    // this delegate makes the reaper pass for exactly the reason these cases
    // exist to rule out.
    clubTimeSettings: {
      findUnique: (...a: unknown[]) => mocks.clubTimeSettingsFindUnique(...a),
    },
  },
}));

vi.mock("@/lib/booking-exception-execution", () => ({
  resolvePolicyExceptionRequestTerminal: (...a: unknown[]) =>
    mocks.resolveTerminal(...a),
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));

vi.mock("@/lib/email/booking", () => ({
  sendPolicyExceptionRequestExpiredEmail: (...a: unknown[]) =>
    mocks.sendExpiredEmail(...a),
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

import {
  POLICY_EXCEPTION_EXPIRY_AUDIT_ACTION,
  reapExpiredPolicyExceptionHolds,
} from "@/lib/cron-policy-exception-hold-reaper";
import {
  computePolicyExceptionHoldExpiry,
  POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS,
  POLICY_EXCEPTION_HOLD_TTL_DAYS,
} from "@/lib/booking-exception-requests";
import { requireClubTimeZone } from "@/lib/club-time";

// The suite runs under the repo's frozen clock (2026-07-01T00:00:00.000Z), so
// every fixture below is written relative to that instant.
const NOW = new Date("2026-07-01T00:00:00.000Z");
/**
 * The club's PERSISTED zone under test (#3123). Deliberately NOT
 * `Pacific/Auckland`: that is what `APP_TIME_ZONE` falls back to, so a club on
 * it could not be told apart from the environment's claim. Denver is behind
 * Greenwich, which is the side these defects are visible on.
 */
const CLUB_ZONE = requireClubTimeZone("America/Denver");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function primeClubZone() {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: CLUB_ZONE,
    updatedByMemberId: null,
    updatedAt: NOW,
  });
}

function candidate(
  over: Partial<{
    id: string;
    version: number;
    holdExpiresAt: Date | null;
    createdAt: Date;
    bookingId: string;
    requestedByMemberId: string;
    reservationNights: { night: Date }[];
  }> = {},
) {
  return {
    id: "req-1",
    version: 3,
    holdExpiresAt: new Date(NOW.getTime() - 60_000),
    createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
    bookingId: "bk-1",
    requestedByMemberId: "mem-1",
    // The scan carries the earliest held night (`@db.Date`, read back at UTC
    // midnight) so the NULL-column fallback can apply the first-night cap.
    reservationNights: [{ night: new Date("2026-08-01T00:00:00.000Z") }],
    ...over,
  };
}

// The post-commit read that backs the member notice: who raised the request and
// which stay it hangs off. Deliberately NOT part of the scan select — the reaper
// reads an address only for a request it actually closed.
function notificationContext(
  over: Partial<{
    firstName: string;
    email: string;
    inheritEmailFromId: string | null;
    inheritEmailFrom: { email: string } | null;
    booking: { checkIn: Date; checkOut: Date; lodgeId: string };
  }> = {},
) {
  return {
    requestedBy: {
      firstName: over.firstName ?? "Aroha",
      email: over.email ?? "aroha@example.org",
      inheritEmailFromId: over.inheritEmailFromId ?? null,
      inheritEmailFrom: over.inheritEmailFrom ?? null,
    },
    booking:
      over.booking ?? {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        lodgeId: "lodge-1",
      },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  primeClubZone();
  mocks.resolveTerminal.mockResolvedValue({ claimed: true, released: 2 });
  mocks.createAuditLog.mockResolvedValue(undefined);
  mocks.findUnique.mockResolvedValue(notificationContext());
  mocks.sendExpiredEmail.mockResolvedValue({
    status: "sent",
    emailLogId: "log-1",
    messageId: "msg-1",
  });
});

describe("reapExpiredPolicyExceptionHolds", () => {
  it("scans only OPEN, HOLD-mode policy-exception requests that still hold beds", async () => {
    mocks.findMany.mockResolvedValue([]);

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      kind: "POLICY_EXCEPTION",
      // An officer-decided, member-cancelled, superseded or already-expired row
      // is out of scope: only a request still awaiting a decision can be
      // abandoned, and only through this filter can the cron be idempotent.
      status: "REQUESTED",
      aggregateCapacityMode: "HOLD",
      // The invariant that keeps the blast radius to stranded capacity: a HOLD
      // request whose incremental footprint came out empty (a pure shrink) holds
      // no beds, so this cron must never close it. Reservation rows exist only
      // between creation and a terminal transition, so for a REQUESTED row this
      // is exactly "is stranding beds right now".
      reservationNights: { some: {} },
    });
  });

  it("never sees a NO_HOLD or empty-footprint request, so cannot close one", async () => {
    // Belt-and-braces on the filter above: the where clause is the ONLY thing
    // deciding which requests are in scope, so pin that a request outside it is
    // never even a candidate — the cron cannot reach `resolveTerminal` for it.
    mocks.findMany.mockResolvedValue([]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 0,
      expired: 0,
      releasedNights: 0,
      failed: 0,
      unresolvable: 0,
    });
  });

  it("expires a past-deadline hold through the SHARED terminal release", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.resolveTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTerminal).toHaveBeenCalledWith({
      requestId: "req-1",
      // The version read during the scan is the optimistic claim token, so a
      // decision landing in between makes this a lost claim rather than a
      // clobber.
      expectedVersion: 3,
      to: "EXPIRED",
    });
    expect(result).toEqual({
      scanned: 1,
      expired: 1,
      releasedNights: 2,
      failed: 0,
      unresolvable: 0,
    });
  });

  it("leaves a hold whose deadline has not arrived completely alone", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: new Date(NOW.getTime() + 60_000) }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      releasedNights: 0,
      failed: 0,
      unresolvable: 0,
    });
  });

  it("treats a deadline exactly at `now` as due", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: new Date(NOW.getTime()) }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result.expired).toBe(1);
  });

  it("falls back to the createdAt-derived deadline when the column is NULL", async () => {
    // A HOLD request the OLD colour wrote during the migrate -> cutover drain
    // has no stored deadline; without the fallback it would hold its beds
    // forever, which is exactly the bug this cron exists to close.
    const createdAt = new Date(
      NOW.getTime() - (POLICY_EXCEPTION_HOLD_TTL_DAYS + 1) * DAY_MS,
    );
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: null, createdAt }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result.expired).toBe(1);
    // ...and the same fallback keeps a RECENT null-column hold alive.
    mocks.resolveTerminal.mockClear();
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: null, createdAt: new Date(NOW.getTime() - DAY_MS) }),
    ]);
    const recent = await reapExpiredPolicyExceptionHolds(NOW);
    expect(recent.expired).toBe(0);
    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
  });

  it("reads the earliest held night, so the NULL-column fallback can cap on it", async () => {
    mocks.findMany.mockResolvedValue([]);

    await reapExpiredPolicyExceptionHolds(NOW);

    // One column of the relation the scan already correlates. Without it the
    // fallback below cannot apply the first-night cap, and an undated hold would
    // sit on beds through the whole stay.
    expect(mocks.findMany.mock.calls[0][0].select.reservationNights).toEqual({
      select: { night: true },
      orderBy: { night: "asc" },
      take: 1,
    });
  });

  it("caps a NULL-column hold at its first held night, not just at createdAt + TTL", async () => {
    // THE case the first-night cap exists for, and the one an uncapped fallback
    // gets wrong. Raised two days ago for a stay that has already started: the
    // 7-day TTL alone would keep the beds off the market until 8 Jul, four days
    // into other members' view of a lodge that looks full. The stamped rule would
    // have released them when the stay began, so the fallback must too.
    const createdAt = new Date(NOW.getTime() - 2 * DAY_MS);
    mocks.findMany.mockResolvedValue([
      candidate({
        holdExpiresAt: null,
        createdAt,
        // 2026-06-29 00:00 in the CLUB's zone (America/Denver, UTC-6) is
        // 2026-06-29T06:00Z — before NOW, and before the 24-hour floor, so the
        // floor is what this case pins (#3123: the night was 30 June while the
        // zone was Auckland's; the club's zone starts the day six hours the
        // other side of Greenwich).
        reservationNights: [{ night: new Date("2026-06-29T00:00:00.000Z") }],
      }),
    ]);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result.expired).toBe(1);
    // Pin that the pure rule agrees, and that the uncapped reading would NOT have
    // expired this row — otherwise this test passes for the wrong reason.
    expect(
      computePolicyExceptionHoldExpiry({
        createdAt,
        firstHeldNight: "2026-06-29",
        zone: CLUB_ZONE,
      }).getTime(),
      // The 24-hour floor still wins over the already-started night.
    ).toBe(createdAt.getTime() + POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS * HOUR_MS);
    expect(
      computePolicyExceptionHoldExpiry({ createdAt, zone: CLUB_ZONE }).getTime(),
    ).toBeGreaterThan(NOW.getTime());
  });

  it("counts and logs a due hold the shared transition REFUSES, instead of assuming a race", async () => {
    // `claimed: false` has two very different meanings. A lost claim self-heals.
    // A refusal — not a policy-exception row, or an unparsable proposalSnapshot —
    // never does: every later run rescans the row, expires nothing, and would
    // otherwise report a clean run while its beds stay stranded indefinitely.
    mocks.findMany.mockResolvedValue([candidate()]);
    mocks.resolveTerminal.mockResolvedValue({
      claimed: false,
      released: 0,
      refused: "unreadable-proposal",
    });

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      releasedNights: 0,
      failed: 0,
      unresolvable: 1,
    });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn.mock.calls[0][0]).toMatchObject({
      changeRequestId: "req-1",
      reason: "unreadable-proposal",
      job: "policy-exception-hold-reaper",
    });
    // Nothing was released, so nothing is claimed in the audit trail either —
    // and nobody is told their request closed, because it did not.
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.sendExpiredEmail).not.toHaveBeenCalled();
  });

  it("writes one audit row per expiry, naming the request, booking and beds released", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLog.mock.calls[0][0]).toMatchObject({
      action: POLICY_EXCEPTION_EXPIRY_AUDIT_ACTION,
      targetId: "bk-1",
      // A cron has no actor member, so the lapsed request's member is the subject
      // and the actor stays unset — this is the system closing their request.
      subjectMemberId: "mem-1",
      entityType: "BookingChangeRequest",
      entityId: "req-1",
      category: "booking",
      outcome: "success",
      metadata: {
        bookingId: "bk-1",
        requestId: "req-1",
        releasedNights: 2,
        deadlineSource: "stamped",
      },
    });
    expect(mocks.createAuditLog.mock.calls[0][0].memberId).toBeUndefined();
  });

  it("records the fallback deadline as such, so an operator can tell the two apart", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({
        holdExpiresAt: null,
        createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
      }),
    ]);

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.createAuditLog.mock.calls[0][0].metadata).toMatchObject({
      deadlineSource: "created-at",
    });
  });

  it("emails the member who raised the request, exactly once per expiry", async () => {
    // Owner decision (2 Aug 2026): closing a member's request and taking their
    // reserved beds back is not done silently. Once per expiry, to the member who
    // RAISED it (not the booking's owner, who may be someone else), carrying the
    // deadline that actually applied rather than "now".
    const holdExpiresAt = new Date(NOW.getTime() - 60_000);
    mocks.findMany.mockResolvedValue([candidate({ holdExpiresAt })]);

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.sendExpiredEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendExpiredEmail.mock.calls[0][0]).toEqual({
      bookingId: "bk-1",
      recipientMemberId: "mem-1",
      email: "aroha@example.org",
      firstName: "Aroha",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      expiresAt: holdExpiresAt,
      lodgeId: "lodge-1",
    });
    // The address is read for the request it CLOSED, not for every candidate it
    // considered, so the read is keyed on that request.
    expect(mocks.findUnique.mock.calls[0][0].where).toEqual({ id: "req-1" });
  });

  it("sends to the household address when the requester inherits their email", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);
    mocks.findUnique.mockResolvedValue(
      notificationContext({
        email: "child@example.invalid",
        inheritEmailFromId: "mem-parent",
        inheritEmailFrom: { email: "parent@example.org" },
      }),
    );

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.sendExpiredEmail.mock.calls[0][0].email).toBe(
      "parent@example.org",
    );
  });

  it("tells the member the DERIVED deadline for a pre-migration hold", async () => {
    // A NULL-column row's deadline is computed, not stored, so the notice has to
    // carry the computed one — telling a member "not decided by null" (or by the
    // moment the cron happened to run) would be worse than saying nothing.
    const createdAt = new Date(NOW.getTime() - 8 * DAY_MS);
    mocks.findMany.mockResolvedValue([
      candidate({ holdExpiresAt: null, createdAt }),
    ]);

    await reapExpiredPolicyExceptionHolds(NOW);

    expect(mocks.sendExpiredEmail.mock.calls[0][0].expiresAt).toEqual(
      computePolicyExceptionHoldExpiry({
        createdAt,
        firstHeldNight: "2026-08-01",
        zone: CLUB_ZONE,
      }),
    );
  });

  it("still counts the expiry when the notice fails to send, and keeps going", async () => {
    // THE property that makes a post-commit send safe. The beds are already back
    // in the pool and the request is no longer REQUESTED, so a failed send has
    // nothing to roll back and nothing to retry — a "retry" would be a second
    // release. It must not be reported as a failed expiry, and it must not stop
    // the run's other stranded holds being returned.
    mocks.findMany.mockResolvedValue([
      candidate({ id: "req-1" }),
      candidate({ id: "req-2" }),
    ]);
    mocks.sendExpiredEmail.mockRejectedValueOnce(new Error("SES unavailable"));

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 2,
      expired: 2,
      releasedNights: 4,
      failed: 0,
      unresolvable: 0,
    });
    expect(mocks.sendExpiredEmail).toHaveBeenCalledTimes(2);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    // Not re-driven: the second candidate got its own single send, and the failed
    // one is not attempted again inside this run.
    expect(mocks.resolveTerminal).toHaveBeenCalledTimes(2);
  });

  it("warns rather than throwing when the request row vanishes before the notice", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);
    mocks.findUnique.mockResolvedValue(null);

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result.expired).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.sendExpiredEmail).not.toHaveBeenCalled();
    // Not silent: somebody's request was closed and nobody could be told.
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still counts an expiry when the audit write fails", async () => {
    // The beds are already back in the pool and the request is no longer
    // REQUESTED, so no retry could repeat the work. Reporting a failure here would
    // send an operator chasing a release that actually happened.
    mocks.findMany.mockResolvedValue([candidate()]);
    mocks.createAuditLog.mockRejectedValue(new Error("audit table offline"));

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 1,
      expired: 1,
      releasedNights: 2,
      failed: 0,
      unresolvable: 0,
    });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the guarded claim is lost to a real decision", async () => {
    mocks.findMany.mockResolvedValue([candidate()]);
    mocks.resolveTerminal.mockResolvedValue({ claimed: false, released: 0 });

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      releasedNights: 0,
      failed: 0,
      unresolvable: 0,
    });
    // A lost claim is the ONE silent outcome: it self-heals, because the next
    // scan re-reads the row's fresh version (or no longer sees it at all). The
    // member hears nothing either — whoever won the race owns telling them.
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.sendExpiredEmail).not.toHaveBeenCalled();
  });

  it("is idempotent across reruns: an already-expired request is no longer scanned", async () => {
    mocks.findMany.mockResolvedValueOnce([candidate()]);
    const first = await reapExpiredPolicyExceptionHolds(NOW);
    expect(first.expired).toBe(1);

    // The status filter excludes the EXPIRED row on the next run, so the second
    // pass claims nothing and releases nothing.
    mocks.findMany.mockResolvedValueOnce([]);
    const second = await reapExpiredPolicyExceptionHolds(NOW);
    expect(second).toEqual({
      scanned: 0,
      expired: 0,
      releasedNights: 0,
      failed: 0,
      unresolvable: 0,
    });
    expect(mocks.resolveTerminal).toHaveBeenCalledTimes(1);
  });

  it("two runners racing the SAME hold expire it exactly once, releasing its beds once", async () => {
    // Concurrent-run safety without an extra job-level advisory lock: the shared
    // terminal helper claims on `status = REQUESTED` AND the exact version read
    // during the scan, inside the global -> lodge locks. Model that here with one
    // claim latch — the first claim through wins, every later one is a lost claim
    // that releases nothing. This is what makes overlapping cron cycles (a slow
    // run still going when the next fires) safe: beds are returned to the pool
    // once, never twice, and capacity can never be double-credited.
    mocks.findMany.mockResolvedValue([candidate()]);
    const claimed = new Set<string>();
    mocks.resolveTerminal.mockImplementation(
      async ({
        requestId,
        expectedVersion,
      }: {
        requestId: string;
        expectedVersion: number;
      }) => {
        const key = `${requestId}@${expectedVersion}`;
        if (claimed.has(key)) return { claimed: false, released: 0 };
        claimed.add(key);
        return { claimed: true, released: 2 };
      },
    );

    const [runA, runB] = await Promise.all([
      reapExpiredPolicyExceptionHolds(NOW),
      reapExpiredPolicyExceptionHolds(NOW),
    ]);

    expect(runA.expired + runB.expired).toBe(1);
    expect(runA.releasedNights + runB.releasedNights).toBe(2);
    expect(runA.failed + runB.failed).toBe(0);
  });

  it("keeps going after one request throws, counting it as failed", async () => {
    mocks.findMany.mockResolvedValue([
      candidate({ id: "req-boom" }),
      candidate({ id: "req-ok", version: 9 }),
    ]);
    mocks.resolveTerminal.mockImplementation(
      async ({ requestId }: { requestId: string }) => {
        if (requestId === "req-boom") throw new Error("deadlock detected");
        return { claimed: true, released: 1 };
      },
    );

    const result = await reapExpiredPolicyExceptionHolds(NOW);

    expect(result).toEqual({
      scanned: 2,
      expired: 1,
      releasedNights: 1,
      failed: 1,
      unresolvable: 0,
    });
  });
});

describe("computePolicyExceptionHoldExpiry", () => {
  it("defaults to the TTL window from creation", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    expect(
      computePolicyExceptionHoldExpiry({ createdAt, zone: CLUB_ZONE }).getTime(),
    ).toBe(createdAt.getTime() + POLICY_EXCEPTION_HOLD_TTL_DAYS * DAY_MS);
  });

  it("never outlives the start of the first held night", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    const expiry = computePolicyExceptionHoldExpiry({
      createdAt,
      // Two days out — well inside the 7-day TTL, so the night caps it.
      firstHeldNight: "2026-07-03",
      zone: CLUB_ZONE,
    });
    expect(expiry.getTime()).toBeLessThan(
      createdAt.getTime() + POLICY_EXCEPTION_HOLD_TTL_DAYS * DAY_MS,
    );
    // 2026-07-03 00:00 in the CLUB's zone (America/Denver, MDT, UTC-6) is
    // 2026-07-03T06:00Z.
    expect(expiry.toISOString()).toBe("2026-07-03T06:00:00.000Z");
  });

  it("starts the night in the CLUB's zone and in nothing else (#3123)", async () => {
    // The discriminating case: the SAME night, capped through two different
    // club zones, must produce two different instants — eighteen hours apart
    // between Auckland (UTC+12) and Denver (UTC-6). Before #3123 the zone came
    // from `APP_TIME_ZONE`, so a club could not move this at all, and a club
    // configured behind its container released its held beds on the wrong day.
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    const denver = computePolicyExceptionHoldExpiry({
      createdAt,
      firstHeldNight: "2026-07-03",
      zone: CLUB_ZONE,
    });
    const auckland = computePolicyExceptionHoldExpiry({
      createdAt,
      firstHeldNight: "2026-07-03",
      zone: requireClubTimeZone("Pacific/Auckland"),
    });
    expect(denver.toISOString()).toBe("2026-07-03T06:00:00.000Z");
    expect(auckland.toISOString()).toBe("2026-07-02T12:00:00.000Z");
    expect(denver.getTime() - auckland.getTime()).toBe(18 * HOUR_MS);
  });

  it("still gives a last-minute request its minimum review window", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    // The first held night has already started, so the cap alone would put the
    // deadline in the past and the very next cron run would reap a request
    // nobody has looked at.
    const expiry = computePolicyExceptionHoldExpiry({
      createdAt,
      firstHeldNight: "2026-06-30",
      zone: CLUB_ZONE,
    });
    expect(expiry.getTime()).toBe(createdAt.getTime() + DAY_MS);
  });

  it("ignores an unparseable night rather than producing an invalid deadline", async () => {
    const createdAt = new Date("2026-07-01T09:00:00.000Z");
    const expiry = computePolicyExceptionHoldExpiry({
      createdAt,
      firstHeldNight: "not-a-date",
      zone: CLUB_ZONE,
    });
    expect(Number.isNaN(expiry.getTime())).toBe(false);
    expect(expiry.getTime()).toBe(
      createdAt.getTime() + POLICY_EXCEPTION_HOLD_TTL_DAYS * DAY_MS,
    );
  });
});
