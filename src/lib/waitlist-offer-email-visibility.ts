import { EmailLogStatus, BookingStatus } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { WAITLIST_OFFER_TEMPLATE_NAME } from "@/lib/email/waitlist-offer-template";
import { offerEmailLookupStart, offerEmailRowState } from "@/lib/waitlist-offer-email-state";

type WaitlistOfferEmailRetryState =
  | "delivered"
  | "queued"
  | "retrying"
  | "exhausted"
  | "undeliverable"
  // #2258: the offer email was deliberately withheld because the booking has
  // the "No emails" switch on. Its OWN state, never folded into "missing" or
  // "undeliverable": those two mean the member did not get a message we tried to
  // send (an operator must act), while this one means an admin chose silence.
  // needsOperatorAction is false for it.
  | "suppressed"
  // #2258: a silenced booking that is nonetheless sitting on a LIVE, unexpired
  // offer. Candidacy exclusion means this should not normally arise, but two
  // real paths reach it — the switch being turned on AFTER an offer was made,
  // and the post-commit race where the offer commits before the send is gated —
  // and the consequence is severe: the entry holds a bed for the whole offer
  // window while the member is never told, then lapses. This is the ONE
  // suppression state with needsOperatorAction: true.
  | "suppressed_live_offer"
  // #5433: held back because this installation is not the club's live site
  // (`SKIPPED_NON_PRODUCTION`): by design, not an operator problem.
  | "withheld_non_production"
  | "missing";

export interface WaitlistOfferEmailDelivery {
  status: EmailLogStatus | "MISSING";
  emailLogId: string | null;
  attempts: number | null;
  lastAttemptAt: string | null;
  errorMessage: string | null;
  retryState: WaitlistOfferEmailRetryState;
  needsOperatorAction: boolean;
}

type WaitlistOfferBooking = {
  id: string;
  status: BookingStatus;
  waitlistOfferedAt: Date | null;
  // #2258: required, so a caller that assembles this shape by hand cannot
  // silently report a deliberately-silenced booking as a delivery failure.
  noEmails: boolean;
  // #2258: needed to tell a silenced entry sitting on a LIVE offer (an operator
  // problem — a held bed nobody was told about) from one whose offer has already
  // lapsed (nothing left to do).
  waitlistOfferExpiresAt: Date | null;
  /** Null for an organisation-owned booking (#3369); the owner is read below. */
  member: {
    email: string;
  } | null;
  /** #3369: the owner may be an Organisation; `bookingOwner()` reads both. */
  organisation: { name: string; email: string | null } | null;
};

type WaitlistOfferEmailLog = {
  id: string;
  to: string;
  bookingId: string | null;
  status: EmailLogStatus;
  attempts: number;
  lastAttemptAt: Date;
  errorMessage: string | null;
  createdAt: Date;
  htmlBody: string | null;
  bookingRetryHtmlBody: string | null;
};

function getLookupStart(booking: WaitlistOfferBooking) {
  return offerEmailLookupStart(booking.waitlistOfferedAt ?? new Date(0));
}

function emailLogMatchesBooking(
  emailLog: WaitlistOfferEmailLog,
  booking: WaitlistOfferBooking,
) {
  return (
    emailLog.to === bookingOwner(booking).member.email &&
    emailLog.createdAt >= getLookupStart(booking)
  );
}

function chooseLatestEmailLog(
  booking: WaitlistOfferBooking,
  emailLogs: WaitlistOfferEmailLog[],
) {
  const matching = emailLogs.filter((emailLog) =>
    emailLogMatchesBooking(emailLog, booking),
  );
  const withBookingLink = matching.filter(
    (emailLog) =>
      // #2258 added a real bookingId column; prefer it, and keep the historical
      // body-scan fallback for rows written before it existed (and for withheld
      // rows, which retain no body at all).
      emailLog.bookingId === booking.id || emailLog.htmlBody?.includes(booking.id),
  );
  const candidates = withBookingLink.length > 0 ? withBookingLink : matching;

  return candidates
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

function hasLiveOffer(booking: WaitlistOfferBooking, now: Date) {
  return (
    booking.waitlistOfferExpiresAt != null &&
    booking.waitlistOfferExpiresAt.getTime() > now.getTime()
  );
}

function suppressedState(
  booking: WaitlistOfferBooking,
  now: Date,
): { retryState: WaitlistOfferEmailRetryState; needsOperatorAction: boolean } {
  return hasLiveOffer(booking, now)
    ? { retryState: "suppressed_live_offer", needsOperatorAction: true }
    : { retryState: "suppressed", needsOperatorAction: false };
}

function deliveryOf(
  emailLog: WaitlistOfferEmailLog,
  retryState: WaitlistOfferEmailRetryState,
  needsOperatorAction: boolean,
): WaitlistOfferEmailDelivery {
  return {
    status: emailLog.status,
    emailLogId: emailLog.id,
    attempts: emailLog.attempts,
    lastAttemptAt: emailLog.lastAttemptAt.toISOString(),
    errorMessage: emailLog.status === EmailLogStatus.SENT ? null : emailLog.errorMessage,
    retryState,
    needsOperatorAction,
  };
}

/**
 * #5433 (round 2, item 5c): built on the one definition of what the offer
 * email's row says (`offerEmailRowState`), the same reading the offer's owed
 * notices and the lapse use; the page keeps its own words for each case. Three
 * cases read differently from before, each because the old reading was wrong:
 * a non-production copy's withheld email (it read as retrying or exhausted by
 * its attempts) is now `withheld_non_production`, neutral; a `FAILED` row with
 * no body to replay (it read as retrying below the ceiling) is now `exhausted`;
 * and a `QUEUED` row past its first attempt, which the retry cron holds while
 * it replays it, is now `retrying`. A live offer whose email the booking's "No
 * emails" withheld is still flagged for an operator: that member was not told,
 * whatever the owed notices count as told.
 */
function toDelivery(
  emailLog: WaitlistOfferEmailLog | null,
  booking: WaitlistOfferBooking,
  now: Date,
): WaitlistOfferEmailDelivery {
  const state = offerEmailRowState(emailLog, now);
  if (!emailLog || state === "not-sent") {
    const missing = { status: "MISSING" as const, emailLogId: null, attempts: null, lastAttemptAt: null, errorMessage: null };
    // A suppressed booking never gets an offer email (processWaitlistForDates
    // excludes it from candidacy), so an absent log here is expected rather than
    // an operator problem. Reporting "missing" would be a false alarm.
    return booking.noEmails
      ? { ...missing, ...suppressedState(booking, now) }
      : { ...missing, retryState: "missing", needsOperatorAction: true };
  }
  switch (state) {
    case "sent":
      return emailLog.status === EmailLogStatus.SENT
        ? deliveryOf(emailLog, "delivered", false)
        : deliveryOf(emailLog, "queued", false);
    case "withheld":
      if (emailLog.status === EmailLogStatus.SKIPPED_NON_PRODUCTION) {
        return deliveryOf(emailLog, "withheld_non_production", false);
      }
      {
        const suppressed = suppressedState(booking, now);
        return deliveryOf(emailLog, suppressed.retryState, suppressed.needsOperatorAction);
      }
    case "retrying":
      return deliveryOf(emailLog, "retrying", false);
    case "undeliverable":
      return emailLog.status === EmailLogStatus.BOUNCED
        ? deliveryOf(emailLog, "undeliverable", true)
        : deliveryOf(emailLog, "exhausted", true);
  }
}

export async function getWaitlistOfferEmailDeliveries(
  bookings: WaitlistOfferBooking[],
): Promise<Map<string, WaitlistOfferEmailDelivery>> {
  const offeredBookings = bookings.filter(
    (booking) => booking.status === BookingStatus.WAITLIST_OFFERED,
  );
  const lookupBookings = offeredBookings.filter(
    (booking) => booking.waitlistOfferedAt,
  );
  const deliveries = new Map<string, WaitlistOfferEmailDelivery>();
  const now = new Date();

  if (offeredBookings.length === 0) {
    return deliveries;
  }

  if (lookupBookings.length === 0) {
    for (const booking of offeredBookings) {
      deliveries.set(booking.id, toDelivery(null, booking, now));
    }
    return deliveries;
  }

  // Seeded from the first booking's own lookup start, which the early return
  // above proves is present; reading it here is what says so (#2800).
  const [firstLookupBooking, ...laterLookupBookings] = lookupBookings;
  if (firstLookupBooking === undefined) return deliveries;
  const earliestLookupStart = laterLookupBookings.reduce((earliest, booking) => {
    const lookupStart = getLookupStart(booking);
    return lookupStart < earliest ? lookupStart : earliest;
  }, getLookupStart(firstLookupBooking));
  const recipients = Array.from(
    new Set(lookupBookings.map((booking) => bookingOwner(booking).member.email)),
  );
  const emailLogs = await prisma.emailLog.findMany({
    where: {
      templateName: WAITLIST_OFFER_TEMPLATE_NAME,
      to: { in: recipients },
      createdAt: {
        gte: earliestLookupStart,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 500,
    select: {
      id: true,
      to: true,
      bookingId: true,
      status: true,
      attempts: true,
      lastAttemptAt: true,
      errorMessage: true,
      createdAt: true,
      htmlBody: true,
      bookingRetryHtmlBody: true,
    },
  });

  for (const booking of offeredBookings) {
    deliveries.set(
      booking.id,
      booking.waitlistOfferedAt
        ? toDelivery(chooseLatestEmailLog(booking, emailLogs), booking, now)
        : toDelivery(null, booking, now),
    );
  }

  return deliveries;
}
