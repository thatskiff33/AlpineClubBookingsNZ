import { EmailLogStatus, BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const WAITLIST_OFFER_TEMPLATE_NAME = "waitlist-offer";
const EMAIL_RETRY_MAX_ATTEMPTS = 3;
const WAITLIST_EMAIL_LOOKBACK_MS = 2 * 60 * 1000;

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
  member: {
    email: string;
  };
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
};

function getLookupStart(booking: WaitlistOfferBooking) {
  const offeredAt = booking.waitlistOfferedAt ?? new Date(0);
  return new Date(offeredAt.getTime() - WAITLIST_EMAIL_LOOKBACK_MS);
}

function emailLogMatchesBooking(
  emailLog: WaitlistOfferEmailLog,
  booking: WaitlistOfferBooking,
) {
  return (
    emailLog.to === booking.member.email &&
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

function toDelivery(
  emailLog: WaitlistOfferEmailLog | null,
  booking: WaitlistOfferBooking,
  now: Date,
): WaitlistOfferEmailDelivery {
  if (!emailLog) {
    // A suppressed booking never gets an offer email (processWaitlistForDates
    // excludes it from candidacy), so an absent log here is expected rather than
    // an operator problem. Reporting "missing" would be a false alarm.
    if (booking.noEmails) {
      return {
        status: "MISSING",
        emailLogId: null,
        attempts: null,
        lastAttemptAt: null,
        errorMessage: null,
        ...suppressedState(booking, now),
      };
    }
    return {
      status: "MISSING",
      emailLogId: null,
      attempts: null,
      lastAttemptAt: null,
      errorMessage: null,
      retryState: "missing",
      needsOperatorAction: true,
    };
  }

  if (emailLog.status === EmailLogStatus.SKIPPED_NO_EMAILS) {
    return {
      status: emailLog.status,
      emailLogId: emailLog.id,
      attempts: emailLog.attempts,
      lastAttemptAt: emailLog.lastAttemptAt.toISOString(),
      errorMessage: emailLog.errorMessage,
      ...suppressedState(booking, now),
    };
  }

  if (emailLog.status === EmailLogStatus.SENT) {
    return {
      status: emailLog.status,
      emailLogId: emailLog.id,
      attempts: emailLog.attempts,
      lastAttemptAt: emailLog.lastAttemptAt.toISOString(),
      errorMessage: null,
      retryState: "delivered",
      needsOperatorAction: false,
    };
  }

  if (emailLog.status === EmailLogStatus.QUEUED) {
    return {
      status: emailLog.status,
      emailLogId: emailLog.id,
      attempts: emailLog.attempts,
      lastAttemptAt: emailLog.lastAttemptAt.toISOString(),
      errorMessage: emailLog.errorMessage,
      retryState: "queued",
      needsOperatorAction: false,
    };
  }

  if (emailLog.status === EmailLogStatus.BOUNCED) {
    return {
      status: emailLog.status,
      emailLogId: emailLog.id,
      attempts: emailLog.attempts,
      lastAttemptAt: emailLog.lastAttemptAt.toISOString(),
      errorMessage: emailLog.errorMessage,
      retryState: "undeliverable",
      needsOperatorAction: true,
    };
  }

  const exhausted = emailLog.attempts >= EMAIL_RETRY_MAX_ATTEMPTS;

  return {
    status: emailLog.status,
    emailLogId: emailLog.id,
    attempts: emailLog.attempts,
    lastAttemptAt: emailLog.lastAttemptAt.toISOString(),
    errorMessage: emailLog.errorMessage,
    retryState: exhausted ? "exhausted" : "retrying",
    needsOperatorAction: exhausted,
  };
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
    new Set(lookupBookings.map((booking) => booking.member.email)),
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
