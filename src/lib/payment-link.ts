/**
 * Tokenised public payment links (issue #707).
 *
 * A PaymentLink lets a verified, approved booking requester pay for their
 * booking without an account. Only SHA-256 token hashes are stored; the raw
 * token is emailed once. Every resolution path refuses politely without
 * leaking whether a token, booking, or request exists.
 *
 * This module is the link RECORD: token resolution, the refusal vocabulary and
 * the revocation helpers. The flows over it live beside it, one per
 * responsibility (#2956): `payment-link-context.ts` (what the public pay page
 * shows), `payment-link-intent.ts` (the Stripe intent a token may mint),
 * `payment-link-reissue.ts` (the expired-link "email me a fresh one" action)
 * and `payment-link-split-guest.ts` (the split non-member child's link). None
 * of those is imported here, so the family has no cycle.
 */
import { BookingStatus, Prisma } from "@prisma/client";
import { hashActionToken, isActionTokenFormat } from "@/lib/action-tokens";
import { prisma } from "@/lib/prisma";

/** A paid booking and a completed stay are both "already paid" for link purposes. */
const PAID_LIKE_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
];

export function isPaidLikeStatus(status: BookingStatus): boolean {
  return PAID_LIKE_STATUSES.includes(status);
}

/** Booking statuses a payment link can still pay for. */
const PAYMENT_LINK_PAYABLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
];

/** Whether a link can still pay for a booking in this status — the one home
 * for that test across the re-issue and intent paths (#2956, `INV-SSOT`). */
export function isPayableByLink(status: BookingStatus): boolean {
  return PAYMENT_LINK_PAYABLE_BOOKING_STATUSES.includes(status);
}

export class PaymentLinkError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PaymentLinkError";
    this.status = status;
  }
}

/*
  The payer-facing refusal vocabulary. One home (#2956, `INV-SSOT`): the sibling
  `payment-link-*` modules import these rather than spelling a second copy, so
  every path refuses in the same words.
*/
const INVALID_LINK_MESSAGE = "This payment link is not valid.";
const EXPIRED_LINK_MESSAGE =
  "This payment link has expired. Please contact the club if you still wish to pay for your stay.";
export const USED_LINK_MESSAGE = "This payment link has already been used.";
export const REVOKED_LINK_MESSAGE =
  "This payment link is no longer active. Please contact the club for help.";
export const NOT_PAYABLE_MESSAGE =
  "This booking can no longer be paid online. Please contact the club for help.";

type ResolvedPaymentLink = Prisma.PaymentLinkGetPayload<{
  include: {
    booking: {
      include: {
        member: true;
        guests: true;
        payment: true;
        groupBookingJoin: { select: { id: true } };
        lodge: { select: { name: true } };
      };
    };
  };
}>;

/**
 * Structural lookup of a payment link by raw token. Throws only for a token
 * that cannot map to a live booking (bad format, unknown token, soft-deleted
 * booking). The link may be revoked/used/expired and the booking may be in any
 * state — callers decide what to do with it. Used by the narrative context
 * path, which renders a clear message for every link/booking state rather than
 * a generic error.
 */
export async function loadPaymentLinkRecord(token: string): Promise<ResolvedPaymentLink> {
  const trimmed = token.trim();
  if (!isActionTokenFormat(trimmed)) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  const link = await prisma.paymentLink.findUnique({
    where: { tokenHash: hashActionToken(trimmed) },
    include: {
      booking: {
        include: {
          member: true,
          guests: true,
          payment: true,
          // #1967: lets link flows tell a genuine split child (#738) apart
          // from a #796 group joiner (which always has a join row).
          groupBookingJoin: { select: { id: true } },
          // #2919: the public pay page names the lodge the booking is actually
          // at. Name only - never the door code or travel note, which this
          // token-authenticated public surface has no business carrying.
          lodge: { select: { name: true } },
        },
      },
    },
  });

  if (!link || link.booking.deletedAt) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  return link;
}

// test seam
/**
 * Look up and validate a payment link by raw token for the payment path
 * (intent creation). Throws PaymentLinkError with a polite message for every
 * failure mode. Returns the link with its booking when the link is still
 * usable (the booking may already be paid/completed — callers handle that
 * explicitly). A paid or completed booking is treated alike (issue #740).
 */
export async function resolvePaymentLink(token: string): Promise<ResolvedPaymentLink> {
  const link = await loadPaymentLinkRecord(token);

  if (link.revokedAt) {
    throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
  }
  if (link.usedAt && !isPaidLikeStatus(link.booking.status)) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }
  if (link.expiresAt < new Date() && !isPaidLikeStatus(link.booking.status)) {
    throw new PaymentLinkError(EXPIRED_LINK_MESSAGE, 410);
  }

  return link;
}

/**
 * Revoke one specific payment link (by row id) if it is still unused and
 * unrevoked. Used by the mint-and-email flows when the post-commit email
 * fails or is suppressed: the raw token is unrecoverable, so the stale
 * sentinel must be cleared for the next run to re-mint and re-send. Scoped to
 * the id — never the whole booking — so a newer link minted concurrently by
 * another flow survives.
 */
export async function revokePaymentLinkById(
  paymentLinkId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { id: paymentLinkId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}

/** Revoke all active payment links for a booking (e.g. when it is bumped). */
export async function revokePaymentLinksForBooking(
  bookingId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}
