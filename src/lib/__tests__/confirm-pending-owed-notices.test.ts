/**
 * #5433 PR 4: the sweep side of the confirm-pending job's remaining owed
 * notices: the two hold-ended cancellations (CP-4, CP-5), the split guest
 * payment link (CP-6) and the retired saved card. Real: the three notice
 * modules, the shared reading of a member email's row
 * (`owed-notice/member-email.ts`, over `email/keyed-email-state.ts`), the
 * officers' alert answer (`owed-notice/officer-alert.ts`) and the mechanism's
 * sweep (`owed-notice/deliver.ts`, `drain.ts`, `store.ts`) over an in-memory
 * `OwedNotice` table. Doubles: the database rows; the email senders, as a
 * stand-in for the email core that writes the keyed row and answers
 * `already_recorded` for a second send; the officers' "Booking email not sent"
 * sender and the once-ever claim (proved in `owed-notice-past-cutoff-once.test.ts`);
 * and the booking page's link re-issue (proved in its own suite). The write in
 * the job's transactions and the delivery right after the commit are proved
 * in `cron-confirm-pending.test.ts` and `saved-card-charge-failure.test.ts`;
 * against PostgreSQL in `confirm-pending-owed-notices.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOwedNoticeStore } from "./support/owed-notice-store";

type EmailRow = { status: string; attempts: number; lastAttemptAt: Date; htmlBody: string | null; bookingRetryHtmlBody: string | null; deliveryBlockReason?: string | null };

const owed = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import("./support/owed-notice-store").createOwedNoticeStore> }));
type LinkRow = { id: string; bookingId: string; usedAt: Date | null; revokedAt: Date | null; createdAt: Date; expiresAt: Date };
const db = vi.hoisted(() => ({
  emailRows: new Map<string, EmailRow>(),
  booking: null as Record<string, unknown> | null,
  links: new Map<string, LinkRow>(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    get owedNotice() {
      return owed.store.delegate;
    },
    emailLog: { findUnique: async ({ where }: { where: { id: string } }) => db.emailRows.get(where.id) ?? null },
    booking: { findUnique: async ({ where }: { where: { id: string } }) => (db.booking && db.booking.id === where.id ? db.booking : null) },
    paymentLink: {
      findUnique: async ({ where }: { where: { id: string } }) => db.links.get(where.id) ?? null,
      findFirst: async ({ where }: { where: { bookingId: string; createdAt: { gt: Date } } }) =>
        [...db.links.values()].find((row) => row.bookingId === where.bookingId && row.createdAt > where.createdAt.gt) ?? null,
    },
    alertCooldown: { findMany: async () => [] },
  },
}));

/** What the stand-in email core does with the next member send: write a row with this status, write none, or throw. */
const core = vi.hoisted(() => ({ next: "SENT" as string | "none" | "throw", sends: [] as Array<{ template: string; key: string; params: Record<string, unknown> }> }));
const memberSend = vi.hoisted(
  () => (template: string) =>
    async (params: Record<string, unknown>) => {
      const key = params.idempotencyKey as string;
      core.sends.push({ template, key, params });
      const id = `email:${template}:${key}`;
      if (db.emailRows.has(id)) return { status: "already_recorded", emailLogId: id };
      if (core.next === "throw") throw new Error("SMTP down");
      if (core.next === "none") return { status: "skipped_no_recipient", emailLogId: null, reason: "no_recipient" };
      db.emailRows.set(id, { status: core.next, attempts: 1, lastAttemptAt: new Date(), htmlBody: core.next === "FAILED" ? "<p>kept</p>" : null, bookingRetryHtmlBody: null });
      return { status: "sent", emailLogId: id, messageId: null };
    },
);
const SENT = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 };
const officers = vi.hoisted(() => ({ requestCancelled: vi.fn(), splitCancelled: vi.fn(), paymentFailure: vi.fn() }));
/** The link email's stand-in: "sent" writes the keyed row, "throw-before-row" throws with no row, "withheld" writes a withheld row. */
const linkCore = vi.hoisted(() => ({ next: "sent" as "sent" | "throw-before-row" | "withheld", sends: [] as Array<{ token: string; key: string | undefined }> }));
vi.mock("@/lib/email", async () => {
  // The senders' own template constants, so a renamed template fails here (round 1, item 6).
  const templates = await import("@/lib/email/owed-notice-templates");
  return {
    sendBookingRequestPaymentExpiredEmail: memberSend(templates.BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE),
    sendSplitGuestPortionCancelledEmail: memberSend(templates.SPLIT_GUEST_PORTION_CANCELLED_TEMPLATE),
    sendSavedCardChargeFailedEmail: memberSend(templates.SAVED_CARD_CHARGE_FAILED_TEMPLATE),
    sendAdminBookingRequestHoldCancelledEmail: officers.requestCancelled,
    sendAdminSplitSettlementCancelledAlert: officers.splitCancelled,
    sendAdminPaymentFailureAlert: officers.paymentFailure,
    sendSplitGuestPaymentLinkEmail: async (params: { token: string; idempotencyKey?: string }) => {
      linkCore.sends.push({ token: params.token, key: params.idempotencyKey });
      if (linkCore.next === "throw-before-row") throw new Error("EmailLog insert failed");
      const row = { attempts: 1, lastAttemptAt: new Date(), htmlBody: null, bookingRetryHtmlBody: null };
      if (params.idempotencyKey) db.emailRows.set(`email:split-guest-payment-link:${params.idempotencyKey}`, { ...row, status: linkCore.next === "sent" ? "SENT" : "SKIPPED_NON_PRODUCTION" });
      return linkCore.next === "sent" ? { status: "sent", emailLogId: "x" } : { status: "withheld_for_environment", emailLogId: "x", reason: "environment_non_production" };
    },
  };
});
vi.mock("@/lib/booking-amount-owed", () => ({ readBookingAmountOwed: async () => ({ owedCents: 12000, dueCents: 12000, appliedCreditCents: 0 }) }));
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinkById: vi.fn(async (id: string) => {
    const row = db.links.get(id);
    if (row) row.revokedAt = new Date();
    return row ? 1 : 0;
  }),
}));
const alerts = vi.hoisted(() => ({ unsent: vi.fn(), onceKeys: [] as string[] }));
vi.mock("@/lib/email/admin-alerts-booking-notice-unsent", () => ({ sendAdminBookingNoticeUnsentAlert: alerts.unsent }));
// The once-ever claim is proved where it lives; here it records its key, sends and is kept.
vi.mock("@/lib/owed-notice/past-cutoff-once", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/owed-notice/past-cutoff-once")),
  alertOfficersOncePastCutoff: async (marker: { id: string }, { send }: { send: () => Promise<unknown> }) => {
    alerts.onceKeys.push(marker.id);
    await send();
    return "settled";
  },
}));
/**
 * The booking page's re-issue, its checks and its mint (proved in its own
 * suite): by default it revokes the booking's live links, mints the next one
 * into the link table and records its owed email with the caller's
 * `recordOwed`, as the real one does inside its transaction.
 */
const reissue = vi.hoisted(() => ({ fn: vi.fn(), sequence: 0 }));
vi.mock("@/lib/payment-link-split-guest", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-link-split-guest")),
  prepareSplitGuestPaymentLinkReissue: reissue.fn,
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { drainOwedNotices } from "@/lib/owed-notice/drain";
import { owedNoticeTableSource, type OwedNoticeDeliverer } from "@/lib/owed-notice/deliver";
import { HOLD_ENDED_NOTICE_DELIVERERS, holdEndedMemberSendBy, recordHoldEndedNoticesOwed } from "@/lib/hold-ended-cancellation-notices";
import { recordSavedCardUnusableNoticesOwed, SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS } from "@/lib/saved-card-unusable-notices";
import {
  BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE,
  SAVED_CARD_CHARGE_FAILED_TEMPLATE,
  SPLIT_GUEST_PORTION_CANCELLED_TEMPLATE,
} from "@/lib/email/owed-notice-templates";
import { deliverHoldEndedNotices } from "@/lib/hold-ended-cancellation-notices";
import { deliverSavedCardUnusableNotices } from "@/lib/saved-card-unusable-notices";
import {
  recordSplitGuestPaymentLinkOwed,
  SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS,
  splitGuestPaymentLinkEmailLogId,
} from "@/lib/split-guest-payment-link-notice";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date("2026-07-01T00:00:00.000Z");
const tx = () => ({ owedNotice: owed.store.delegate }) as never;

function sweep<S>(deliverers: readonly OwedNoticeDeliverer<S>[], now: Date) {
  return drainOwedNotices(now, { deliverers: deliverers as unknown as readonly OwedNoticeDeliverer[], sources: [owedNoticeTableSource], job: "test-sweep" });
}

function owner() {
  return { memberId: "m1", member: { firstName: "Ada", lastName: "Proof", email: "ada@example.test" }, organisation: null };
}

function cancelledBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    status: "CANCELLED",
    deletedAt: null,
    lodgeId: "lodge_1",
    checkIn: new Date("2026-06-30T00:00:00.000Z"),
    checkOut: new Date("2026-07-05T00:00:00.000Z"),
    finalPriceCents: 14000,
    parentBookingId: "parent_1",
    guests: [{ id: "g1" }, { id: "g2" }],
    ...owner(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  owed.store = createOwedNoticeStore();
  db.emailRows.clear();
  db.booking = null;
  db.links.clear();
  linkCore.next = "sent";
  linkCore.sends = [];
  reissue.sequence = 0;
  core.next = "SENT";
  core.sends = [];
  alerts.onceKeys = [];
  alerts.unsent.mockResolvedValue(SENT);
  officers.requestCancelled.mockResolvedValue(SENT);
  officers.splitCancelled.mockResolvedValue(SENT);
  officers.paymentFailure.mockResolvedValue(SENT);
  reissue.fn.mockImplementation(async (bookingId: string, recordOwed: (tx: unknown, minted: { token: string; paymentLinkId: string; expiresAt: Date }) => Promise<unknown>) => {
    for (const row of db.links.values()) if (row.bookingId === bookingId && !row.usedAt && !row.revokedAt) row.revokedAt = new Date();
    reissue.sequence += 1;
    const minted = { token: `tok_re_${reissue.sequence}`, paymentLinkId: `pl_re_${reissue.sequence}`, expiresAt: new Date("2026-07-20T11:59:59.999Z") };
    db.links.set(minted.paymentLinkId, { id: minted.paymentLinkId, bookingId, usedAt: null, revokedAt: null, createdAt: new Date(Date.now() + reissue.sequence), expiresAt: minted.expiresAt });
    const owedMarker = await recordOwed(tx(), minted);
    return { kind: "minted", booking: { ...(db.booking as object), payment: null }, minted, owed: owedMarker };
  });
});

describe("CP-4 and CP-5: the notices of a hold that ended in cancellation", () => {
  it("records nothing when the cancel cannot key its markers, so the cancel still commits, and sends both unkeyed as before #5433 (round 1, item 5)", async () => {
    const owedNotices = await recordHoldEndedNoticesOwed(tx(), { ended: "split-guest", bookingId: "not an id", parentUnpaid: false });
    expect(owedNotices.recorded).toBe(false);
    expect(owed.store.rows.size).toBe(0);

    await deliverHoldEndedNotices(cancelledBooking({ id: "not an id" }) as never, owedNotices, CLUB_FORMAT_TEST, "test");

    expect(core.sends.map((send) => [send.template, send.key, send.params.parentConfirmed])).toEqual([[SPLIT_GUEST_PORTION_CANCELLED_TEMPLATE, undefined, true]]);
    expect(officers.splitCancelled).toHaveBeenCalledWith(expect.objectContaining({ parentUnpaid: false }), CLUB_FORMAT_TEST);
    expect(owed.store.rows.size).toBe(0);
  });

  it("past its cut-off holds a notice the email retry cron still holds, instead of telling officers it will not be sent (round 1, item 4)", async () => {
    // A one-night stay cancelled after its check-out day ended: the first send hits a provider error the retry cron will replay.
    db.booking = cancelledBooking({ checkOut: new Date("2026-06-30T00:00:00.000Z") });
    const memberKind = HOLD_ENDED_NOTICE_DELIVERERS.filter((d) => d.kind === "request-hold-cancelled-member");
    const recorded = await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    // The attempt right after the cancel left a replayable FAILED row; the sweep then runs past the cut-off.
    db.emailRows.set(`email:${BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE}:b1:${recorded.cancelledAt.getTime()}`, { status: "FAILED", attempts: 1, lastAttemptAt: NOW, htmlBody: "<p>kept</p>", bookingRetryHtmlBody: null });

    await sweep(memberKind, new Date(NOW.getTime() + HOUR));
    expect(alerts.unsent).not.toHaveBeenCalled();
    expect([...owed.store.rows.values()].map((row) => row.kind)).toEqual(["request-hold-cancelled-member", "request-hold-cancelled-officers"]);

    // The retry cron gives up: the row can no longer be replayed, and the alert goes.
    db.emailRows.set(`email:${BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE}:b1:${recorded.cancelledAt.getTime()}`, { status: "FAILED", attempts: 3, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });
    await sweep(memberKind, new Date(NOW.getTime() + 2 * HOUR));
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
  });

  it("sends a requester's notice a stopped run never sent, once, keyed by the cancel, after the wait and not before", async () => {
    const recorded = await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();

    expect((await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + 29 * MINUTE))).checked).toBe(0);
    const swept = await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + 31 * MINUTE));

    expect(swept).toEqual({ checked: 2, delivered: 2, cleared: 0, expired: 0 });
    expect(core.sends.map((send) => [send.template, send.key])).toEqual([[BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE, `b1:${recorded.cancelledAt.getTime()}`]]);
    expect(officers.requestCancelled).toHaveBeenCalledWith(
      { requesterName: "Ada Proof", checkIn: cancelledBooking().checkIn, checkOut: cancelledBooking().checkOut, guestCount: 2, totalCents: 14000 },
      CLUB_FORMAT_TEST,
    );
    expect(owed.store.rows.size).toBe(0);
    expect((await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR))).checked).toBe(0);
  });

  it.each([
    ["no longer cancelled", { status: "CONFIRMED" }],
    ["deleted", { deletedAt: new Date("2026-07-01T00:10:00.000Z") }],
  ])("clears without sending when the booking is %s", async (_label, change) => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "split-guest", bookingId: "b1", parentUnpaid: false });
    db.booking = cancelledBooking(change);

    const swept = await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.cleared).toBe(2);
    expect(core.sends).toEqual([]);
    expect(officers.splitCancelled).not.toHaveBeenCalled();
  });

  it("words a recovered split guest notice from the payload the cancel wrote, and a payload it cannot read as unsettled", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "split-guest", bookingId: "b1", parentUnpaid: false });
    db.booking = cancelledBooking();
    await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect(core.sends[0]!.params).toMatchObject({ parentConfirmed: true, parentBookingReference: expect.any(String) });
    expect(officers.splitCancelled).toHaveBeenCalledWith(expect.objectContaining({ parentUnpaid: false, memberName: "Ada Proof" }), CLUB_FORMAT_TEST);

    owed.store.seed({ id: "split-guest-cancelled-member:b1:1", kind: "split-guest-cancelled-member", subjectId: "b1", eventAt: new Date(NOW.getTime() + 1) });
    await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR));
    expect(core.sends[1]!.params).toMatchObject({ parentConfirmed: false });
  });

  it("alerts the officers once when the member's email did not reach them, and clears it", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "split-guest", bookingId: "b1", parentUnpaid: true });
    db.booking = cancelledBooking();
    core.next = "BOUNCED";

    await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(alerts.unsent).toHaveBeenCalledTimes(1);
    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "split-guest-cancelled", memberName: "Ada Proof", bookingId: "b1" }));
    expect(alerts.onceKeys).toEqual([expect.stringMatching(/^split-guest-cancelled-member:b1:/)]);
    expect(owed.store.rows.size).toBe(0);
  });

  it("alerts the officers once for an owner with no address that can be emailed (no row at all)", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();
    core.next = "none";

    await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "request-hold-cancelled" }));
  });

  it("keeps a member's notice the email retry cron holds (a replayable failure), and alerts nobody", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();
    core.next = "FAILED";

    await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect([...owed.store.rows.values()].map((row) => row.kind)).toEqual(["request-hold-cancelled-member"]);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("past the end of the check-out day alerts the officers once instead of sending, unless the email did reach the member", async () => {
    const recorded = await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();
    const pastCheckOut = new Date(holdEndedMemberSendBy(cancelledBooking().checkOut, "Pacific/Auckland" as never).getTime() + MINUTE);

    await sweep(HOLD_ENDED_NOTICE_DELIVERERS.filter((d) => d.kind === "request-hold-cancelled-member"), pastCheckOut);
    expect(core.sends).toEqual([]);
    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "request-hold-cancelled" }));

    // A second marker whose email did go: cleared past its cut-off, no alert.
    alerts.unsent.mockClear();
    owed.store.seed({ id: "request-hold-cancelled-member:b1:2", kind: "request-hold-cancelled-member", subjectId: "b1", eventAt: new Date(recorded.cancelledAt.getTime() + 1) });
    db.emailRows.set(`email:${BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE}:b1:${recorded.cancelledAt.getTime() + 1}`, { status: "SENT", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });
    await sweep(HOLD_ENDED_NOTICE_DELIVERERS.filter((d) => d.kind === "request-hold-cancelled-member"), pastCheckOut);
    expect(alerts.unsent).not.toHaveBeenCalled();
    // Only the officers' marker, which this sweep did not take, is left.
    expect([...owed.store.rows.values()].map((row) => row.kind)).toEqual(["request-hold-cancelled-officers"]);
  });

  it("past seven days alerts the officers once even with the check-out still to come (owner decision D7's limit, applied here)", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking({ checkOut: new Date("2026-08-01T00:00:00.000Z") });

    await sweep(HOLD_ENDED_NOTICE_DELIVERERS.filter((d) => d.kind === "request-hold-cancelled-member"), new Date(NOW.getTime() + 7 * DAY + HOUR));

    expect(core.sends).toEqual([]);
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
  });

  it("clears an officers' notice older than seven days with an error log and sends nothing", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();

    const swept = await sweep(HOLD_ENDED_NOTICE_DELIVERERS.filter((d) => d.kind === "request-hold-cancelled-officers"), new Date(NOW.getTime() + 7 * DAY + HOUR));

    expect(swept.expired).toBe(1);
    expect(officers.requestCancelled).not.toHaveBeenCalled();
  });

  it("keeps an officers' notice for a day when nobody received it and nothing will replay it", async () => {
    await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();
    officers.requestCancelled.mockResolvedValue({ ...SENT, sent: 0, notDelivered: 1, failedBeforeLogged: 1 });
    const officerKind = HOLD_ENDED_NOTICE_DELIVERERS.filter((d) => d.kind === "request-hold-cancelled-officers");

    await sweep(officerKind, new Date(NOW.getTime() + HOUR));
    expect(owed.store.rows.size).toBe(2);
    expect((await sweep(officerKind, new Date(NOW.getTime() + 12 * HOUR))).checked).toBe(0);
  });
});

describe("CP-6: a split guest portion's payment link", () => {
  const LINK = "pl_1";
  const childBooking = (overrides: Record<string, unknown> = {}) => cancelledBooking({ id: "child_1", status: "PENDING", ...overrides });
  const linkRow = (overrides: Partial<LinkRow> = {}): LinkRow => ({
    id: LINK,
    bookingId: "child_1",
    usedAt: null,
    revokedAt: null,
    createdAt: NOW,
    expiresAt: new Date("2026-07-20T11:59:59.999Z"),
    ...overrides,
  });
  const live = () => [...db.links.values()].filter((row) => !row.usedAt && !row.revokedAt);
  /** Every live link that was never emailed has a marker: the property round 1, item 1 asks for. */
  const everyLiveUnemailedLinkIsOwed = () =>
    live()
      .filter((row) => !db.emailRows.has(splitGuestPaymentLinkEmailLogId(row.id)))
      .every((row) => [...owed.store.rows.values()].some((marker) => marker.subjectId === row.id));

  async function owe() {
    db.booking = childBooking();
    db.links.set(LINK, linkRow());
    return (await recordSplitGuestPaymentLinkOwed(tx(), { bookingId: "child_1", paymentLinkId: LINK }))!;
  }

  it("records a marker keyed by the link, holding the booking and no token, and null for an input it cannot key", async () => {
    const marker = await owe();
    expect(marker).toMatchObject({ kind: "split-guest-payment-link", subjectId: LINK, payload: { bookingId: "child_1" } });
    expect(await recordSplitGuestPaymentLinkOwed(tx(), { bookingId: "child 1", paymentLinkId: LINK })).toBeNull();
  });

  it("clears without a re-issue when the original link's email was sent or is in flight", async () => {
    await owe();
    db.emailRows.set(splitGuestPaymentLinkEmailLogId(LINK), { status: "QUEUED", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });

    const swept = await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.delivered).toBe(1);
    expect(reissue.fn).not.toHaveBeenCalled();
  });

  it("otherwise re-issues through the booking page's own path, owing the new link in its transaction, and delivers it keyed by the new link", async () => {
    await owe();
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(reissue.fn).toHaveBeenCalledTimes(1);
    expect(reissue.fn).toHaveBeenCalledWith("child_1", expect.any(Function));
    expect(linkCore.sends).toEqual([{ token: "tok_re_1", key: "pl_re_1" }]);
    expect(db.links.get(LINK)!.revokedAt).not.toBeNull();
    expect(owed.store.rows.size).toBe(0);
    expect((await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR))).checked).toBe(0);
  });

  it("two stops: the re-issue commits and the process stops before the new link's email, then the next sweep sends it, and no live unemailed link is ever left unowed", async () => {
    await owe();
    expect(everyLiveUnemailedLinkIsOwed()).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    // First stop: the re-issue's transaction (link and marker) commits, then the process dies.
    const realReissue = reissue.fn.getMockImplementation()!;
    reissue.fn.mockImplementationOnce(async (...args: Parameters<typeof realReissue>) => {
      await realReissue(...args);
      throw new Error("process stopped after the re-issue committed");
    });
    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect(live().map((row) => row.id)).toEqual(["pl_re_1"]);
    expect(linkCore.sends).toEqual([]);
    expect(everyLiveUnemailedLinkIsOwed()).toBe(true);

    // The next sweep: the old link's marker has moved on (a newer link, owed in its own right), and the new link's is recovered.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR));
    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR));
    expect(everyLiveUnemailedLinkIsOwed()).toBe(true);
    expect(linkCore.sends).toEqual([{ token: "tok_re_2", key: "pl_re_2" }]);
    expect(owed.store.rows.size).toBe(0);
  });

  it("a second stop on the new link's own send (it throws before its row) keeps that link's marker, and the next sweep sends again", async () => {
    await owe();
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    linkCore.next = "throw-before-row";
    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect([...owed.store.rows.values()].map((row) => row.subjectId)).toEqual(["pl_re_1"]);
    expect(everyLiveUnemailedLinkIsOwed()).toBe(true);

    linkCore.next = "sent";
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR));
    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR));
    expect(linkCore.sends.at(-1)).toEqual({ token: "tok_re_2", key: "pl_re_2" });
    expect(owed.store.rows.size).toBe(0);
  });

  it.each([["not_payable"], ["just_sent"], ["withheld"]])("clears when the re-issue answers %s, with nothing minted", async (kind) => {
    await owe();
    reissue.fn.mockResolvedValueOnce({ kind });
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(owed.store.rows.size).toBe(0);
    expect(linkCore.sends).toEqual([]);
  });

  it("keeps the marker when the re-issue throws before committing, for a later sweep", async () => {
    await owe();
    reissue.fn.mockRejectedValueOnce(new Error("lock timeout"));
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect([...owed.store.rows.values()].map((row) => row.subjectId)).toEqual([LINK]);
  });

  it.each([
    ["the booking is no longer PENDING", () => (db.booking = childBooking({ status: "PAID" }))],
    ["the booking was deleted", () => (db.booking = childBooking({ deletedAt: NOW }))],
    ["the link was used", () => db.links.set(LINK, linkRow({ usedAt: NOW }))],
    ["a newer link was minted", () => db.links.set("pl_newer", linkRow({ id: "pl_newer", createdAt: new Date(NOW.getTime() + MINUTE) }))],
    ["the link is gone", () => db.links.delete(LINK)],
  ])("clears without a re-issue or an alert when %s", async (_label, change) => {
    await owe();
    change();
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));

    const swept = await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.cleared).toBe(1);
    expect(reissue.fn).not.toHaveBeenCalled();
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("at the link's expiry (the end of the check-in day) alerts the officers once when the member was not told, and stays quiet when they were (round 1, item 3; D10)", async () => {
    await owe();
    db.links.set(LINK, linkRow({ expiresAt: new Date(NOW.getTime() + 40 * MINUTE) }));
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect(reissue.fn).not.toHaveBeenCalled();
    expect(alerts.unsent).toHaveBeenCalledTimes(1);
    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "split-guest-payment-link", bookingId: "child_1" }));

    alerts.unsent.mockClear();
    await owe();
    db.links.set(LINK, linkRow({ expiresAt: new Date(NOW.getTime() + 40 * MINUTE) }));
    db.emailRows.set(splitGuestPaymentLinkEmailLogId(LINK), { status: "SENT", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });
    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect(alerts.unsent).not.toHaveBeenCalled();
  });

  it("past seven days, with the check-in day still to come, alerts the officers once (D10)", async () => {
    await owe();
    const late = new Date(NOW.getTime() + 7 * DAY + HOUR);
    vi.setSystemTime(late);

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, late);

    expect(reissue.fn).not.toHaveBeenCalled();
    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "split-guest-payment-link", bookingId: "child_1" }));
  });
});

describe("the retired saved card's notices", () => {
  const facts = { reason: "card_permanently_declined" as const, stripeCode: "card_declined", declineCode: "stolen_card", message: "Your card was declined." };
  const pendingBooking = (overrides: Record<string, unknown> = {}) =>
    cancelledBooking({ status: "PENDING", checkIn: new Date("2026-07-15T00:00:00.000Z"), checkOut: new Date("2026-07-17T00:00:00.000Z"), payment: null, parentBooking: null, ...overrides });

  async function owe(overrides: Partial<Parameters<typeof recordSavedCardUnusableNoticesOwed>[1]> = {}) {
    const recorded = await recordSavedCardUnusableNoticesOwed(tx(), { bookingId: "b1", facts, claimReleased: true, amountCents: 14000, paymentIntentId: "pi_1", ...overrides });
    db.booking = pendingBooking();
    return recorded;
  }

  it("records nothing when the clear cannot key its markers, so the clear still commits, and sends both unkeyed as before #5433 (round 1, item 5)", async () => {
    const owedNotices = await recordSavedCardUnusableNoticesOwed(tx(), { bookingId: "not an id", facts, claimReleased: true, amountCents: 1, paymentIntentId: "pi_1" });
    expect(owedNotices.recorded).toBe(false);
    expect(owed.store.rows.size).toBe(0);

    await deliverSavedCardUnusableNotices(pendingBooking({ id: "not an id" }) as never, owedNotices, CLUB_FORMAT_TEST);

    expect(core.sends.map((send) => [send.template, send.key])).toEqual([[SAVED_CARD_CHARGE_FAILED_TEMPLATE, undefined]]);
    const [alert] = officers.paymentFailure.mock.calls[0] as [{ errorMessage: string }];
    expect(alert.errorMessage).toContain("Your card was declined.");
    expect(owed.store.rows.size).toBe(0);
  });

  it("sends the owner's email a stopped run never sent, keyed by the clear, and the officers' alert from its payload with Stripe's message not kept", async () => {
    const recorded = await owe();

    const swept = await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.delivered).toBe(2);
    expect(core.sends.map((send) => [send.template, send.key])).toEqual([[SAVED_CARD_CHARGE_FAILED_TEMPLATE, `b1:${recorded.retiredAt.getTime()}`]]);
    const [alert] = officers.paymentFailure.mock.calls[0] as [{ errorMessage: string; amountCents: number; paymentIntentId: string; memberName: string }];
    expect(alert).toMatchObject({ amountCents: 14000, paymentIntentId: "pi_1", memberName: "Ada Proof" });
    expect(alert.errorMessage).toContain("the card issuer declined it for a reason a retry cannot fix");
    expect(alert.errorMessage).toContain("Stripe's own message was not kept for this delayed alert (code card_declined, decline stolen_card).");
    expect(alert.errorMessage).not.toContain("Your card was declined.");
  });

  it("clears the owner's email without sending when a card the job can charge has been saved since", async () => {
    await owe();
    db.booking = pendingBooking({ payment: { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_new", stripeSetupIntentId: "seti_1" } });

    const swept = await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS.filter((d) => d.kind === "saved-card-unusable-member"), new Date(NOW.getTime() + HOUR));

    expect(swept.cleared).toBe(1);
    expect(core.sends).toEqual([]);
  });

  it.each([["PAID"], ["CANCELLED"]])("clears both without sending when the booking is %s", async (status) => {
    await owe();
    db.booking = pendingBooking({ status });

    const swept = await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.cleared).toBe(2);
    expect(officers.paymentFailure).not.toHaveBeenCalled();
  });

  it("past the end of the check-in day alerts the officers once instead of asking the owner for a card", async () => {
    await owe();
    db.booking = pendingBooking({ checkIn: new Date("2026-07-05T00:00:00.000Z"), checkOut: new Date("2026-07-07T00:00:00.000Z") });

    await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS.filter((d) => d.kind === "saved-card-unusable-member"), new Date("2026-07-06T00:00:00.000Z"));

    expect(core.sends).toEqual([]);
    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "saved-card-unusable", bookingId: "b1" }));
  });

  it.each([
    ["CONFIRMED, though the clear recorded the claim handed back", "CONFIRMED", true, "still marked confirmed but unpaid", "stays pending"],
    ["PENDING, though the clear recorded the claim not handed back (an officer put it right since)", "PENDING", false, "The booking stays pending", "confirmed but unpaid"],
  ])("words a delayed alert from the booking's status when it is sent: %s (round 1, item 9)", async (_label, status, claimReleased, says, never) => {
    await owe({ claimReleased });
    db.booking = pendingBooking({ status });

    await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS.filter((d) => d.kind === "saved-card-unusable-officers"), new Date(NOW.getTime() + HOUR));

    const [alert] = officers.paymentFailure.mock.calls[0] as [{ errorMessage: string }];
    expect(alert.errorMessage).toContain(says);
    expect(alert.errorMessage).not.toContain(never);
  });
});
