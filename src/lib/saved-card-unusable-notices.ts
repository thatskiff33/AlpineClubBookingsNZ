/**
 * #5433 PR 4: THE NOTICES OF A RETIRED SAVED CARD ARE OWED UNTIL SENT.
 *
 * When the confirm-pending job finds a saved card permanently unusable
 * (#3268, `retireAndEscalateUnusableSavedCard`), it clears the card from every
 * row that carries it, then emails the owner (`saved-card-charge-failed`,
 * asking for a new card) and alerts the officers (`admin-payment-failure`,
 * with the account below). Before #5433 a stop between the clear and the two
 * sends lost both for good: with the card cleared, the next run takes the
 * missing-payment-method path, which only logs. So the clear and the two
 * markers commit together, the markers as that transaction's last write
 * (`recordSavedCardUnusableNoticesOwed`); after the commit
 * `deliverSavedCardUnusableNotices` claims, sends and clears each, the
 * owner's first as before, and the sweep (`drainOwedNotices`) sends what that
 * attempt never did.
 *
 * The kinds:
 * - the wait: 30 minutes after the clear or the last attempt; an officers'
 *   alert that reached nobody waits a day;
 * - the owner's email carries the event key `<bookingId>:<retiredAtMs>`, so
 *   the owner can never be sent it twice for one clear; what became of it is
 *   read from its row (`owed-notice/member-email.ts`): not told (it failed
 *   for good, bounced, or the owner has no address that can be emailed), the
 *   officers are alerted once ("Booking email not sent");
 * - "moved on": the booking is gone, deleted, or neither PENDING nor
 *   CONFIRMED (paid, cancelled or ended since); for the owner's email also a
 *   card the job can charge saved on the booking or its parent since;
 * - the cut-off: the owner's email until the end of the check-in day in the
 *   club's time zone (a card is no use after it), or seven days after the
 *   clear (owner decision D7's limit for a confirmation, applied here),
 *   whichever comes first; past it the officers are alerted once. The
 *   officers' alert: seven days, then cleared with an error log. The attempt
 *   right after the clear always sends, as before #5433;
 * - the officers' alert's facts travel in its payload (the reason, whether the
 *   claim was handed back, the amount, and the provider's id-shaped codes).
 *   Stripe's own message is free text, which a payload never holds, so only
 *   the attempt right after the clear quotes it; a recovered alert says it
 *   was not kept.
 *
 * Locks (`INV-LOCK-001`): the clear has always taken no advisory lock
 * (`retireUnusableSavedCard` says why); the markers join its transaction, one
 * insert of two rows on primary keys, with no read, provider call or settings
 * query (`INV-INT-003`). Everything else here runs after the commit on the
 * base client.
 */
import { BookingStatus, Prisma } from "@prisma/client";

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import { alertOfficersBookingNoticeUnsent, OWED_BOOKING_NOTICE_SELECT, owedNoticeOwnerName } from "@/lib/booking-notice-unsent-alert";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import { calendarDateOfDateOnlyInstant, endOfClubDayInclusive, type ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendAdminPaymentFailureAlert, sendSavedCardChargeFailedEmail } from "@/lib/email";
import { durableEmailLogId } from "@/lib/email/attempt-log";
import logger from "@/lib/logger";
import {
  deliverOwedNotice,
  OWED_OFFICER_ALERT_MAX_AGE_MS,
  type OwedNoticeDeliverer,
  type OwedNoticeImmediateDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeRun,
} from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import {
  OWED_MEMBER_NOTICE_MAX_AGE_MS,
  OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  owedMemberEmailOutcome,
  owedMemberEmailPastCutoff,
  type OwedMemberEmail,
} from "@/lib/owed-notice/member-email";
import { owedOfficerAlertOutcome } from "@/lib/owed-notice/officer-alert";
import {
  OWED_NOTICE_PAYLOAD_ID,
  owedNoticeEventKey,
  owedNoticeInputProblem,
  owedNoticeMarker,
  recordOwedNotices,
  type OwedNoticeInput,
  type OwedNoticeMarker,
  type OwedNoticePayload,
} from "@/lib/owed-notice/store";
import { prisma } from "@/lib/prisma";
import type { SavedCardChargeFailureReason } from "@/lib/saved-card-charge-failure";
import { savedPaymentMethodForBooking } from "@/lib/saved-payment-method";

const MEMBER_KIND: OwedNoticeKind = "saved-card-unusable-member";
const OFFICERS_KIND: OwedNoticeKind = "saved-card-unusable-officers";
const SAVED_CARD_CHARGE_FAILED_TEMPLATE = "saved-card-charge-failed";

/** What the officers' alert says about the failure: the classification's reason and codes, and Stripe's message when it is still in memory. */
export interface UnusableSavedCardFacts {
  reason: SavedCardChargeFailureReason;
  stripeCode: string | null;
  declineCode: string | null;
  /** Stripe's own words: free text, so never stored; null in a recovered alert. */
  message: string | null;
}

/**
 * Plain-English admin alert body for a terminal failure (#3268). Says what
 * happened, what the system did about it, what the owner is asked to do, and
 * quotes Stripe's own words, when they are still known, so the operator can
 * look them up.
 *
 * `claimReleased` is whether `releaseChargeClaim` succeeded. It normally does,
 * and the booking is back to PENDING with its beds unheld; when it did not, the
 * booking is stuck CONFIRMED and unpaid with no card, and the alert must say
 * that rather than assert a pending state the row is not in.
 *
 * #5433 PR 4: the owner's email is an owed notice of its own, so this alert
 * can go before it, or without it reaching the owner. It says what is true in
 * each case: the email is sent separately, the "No emails" switch holds it
 * back, and an email that does not reach the owner raises its own alert.
 */
export function describeTerminalSavedCardChargeFailure(facts: UnusableSavedCardFacts, { claimReleased }: { claimReleased: boolean }): string {
  const why =
    facts.reason === "payment_method_unusable"
      ? "Stripe reported the saved card can no longer be charged"
      : facts.reason === "card_permanently_declined"
        ? "the card issuer declined it for a reason a retry cannot fix"
        : "the card has kept declining for two days after the charge first became due";
  const stripeDetail = [facts.stripeCode ? `code ${facts.stripeCode}` : null, facts.declineCode ? `decline ${facts.declineCode}` : null]
    .filter((part): part is string => part !== null)
    .join(", ");
  return (
    `The saved card for this booking was found unusable: ${why}. ` +
    "It has been removed from the booking. A separate email asks the owner to save a new card, unless this booking's emails are turned off; if that email does not reach them, officers are sent a \"Booking email not sent\" alert. " +
    (claimReleased
      ? "The booking stays pending; no further automatic charge will be attempted until a card is saved. "
      : "The booking could NOT be returned to pending after the failed charge and is still marked confirmed but unpaid, with no card on file — it needs an administrator to correct it. ") +
    (facts.message !== null
      ? `Stripe said: "${facts.message}"${stripeDetail ? ` (${stripeDetail})` : ""}.`
      : `Stripe's own message was not kept for this delayed alert${stripeDetail ? ` (${stripeDetail})` : ""}.`)
  );
}

/** One clear's owed notices: the booking, the instant that keys and stamps them, and the officers' alert's facts. */
export interface OwedSavedCardUnusableNotices {
  bookingId: string;
  retiredAt: Date;
  facts: UnusableSavedCardFacts;
  claimReleased: boolean;
  amountCents: number;
  paymentIntentId: string;
}

/** A provider value kept in the payload only when it is id-shaped (`"N/A"` is not); a recovered alert then shows what the immediate one would have had to guess. */
const idShaped = (value: string | null): value is string => value !== null && OWED_NOTICE_PAYLOAD_ID.test(value);

function officersPayload(owed: OwedSavedCardUnusableNotices): OwedNoticePayload {
  return {
    reason: owed.facts.reason,
    claimReleased: owed.claimReleased ? 1 : 0,
    amountCents: owed.amountCents,
    ...(idShaped(owed.paymentIntentId) ? { paymentIntentId: owed.paymentIntentId } : {}),
    ...(idShaped(owed.facts.stripeCode) ? { stripeCode: owed.facts.stripeCode } : {}),
    ...(idShaped(owed.facts.declineCode) ? { declineCode: owed.facts.declineCode } : {}),
  };
}

function savedCardInputs(owed: OwedSavedCardUnusableNotices): [OwedNoticeInput, OwedNoticeInput] {
  return [
    { kind: MEMBER_KIND, subjectId: owed.bookingId, eventAt: owed.retiredAt },
    { kind: OFFICERS_KIND, subjectId: owed.bookingId, eventAt: owed.retiredAt, payload: officersPayload(owed) },
  ];
}

/**
 * Inside the card clear's transaction, as its last write: record both notices
 * as owed and return the descriptor the delivery claims with
 * (`INV-SSOT-002`). Asked first without a write (`owedNoticeInputProblem`): an
 * input that cannot key a marker is an error log and null, so the marker can
 * never roll the clear back for a reason of shape.
 */
export async function recordSavedCardUnusableNoticesOwed(
  tx: Pick<Prisma.TransactionClient, "owedNotice">,
  notice: Omit<OwedSavedCardUnusableNotices, "retiredAt">,
): Promise<OwedSavedCardUnusableNotices | null> {
  const owed: OwedSavedCardUnusableNotices = { ...notice, retiredAt: new Date() };
  const inputs = savedCardInputs(owed);
  const problem = inputs.map(owedNoticeInputProblem).find((found) => found !== null);
  if (problem) {
    logger.error({ bookingId: notice.bookingId, problem }, "A retired saved card cannot key its owed notices; the clear commits and nothing is recorded as owed");
    return null;
  }
  await recordOwedNotices(tx, inputs);
  return owed;
}

/** The booking fields the notices read: ids and dates, no more. */
export interface SavedCardUnusableBooking {
  id: string;
  /** The booking OWNER, null when it is owned by an Organisation (#3369). */
  memberId: string | null;
  lodgeId: string | null;
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  member: { email: string; firstName: string; lastName: string } | null;
  organisation: { name: string; email: string | null } | null;
}

/** The attempt right after the clear: the booking, the club's format, and Stripe's message while it is still in memory. */
interface SavedCardUnusableSubject {
  booking: SavedCardUnusableBooking;
  format: ClubFormat;
  stripeMessage: string | null;
}

/** The owner's email as the shared reading takes it, and the alert it raises. */
function savedCardMemberEmail(booking: SavedCardUnusableBooking, marker: OwedNoticeMarker, job: string): OwedMemberEmail {
  return {
    emailLogId: durableEmailLogId(SAVED_CARD_CHARGE_FAILED_TEMPLATE, owedNoticeEventKey(marker.subjectId, marker.eventAt)),
    label: "saved-card-charge-failed email",
    log: { bookingId: marker.subjectId, key: marker.id, job },
    alertOfficers: () => alertOfficersBookingNoticeUnsent(marker, "saved-card-unusable", booking),
  };
}

/** The owner's email, with the clear's event key, then what became of it. Never throws. */
async function deliverSavedCardMemberEmail(
  { booking }: SavedCardUnusableSubject,
  marker: OwedNoticeMarker,
  { idempotencyKey, job }: OwedNoticeRun & { idempotencyKey: string },
): Promise<OwedNoticeOutcome> {
  const owner = bookingOwner(booking);
  try {
    await sendSavedCardChargeFailedEmail({
      bookingId: booking.id,
      recipientMemberId: owner.memberId,
      email: owner.member.email,
      firstName: owner.member.firstName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: booking.lodgeId,
      idempotencyKey,
    });
  } catch (emailErr) {
    logger.error({ err: emailErr, bookingId: booking.id, job }, "Failed to send the saved-card-charge-failed email to the member (#3268)");
    return "threw";
  }
  return owedMemberEmailOutcome(savedCardMemberEmail(booking, marker, job));
}

type PayloadRecord = Readonly<Record<string, unknown>>;

function payloadOf(marker: OwedNoticeMarker): PayloadRecord {
  const payload = marker.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

const textOf = (payload: PayloadRecord, field: string): string | null => (typeof payload[field] === "string" ? (payload[field] as string) : null);

const REASONS: readonly SavedCardChargeFailureReason[] = ["payment_method_unusable", "card_permanently_declined", "soft_decline_exhausted"];

/** The officers' alert, from its payload and the booking as it stands, with Stripe's message when still known. Never throws. */
function deliverSavedCardOfficersAlert(
  { booking, format, stripeMessage }: SavedCardUnusableSubject,
  marker: OwedNoticeMarker,
  { job }: OwedNoticeRun,
): Promise<OwedNoticeOutcome> {
  const payload = payloadOf(marker);
  const storedReason = textOf(payload, "reason");
  const reason = REASONS.find((known) => known === storedReason) ?? "payment_method_unusable";
  const facts: UnusableSavedCardFacts = { reason, stripeCode: textOf(payload, "stripeCode"), declineCode: textOf(payload, "declineCode"), message: stripeMessage };
  return owedOfficerAlertOutcome("admin payment failure alert", { bookingId: booking.id, job }, () =>
    sendAdminPaymentFailureAlert({
      memberName: owedNoticeOwnerName(booking),
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : booking.finalPriceCents,
      errorMessage: describeTerminalSavedCardChargeFailure(facts, { claimReleased: payload.claimReleased === 1 }),
      paymentIntentId: textOf(payload, "paymentIntentId") ?? "N/A",
    }, format),
  );
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

const SAVED_CARD_SWEEP_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  ...OWED_BOOKING_NOTICE_SELECT,
  payment: { select: { stripeCustomerId: true, stripePaymentMethodId: true, stripeSetupIntentId: true } },
  parentBooking: { select: { payment: { select: { stripeCustomerId: true, stripePaymentMethodId: true, stripeSetupIntentId: true } } } },
});

type SavedCardSweepBooking = Prisma.BookingGetPayload<{ select: typeof SAVED_CARD_SWEEP_SELECT }>;

interface SavedCardUnusableSweepSubject extends SavedCardUnusableSubject {
  booking: SavedCardSweepBooking;
  zone: ClubTimeZone;
}

async function loadSavedCardUnusableSweepSubject(marker: OwedNoticeMarker): Promise<SavedCardUnusableSweepSubject | null> {
  const booking = await prisma.booking.findUnique({ where: { id: marker.subjectId }, select: SAVED_CARD_SWEEP_SELECT });
  if (!booking) return null;
  return { booking, format: await clubFormatValues(), zone: await readClubTimeZoneOutsideRequest(), stripeMessage: null };
}

/** Null when the booking still stands where the clear left it; otherwise why it moved on. */
export function savedCardUnusableBookingMovedOn(booking: Pick<SavedCardSweepBooking, "status" | "deletedAt">): string | null {
  if (booking.deletedAt) return "the booking was deleted";
  if (booking.status !== BookingStatus.PENDING && booking.status !== BookingStatus.CONFIRMED) return `the booking is ${booking.status}`;
  return null;
}

/** For the owner's email also: a card the job can charge has been saved since. */
export function savedCardUnusableMemberMovedOn(booking: Pick<SavedCardSweepBooking, "status" | "deletedAt" | "payment" | "parentBooking">): string | null {
  return savedCardUnusableBookingMovedOn(booking) ?? (savedPaymentMethodForBooking(booking) ? "a card the job can charge has been saved since" : null);
}

/** The owner's cut-off: the last instant of the check-in day in the club's time zone. */
export function savedCardUnusableMemberSendBy(checkIn: Date, zone: ClubTimeZone): Date {
  return endOfClubDayInclusive(calendarDateOfDateOnlyInstant(checkIn), zone);
}

const MEMBER_DELIVERY = {
  kind: MEMBER_KIND,
  job: "confirmPendingBookings",
  audience: "member" as const,
  sweepAfterMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  idempotencyKey: (marker: OwedNoticeMarker) => owedNoticeEventKey(marker.subjectId, marker.eventAt),
  deliver: deliverSavedCardMemberEmail,
};

const OFFICERS_DELIVERY = {
  kind: OFFICERS_KIND,
  job: "confirmPendingBookings",
  audience: "officers" as const,
  sweepAfterMs: OWED_MEMBER_NOTICE_SWEEP_AFTER_MS,
  unreachedRetryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  deliver: deliverSavedCardOfficersAlert,
};

const SAVED_CARD_MEMBER: OwedNoticeDeliverer<SavedCardUnusableSweepSubject> = {
  ...MEMBER_DELIVERY,
  maxAgeMs: OWED_MEMBER_NOTICE_MAX_AGE_MS,
  load: loadSavedCardUnusableSweepSubject,
  stillOwed: async ({ booking }) => savedCardUnusableMemberMovedOn(booking) ?? true,
  sendBy: ({ booking, zone }) => savedCardUnusableMemberSendBy(booking.checkIn, zone),
  pastCutoff: ({ booking }, marker, run) => owedMemberEmailPastCutoff(savedCardMemberEmail(booking, marker, run.job)),
};

const SAVED_CARD_OFFICERS: OwedNoticeDeliverer<SavedCardUnusableSweepSubject> = {
  ...OFFICERS_DELIVERY,
  maxAgeMs: OWED_OFFICER_ALERT_MAX_AGE_MS,
  load: loadSavedCardUnusableSweepSubject,
  stillOwed: async ({ booking }) => savedCardUnusableBookingMovedOn(booking) ?? true,
  sendBy: (_subject, marker) => new Date(marker.eventAt.getTime() + OWED_OFFICER_ALERT_MAX_AGE_MS),
};

/** The two kinds, the owner's first, as the registry lists them. */
export const SAVED_CARD_UNUSABLE_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer<SavedCardUnusableSweepSubject>[] = [SAVED_CARD_MEMBER, SAVED_CARD_OFFICERS];

/**
 * After the clear commits: deliver both notices, the owner's first, from the
 * descriptor `recordSavedCardUnusableNoticesOwed` returned inside the
 * transaction, with Stripe's message for the officers' alert. Each claim is
 * taken on the stamp the transaction wrote, so a sweep that already holds a
 * marker wins and this sends nothing. Never throws.
 */
export async function deliverSavedCardUnusableNotices(
  booking: SavedCardUnusableBooking,
  owed: OwedSavedCardUnusableNotices,
  format: ClubFormat,
): Promise<void> {
  const subject: SavedCardUnusableSubject = { booking, format, stripeMessage: owed.facts.message };
  const [memberInput, officersInput] = savedCardInputs(owed);
  await deliverOwedNotice<SavedCardUnusableSubject>(MEMBER_DELIVERY satisfies OwedNoticeImmediateDeliverer<SavedCardUnusableSubject>, owedNoticeMarker(memberInput), subject);
  await deliverOwedNotice<SavedCardUnusableSubject>(OFFICERS_DELIVERY satisfies OwedNoticeImmediateDeliverer<SavedCardUnusableSubject>, owedNoticeMarker(officersInput), subject);
}
