import { EmailLogStatus, BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const WAITLIST_OFFER_TEMPLATE_NAME = "waitlist-offer";
const EMAIL_RETRY_MAX_ATTEMPTS = 3;
const WAITLIST_EMAIL_LOOKBACK_MS = 2 * 60 * 1000;

export type WaitlistOfferEmailRetryState =
  | "delivered"
  | "queued"
  | "retrying"
  | "exhausted"
  | "undeliverable"
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
  member: {
    email: string;
  };
};

type WaitlistOfferEmailLog = {
  id: string;
  to: string;
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
  const withBookingLink = matching.filter((emailLog) =>
    emailLog.htmlBody?.includes(booking.id),
  );
  const candidates = withBookingLink.length > 0 ? withBookingLink : matching;

  return candidates
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

function toDelivery(emailLog: WaitlistOfferEmailLog | null): WaitlistOfferEmailDelivery {
  if (!emailLog) {
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

  if (offeredBookings.length === 0) {
    return deliveries;
  }

  if (lookupBookings.length === 0) {
    for (const booking of offeredBookings) {
      deliveries.set(booking.id, toDelivery(null));
    }
    return deliveries;
  }

  const earliestLookupStart = lookupBookings.reduce((earliest, booking) => {
    const lookupStart = getLookupStart(booking);
    return lookupStart < earliest ? lookupStart : earliest;
  }, getLookupStart(lookupBookings[0]));
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
        ? toDelivery(chooseLatestEmailLog(booking, emailLogs))
        : toDelivery(null),
    );
  }

  return deliveries;
}
