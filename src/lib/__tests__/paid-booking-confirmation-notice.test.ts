/**
 * #5433 PR 3 (ST, CP-2; owner decision D1): a paid booking's confirmation is
 * owed until sent. Real: `paid-booking-confirmation-notice.ts`,
 * `paid-booking-confirmation-owed.ts`, the shared told rule
 * (`email/keyed-email-state.ts`) and the mechanism's delivery and sweep
 * (`owed-notice/deliver.ts`, `drain.ts`, `store.ts`) over an in-memory
 * `OwedNotice` table. Doubles: the database rows, the render and send (proved
 * in `paid-booking-confirmation-email.test.ts`, here a stand-in for the email
 * core that writes the keyed row and answers `already_recorded` for a second
 * send), the officers' alert sender and the once-ever claim (proved in
 * `owed-notice-past-cutoff-once.test.ts`). Against PostgreSQL:
 * `paid-booking-confirmation.realdb.test.ts`.
 */
import { EmailLogStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOwedNoticeStore } from "./support/owed-notice-store";

const owed = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import("./support/owed-notice-store").createOwedNoticeStore> }));
const db = vi.hoisted(() => ({
  emailRows: new Map<string, { status: string; attempts: number; lastAttemptAt: Date; htmlBody: string | null; bookingRetryHtmlBody: string | null }>(),
  emailReadFails: false,
  /** The booking's status as a fresh read just before a send finds it; null follows the loaded booking. */
  liveStatus: null as string | null,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    get owedNotice() {
      return owed.store.delegate;
    },
    emailLog: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (db.emailReadFails) throw new Error("database down");
        return db.emailRows.get(where.id) ?? null;
      },
    },
    alertCooldown: { findMany: async () => [] },
    // The fresh status read just before a send (round 1, item 4).
    booking: {
      findUnique: async () =>
        core.booking ? { status: db.liveStatus ?? core.booking.status, deletedAt: core.booking.deletedAt ?? null } : null,
    },
  },
}));

/** What the stand-in email core does with the next send: write a row with this status, write none, or throw. */
const core = vi.hoisted(() => ({
  next: "SENT" as string | "none" | "throw",
  booking: null as Record<string, unknown> | null,
  sends: [] as string[],
}));
vi.mock("@/lib/paid-booking-confirmation-email", () => ({
  loadPaidConfirmationBooking: vi.fn(async () => core.booking),
  sendPaidBookingConfirmation: vi.fn(async (_booking: unknown, _format: unknown, idempotencyKey: string) => {
    core.sends.push(idempotencyKey);
    const id = `email:booking-confirmed:${idempotencyKey}`;
    if (db.emailRows.has(id)) return { status: "already_recorded", emailLogId: id };
    if (core.next === "throw") throw new Error("SMTP down");
    if (core.next === "none") return { status: "skipped_no_recipient", emailLogId: null, reason: "no_recipient" };
    db.emailRows.set(id, { status: core.next, attempts: 1, lastAttemptAt: new Date(), htmlBody: null, bookingRetryHtmlBody: null });
    return { status: "sent", emailLogId: id, messageId: null };
  }),
}));
const alerts = vi.hoisted(() => ({ unsent: vi.fn(), onceKeys: [] as string[] }));
vi.mock("@/lib/email/admin-alerts-booking-confirmation-unsent", () => ({ sendAdminBookingConfirmationUnsentAlert: alerts.unsent }));
// The once-ever claim is proved where it lives; here it records its key, sends and is kept.
vi.mock("@/lib/owed-notice/past-cutoff-once", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/owed-notice/past-cutoff-once")),
  alertOfficersOncePastCutoff: async (marker: { id: string }, { send }: { send: () => Promise<unknown> }) => {
    alerts.onceKeys.push(marker.id);
    await send();
    return "settled";
  },
}));
const zoneReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => {
    zoneReads.count += 1;
    return "Pacific/Auckland";
  },
}));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { requireClubTimeZone } from "@/lib/club-time";
import logger from "@/lib/logger";
import { shouldPersistEmailHtml } from "@/lib/email/internal";
import { STILL_WANTED_TEMPLATE_NAMES } from "@/lib/email/retry-still-wanted";
import { drainOwedNotices } from "@/lib/owed-notice/drain";
import { owedNoticeTableSource } from "@/lib/owed-notice/deliver";
import {
  deliverPaidBookingConfirmation,
  sendUnrecordedPaidBookingConfirmation,
  PAID_CONFIRMATION_MAX_AGE_MS,
  PAID_CONFIRMATION_NOTICE_DELIVERERS,
  PAID_CONFIRMATION_SWEEP_AFTER_MS,
  paidConfirmationEmailLogId,
  paidConfirmationKey,
  paidConfirmationMovedOn,
  paidConfirmationSendBy,
  type PaidConfirmationSubject,
  type PaidConfirmationSweepSubject,
} from "@/lib/paid-booking-confirmation-notice";
import { BOOKING_CONFIRMED_KIND, owePaidConfirmationAfterFreshClaim, recordPaidBookingConfirmationOwed } from "@/lib/paid-booking-confirmation-owed";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-07-01T00:00:00.000Z");
const BOOKING_ID = "booking1";
const SENT = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 };

function paidBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    status: "PAID",
    deletedAt: null,
    memberId: "m1",
    member: { id: "m1", firstName: "Ada", lastName: "Proof", email: "ada@example.test" },
    organisation: null,
    // A stay months away: the cut-off is the end of its check-in day.
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    ...overrides,
  };
}

/** What the settle commits at its fresh PAID claim, paid at `paidAt`, and the marker it hands back. */
async function commitSettle(paidAt: Date) {
  return recordPaidBookingConfirmationOwed({ owedNotice: owed.store.delegate } as never, { bookingId: BOOKING_ID, paidAt });
}

const sweep = (now: Date) =>
  drainOwedNotices(now, { deliverers: PAID_CONFIRMATION_NOTICE_DELIVERERS, sources: [owedNoticeTableSource], job: "test-sweep" });

beforeEach(() => {
  vi.clearAllMocks();
  owed.store = createOwedNoticeStore();
  db.emailRows.clear();
  db.emailReadFails = false;
  db.liveStatus = null;
  zoneReads.count = 0;
  core.next = "SENT";
  core.booking = paidBooking();
  core.sends = [];
  alerts.onceKeys = [];
  alerts.unsent.mockResolvedValue(SENT);
});

describe("a confirmation that could not be recorded as owed (#5433 PR 4, round 1, item 5)", () => {
  it("is sent once, unkeyed, as before #5433, with no marker, no row read and no officers' alert", async () => {
    core.booking = paidBooking();

    await sendUnrecordedPaidBookingConfirmation(BOOKING_ID, CLUB_FORMAT_TEST, "test");

    expect(core.sends).toEqual([undefined]);
    expect(owed.store.rows.size).toBe(0);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("never throws when the send does", async () => {
    core.booking = paidBooking();
    core.next = "throw";

    await expect(sendUnrecordedPaidBookingConfirmation(BOOKING_ID, CLUB_FORMAT_TEST, "test")).resolves.toBeUndefined();
  });
});

describe("the marker the settle writes", () => {
  it("is one insert that skips a duplicate, keyed by kind, booking and the moment it was paid, and stamped with it", async () => {
    const paidAt = new Date(NOW.getTime() - HOUR);
    const marker = await commitSettle(paidAt);

    expect(marker).toEqual({ id: `booking-confirmed:${BOOKING_ID}:${paidAt.getTime()}`, kind: BOOKING_CONFIRMED_KIND, subjectId: BOOKING_ID, eventAt: paidAt, variant: null, payload: null });
    expect(owed.store.delegate.createMany).toHaveBeenCalledTimes(1);
    expect(owed.store.delegate.createMany.mock.calls[0]![0]).toMatchObject({ skipDuplicates: true, data: [{ id: marker.id, stampedAt: paidAt }] });
    expect(paidConfirmationKey(marker)).toBe(`${BOOKING_ID}:${paidAt.getTime()}`);
    expect(paidConfirmationEmailLogId(marker)).toBe(`email:booking-confirmed:${BOOKING_ID}:${paidAt.getTime()}`);
  });
});

describe("the sweep's subject always carries the club's time zone (round 2, F4)", () => {
  it("cannot be written without one, so a cut-off can never be asked without a zone (a compile-time pin)", () => {
    const immediate: PaidConfirmationSubject = { booking: paidBooking() as never, format: CLUB_FORMAT_TEST };
    // @ts-expect-error -- a sweep subject needs the zone its cut-off reads; making `zone` optional fails the typecheck here.
    const sweepWithoutZone: PaidConfirmationSweepSubject = { ...immediate };
    expect(sweepWithoutZone).toEqual(immediate);
  });
});

describe("the settle's last write (owePaidConfirmationAfterFreshClaim)", () => {
  const card = (owesPaidConfirmation?: boolean) =>
    ({ kind: "stripe", paymentIntentId: "pi_1", amountCents: 100, paymentMethodId: null, format: CLUB_FORMAT_TEST, owesPaidConfirmation }) as const;
  const tx = () => ({ owedNotice: owed.store.delegate }) as never;

  it("records it only for a fresh card \"paid\" whose caller asked, and hands the result back with the marker", async () => {
    const result = await owePaidConfirmationAfterFreshClaim(tx(), BOOKING_ID, card(true), { outcome: "paid", extra: 1 });

    expect(result).toMatchObject({ outcome: "paid", extra: 1, paidConfirmation: { kind: BOOKING_CONFIRMED_KIND, subjectId: BOOKING_ID, eventAt: NOW } });
    expect(owed.store.rows.size).toBe(1);
  });

  it("never throws inside the settle for a booking id that cannot key a marker: logs an error and writes nothing (round 1, item 1)", async () => {
    const result = await owePaidConfirmationAfterFreshClaim(tx(), "not:an-id", card(true), { outcome: "paid" });

    expect(result.paidConfirmation).toBeNull();
    expect(owed.store.delegate.createMany).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      { bookingId: "not:an-id", problem: expect.stringContaining("subjectId") },
      expect.stringContaining("cannot key an owed confirmation"),
    );
  });

  it.each([
    ["a caller that sends no confirmation", card(undefined), "paid"],
    ["a caller that said no", card(false), "paid"],
    ["an already-paid replay", card(true), "already_paid"],
    ["a capacity-race cancel", card(true), "capacity_failed"],
    ["a duplicate capture", card(true), "duplicate_capture"],
    ["an officer's manual settle", { kind: "manual", actingAdminMemberId: "a", note: null, expectedAmountCents: 1, notifyMember: true, additionalCoverage: null } as const, "manual_paid"],
  ])("writes nothing for %s", async (_label, settlement, outcome) => {
    const result = await owePaidConfirmationAfterFreshClaim(tx(), BOOKING_ID, settlement, { outcome });

    expect(result.paidConfirmation).toBeNull();
    expect(owed.store.delegate.createMany).not.toHaveBeenCalled();
  });
});

describe("delivery right after the settle commits", () => {
  it("sends the confirmation once with the payment's event key and clears the marker", async () => {
    const marker = await commitSettle(NOW);

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(core.sends).toEqual([paidConfirmationKey(marker)]);
    expect(owed.store.rows.size).toBe(0);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("sends nothing when a sweep already holds the marker", async () => {
    const marker = await commitSettle(new Date(NOW.getTime() - HOUR));
    owed.store.rows.get(marker.id)!.stampedAt = new Date(NOW.getTime() - 1);

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(1);
  });

  it("sends nothing for a booking cancelled between the settle and the send, and clears the marker (D1)", async () => {
    const marker = await commitSettle(NOW);
    core.booking = paidBooking({ status: "CANCELLED" });

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(0);
  });

  it("reads the booking's status afresh just before the send: a cancel after the booking was loaded is not sent (round 1, item 4)", async () => {
    const marker = await commitSettle(NOW);
    db.liveStatus = "CANCELLED";

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(0);
  });

  it("reads no time zone: only the sweep's cut-off needs one (round 1, item 6)", async () => {
    const marker = await commitSettle(NOW);

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(core.sends).toHaveLength(1);
    expect(zoneReads.count).toBe(0);
  });

  it("leaves the marker to the sweep when the status read before the send fails, logging that read, and sends nothing (round 2, F5)", async () => {
    const marker = await commitSettle(NOW);
    const { prisma } = await import("@/lib/prisma");
    const spy = vi.spyOn(prisma.booking, "findUnique").mockRejectedValueOnce(new Error("database down"));

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING_ID }), expect.stringContaining("status before sending its confirmation"));
    spy.mockRestore();
  });

  it("leaves the marker to the sweep when the send throws, and alerts nobody yet", async () => {
    const marker = await commitSettle(NOW);
    core.next = "throw";

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(owed.store.rows.size).toBe(1);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("leaves the marker to the sweep when the booking cannot be read", async () => {
    const marker = await commitSettle(NOW);
    const { loadPaidConfirmationBooking } = await import("@/lib/paid-booking-confirmation-email");
    vi.mocked(loadPaidConfirmationBooking).mockRejectedValueOnce(new Error("database down"));

    await expect(deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook")).resolves.toBeUndefined();

    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(1);
  });
});

describe("the sweep (a first attempt that never started)", () => {
  it("recovers it exactly once after the wait, and not before", async () => {
    const paidAt = new Date(NOW.getTime() - 2 * HOUR);
    await commitSettle(paidAt);

    expect((await sweep(new Date(paidAt.getTime() + PAID_CONFIRMATION_SWEEP_AFTER_MS - 1))).checked).toBe(0);
    expect(core.sends).toEqual([]);

    expect(await sweep(NOW)).toMatchObject({ checked: 1, delivered: 1 });
    expect(core.sends).toEqual([`${BOOKING_ID}:${paidAt.getTime()}`]);
    expect(owed.store.rows.size).toBe(0);

    expect((await sweep(new Date(NOW.getTime() + HOUR))).checked).toBe(0);
    expect(core.sends).toHaveLength(1);
  });

  it("a replay after a stop between the send and the clear finds the row and never sends twice", async () => {
    const paidAt = new Date(NOW.getTime() - 2 * HOUR);
    const marker = await commitSettle(paidAt);
    // The first attempt's email went (its row exists) and the job stopped before the clear.
    db.emailRows.set(paidConfirmationEmailLogId(marker), { status: EmailLogStatus.SENT, attempts: 1, lastAttemptAt: paidAt, htmlBody: null, bookingRetryHtmlBody: null });

    expect(await sweep(NOW)).toMatchObject({ checked: 1, delivered: 1 });

    expect(db.emailRows.size).toBe(1);
    expect(alerts.unsent).not.toHaveBeenCalled();
    expect(owed.store.rows.size).toBe(0);
  });

  it.each([
    ["CANCELLED", { status: "CANCELLED" }],
    ["refunded and cancelled", { status: "CANCELLED" }],
    ["reversed to PAYMENT_PENDING", { status: "PAYMENT_PENDING" }],
    ["deleted", { deletedAt: new Date(NOW.getTime() - HOUR) }],
  ])("clears a booking that moved on (%s) without sending (D1)", async (_label, change) => {
    await commitSettle(new Date(NOW.getTime() - 2 * HOUR));
    core.booking = paidBooking(change);

    expect(await sweep(NOW)).toMatchObject({ checked: 1, cleared: 1, delivered: 0 });
    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(0);
  });

  it("clears a booking cancelled between the sweep's read and its send, from the fresh status read (round 1, item 4)", async () => {
    await commitSettle(new Date(NOW.getTime() - 2 * HOUR));
    db.liveStatus = "CANCELLED";

    expect(await sweep(NOW)).toMatchObject({ checked: 1, delivered: 1 });
    expect(core.sends).toEqual([]);
    expect(owed.store.rows.size).toBe(0);
    expect(zoneReads.count).toBe(1);
  });

  it("clears a booking that is gone without sending", async () => {
    await commitSettle(new Date(NOW.getTime() - 2 * HOUR));
    core.booking = null;

    expect(await sweep(NOW)).toMatchObject({ checked: 1, cleared: 1 });
    expect(core.sends).toEqual([]);
  });

  it("still sends a COMPLETED booking's confirmation before its cut-off (paid-like)", async () => {
    expect(paidConfirmationMovedOn({ status: "COMPLETED", deletedAt: null })).toBeNull();
  });
});

describe("past the cut-off (D1: clear it and alert officers once)", () => {
  it("sends the member nothing once the check-in day has ended, and alerts the officers once", async () => {
    // Paid two days ago for a stay whose check-in day (30 June, NZ) ended at midnight NZ, before the frozen now.
    await commitSettle(new Date(NOW.getTime() - 48 * HOUR));
    core.booking = paidBooking({ checkIn: new Date("2026-06-30T00:00:00.000Z"), checkOut: new Date("2026-07-02T00:00:00.000Z") });

    expect(await sweep(NOW)).toMatchObject({ checked: 1, expired: 1, delivered: 0 });

    expect(core.sends).toEqual([]);
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
    expect(alerts.unsent).toHaveBeenCalledWith({ memberName: "Ada Proof", bookingId: BOOKING_ID, checkIn: new Date("2026-06-30T00:00:00.000Z"), checkOut: new Date("2026-07-02T00:00:00.000Z") });
    expect(owed.store.rows.size).toBe(0);
    expect((await sweep(new Date(NOW.getTime() + HOUR))).checked).toBe(0);
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
  });

  it("is also past it seven days after the payment, whatever the check-in date", async () => {
    await commitSettle(new Date(NOW.getTime() - PAID_CONFIRMATION_MAX_AGE_MS - HOUR));

    expect(await sweep(NOW)).toMatchObject({ checked: 1, expired: 1 });
    expect(core.sends).toEqual([]);
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
  });

  it("alerts nobody when the confirmation did reach the owner after all", async () => {
    const marker = await commitSettle(new Date(NOW.getTime() - 48 * HOUR));
    core.booking = paidBooking({ checkIn: new Date("2026-06-30T00:00:00.000Z") });
    db.emailRows.set(paidConfirmationEmailLogId(marker), { status: EmailLogStatus.SENT, attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });

    await sweep(NOW);

    expect(alerts.unsent).not.toHaveBeenCalled();
    expect(owed.store.rows.size).toBe(0);
  });

  it("takes the cut-off as the last instant of the check-in day in the club's time zone, through the kernel", () => {
    const zone = requireClubTimeZone("Pacific/Auckland");
    // 10 July is NZST (UTC+12): the day ends at 12:00 UTC.
    expect(paidConfirmationSendBy(new Date("2026-07-10T00:00:00.000Z"), zone)).toEqual(new Date("2026-07-10T11:59:59.999Z"));
    // 10 January is NZDT (UTC+13).
    expect(paidConfirmationSendBy(new Date("2027-01-10T00:00:00.000Z"), zone)).toEqual(new Date("2027-01-10T10:59:59.999Z"));
  });
});

describe("what became of the email after a send (the told rule)", () => {
  it.each([
    ["SENT", EmailLogStatus.SENT],
    ["QUEUED on its first attempt (the crash-during-the-provider-call limit)", EmailLogStatus.QUEUED],
    ["withheld by the booking's No emails", EmailLogStatus.SKIPPED_NO_EMAILS],
    ["withheld on a non-production copy", EmailLogStatus.SKIPPED_NON_PRODUCTION],
  ])("%s: told, cleared, no officers' alert", async (_label, status) => {
    const marker = await commitSettle(NOW);
    core.next = status;

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(owed.store.rows.size).toBe(0);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it.each([
    ["FAILED with no body and no block reason (a provider failure, a fail-closed No-emails read)", EmailLogStatus.FAILED],
    ["BOUNCED (a suppressed address)", EmailLogStatus.BOUNCED],
    ["no row (no address, or a club placeholder)", "none"],
  ])("%s: not told, so the officers are alerted once and the marker cleared", async (_label, next) => {
    const marker = await commitSettle(NOW);
    core.next = next;

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(alerts.onceKeys).toEqual([marker.id]);
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
    expect(owed.store.rows.size).toBe(0);
  });

  it("held back by the installation's environment gate (FAILED with a block reason, in the review queue): cleared with no officers' alert, as before #5433", async () => {
    const marker = await commitSettle(NOW);
    const { sendPaidBookingConfirmation } = await import("@/lib/paid-booking-confirmation-email");
    vi.mocked(sendPaidBookingConfirmation).mockImplementationOnce(async () => {
      db.emailRows.set(paidConfirmationEmailLogId(marker), { status: EmailLogStatus.FAILED, attempts: 3, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null, deliveryBlockReason: "ENVIRONMENT_UNKNOWN" } as never);
      return { status: "withheld_for_environment", emailLogId: paidConfirmationEmailLogId(marker), reason: "environment_unknown" };
    });

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(owed.store.rows.size).toBe(0);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("withheld because No emails could not be read: undeliverable like any other, so the officers are alerted once through this notice's own claim (round 2, F1)", async () => {
    const marker = await commitSettle(NOW);
    const { sendPaidBookingConfirmation } = await import("@/lib/paid-booking-confirmation-email");
    vi.mocked(sendPaidBookingConfirmation).mockImplementationOnce(async () => {
      // The email core's own fail-closed row: FAILED, no body, no block reason.
      db.emailRows.set(paidConfirmationEmailLogId(marker), { status: EmailLogStatus.FAILED, attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null, errorMessage: "Withheld: the booking's \"No emails\" switch could not be read, so the send failed closed" } as never);
      return { status: "withheld_for_booking", emailLogId: paidConfirmationEmailLogId(marker), bookingId: BOOKING_ID, reason: "booking_flag_unreadable" };
    });

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(alerts.onceKeys).toEqual([marker.id]);
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
    expect(owed.store.rows.size).toBe(0);
  });

  it("keeps the marker when the row cannot be read after the send", async () => {
    const marker = await commitSettle(NOW);
    const { sendPaidBookingConfirmation } = await import("@/lib/paid-booking-confirmation-email");
    vi.mocked(sendPaidBookingConfirmation).mockImplementationOnce(async () => {
      db.emailReadFails = true;
      return { status: "sent", emailLogId: "x", messageId: null };
    });

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(owed.store.rows.size).toBe(1);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("names an organisation owner by its name in the officers' alert", async () => {
    const marker = await commitSettle(NOW);
    core.booking = paidBooking({ memberId: null, member: null, organisation: { name: "Hill School", email: "" } });
    core.next = "none";

    await deliverPaidBookingConfirmation(marker, CLUB_FORMAT_TEST, "stripe-webhook");

    expect(alerts.unsent.mock.calls[0]![0]).toMatchObject({ memberName: "Hill School" });
  });
});

describe("the email retry job and the release before this one", () => {
  // The retry job replays only a FAILED row that kept its body. A confirmation
  // never keeps one, so a failed confirmation (keyed by this release, or unkeyed
  // by the one before) is never replayed, for a cancelled booking or any other:
  // D1's "a booking cancelled in the meantime is not sent" holds there with no
  // "still wanted" check. Should that ever change, register one first.
  it("never keeps a confirmation's body, so nothing replays it and no still-wanted check is needed", () => {
    expect(shouldPersistEmailHtml("booking-confirmed")).toBe(false);
    expect(STILL_WANTED_TEMPLATE_NAMES).not.toContain("booking-confirmed");
  });

  it("a booking paid before the upgrade has no marker, so the sweep never sends it anything", async () => {
    // The previous release sent its confirmation unkeyed and wrote no marker.
    db.emailRows.set("an-unkeyed-row", { status: EmailLogStatus.FAILED, attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });

    expect((await sweep(new Date(NOW.getTime() + 24 * HOUR))).checked).toBe(0);
    expect(core.sends).toEqual([]);
  });
});
