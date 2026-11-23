import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";
import { createOwedNoticeStore } from "./support/owed-notice-store";

/*
 * #5407 item 13: the bump notices' owed markers, their delivery after the
 * bump commits, and the sweep each confirm-pending run makes. Since #5433 the
 * markers are written to an in-memory `OwedNotice` table, and the sweep cases
 * that seed an in-memory `AlertCooldown` prove the drain of the markers a
 * release before #5433 left there (same claim, same event key); the member's
 * email is a double of the email core
 * that answers `already_recorded` for an event key it has recorded, which is
 * what `recordEmailAttempt` does against the EmailLog primary key
 * (durable-email-idempotency.test.ts). The sweep against PostgreSQL is in
 * booking-bump-notice-owed.realdb.test.ts.
 */

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingEventFindFirst: vi.fn(),
  sendBumped: vi.fn(),
  sendGuestsCancelled: vi.fn(),
  alertOfficers: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const cooldown = createAlertCooldownStore();
const owedTable = createOwedNoticeStore();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get alertCooldown() {
      return cooldown.delegate;
    },
    get owedNotice() {
      return owedTable.delegate;
    },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    bookingEvent: { findFirst: (...args: unknown[]) => mocks.bookingEventFindFirst(...args) },
  },
}));
vi.mock("@/lib/email", () => ({
  sendBookingBumpedEmail: (...args: unknown[]) => mocks.sendBumped(...args),
  sendBookingGuestsCancelledEmail: (...args: unknown[]) => mocks.sendGuestsCancelled(...args),
}));
vi.mock("@/lib/booking-bump-alert", () => ({
  alertOfficersOfBump: (...args: unknown[]) => mocks.alertOfficers(...args),
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import {
  NOT_A_SETTLEMENT_MARKER_WHERE,
  SETTLEMENT_MARKER_EVENT_REASONS,
} from "@/lib/manual-settlement-reversal-event";
import {
  BUMP_NOTICE_MAX_AGE_MS,
  BUMP_NOTICE_SWEEP_AFTER_MS,
  bumpNoticeId,
  bumpNoticeIdempotencyKey,
  legacyBumpNoticeKey,
  legacyBumpMarkerSource,
  BUMP_NOTICE_DELIVERERS,
  deliverBumpNotice,
  recordBumpNoticesOwed,
} from "@/lib/booking-bump-notice-owed";
import { drainOwedNotices } from "@/lib/owed-notice/drain";

const BUMPED_AT = new Date("2026-07-01T00:00:00.000Z");
const at = (ms: number) => new Date(BUMPED_AT.getTime() + ms);
const DUE = at(BUMP_NOTICE_SWEEP_AFTER_MS);

function cancelledBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    status: "CANCELLED",
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-15"),
    checkOut: new Date("2026-07-17"),
    memberId: "member-1",
    member: { id: "member-1", email: "jane@example.org", firstName: "Jane", lastName: "Doe", canLogin: true },
    organisation: null,
    guests: [{ id: "g1" }, { id: "g2" }],
    ...overrides,
  };
}

/** The descriptor `recordBumpNoticesOwed` hands the delivery. */
const owedAt = (bumpedAt: Date, flagged: boolean) => ({ bookingId: "b1", bumpedAt, flagged });

/** The legacy `AlertCooldown` keys a release before #5433 wrote. */
const memberKey = (flagged = false) => legacyBumpNoticeKey("member", "b1", BUMPED_AT, flagged);
const officerKey = (flagged = false) => legacyBumpNoticeKey("officers", "b1", BUMPED_AT, flagged);
/** The `OwedNotice` ids this release writes. */
const memberId = (flagged = false) => bumpNoticeId("member", "b1", BUMPED_AT, flagged);
const officerId = (flagged = false) => bumpNoticeId("officers", "b1", BUMPED_AT, flagged);

/** Seed a table marker as the bump's transaction writes it. */
function seedTable(kind: "member" | "officers", flagged: boolean, stampedAt: Date = BUMPED_AT, bumpedAt: Date = BUMPED_AT) {
  owedTable.seed({
    id: bumpNoticeId(kind, "b1", bumpedAt, flagged),
    kind: kind === "member" ? "booking-bump-member" : "booking-bump-officers",
    subjectId: "b1",
    eventAt: bumpedAt,
    variant: flagged ? "g" : "b",
    stampedAt,
  });
}

type StoredEvent = { type: string; reason: string | null; occurredAt: Date };
type EventWhere = {
  type: { in: string[] };
  occurredAt: { gt: Date };
  OR: Array<{ reason: null } | { reason: { notIn: string[] } }>;
};

/** The sweep's later-event where, read the way PostgreSQL reads it (NULL never matches `notIn`). */
function matchesEventWhere(event: StoredEvent, where: EventWhere): boolean {
  if (!where.type.in.includes(event.type) || !(event.occurredAt > where.occurredAt.gt)) return false;
  return where.OR.some((branch) =>
    branch.reason === null ? event.reason === null : event.reason !== null && !branch.reason.notIn.includes(event.reason),
  );
}

/** Provider sends the email core made, one per event key it recorded. */
let transportSends = 0;

beforeEach(() => {
  vi.clearAllMocks();
  cooldown.rows.clear();
  owedTable.rows.clear();
  transportSends = 0;
  const recorded = new Set<string>();
  const emailCore = async (context: { idempotencyKey: string }) => {
    if (recorded.has(context.idempotencyKey)) return { status: "already_recorded", emailLogId: context.idempotencyKey };
    recorded.add(context.idempotencyKey);
    transportSends += 1;
    return { status: "sent", emailLogId: context.idempotencyKey, messageId: "m1" };
  };
  mocks.sendBumped.mockImplementation(emailCore);
  mocks.sendGuestsCancelled.mockImplementation(emailCore);
  mocks.alertOfficers.mockResolvedValue("settled");
  mocks.bookingFindUnique.mockResolvedValue(cancelledBooking());
  mocks.bookingEventFindFirst.mockResolvedValue(null);
});

describe("recordBumpNoticesOwed", () => {
  it("records both notices, stamped at the bump, and leaves an existing marker as it is", async () => {
    const tx = { owedNotice: owedTable.delegate } as never;
    await expect(recordBumpNoticesOwed(tx, { bookingId: "b1", bumpedAt: BUMPED_AT, flagged: false })).resolves.toEqual(
      owedAt(BUMPED_AT, false),
    );

    expect([...owedTable.rows.values()].map(({ id, stampedAt }) => [id, stampedAt])).toEqual([
      [`booking-bump-member:b1:${BUMPED_AT.getTime()}:b`, BUMPED_AT],
      [`booking-bump-officers:b1:${BUMPED_AT.getTime()}:b`, BUMPED_AT],
    ]);
    // One insert that skips a marker already there (ON CONFLICT DO NOTHING):
    // a caught unique-key error would abort the transaction.
    expect(owedTable.delegate.createMany).toHaveBeenCalledTimes(1);
    expect(owedTable.delegate.createMany.mock.calls[0]![0]).toMatchObject({ skipDuplicates: true });
    owedTable.rows.get(memberId())!.stampedAt = at(5);
    await recordBumpNoticesOwed(tx, { bookingId: "b1", bumpedAt: BUMPED_AT, flagged: false });
    expect(owedTable.rows.get(memberId())!.stampedAt).toEqual(at(5));
  });

  it("takes the bump time once, on the clock, and hands it back for the delivery", async () => {
    const tx = { owedNotice: owedTable.delegate } as never;
    const owed = await recordBumpNoticesOwed(tx, { bookingId: "b1", flagged: false });
    expect(owed.bumpedAt).toEqual(new Date());
    expect(owedTable.rows.get(bumpNoticeId("member", "b1", owed.bumpedAt, false))!.stampedAt).toEqual(owed.bumpedAt);
  });

  it("keys each bump of a reinstated booking apart", () => {
    expect(bumpNoticeId("member", "b1", at(1), false)).not.toBe(memberId());
    expect(memberId(true)).not.toBe(memberId(false));
    expect(memberId()).not.toBe(officerId());
  });
});

describe("deliverBumpNotice, right after the commit", () => {
  it("sends the member's email with the bump's event key and clears its marker", async () => {
    seedTable("member", false);

    await deliverBumpNotice("member", cancelledBooking() as never, owedAt(BUMPED_AT, false));

    expect(mocks.sendBumped).toHaveBeenCalledWith(
      { bookingId: "b1", recipientMemberId: "member-1", idempotencyKey: bumpNoticeIdempotencyKey("b1", BUMPED_AT) },
      "jane@example.org",
      "Jane",
      new Date("2026-07-15"),
      new Date("2026-07-17"),
      2,
      "lodge-1",
      true,
    );
    expect(bumpNoticeIdempotencyKey("b1", BUMPED_AT)).toBe(`b1:${BUMPED_AT.getTime()}`);
    expect(owedTable.rows.size).toBe(0);
  });

  it("sends the guests-cancelled email for a flagged booking", async () => {
    seedTable("member", true);

    await deliverBumpNotice("member", cancelledBooking() as never, owedAt(BUMPED_AT, true));

    expect(mocks.sendGuestsCancelled).toHaveBeenCalledTimes(1);
    expect(mocks.sendBumped).not.toHaveBeenCalled();
    expect(owedTable.rows.size).toBe(0);
  });

  it("leaves the marker, claimed, when the send throws", async () => {
    seedTable("officers", false);
    mocks.alertOfficers.mockResolvedValue("threw");

    await deliverBumpNotice("officers", cancelledBooking() as never, owedAt(BUMPED_AT, false));

    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    // Stamped at the claim, so the sweep waits from this attempt.
    expect(owedTable.rows.get(officerId())!.stampedAt.getTime()).toBeGreaterThan(BUMPED_AT.getTime());
  });

  // INV-SSOT-002: the claim's bound is the stamp the transaction wrote, never
  // the clock or the run's start.
  it("claims with the stamp it is handed when that differs from the clock", async () => {
    const stampedAt = new Date(Date.now() - 90 * 60 * 1000);
    seedTable("officers", false, stampedAt, stampedAt);

    await deliverBumpNotice("officers", cancelledBooking() as never, owedAt(stampedAt, false));

    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    expect(owedTable.rows.size).toBe(0);
  });

  it("sends nothing when a sweep already holds the marker", async () => {
    // A sweep claimed it after the bump; the delivery runs later still, so a
    // bound taken from the clock rather than the stamp would win it back.
    seedTable("officers", false, at(5));
    vi.setSystemTime(at(60_000));
    try {
      await deliverBumpNotice("officers", cancelledBooking() as never, owedAt(BUMPED_AT, false));
    } finally {
      vi.setSystemTime(BUMPED_AT);
    }

    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(owedTable.rows.get(officerId())!.stampedAt).toEqual(at(5));
  });

  it("sends nothing, and never throws, when the claim cannot be written", async () => {
    seedTable("officers", false);
    owedTable.delegate.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(deliverBumpNotice("officers", cancelledBooking() as never, owedAt(BUMPED_AT, false))).resolves.toBeUndefined();

    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(owedTable.rows.get(officerId())!.stampedAt).toEqual(BUMPED_AT);
  });
});

describe("drainOwedNotices, the sweep of the legacy AlertCooldown bump markers", () => {
  it("sends an owed member email with the bump's event key, then clears it", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);

    const result = await drainOwedNotices(DUE);

    expect(result).toEqual({ checked: 1, delivered: 1, cleared: 0, expired: 0 });
    expect(mocks.sendBumped.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ idempotencyKey: `b1:${BUMPED_AT.getTime()}` }),
    );
    expect(mocks.bookingFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "b1" } }));
    expect(cooldown.rows.size).toBe(0);
  });

  it("sends an owed officers' alert with the booking it read again", async () => {
    cooldown.rows.set(officerKey(true), BUMPED_AT);

    await drainOwedNotices(DUE);

    // #5433 review: with the job running the sweep, for its logs.
    expect(mocks.alertOfficers).toHaveBeenCalledWith(cancelledBooking(), true, "owed-notice-sweep");
    expect(cooldown.rows.size).toBe(0);
  });

  it("records nothing twice: a second sweep finds the row recorded, clears the marker and sends nothing", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);
    // The first sweep sends, then cannot clear its marker (as if it crashed).
    cooldown.delegate.deleteMany.mockRejectedValueOnce(new Error("connection lost"));
    await drainOwedNotices(DUE);
    expect(transportSends).toBe(1);
    expect(cooldown.rows.has(memberKey())).toBe(true);

    const second = await drainOwedNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS + 1));

    expect(second.delivered).toBe(1);
    expect(mocks.sendBumped).toHaveBeenCalledTimes(2);
    expect(transportSends).toBe(1);
    expect(cooldown.rows.size).toBe(0);
  });

  it("waits until the marker's last attempt is a full wait old", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);

    await expect(drainOwedNotices(at(BUMP_NOTICE_SWEEP_AFTER_MS - 1))).resolves.toEqual({
      checked: 0,
      delivered: 0,
      cleared: 0,
      expired: 0,
    });
    expect(mocks.alertOfficers).not.toHaveBeenCalled();

    // A send that throws waits a full period again from that attempt.
    mocks.alertOfficers.mockResolvedValue("threw");
    await drainOwedNotices(DUE);
    await drainOwedNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS - 1));
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    await drainOwedNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS));
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(2);
    expect(cooldown.rows.has(officerKey())).toBe(true);
  });

  it("clears a marker past its maximum age with an error log, sending nothing", async () => {
    const tooOld = at(BUMP_NOTICE_MAX_AGE_MS + 1);
    cooldown.rows.set(officerKey(), at(BUMP_NOTICE_MAX_AGE_MS - BUMP_NOTICE_SWEEP_AFTER_MS));

    const result = await drainOwedNotices(tooOld);

    expect(result).toEqual({ checked: 1, delivered: 0, cleared: 0, expired: 1 });
    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: officerKey() }),
      expect.stringContaining("maximum age"),
    );
    expect(cooldown.rows.size).toBe(0);
  });

  it("clears a marker it cannot read, sending nothing", async () => {
    cooldown.rows.set("booking-bump-member-owed:b1:not-a-time:b", BUMPED_AT);

    const result = await drainOwedNotices(DUE);

    expect(result.expired).toBe(1);
    expect(mocks.sendBumped).not.toHaveBeenCalled();
    expect(cooldown.rows.size).toBe(0);
  });

  it.each([
    ["deleted", null],
    ["reinstated", cancelledBooking({ status: "CONFIRMED" })],
  ])("clears a marker whose booking was %s, sending nothing", async (_label, booking) => {
    cooldown.rows.set(memberKey(), BUMPED_AT);
    cooldown.rows.set(officerKey(), BUMPED_AT);
    mocks.bookingFindUnique.mockResolvedValue(booking);

    const result = await drainOwedNotices(DUE);

    expect(result).toEqual({ checked: 2, delivered: 0, cleared: 2, expired: 0 });
    expect(mocks.sendBumped).not.toHaveBeenCalled();
    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(cooldown.rows.size).toBe(0);
  });

  // #5407 review: the bump writes BUMPED only, so a later CANCELLED or
  // confirmation event means the booking was reinstated and moved on.
  it.each(["CANCELLED", "MEMBER_PAID", "NON_MEMBER_CONFIRMED"])(
    "clears without sending when a %s event was recorded after the bump",
    async (type) => {
      cooldown.rows.set(memberKey(), BUMPED_AT);
      mocks.bookingEventFindFirst.mockResolvedValue({ type });

      const result = await drainOwedNotices(DUE);

      expect(result).toEqual({ checked: 1, delivered: 0, cleared: 1, expired: 0 });
      expect(mocks.sendBumped).not.toHaveBeenCalled();
      expect(mocks.bookingEventFindFirst).toHaveBeenCalledWith({
        where: {
          bookingId: "b1",
          type: { in: ["CANCELLED", "MEMBER_PAID", "NON_MEMBER_CONFIRMED"] },
          occurredAt: { gt: BUMPED_AT },
          ...NOT_A_SETTLEMENT_MARKER_WHERE,
        },
        select: { type: true },
      });
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: memberKey(), why: `recorded ${type} since the bump` }),
        expect.any(String),
      );
      expect(cooldown.rows.size).toBe(0);
    },
  );

  it("still sends when no later event moved the booking on", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);

    await drainOwedNotices(DUE);

    expect(mocks.bookingEventFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
  });

  // #5407 review: each attempt that reaches nobody writes an undeliverable-
  // alert escalation, so the next one waits a day, as the once-only alerts do.
  it("holds the officers' marker a day when their alert reached nobody and nothing replays it", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);
    mocks.alertOfficers.mockResolvedValue("unreached");

    const result = await drainOwedNotices(DUE);

    expect(result.delivered).toBe(0);
    expect(cooldown.rows.has(officerKey())).toBe(true);
    // Not offered again an hour later, nor until a day after that attempt.
    await drainOwedNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS));
    await drainOwedNotices(new Date(DUE.getTime() + ALERT_NOBODY_ELIGIBLE_RETRY_MS - 1));
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    mocks.alertOfficers.mockResolvedValue("settled");
    await drainOwedNotices(new Date(DUE.getTime() + ALERT_NOBODY_ELIGIBLE_RETRY_MS));
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(2);
    expect(cooldown.rows.size).toBe(0);
  });

  it("does not hold the member's marker a day: a member send that threw waits the usual hour", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);
    mocks.sendBumped.mockRejectedValueOnce(new Error("SMTP down"));

    await drainOwedNotices(DUE);
    await drainOwedNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS));

    expect(mocks.sendBumped).toHaveBeenCalledTimes(2);
    expect(cooldown.rows.size).toBe(0);
  });

  // #5407 review: a settlement marker is a CANCELLED event that cancels
  // nothing; the sweep's read leaves it out by reason, so the notice is sent.
  it("still sends when the only later CANCELLED event is a settlement marker", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);
    // The stored events after the bump, read through the sweep's own where:
    // a settlement marker, and a genuine cancel with no reason, before the bump.
    const events = [
      { type: "CANCELLED", reason: SETTLEMENT_MARKER_EVENT_REASONS[0]!, occurredAt: at(60_000) },
      { type: "CANCELLED", reason: null, occurredAt: at(-60_000) },
    ];
    mocks.bookingEventFindFirst.mockImplementation(async ({ where }: { where: EventWhere }) => {
      return events.find((event) => matchesEventWhere(event, where)) ?? null;
    });

    const result = await drainOwedNotices(DUE);

    expect(result.delivered).toBe(1);
    expect(mocks.sendBumped).toHaveBeenCalledTimes(1);
    // A genuine cancel after the bump, reason or none, still clears it.
    for (const reason of [null, "Cancelled by the member"]) {
      cooldown.rows.set(memberKey(), BUMPED_AT);
      events.push({ type: "CANCELLED", reason, occurredAt: at(120_000) });
      await expect(drainOwedNotices(DUE)).resolves.toMatchObject({ cleared: 1 });
      events.pop();
    }
    expect(mocks.sendBumped).toHaveBeenCalledTimes(1);
  });

  it("sends the officers' alert once when two runs sweep at the same moment", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);

    const results = await Promise.all([drainOwedNotices(DUE), drainOwedNotices(DUE)]);

    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.delivered).sort()).toEqual([0, 1]);
    expect(cooldown.rows.size).toBe(0);
  });

  it("carries on past a marker that fails, and never throws", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);
    cooldown.rows.set(legacyBumpNoticeKey("officers", "b2", BUMPED_AT, false), at(1));
    mocks.bookingFindUnique.mockRejectedValueOnce(new Error("db down"));

    const result = await drainOwedNotices(at(BUMP_NOTICE_SWEEP_AFTER_MS + 1));

    expect(result).toEqual({ checked: 2, delivered: 1, cleared: 0, expired: 0 });
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    // The failed one stays owed, under the sweep's claim.
    expect(cooldown.rows.has(officerKey())).toBe(true);
  });

  // #5433 review (INV-SSOT-002): the legacy source lists by the bound the drain hands it, not one of its own.
  it("lists legacy markers by the due bound it is given", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);
    const deliverer = BUMP_NOTICE_DELIVERERS[1]!;
    const list = (dueBefore: Date) => legacyBumpMarkerSource.listDue(deliverer, { dueBefore, now: at(10 * BUMP_NOTICE_SWEEP_AFTER_MS) });

    await expect(list(at(-1))).resolves.toEqual([]);
    await expect(list(BUMPED_AT)).resolves.toMatchObject([{ key: officerKey() }]);
  });

  it("answers zero, and never throws, when the markers cannot be read", async () => {
    // One failed read per notice kind.
    cooldown.delegate.findMany.mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"));

    await expect(drainOwedNotices(DUE)).resolves.toEqual({ checked: 0, delivered: 0, cleared: 0, expired: 0 });
    expect(cooldown.delegate.findMany).toHaveBeenCalledTimes(2);
  });
});
