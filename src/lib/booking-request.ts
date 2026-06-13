/**
 * Public non-member booking request flow (issue #707).
 *
 * Lifecycle: NEW -> (email verification) -> VERIFIED -> (officer pricing)
 * -> PRICED -> (officer decision) -> APPROVED/DECLINED -> CONVERTED.
 *
 * Approval converts the request into a non-login Member (canLogin: false)
 * plus a PENDING Booking owned by it, mirroring the membership application
 * pattern in src/lib/nomination.ts. Booking.memberId stays required.
 *
 * Conventions:
 *   - money stays integer cents
 *   - booking dates stay NZ date-only values
 *   - only SHA-256 token hashes are stored (issueActionToken)
 *   - external calls (email) run after the transaction commits
 */
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingRequestStatus,
  BookingStatus,
  PaymentStatus,
  Prisma,
  type BookingRequest,
} from "@prisma/client";
import { z } from "zod";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import {
  sendAdminBookingRequestPendingEmail,
  sendBookingRequestApprovedEmail,
  sendBookingRequestDeclinedEmail,
  sendBookingRequestVerificationEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import {
  priceBookingGuests,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { prisma } from "@/lib/prisma";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";

export const BOOKING_REQUEST_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
/** Privacy Act 2020 retention: purge declined and never-verified requests. */
export const BOOKING_REQUEST_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export const bookingRequestGuestSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  ageTier: ageTierEnum,
});

export type BookingRequestGuest = z.infer<typeof bookingRequestGuestSchema>;

export class BookingRequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BookingRequestError";
    this.status = status;
  }
}

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

export function parseBookingRequestGuests(raw: unknown): BookingRequestGuest[] {
  const parsed = z.array(bookingRequestGuestSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError("Stored booking request guests are invalid", 500);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Settings (pricing visibility)
// ---------------------------------------------------------------------------

export async function getBookingRequestSettings(db: Pick<typeof prisma, "bookingRequestSettings"> = prisma) {
  const record = await db.bookingRequestSettings.findUnique({
    where: { id: "default" },
  });
  return {
    showPricingToNonMembers: record?.showPricingToNonMembers ?? false,
  };
}

export async function updateBookingRequestSettings(input: {
  showPricingToNonMembers: boolean;
  adminMemberId: string;
}) {
  const settings = await prisma.bookingRequestSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      showPricingToNonMembers: input.showPricingToNonMembers,
      updatedByMemberId: input.adminMemberId,
    },
    update: {
      showPricingToNonMembers: input.showPricingToNonMembers,
      updatedByMemberId: input.adminMemberId,
    },
  });

  logAudit({
    action: "booking_request.settings_updated",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    entityType: "BookingRequestSettings",
    entityId: "default",
    category: "admin",
    outcome: "success",
    summary: "Booking request pricing visibility updated",
    metadata: { showPricingToNonMembers: input.showPricingToNonMembers },
  });

  return { showPricingToNonMembers: settings.showPricingToNonMembers };
}

// ---------------------------------------------------------------------------
// Indicative non-member pricing
// ---------------------------------------------------------------------------

/**
 * Price a guest list at the public non-member rates for the given range.
 * Returns null when no active season covers the dates (no rate available).
 */
export async function calculateIndicativeNonMemberPriceCents(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
}): Promise<number | null> {
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: input.checkOut },
      endDate: { gte: input.checkIn },
    },
    include: { rates: true },
  });

  if (seasons.length === 0) {
    return null;
  }

  const price = priceBookingGuests({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: input.guests.map((guest) => ({
      ageTier: guest.ageTier,
      isMember: false,
    })),
    seasons: toSeasonRateData(seasons),
  });

  return price.totalPriceCents;
}

// ---------------------------------------------------------------------------
// Public submission + verification
// ---------------------------------------------------------------------------

export interface CreateBookingRequestInput {
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  guests: BookingRequestGuest[];
  message?: string | null;
}

/**
 * Create a NEW booking request and email the requester a verification link.
 * The request only enters the admin queue once the email is verified.
 */
export async function createBookingRequest(input: CreateBookingRequestInput) {
  const contactEmail = cleanString(input.contactEmail).toLowerCase();
  const contactFirstName = cleanString(input.contactFirstName);
  const contactLastName = cleanString(input.contactLastName);

  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError("Contact name and email are required", 422);
  }
  if (input.guests.length === 0) {
    throw new BookingRequestError("At least one guest is required", 422);
  }

  const settings = await getBookingRequestSettings();
  const indicativePriceCents = settings.showPricingToNonMembers
    ? await calculateIndicativeNonMemberPriceCents({
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        guests: input.guests,
      })
    : null;

  const { token, tokenHash } = issueActionToken();
  const verificationTokenExpiresAt = new Date(
    Date.now() + BOOKING_REQUEST_VERIFICATION_TTL_MS
  );

  const request = await prisma.bookingRequest.create({
    data: {
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: cleanNullableString(input.contactPhone),
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      message: cleanNullableString(input.message),
      indicativePriceCents,
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt,
    },
  });

  try {
    await sendBookingRequestVerificationEmail({
      email: contactEmail,
      firstName: contactFirstName,
      token,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guestCount: input.guests.length,
      expiresAt: verificationTokenExpiresAt,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send booking request verification email"
    );
  }

  logAudit({
    action: "booking_request.submitted",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Public booking request submitted",
    metadata: {
      checkIn: input.checkIn.toISOString(),
      checkOut: input.checkOut.toISOString(),
      guestCount: input.guests.length,
      indicativePriceCents,
      pricingShown: settings.showPricingToNonMembers,
    },
  });

  return request;
}

export type VerifyBookingRequestOutcome =
  | { outcome: "verified"; request: BookingRequest }
  | { outcome: "already_verified"; request: BookingRequest }
  | { outcome: "expired" }
  | { outcome: "invalid" };

/**
 * Verify the requester's email address from the emailed token. On first
 * verification the request moves NEW -> VERIFIED and lands in the admin queue.
 */
export async function verifyBookingRequest(
  token: string
): Promise<VerifyBookingRequestOutcome> {
  const tokenHash = hashActionToken(cleanString(token));

  const request = await prisma.bookingRequest.findUnique({
    where: { verificationTokenHash: tokenHash },
  });

  if (!request) {
    return { outcome: "invalid" };
  }

  if (request.status !== BookingRequestStatus.NEW) {
    return { outcome: "already_verified", request };
  }

  if (
    !request.verificationTokenExpiresAt ||
    request.verificationTokenExpiresAt < new Date()
  ) {
    return { outcome: "expired" };
  }

  const verifiedAt = new Date();
  // Status-claim: only one concurrent verification can flip NEW -> VERIFIED.
  const claimed = await prisma.bookingRequest.updateMany({
    where: { id: request.id, status: BookingRequestStatus.NEW },
    data: { status: BookingRequestStatus.VERIFIED, verifiedAt },
  });

  if (claimed.count === 0) {
    const latest = await prisma.bookingRequest.findUnique({
      where: { id: request.id },
    });
    return latest
      ? { outcome: "already_verified", request: latest }
      : { outcome: "invalid" };
  }

  const updated = { ...request, status: BookingRequestStatus.VERIFIED, verifiedAt };

  logAudit({
    action: "booking_request.verified",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Booking request email verified",
  });

  sendAdminBookingRequestPendingEmail({
    requesterName: `${request.contactFirstName} ${request.contactLastName}`,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guestCount: parseBookingRequestGuests(request.guests).length,
  }).catch((err) =>
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send admin booking request alert"
    )
  );

  return { outcome: "verified", request: updated };
}

// ---------------------------------------------------------------------------
// Officer pricing and decisions
// ---------------------------------------------------------------------------

/** Set or override the officer price on a verified request. */
export async function priceBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  priceCents: number;
}) {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new BookingRequestError("Price must be a non-negative whole number of cents", 422);
  }

  const pricedAt = new Date();
  const existing = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!existing) {
    throw new BookingRequestError("Booking request not found", 404);
  }

  const claimed = await prisma.bookingRequest.updateMany({
    where: {
      id: input.requestId,
      status: {
        in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
      },
    },
    data: {
      status: BookingRequestStatus.PRICED,
      priceCents: input.priceCents,
      pricedByMemberId: input.adminMemberId,
      pricedAt,
    },
  });

  if (claimed.count === 0) {
    throw new BookingRequestError(
      "Only verified booking requests can be priced",
      409
    );
  }

  logAudit({
    action: "booking_request.priced",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Booking request priced by officer",
    metadata: {
      priceCents: input.priceCents,
      previousPriceCents: existing.priceCents,
      indicativePriceCents: existing.indicativePriceCents,
    },
  });

  return prisma.bookingRequest.findUnique({ where: { id: input.requestId } });
}

/** Decline a verified or priced request and email the requester. */
export async function declineBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  reason?: string | null;
}) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }

  const reviewedAt = new Date();
  const declineReason = cleanNullableString(input.reason);
  const claimed = await prisma.bookingRequest.updateMany({
    where: {
      id: input.requestId,
      status: {
        in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
      },
    },
    data: {
      status: BookingRequestStatus.DECLINED,
      reviewedByMemberId: input.adminMemberId,
      reviewedAt,
      declineReason,
    },
  });

  if (claimed.count === 0) {
    throw new BookingRequestError(
      "Only verified or priced booking requests can be declined",
      409
    );
  }

  try {
    await sendBookingRequestDeclinedEmail({
      email: request.contactEmail,
      firstName: request.contactFirstName,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      reason: declineReason,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send booking request declined email"
    );
  }

  logAudit({
    action: "booking_request.declined",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Booking request declined",
    metadata: { reason: declineReason },
  });

  return prisma.bookingRequest.findUnique({ where: { id: input.requestId } });
}

// ---------------------------------------------------------------------------
// Approval conversion
// ---------------------------------------------------------------------------

export type ApproveBookingRequestOutcome =
  | {
      type: "approved";
      requestId: string;
      bookingId: string;
      memberId: string;
      priceCents: number;
      paymentLinkExpiresAt: Date;
    }
  | { type: "capacityExceeded"; fullNights: string[] };

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

/**
 * Split the officer-set total across the guest rows in integer cents.
 * The remainder goes to the first guest so the rows always sum exactly.
 */
export function splitPriceAcrossGuests(totalCents: number, guestCount: number): number[] {
  if (guestCount <= 0) return [];
  const base = Math.floor(totalCents / guestCount);
  const remainder = totalCents - base * guestCount;
  return Array.from({ length: guestCount }, (_, index) =>
    index === 0 ? base + remainder : base
  );
}

/**
 * Resolve when the booking's non-member hold expires. Member-priority
 * bumping applies until the requester pays. Late approvals still get at
 * least 48 hours to pay, but never beyond check-in.
 */
export function resolveRequestBookingHoldUntil(
  checkIn: Date,
  holdDays: number,
  now: Date = new Date()
): Date {
  const standardHold = new Date(checkIn.getTime() - holdDays * DAY_MS);
  const minimumHold = new Date(now.getTime() + 2 * DAY_MS);
  const hold = standardHold > minimumHold ? standardHold : minimumHold;
  return hold > checkIn ? checkIn : hold;
}

/**
 * Approve a PRICED request: in a single transaction under the booking
 * advisory lock, create the non-login Member, the PENDING Booking with
 * capacity checking, the PENDING Payment, and the tokenised PaymentLink.
 * The payment link email is sent after commit.
 */
export async function approveBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
}): Promise<ApproveBookingRequestOutcome> {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  if (request.status !== BookingRequestStatus.PRICED) {
    throw new BookingRequestError(
      "Only priced booking requests can be approved",
      409
    );
  }
  if (request.priceCents == null) {
    throw new BookingRequestError(
      "A price must be set before the request can be approved",
      409
    );
  }

  const guests = parseBookingRequestGuests(request.guests);
  const priceCents = request.priceCents;

  // Non-login members never authenticate; store a random bcrypt hash so the
  // row satisfies the schema without any usable credential.
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const holdDays = await getNonMemberHoldDays(request.checkIn);
  const reviewedAt = new Date();
  const nonMemberHoldUntil = resolveRequestBookingHoldUntil(
    request.checkIn,
    holdDays,
    reviewedAt
  );
  // The payment link stays valid while the booking remains payable; the
  // hard ceiling is check-in. Booking status checks gate actual payment.
  const paymentLinkExpiresAt = request.checkIn;
  const { token: paymentToken, tokenHash: paymentTokenHash } = issueActionToken();

  let capacityFullNights: string[] | null = null;
  let conversion: {
    bookingId: string;
    memberId: string;
  };

  try {
    conversion = await prisma.$transaction(async (tx) => {
      // Single advisory lock serialises ALL booking creation paths so the
      // capacity check below stays safe (same key as booking-create.ts).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      // Status-claim so two admins cannot approve concurrently.
      const claimed = await tx.bookingRequest.updateMany({
        where: { id: request.id, status: BookingRequestStatus.PRICED },
        data: {
          status: BookingRequestStatus.APPROVED,
          reviewedByMemberId: input.adminMemberId,
          reviewedAt,
        },
      });
      if (claimed.count === 0) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      const capacityRanges = guests.map(() => ({
        stayStart: request.checkIn,
        stayEnd: request.checkOut,
      }));
      const capacity = await checkCapacityForGuestRanges(
        request.checkIn,
        request.checkOut,
        capacityRanges,
        undefined,
        tx
      );
      if (!capacity.available) {
        capacityFullNights = getCapacityFullNights(capacity.nightDetails);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      // Mirror approveMemberApplication(): a non-login member owns the
      // booking. emailVerified is true because the address was verified in
      // the request flow before it entered the queue.
      const member = await tx.member.create({
        data: {
          email: request.contactEmail,
          passwordHash: placeholderPasswordHash,
          emailVerified: true,
          firstName: request.contactFirstName,
          lastName: request.contactLastName,
          role: "MEMBER",
          ageTier: AgeTier.ADULT,
          active: true,
          canLogin: false,
          phoneNumber: request.contactPhone,
        },
        select: { id: true },
      });

      const guestPriceCents = splitPriceAcrossGuests(priceCents, guests.length);
      const booking = await tx.booking.create({
        data: {
          memberId: member.id,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          status: BookingStatus.PENDING,
          totalPriceCents: priceCents,
          finalPriceCents: priceCents,
          hasNonMembers: true,
          nonMemberHoldUntil,
          notes: request.message,
          createdById: input.adminMemberId,
          guests: {
            create: guests.map((guest, index) => ({
              firstName: guest.firstName,
              lastName: guest.lastName,
              ageTier: guest.ageTier,
              isMember: false,
              stayStart: request.checkIn,
              stayEnd: request.checkOut,
              priceCents: guestPriceCents[index],
            })),
          },
        },
        select: { id: true },
      });

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amountCents: priceCents,
          status: PaymentStatus.PENDING,
        },
      });

      await tx.paymentLink.create({
        data: {
          bookingId: booking.id,
          bookingRequestId: request.id,
          tokenHash: paymentTokenHash,
          expiresAt: paymentLinkExpiresAt,
        },
      });

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: booking.id,
          convertedMemberId: member.id,
        },
      });

      return { bookingId: booking.id, memberId: member.id };
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "CAPACITY_EXCEEDED_SENTINEL" &&
      capacityFullNights
    ) {
      return { type: "capacityExceeded", fullNights: capacityFullNights };
    }
    throw err;
  }

  try {
    await sendBookingRequestApprovedEmail({
      email: request.contactEmail,
      firstName: request.contactFirstName,
      token: paymentToken,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      guestCount: guests.length,
      priceCents,
      bookingReference: conversion.bookingId,
      expiresAt: paymentLinkExpiresAt,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id, bookingId: conversion.bookingId },
      "Failed to send booking request approved email"
    );
  }

  logAudit({
    action: "booking_request.approved",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    subjectMemberId: conversion.memberId,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Booking request approved and converted to booking",
    metadata: {
      bookingId: conversion.bookingId,
      memberId: conversion.memberId,
      priceCents,
      guestCount: guests.length,
      checkIn: request.checkIn.toISOString(),
      checkOut: request.checkOut.toISOString(),
      nonMemberHoldUntil: nonMemberHoldUntil.toISOString(),
      paymentLinkExpiresAt: paymentLinkExpiresAt.toISOString(),
    },
  });

  return {
    type: "approved",
    requestId: request.id,
    bookingId: conversion.bookingId,
    memberId: conversion.memberId,
    priceCents,
    paymentLinkExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Privacy Act retention purge
// ---------------------------------------------------------------------------

/**
 * Permanently delete declined and never-verified requests once the
 * retention window has passed (Privacy Act 2020 — personal information
 * may only be kept while there is a lawful purpose).
 */
export async function purgeExpiredBookingRequests(
  now: Date = new Date(),
  db: Pick<typeof prisma, "bookingRequest"> = prisma
) {
  const cutoff = new Date(now.getTime() - BOOKING_REQUEST_RETENTION_DAYS * DAY_MS);

  const [declined, neverVerified] = await Promise.all([
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.DECLINED,
        updatedAt: { lte: cutoff },
      },
    }),
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.NEW,
        verifiedAt: null,
        createdAt: { lte: cutoff },
      },
    }),
  ]);

  if (declined.count > 0 || neverVerified.count > 0) {
    logAudit({
      action: "booking_request.retention_purge",
      category: "privacy",
      outcome: "success",
      summary: "Expired booking requests purged per retention policy",
      metadata: {
        declinedPurged: declined.count,
        neverVerifiedPurged: neverVerified.count,
        retentionDays: BOOKING_REQUEST_RETENTION_DAYS,
      },
    });
  }

  return {
    declinedPurged: declined.count,
    neverVerifiedPurged: neverVerified.count,
  };
}

// ---------------------------------------------------------------------------
// Admin queue serialisation
// ---------------------------------------------------------------------------

export type AdminBookingRequestStatusFilter =
  | BookingRequestStatus
  | "QUEUE"
  | "ALL";

export function buildBookingRequestListWhere(
  filter: AdminBookingRequestStatusFilter
): Prisma.BookingRequestWhereInput | undefined {
  if (filter === "ALL") return undefined;
  if (filter === "QUEUE") {
    return {
      status: {
        in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
      },
    };
  }
  return { status: filter };
}

export function serializeBookingRequestForAdmin(request: BookingRequest) {
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    contactFirstName: request.contactFirstName,
    contactLastName: request.contactLastName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    checkIn: request.checkIn.toISOString(),
    checkOut: request.checkOut.toISOString(),
    guests: parseBookingRequestGuests(request.guests),
    message: request.message,
    indicativePriceCents: request.indicativePriceCents,
    priceCents: request.priceCents,
    verifiedAt: request.verifiedAt?.toISOString() ?? null,
    pricedAt: request.pricedAt?.toISOString() ?? null,
    pricedByMemberId: request.pricedByMemberId,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewedByMemberId: request.reviewedByMemberId,
    declineReason: request.declineReason,
    convertedBookingId: request.convertedBookingId,
    convertedMemberId: request.convertedMemberId,
    createdAt: request.createdAt.toISOString(),
  };
}
