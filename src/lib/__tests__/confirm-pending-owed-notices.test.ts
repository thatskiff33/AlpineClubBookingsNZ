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
const db = vi.hoisted(() => ({
  emailRows: new Map<string, EmailRow>(),
  booking: null as Record<string, unknown> | null,
  link: null as Record<string, unknown> | null,
  newerLink: false,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    get owedNotice() {
      return owed.store.delegate;
    },
    emailLog: { findUnique: async ({ where }: { where: { id: string } }) => db.emailRows.get(where.id) ?? null },
    booking: { findUnique: async ({ where }: { where: { id: string } }) => (db.booking && db.booking.id === where.id ? db.booking : null) },
    paymentLink: {
      findUnique: async ({ where }: { where: { id: string } }) => (db.link && db.link.id === where.id ? db.link : null),
      findFirst: async () => (db.newerLink ? { id: "pl_newer" } : null),
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
vi.mock("@/lib/email", () => ({
  sendBookingRequestPaymentExpiredEmail: (params: Record<string, unknown>) =>
    memberSend("booking-request-payment-expired")({ ...params, idempotencyKey: params.idempotencyKey }),
  sendSplitGuestPortionCancelledEmail: memberSend("split-guest-portion-cancelled"),
  sendSavedCardChargeFailedEmail: memberSend("saved-card-charge-failed"),
  sendAdminBookingRequestHoldCancelledEmail: officers.requestCancelled,
  sendAdminSplitSettlementCancelledAlert: officers.splitCancelled,
  sendAdminPaymentFailureAlert: officers.paymentFailure,
  sendSplitGuestPaymentLinkEmail: vi.fn(),
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
const reissue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/payment-link-split-guest", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-link-split-guest")),
  issueSplitGuestPaymentLink: reissue.fn,
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
  recordSplitGuestPaymentLinkOwed,
  SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS,
  splitGuestPaymentLinkRecoveryKey,
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
  db.link = null;
  db.newerLink = false;
  core.next = "SENT";
  core.sends = [];
  alerts.onceKeys = [];
  alerts.unsent.mockResolvedValue(SENT);
  officers.requestCancelled.mockResolvedValue(SENT);
  officers.splitCancelled.mockResolvedValue(SENT);
  officers.paymentFailure.mockResolvedValue(SENT);
  reissue.fn.mockResolvedValue({ outcome: "sent", emailLogId: "x", recipientMemberId: "m1", sentTo: "ada@example.test" });
});

describe("CP-4 and CP-5: the notices of a hold that ended in cancellation", () => {
  it("records nothing and returns null when the cancel cannot key its markers, so the cancel still commits", async () => {
    expect(await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "not an id" })).toBeNull();
    expect(owed.store.rows.size).toBe(0);
  });

  it("sends a requester's notice a stopped run never sent, once, keyed by the cancel, after the wait and not before", async () => {
    const recorded = await recordHoldEndedNoticesOwed(tx(), { ended: "request", bookingId: "b1" });
    db.booking = cancelledBooking();

    expect((await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + 29 * MINUTE))).checked).toBe(0);
    const swept = await sweep(HOLD_ENDED_NOTICE_DELIVERERS, new Date(NOW.getTime() + 31 * MINUTE));

    expect(swept).toEqual({ checked: 2, delivered: 2, cleared: 0, expired: 0 });
    expect(core.sends.map((send) => [send.template, send.key])).toEqual([["booking-request-payment-expired", `b1:${recorded!.cancelledAt.getTime()}`]]);
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
    owed.store.seed({ id: "request-hold-cancelled-member:b1:2", kind: "request-hold-cancelled-member", subjectId: "b1", eventAt: new Date(recorded!.cancelledAt.getTime() + 1) });
    db.emailRows.set(`email:booking-request-payment-expired:b1:${recorded!.cancelledAt.getTime() + 1}`, { status: "SENT", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });
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
  const activeLink = (overrides: Record<string, unknown> = {}) => ({
    id: LINK,
    bookingId: "child_1",
    usedAt: null,
    createdAt: NOW,
    expiresAt: new Date("2026-07-20T11:59:59.999Z"),
    ...overrides,
  });

  async function owe() {
    const marker = await recordSplitGuestPaymentLinkOwed(tx(), { bookingId: "child_1", paymentLinkId: LINK });
    db.booking = childBooking();
    db.link = activeLink();
    return marker!;
  }

  it("records a marker keyed by the link, holding the booking and no token, and null for an input it cannot key", async () => {
    const marker = await owe();
    expect(marker).toMatchObject({ kind: "split-guest-payment-link", subjectId: LINK, payload: { bookingId: "child_1" } });
    expect(await recordSplitGuestPaymentLinkOwed(tx(), { bookingId: "child 1", paymentLinkId: LINK })).toBeNull();
  });

  it("clears without a re-issue when the original link's email was sent or is in flight", async () => {
    await owe();
    db.emailRows.set(`email:split-guest-payment-link:${LINK}`, { status: "QUEUED", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });

    const swept = await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.delivered).toBe(1);
    expect(reissue.fn).not.toHaveBeenCalled();
  });

  it("otherwise revokes and re-mints through the booking page's re-issue, keyed for one recovery per link, once", async () => {
    await owe();

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(reissue.fn).toHaveBeenCalledTimes(1);
    expect(reissue.fn).toHaveBeenCalledWith("child_1", CLUB_FORMAT_TEST, { idempotencyKey: splitGuestPaymentLinkRecoveryKey(LINK) });
    expect(owed.store.rows.size).toBe(0);
    expect((await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR))).checked).toBe(0);
  });

  it("does not re-issue a second time when a recovery's row already exists, even one that did not reach the member", async () => {
    await owe();
    db.emailRows.set(`email:split-guest-payment-link:${LINK}:resend`, { status: "FAILED", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });

    const swept = await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.delivered).toBe(1);
    expect(reissue.fn).not.toHaveBeenCalled();
  });

  it("keeps the marker when the re-issue throws, for a later sweep", async () => {
    await owe();
    reissue.fn.mockRejectedValueOnce(new Error("SMTP down"));

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));
    expect(owed.store.rows.size).toBe(1);

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + 2 * HOUR));
    expect(reissue.fn).toHaveBeenCalledTimes(2);
    expect(owed.store.rows.size).toBe(0);
  });

  it.each([
    ["the booking is no longer PENDING", () => (db.booking = childBooking({ status: "PAID" }))],
    ["the booking was deleted", () => (db.booking = childBooking({ deletedAt: NOW }))],
    ["the link was used", () => (db.link = activeLink({ usedAt: NOW }))],
    ["a newer link was minted", () => (db.newerLink = true)],
    ["the link expired at the end of the check-in day", () => (db.link = activeLink({ expiresAt: new Date(NOW.getTime() + 40 * MINUTE) }))],
    ["the link is gone", () => (db.link = null)],
  ])("clears without a re-issue when %s", async (_label, change) => {
    await owe();
    change();
    // The sweep runs on the real clock: its "now" and the moved-on read agree.
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));

    const swept = await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.cleared).toBe(1);
    expect(reissue.fn).not.toHaveBeenCalled();
  });

  it("past seven days, with the check-in day still to come, alerts the officers once, unless an email did reach the member", async () => {
    await owe();
    const late = new Date(NOW.getTime() + 7 * DAY + HOUR);

    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, late);
    expect(reissue.fn).not.toHaveBeenCalled();
    expect(alerts.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "split-guest-payment-link", bookingId: "child_1" }));

    alerts.unsent.mockClear();
    await owe();
    db.emailRows.set(`email:split-guest-payment-link:${LINK}:resend`, { status: "SENT", attempts: 1, lastAttemptAt: NOW, htmlBody: null, bookingRetryHtmlBody: null });
    await sweep(SPLIT_GUEST_PAYMENT_LINK_NOTICE_DELIVERERS, late);
    expect(alerts.unsent).not.toHaveBeenCalled();
  });
});

describe("the retired saved card's notices", () => {
  const facts = { reason: "card_permanently_declined" as const, stripeCode: "card_declined", declineCode: "stolen_card", message: "Your card was declined." };
  const pendingBooking = (overrides: Record<string, unknown> = {}) =>
    cancelledBooking({ status: "PENDING", checkIn: new Date("2026-07-15T00:00:00.000Z"), checkOut: new Date("2026-07-17T00:00:00.000Z"), payment: null, parentBooking: null, ...overrides });

  async function owe(overrides: Partial<Parameters<typeof recordSavedCardUnusableNoticesOwed>[1]> = {}) {
    const recorded = await recordSavedCardUnusableNoticesOwed(tx(), { bookingId: "b1", facts, claimReleased: true, amountCents: 14000, paymentIntentId: "pi_1", ...overrides });
    db.booking = pendingBooking();
    return recorded!;
  }

  it("sends the owner's email a stopped run never sent, keyed by the clear, and the officers' alert from its payload with Stripe's message not kept", async () => {
    const recorded = await owe();

    const swept = await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS, new Date(NOW.getTime() + HOUR));

    expect(swept.delivered).toBe(2);
    expect(core.sends.map((send) => [send.template, send.key])).toEqual([["saved-card-charge-failed", `b1:${recorded.retiredAt.getTime()}`]]);
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

  it("names a claim that was not handed back in a recovered alert", async () => {
    await owe({ claimReleased: false });

    await sweep(SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS.filter((d) => d.kind === "saved-card-unusable-officers"), new Date(NOW.getTime() + HOUR));

    const [alert] = officers.paymentFailure.mock.calls[0] as [{ errorMessage: string }];
    expect(alert.errorMessage).toContain("still marked confirmed but unpaid");
  });
});
