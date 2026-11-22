import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";

/*
 * #5407 item 13: the bump notices' owed markers, their delivery after the
 * bump commits, and the sweep each confirm-pending run makes. The table is an
 * in-memory `AlertCooldown`; the member's email is a double of the email core
 * that answers `already_recorded` for an event key it has recorded, which is
 * what `recordEmailAttempt` does against the EmailLog primary key
 * (durable-email-idempotency.test.ts). The sweep against PostgreSQL is in
 * booking-bump-notice-owed.realdb.test.ts.
 */

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  sendBumped: vi.fn(),
  sendGuestsCancelled: vi.fn(),
  alertOfficers: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const cooldown = createAlertCooldownStore();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get alertCooldown() {
      return cooldown.delegate;
    },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
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

import {
  BUMP_NOTICE_MAX_AGE_MS,
  BUMP_NOTICE_SWEEP_AFTER_MS,
  bumpNoticeIdempotencyKey,
  bumpNoticeOwedKey,
  deliverBumpNotice,
  drainOwedBumpNotices,
  recordBumpNoticesOwed,
} from "@/lib/booking-bump-notice-owed";

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

const memberKey = (flagged = false) => bumpNoticeOwedKey("member", "b1", BUMPED_AT, flagged);
const officerKey = (flagged = false) => bumpNoticeOwedKey("officers", "b1", BUMPED_AT, flagged);

/** Provider sends the email core made, one per event key it recorded. */
let transportSends = 0;

beforeEach(() => {
  vi.clearAllMocks();
  cooldown.rows.clear();
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
  mocks.alertOfficers.mockResolvedValue(true);
  mocks.bookingFindUnique.mockResolvedValue(cancelledBooking());
});

describe("recordBumpNoticesOwed", () => {
  it("records both notices, stamped at the bump, and leaves an existing marker as it is", async () => {
    const tx = { alertCooldown: cooldown.delegate } as never;
    await recordBumpNoticesOwed(tx, { bookingId: "b1", bumpedAt: BUMPED_AT, flagged: false });

    expect([...cooldown.rows]).toEqual([
      [`booking-bump-member-owed:b1:${BUMPED_AT.getTime()}:b`, BUMPED_AT],
      [`booking-bump-officers-owed:b1:${BUMPED_AT.getTime()}:b`, BUMPED_AT],
    ]);
    expect(cooldown.delegate.upsert).toHaveBeenCalledWith({
      where: { key: memberKey() },
      create: { key: memberKey(), lastAlertedAt: BUMPED_AT },
      update: {},
    });
    // Upsert only: a caught unique-key error would abort the transaction.
    expect(cooldown.delegate.create).not.toHaveBeenCalled();
  });

  it("keys each bump of a reinstated booking apart", () => {
    expect(bumpNoticeOwedKey("member", "b1", at(1), false)).not.toBe(memberKey());
    expect(memberKey(true)).not.toBe(memberKey(false));
  });
});

describe("deliverBumpNotice, right after the commit", () => {
  it("sends the member's email with the bump's event key and clears its marker", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);

    await deliverBumpNotice("member", cancelledBooking() as never, false, BUMPED_AT);

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
    expect(cooldown.rows.size).toBe(0);
  });

  it("sends the guests-cancelled email for a flagged booking", async () => {
    cooldown.rows.set(memberKey(true), BUMPED_AT);

    await deliverBumpNotice("member", cancelledBooking() as never, true, BUMPED_AT);

    expect(mocks.sendGuestsCancelled).toHaveBeenCalledTimes(1);
    expect(mocks.sendBumped).not.toHaveBeenCalled();
    expect(cooldown.rows.size).toBe(0);
  });

  it("leaves the marker, claimed, when the send throws", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);
    mocks.alertOfficers.mockResolvedValue(false);

    await deliverBumpNotice("officers", cancelledBooking() as never, false, BUMPED_AT);

    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    // Stamped at the claim, so the sweep waits from this attempt.
    expect(cooldown.rows.get(officerKey())!.getTime()).toBeGreaterThan(BUMPED_AT.getTime());
  });

  it("sends nothing when a sweep already holds the marker", async () => {
    cooldown.rows.set(officerKey(), at(5));

    await deliverBumpNotice("officers", cancelledBooking() as never, false, BUMPED_AT);

    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(cooldown.rows.get(officerKey())).toEqual(at(5));
  });

  it("sends nothing, and never throws, when the claim cannot be written", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);
    cooldown.delegate.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(deliverBumpNotice("officers", cancelledBooking() as never, false, BUMPED_AT)).resolves.toBeUndefined();

    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(cooldown.rows.get(officerKey())).toEqual(BUMPED_AT);
  });
});

describe("drainOwedBumpNotices, the sweep", () => {
  it("sends an owed member email with the bump's event key, then clears it", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);

    const result = await drainOwedBumpNotices(DUE);

    expect(result).toEqual({ checked: 1, delivered: 1, cleared: 0, expired: 0 });
    expect(mocks.sendBumped.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ idempotencyKey: `b1:${BUMPED_AT.getTime()}` }),
    );
    expect(mocks.bookingFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "b1" } }));
    expect(cooldown.rows.size).toBe(0);
  });

  it("sends an owed officers' alert with the booking it read again", async () => {
    cooldown.rows.set(officerKey(true), BUMPED_AT);

    await drainOwedBumpNotices(DUE);

    expect(mocks.alertOfficers).toHaveBeenCalledWith(cancelledBooking(), true);
    expect(cooldown.rows.size).toBe(0);
  });

  it("records nothing twice: a second sweep finds the row recorded, clears the marker and sends nothing", async () => {
    cooldown.rows.set(memberKey(), BUMPED_AT);
    // The first sweep sends, then cannot clear its marker (as if it crashed).
    cooldown.delegate.deleteMany.mockRejectedValueOnce(new Error("connection lost"));
    await drainOwedBumpNotices(DUE);
    expect(transportSends).toBe(1);
    expect(cooldown.rows.has(memberKey())).toBe(true);

    const second = await drainOwedBumpNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS + 1));

    expect(second.delivered).toBe(1);
    expect(mocks.sendBumped).toHaveBeenCalledTimes(2);
    expect(transportSends).toBe(1);
    expect(cooldown.rows.size).toBe(0);
  });

  it("waits until the marker's last attempt is a full wait old", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);

    await expect(drainOwedBumpNotices(at(BUMP_NOTICE_SWEEP_AFTER_MS - 1))).resolves.toEqual({
      checked: 0,
      delivered: 0,
      cleared: 0,
      expired: 0,
    });
    expect(mocks.alertOfficers).not.toHaveBeenCalled();

    // A send that throws waits a full period again from that attempt.
    mocks.alertOfficers.mockResolvedValue(false);
    await drainOwedBumpNotices(DUE);
    await drainOwedBumpNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS - 1));
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    await drainOwedBumpNotices(at(2 * BUMP_NOTICE_SWEEP_AFTER_MS));
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(2);
    expect(cooldown.rows.has(officerKey())).toBe(true);
  });

  it("clears a marker past its maximum age with an error log, sending nothing", async () => {
    const tooOld = at(BUMP_NOTICE_MAX_AGE_MS + 1);
    cooldown.rows.set(officerKey(), at(BUMP_NOTICE_MAX_AGE_MS - BUMP_NOTICE_SWEEP_AFTER_MS));

    const result = await drainOwedBumpNotices(tooOld);

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

    const result = await drainOwedBumpNotices(DUE);

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

    const result = await drainOwedBumpNotices(DUE);

    expect(result).toEqual({ checked: 2, delivered: 0, cleared: 2, expired: 0 });
    expect(mocks.sendBumped).not.toHaveBeenCalled();
    expect(mocks.alertOfficers).not.toHaveBeenCalled();
    expect(cooldown.rows.size).toBe(0);
  });

  it("sends the officers' alert once when two runs sweep at the same moment", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);

    const results = await Promise.all([drainOwedBumpNotices(DUE), drainOwedBumpNotices(DUE)]);

    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.delivered).sort()).toEqual([0, 1]);
    expect(cooldown.rows.size).toBe(0);
  });

  it("carries on past a marker that fails, and never throws", async () => {
    cooldown.rows.set(officerKey(), BUMPED_AT);
    cooldown.rows.set(bumpNoticeOwedKey("officers", "b2", BUMPED_AT, false), at(1));
    mocks.bookingFindUnique.mockRejectedValueOnce(new Error("db down"));

    const result = await drainOwedBumpNotices(at(BUMP_NOTICE_SWEEP_AFTER_MS + 1));

    expect(result).toEqual({ checked: 2, delivered: 1, cleared: 0, expired: 0 });
    expect(mocks.alertOfficers).toHaveBeenCalledTimes(1);
    // The failed one stays owed, under the sweep's claim.
    expect(cooldown.rows.has(officerKey())).toBe(true);
  });

  it("answers zero, and never throws, when the markers cannot be read", async () => {
    // One failed read per notice kind.
    cooldown.delegate.findMany.mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"));

    await expect(drainOwedBumpNotices(DUE)).resolves.toEqual({ checked: 0, delivered: 0, cleared: 0, expired: 0 });
    expect(cooldown.delegate.findMany).toHaveBeenCalledTimes(2);
  });
});
