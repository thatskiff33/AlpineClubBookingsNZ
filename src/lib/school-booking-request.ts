/**
 * School group booking request variant (issue #709).
 *
 * Built on the #707 `BookingRequest` infrastructure rather than a parallel
 * intake: a SCHOOL request reuses the same email-verification step and admin
 * queue. The differences live here.
 *
 * Locked decisions:
 *   - The booking confirms at approval (CONFIRMED, capacity held) and flips to
 *     PAID when the Xero invoice is paid. CONFIRMED holds capacity via
 *     CAPACITY_HOLDING_BOOKING_STATUSES (src/lib/booking-status.ts).
 *   - The school is the invoiced party / Xero contact. The booking is owned by
 *     a non-login Member named after the school (canLogin: false), mirroring
 *     the xero-member-import pattern. The teacher(s) become separate non-login
 *     Members with a HutLeaderAssignment and PIN email.
 *   - Pay-on-account uses the existing INTERNET_BANKING payment source so the
 *     existing line-item builder emails the invoice and the existing inbound
 *     reconciliation marks the booking PAID when the invoice is paid. No new
 *     tax logic is introduced.
 *
 * Conventions: money stays integer cents, booking dates stay NZ date-only,
 * only SHA-256 token hashes are stored, and external calls (email, Xero outbox)
 * run after the transaction commits.
 */
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  Prisma,
  SchoolCateringPreference,
} from "@prisma/client";
import { z } from "zod";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { issueActionToken } from "@/lib/action-tokens";
import { createAuditLog, logAudit } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";
import {
  MAX_AUDITED_PRUNED_ALLOCATIONS,
  reconcileBedAllocationsForBooking,
} from "@/lib/bed-allocation-lifecycle";
import {
  assertMappableOwnerContact,
  BOOKING_REQUEST_VERIFICATION_TTL_MS,
  BookingRequestError,
  linkedGuestMemberMap,
  parseBookingRequestGuests,
  reassignHeldBookingGuests,
  splitPriceAcrossGuests,
  type BookingRequestGuest,
} from "@/lib/booking-request";
import {
  buildApprovalGuestCreates,
  claimAlreadyConvertedBookingRequest,
  getCapacityFullNights,
  sendOwnerSubstitutionAdminAlert,
  type OwnerSubstitution,
} from "@/lib/booking-request-shared";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
  findOverlappingCapacityHoldingBookings,
  type HoldConflictBooking,
} from "@/lib/capacity";
import {
  sendAdminSchoolManualInvoiceEmail,
  sendBookingRequestVerificationEmail,
  sendHutLeaderAssignmentEmail,
} from "@/lib/email";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { generateHutLeaderPin, hashHutLeaderPin } from "@/lib/lodge-pin-session";
import logger from "@/lib/logger";
import {
  priceBookingGuests,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import type { PriceBreakdown } from "@/lib/policies/pricing";
import {
  resolveGroupDiscountRateType,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";
import { getSeasonYear } from "@/lib/utils";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { nameField } from "@/lib/zod-helpers";

/** Age tiers a school can request counts for. Teachers are always ADULT. */
const SCHOOL_CHILD_TIERS = [
  AgeTier.INFANT,
  AgeTier.CHILD,
  AgeTier.YOUTH,
] as const;

/** Display name prefix for the generated bulk child guests. */
const SCHOOL_CHILD_NAME_PREFIX = "School Child";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export const schoolTeacherSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  // PIN email goes here when present; otherwise it falls back to the school
  // contact email at approval time.
  email: z.string().email().max(200).optional().nullable(),
});

type SchoolTeacherInput = z.infer<typeof schoolTeacherSchema>;

export const schoolChildCountsSchema = z.object({
  INFANT: z.number().int().min(0).max(200).optional(),
  CHILD: z.number().int().min(0).max(200).optional(),
  YOUTH: z.number().int().min(0).max(200).optional(),
});

type SchoolChildCounts = z.infer<typeof schoolChildCountsSchema>;

interface CreateSchoolBookingRequestInput {
  schoolName: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  teachers: SchoolTeacherInput[];
  childCounts: SchoolChildCounts;
  cateringPreference: SchoolCateringPreference;
  message?: string | null;
  /**
   * The requester asked for sole (whole-lodge) occupancy for their group
   * (issue #121, ADR-001). Persisted to BookingRequest.exclusivityRequested;
   * an admin approving the request may set Booking.wholeLodgeHold from it. It
   * is a request, not a guarantee — the school booking-request path is the only
   * requester front-door for exclusivity (owner decision, 2026-07-14).
   */
  exclusivityRequested?: boolean;
  /**
   * Lodge the stay is requested at. Callers must validate it names an ACTIVE
   * lodge (assertRequestedLodgeActive). Null/omitted means the club's default
   * lodge (BookingRequest.lodgeId null semantics).
   */
  lodgeId?: string | null;
}

interface StoredTeacher {
  firstName: string;
  lastName: string;
  email: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers (kept local to avoid cross-module coupling)
// ---------------------------------------------------------------------------

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  return cleanString(value) || null;
}

/**
 * Build the bulk guest list: teachers as named ADULT guests, then children
 * numbered "School Child 1..N" across the requested age tiers.
 */
export function generateSchoolGuests(input: {
  teachers: Array<{ firstName: string; lastName: string }>;
  childCounts: SchoolChildCounts;
}): BookingRequestGuest[] {
  const teacherGuests: BookingRequestGuest[] = input.teachers.map((teacher) => ({
    firstName: teacher.firstName,
    lastName: teacher.lastName,
    ageTier: AgeTier.ADULT,
  }));

  const childGuests: BookingRequestGuest[] = [];
  let childNumber = 0;
  for (const tier of SCHOOL_CHILD_TIERS) {
    const count = input.childCounts[tier] ?? 0;
    for (let i = 0; i < count; i += 1) {
      childNumber += 1;
      childGuests.push({
        firstName: SCHOOL_CHILD_NAME_PREFIX,
        lastName: String(childNumber),
        ageTier: tier,
      });
    }
  }

  return [...teacherGuests, ...childGuests];
}

function parseSchoolTeachers(raw: unknown): StoredTeacher[] {
  const parsed = z.array(schoolTeacherSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError("Stored school teachers are invalid", 500);
  }
  return parsed.data.map((teacher) => ({
    firstName: teacher.firstName,
    lastName: teacher.lastName,
    email: teacher.email ? teacher.email.toLowerCase() : null,
  }));
}

// ---------------------------------------------------------------------------
// Pricing (non-member rates + group discount where eligible)
// ---------------------------------------------------------------------------

/**
 * Price the school guest list at non-member rates, applying the group discount
 * per GroupDiscountSetting where eligible. Returns null when no active season
 * covers the dates (so the officer must price manually before approving).
 */
async function priceSchoolGuests(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
  /** Requested lodge; null/omitted prices against the club's default lodge. */
  lodgeId?: string | null;
}): Promise<PriceBreakdown | null> {
  const requestLodgeId = input.lodgeId ?? (await getDefaultLodgeId(prisma));
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: input.checkOut },
      endDate: { gte: input.checkIn },
      ...lodgeNullTolerantScope(requestLodgeId),
    },
    include: { membershipTypeRates: true },
  });

  if (seasons.length === 0) {
    return null;
  }

  const groupDiscountSetting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  // School requests are non-member (NON_MEMBER_DEFAULT); resolve the rate
  // membership type so pricing keys on the NON_MEMBER type (#1930, E4).
  const ratedGuests = await resolveGuestRateMembershipTypes(prisma, {
    seasonYear: getSeasonYear(input.checkIn),
    guests: input.guests.map((guest) => ({
      ageTier: guest.ageTier,
      isMember: false,
    })),
  });

  return priceBookingGuests({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: ratedGuests,
    seasons: toSeasonRateData(seasons),
    // NULL substitution target (row created post-migration) resolves to the
    // built-in FULL type so the discount is never silently inert (#1930, E4).
    groupDiscount: await resolveGroupDiscountRateType(
      prisma,
      toGroupDiscountConfig(groupDiscountSetting),
    ),
  });
}

async function calculateSchoolIndicativePriceCents(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
  lodgeId?: string | null;
}): Promise<number | null> {
  const price = await priceSchoolGuests(input);
  return price ? price.totalPriceCents : null;
}

// ---------------------------------------------------------------------------
// Public submission
// ---------------------------------------------------------------------------

/**
 * Create a NEW SCHOOL booking request and email the contact a verification
 * link. The request only enters the admin queue once the email is verified
 * (inherited from #707 via verifyBookingRequest).
 */
export async function createSchoolBookingRequest(
  input: CreateSchoolBookingRequestInput
) {
  const schoolName = cleanString(input.schoolName);
  const contactEmail = cleanString(input.contactEmail).toLowerCase();
  const contactFirstName = cleanString(input.contactFirstName);
  const contactLastName = cleanString(input.contactLastName);

  if (!schoolName) {
    throw new BookingRequestError("School name is required", 422);
  }
  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError("Contact name and email are required", 422);
  }

  const teachers: StoredTeacher[] = input.teachers
    .map((teacher) => ({
      firstName: cleanString(teacher.firstName),
      lastName: cleanString(teacher.lastName),
      email: teacher.email ? cleanString(teacher.email).toLowerCase() : null,
    }))
    .filter((teacher) => teacher.firstName && teacher.lastName);

  if (teachers.length === 0) {
    throw new BookingRequestError(
      "At least one teacher attending is required",
      422
    );
  }

  const guests = generateSchoolGuests({ teachers, childCounts: input.childCounts });
  if (guests.length === 0) {
    throw new BookingRequestError("At least one guest is required", 422);
  }

  const requestedLodgeId = input.lodgeId ?? null;
  const lodgeCapacity = requestedLodgeId
    ? await getLodgeCapacity(requestedLodgeId)
    : await getDefaultLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    throw new BookingRequestError(
      `A school booking cannot exceed the lodge capacity of ${lodgeCapacity} guests`,
      422
    );
  }

  const indicativePriceCents = await calculateSchoolIndicativePriceCents({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests,
    lodgeId: requestedLodgeId,
  });

  const { token, tokenHash } = issueActionToken();
  const verificationTokenExpiresAt = new Date(
    Date.now() + BOOKING_REQUEST_VERIFICATION_TTL_MS
  );

  const request = await prisma.bookingRequest.create({
    data: {
      type: BookingRequestType.SCHOOL,
      schoolName,
      teachers: teachers as unknown as Prisma.InputJsonValue,
      cateringPreference: input.cateringPreference,
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: cleanNullableString(input.contactPhone),
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests,
      message: cleanNullableString(input.message),
      indicativePriceCents,
      lodgeId: requestedLodgeId,
      // Whole-lodge exclusivity request (issue #121). Only ever set on the
      // school front-door; approval may translate it into a Booking.wholeLodgeHold.
      exclusivityRequested: Boolean(input.exclusivityRequested),
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt,
    },
  });

  try {
    await sendBookingRequestVerificationEmail({
      // A school request has no booking until it is approved (#2258).
      bookingContext: "none",
      email: contactEmail,
      firstName: contactFirstName,
      token,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guestCount: guests.length,
      expiresAt: verificationTokenExpiresAt,
      lodgeId: input.lodgeId ?? null,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send school booking request verification email"
    );
  }

  logAudit({
    action: "booking_request.school_submitted",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "School booking request submitted",
    metadata: {
      schoolName,
      checkIn: input.checkIn.toISOString(),
      checkOut: input.checkOut.toISOString(),
      guestCount: guests.length,
      teacherCount: teachers.length,
      indicativePriceCents,
      lodgeId: requestedLodgeId,
      exclusivityRequested: Boolean(input.exclusivityRequested),
    },
  });

  return request;
}

// ---------------------------------------------------------------------------
// Approval conversion
// ---------------------------------------------------------------------------

type ApproveSchoolBookingRequestOutcome =
  | {
      type: "approved";
      requestId: string;
      bookingId: string;
      schoolMemberId: string;
      priceCents: number;
      invoiceMode: "xero" | "manual";
      teacherCount: number;
      /**
       * Existing capacity-holding bookings that overlap the approved booking's
       * nights when an exclusive whole-lodge hold was set at approval
       * (exclusivityRequested; issue #119). Informational — decision 1 never
       * refuses or displaces; the officer resolves them. Empty when no hold was
       * set or the nights are clear.
       */
      exclusiveHoldConflicts: HoldConflictBooking[];
    }
  | { type: "capacityExceeded"; fullNights: string[] };

interface TeacherCreationPlan {
  teacher: StoredTeacher;
  email: string;
  pin: string;
  hutLeaderPin: string;
}

/**
 * Approve a verified (or priced) SCHOOL request. In a single transaction under
 * the lodge capacity lock (and, when converting an existing hold, the global
 * lifecycle lock first): create the non-login school Member, a CONFIRMED
 * Booking that holds capacity, a PENDING INTERNET_BANKING Payment, the bulk
 * guests, and a non-login Member + HutLeaderAssignment per teacher. After the
 * commit, queue the Xero invoice (emailed to the school) or, when the Xero
 * module is off, notify admins to invoice manually; PIN emails are sent to the
 * teachers.
 */
export async function approveSchoolBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  /**
   * Optional admin override of the bulk child counts at approval time. The
   * named teachers/parent helpers are preserved; the children are regenerated
   * from these counts, then the booking is repriced and capacity re-checked
   * against the new list. Leave unset to use the submitted guest list as-is.
   */
  guestOverride?: { childCounts: SchoolChildCounts };
  /**
   * Optional existing non-login contact to own the confirmed booking and be the
   * invoiced Xero party (issue #1255). When set, the school booking is attached
   * to this contact instead of creating a new SCHOOL member — reusing its Xero
   * contact so a repeat school does not spawn a duplicate. Per-teacher records
   * are always created fresh (each needs its own HutLeaderAssignment + PIN).
   * Only honoured when the owner has not already been materialised by a capacity
   * hold; ignored on the held-booking reuse path.
   */
  ownerContactMemberId?: string | null;
}): Promise<ApproveSchoolBookingRequestOutcome> {
  const initialRequest = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!initialRequest) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  let request = initialRequest;
  if (request.type !== BookingRequestType.SCHOOL) {
    throw new BookingRequestError("This is not a school booking request", 400);
  }
  if (
    request.status !== BookingRequestStatus.VERIFIED &&
    request.status !== BookingRequestStatus.PRICED
  ) {
    throw new BookingRequestError(
      "Only verified school booking requests can be approved",
      409
    );
  }

  // A held booking has already materialised the request's null/default lodge
  // semantics into an immutable concrete Booking.lodgeId. Read only that lock
  // key before the transaction; the full request and booking are re-read after
  // global -> lodge locks below. Fresh-create approvals need no extra lookup.
  const expectedHeldBookingId = request.heldBookingId ?? null;
  const heldLodgeLocator = expectedHeldBookingId
    ? await prisma.booking.findUnique({
        where: { id: expectedHeldBookingId },
        select: { lodgeId: true },
      })
    : null;
  if (expectedHeldBookingId && !heldLodgeLocator) {
    throw new BookingRequestError("Held booking was not found", 409);
  }
  const expectedHeldLodgeId = heldLodgeLocator?.lodgeId ?? null;
  const approvalLodgeId = expectedHeldLodgeId ?? request.lodgeId ?? null;

  const teachers = parseSchoolTeachers(request.teachers);
  const linkedMembers = linkedGuestMemberMap(request.linkedGuestMembers);
  // When the admin varies the quantity, regenerate the guest list from the
  // preserved teachers + the new child counts; otherwise use the submitted
  // snapshot. The new list then drives pricing, capacity and the booking below.
  const guests = input.guestOverride
    ? generateSchoolGuests({
        teachers,
        childCounts: input.guestOverride.childCounts,
      })
    : parseBookingRequestGuests(request.guests);
  if (guests.length === 0) {
    throw new BookingRequestError("At least one guest is required", 422);
  }
  if (input.guestOverride) {
    const lodgeCapacity = approvalLodgeId
      ? await getLodgeCapacity(approvalLodgeId)
      : await getDefaultLodgeCapacity();
    if (guests.length > lodgeCapacity) {
      throw new BookingRequestError(
        `A school booking cannot exceed the lodge capacity of ${lodgeCapacity} guests`,
        422
      );
    }
  }
  const schoolName =
    request.schoolName ?? `${request.contactFirstName} ${request.contactLastName}`;

  // Resolve the total and the per-guest split. An officer-set price overrides
  // the computed price and is split evenly; otherwise per-guest engine prices
  // (which reflect tier rates and the group discount) drive accurate invoice
  // line items.
  const price = await priceSchoolGuests({
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests,
    lodgeId: approvalLodgeId,
  });

  let totalPriceCents: number;
  let guestPriceCents: number[];
  if (request.priceCents != null) {
    totalPriceCents = request.priceCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else if (price && price.guests.length === guests.length) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = price.guests.map((guest) => guest.priceCents);
  } else if (price) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else {
    throw new BookingRequestError(
      "Cannot price this school booking: no active season covers the requested dates. Set a price before approving.",
      409
    );
  }

  // Non-login members never authenticate; store a random bcrypt hash so the
  // row satisfies the schema without any usable credential. Generate teacher
  // PINs (and their hashes) before the transaction so the plaintext PIN can be
  // emailed after commit while only the hash is persisted.
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const teacherPlans: TeacherCreationPlan[] = await Promise.all(
    teachers.map(async (teacher) => {
      const pin = generateHutLeaderPin();
      return {
        teacher,
        email: teacher.email || request.contactEmail,
        pin,
        hutLeaderPin: await hashHutLeaderPin(pin),
      };
    })
  );

  const reviewedAt = new Date();

  // Whole-lodge exclusivity (issue #121, ADR-001): when the request asked for
  // sole occupancy, stamp the resulting booking's authoritative hold flag at
  // approval. Stamped by the approving admin, since the admin is the actor who
  // grants exclusivity (a member request only records the ASK). ADR-001
  // decision 1: NO empty-lodge precondition — the hold is set regardless of any
  // existing overlapping bookings; conflicts are surfaced/resolved by the
  // officer, not auto-displaced. Spread into both the fresh-create and
  // held-booking conversion branches below.
  const exclusiveHoldData = request.exclusivityRequested
    ? {
        wholeLodgeHold: true,
        wholeLodgeHoldAt: reviewedAt,
        wholeLodgeHoldByMemberId: input.adminMemberId,
      }
    : {};

  let capacityFullNights: string[] | null = null;
  let conversion: {
    bookingId: string;
    lodgeId: string;
    schoolMemberId: string;
    teacherAssignments: Array<{
      memberId: string;
      assignmentId: string;
      email: string;
      firstName: string;
      pin: string;
    }>;
    ownerSubstitution:
      | { invalidMemberId: string; substituteMemberId: string; reason: string }
      | null;
    alreadyConverted: boolean;
  };

  try {
    conversion = await prisma.$transaction(async (tx) => {
      // A held conversion is both a lifecycle transition (the same
      // AWAITING_REVIEW row can be cancelled/released) and a capacity write.
      // Compose the canonical locks in global -> lodge order so approval
      // cannot resurrect a hold that a global-lock cancellation just won.
      // A fresh approval creates a new booking and therefore remains
      // lodge-only; do not unnecessarily serialise unrelated lodges.
      if (expectedHeldBookingId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      }

      // Held reuse locks the concrete lodge stamped onto the booking when the
      // hold was created. A null request lodge must not be re-resolved through
      // a default that may have changed since then. Fresh creation continues
      // to resolve the request/default lodge normally.
      const bookingLodgeId = expectedHeldBookingId
        ? expectedHeldLodgeId!
        : request.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      const lockedRequest = await tx.bookingRequest.findUnique({
        where: { id: request.id },
      });
      if (!lockedRequest) {
        throw new BookingRequestError("Booking request not found", 404);
      }

      // A concurrent successful approval legitimately changes updatedAt (and
      // may change the held pointer). Recognise its durable converted ids under
      // the locks before applying the stale-snapshot fence, so a valid double
      // approval replays the committed conversion rather than returning 409.
      const committedConversion = await claimAlreadyConvertedBookingRequest(
        tx,
        request.id
      );
      if (committedConversion) {
        return {
          bookingId: committedConversion.convertedBookingId,
          lodgeId: bookingLodgeId,
          schoolMemberId: committedConversion.convertedMemberId,
          teacherAssignments: [],
          ownerSubstitution: null,
          alreadyConverted: true as const,
        };
      }

      // Any edit to the approval snapshot (including attaching/detaching a
      // hold) increments version (#1923). Refuse this stale attempt so every
      // value used below was validated under the locks; the caller can retry
      // from the new request state. The explicit held-id comparison also
      // documents the global-lock decision instead of relying on the counter
      // alone. Version replaces the former updatedAt comparison, whose
      // TIMESTAMP(3) precision could collide for two same-millisecond writes.
      if (
        lockedRequest.version !== request.version ||
        (lockedRequest.heldBookingId ?? null) !== expectedHeldBookingId
      ) {
        throw new BookingRequestError(
          "This booking request changed while it was being approved; review it and try again",
          409
        );
      }
      request = lockedRequest;

      if (
        request.type !== BookingRequestType.SCHOOL ||
        (request.status !== BookingRequestStatus.VERIFIED &&
          request.status !== BookingRequestStatus.PRICED)
      ) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      // Re-read the complete held booking only after global -> concrete-lodge
      // locks. Its lodge identity must match the immutable locator used for the
      // lock; an explicit request lodge must also name that same lodge.
      let held: {
        id: string;
        lodgeId: string;
        memberId: string;
        status: BookingStatus;
      } | null = null;
      if (request.heldBookingId) {
        held = await tx.booking.findUnique({
          where: { id: request.heldBookingId },
          select: { id: true, lodgeId: true, memberId: true, status: true },
        });
        if (!held || held.status !== BookingStatus.AWAITING_REVIEW) {
          throw new BookingRequestError("Held booking is no longer available", 409);
        }
        if (
          held.lodgeId !== bookingLodgeId ||
          (request.lodgeId != null && request.lodgeId !== held.lodgeId)
        ) {
          throw new BookingRequestError(
            "Held booking lodge no longer matches this booking request",
            409
          );
        }
      }

      // Status-claim so two admins cannot approve concurrently.
      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: request.id,
          // Optimistic version fence for mutable price/guest/hold state (#1923):
          // a writer that lands after the locked re-read cannot be silently
          // overwritten by an approval built from the older snapshot. Fences on
          // the integer version, not updatedAt (millisecond-collidable).
          version: request.version,
          status: {
            in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
          },
        },
        data: {
          status: BookingRequestStatus.APPROVED,
          reviewedByMemberId: input.adminMemberId,
          reviewedAt,
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      // Claim the freshly-read held booking before guest/capacity/member/payment
      // work. The guarded
      // AWAITING_REVIEW -> CONFIRMED transition is the winning lifecycle CAS;
      // count=0 means cancellation/release won, so the transaction aborts and
      // no post-commit audit, invoice, or email can run.
      if (held) {
        const heldClaim = await tx.booking.updateMany({
          where: { id: held.id, status: BookingStatus.AWAITING_REVIEW },
          data: { status: BookingStatus.CONFIRMED },
        });
        if (heldClaim.count === 0) {
          throw new BookingRequestError("Held booking is no longer available", 409);
        }
      }

      const guestCreates = await buildApprovalGuestCreates(tx, {
        guests,
        linkedMembers,
        guestPriceCents,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        adminMemberId: input.adminMemberId,
        heldBookingId: request.heldBookingId ?? null,
      });

      let booking: { id: string };
      let schoolMember: { id: string };
      // Set when the held school owner failed re-validation at conversion and a
      // fresh contact was substituted (issue #1255 residual-risk decision 1);
      // drives a post-commit admin alert.
      let ownerSubstitution: OwnerSubstitution | null = null;

      if (held) {
        // Re-validate the held school owner at conversion (issue #1255
        // residual-risk decision 1). If it had been MAPPED to a pre-existing
        // contact, that contact could have changed state during the
        // quote→accept window (login enabled, archived, deactivated, role
        // changed). If it is no longer a valid non-login booking contact, DO NOT
        // fail the accept: fall back to a fresh non-login SCHOOL contact (the
        // pre-#1255 default owner) and flag an admin. Auto-created owners always
        // pass, so this is a no-op except for a changed-state mapped contact.
        let ownerId = held.memberId;
        try {
          await assertMappableOwnerContact(tx, held.memberId);
        } catch (err) {
          if (!(err instanceof BookingRequestError)) throw err;
          const substitute = await tx.member.create({
            data: {
              email: request.contactEmail,
              passwordHash: placeholderPasswordHash,
              emailVerified: true,
              firstName: schoolName.slice(0, 100),
              lastName: "",
              role: "SCHOOL",
              ageTier: AgeTier.ADULT,
              active: true,
              canLogin: false,
              phoneNumber: request.contactPhone,
            },
            select: { id: true },
          });
          ownerId = substitute.id;
          ownerSubstitution = {
            invalidMemberId: held.memberId,
            substituteMemberId: substitute.id,
            reason: err.message,
          };
        }

        // F6 (#1352): re-check per-night capacity for the NEW guest list
        // before the swap, excluding the held booking's own guests — the hold
        // reserved only the ORIGINAL N spots, and a guestOverride can approve
        // M > N children whose extra beds may already be taken on some
        // nights. Runs under the same advisory lock as every other capacity
        // writer, mirroring the fresh-create branch below; the sentinel
        // aborts the transaction, so the APPROVED status-claim rolls back and
        // the admin sees the same capacityExceeded outcome with the full
        // nights listed. (This makes the docstring's "capacity re-checked
        // against the new list" promise true on this branch.)
        const heldCapacity = await checkCapacityForGuestRanges(
          bookingLodgeId,
          request.checkIn,
          request.checkOut,
          guests.map(() => ({
            stayStart: request.checkIn,
            stayEnd: request.checkOut,
          })),
          held.id,
          tx
        );
        if (!heldCapacity.available) {
          capacityFullNights = getCapacityFullNights(heldCapacity.nightDetails);
          throw new Error("CAPACITY_EXCEEDED_SENTINEL");
        }

        // Preserve the held booking's beds across the guest swap (issue #1254):
        // update guest rows in place rather than deleteMany+recreate, so an
        // admin's pre-assigned beds (and #713 night sets) survive. CONFIRMED
        // already holds capacity (#709), so the school hold spans send → accept.
        await reassignHeldBookingGuests(tx, held.id, guestCreates);
        booking = await tx.booking.update({
          where: { id: held.id },
          data: {
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            totalPriceCents,
            finalPriceCents: totalPriceCents,
            hasNonMembers: true,
            notes: request.message,
            createdById: input.adminMemberId,
            // Point the held booking at the (possibly substituted) owner. On the
            // no-substitution path this rewrites the same id (a no-op); bed
            // allocations live on guest rows and are unaffected by ownership.
            memberId: ownerId,
            // Exclusive whole-lodge hold when the request asked for it (#121).
            ...exclusiveHoldData,
          },
          select: { id: true },
        });
        schoolMember = { id: ownerId };
      } else {
        const capacityRanges = guests.map(() => ({
          stayStart: request.checkIn,
          stayEnd: request.checkOut,
        }));
        const capacity = await checkCapacityForGuestRanges(
          bookingLodgeId,
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

        if (input.ownerContactMemberId) {
          // Admin mapped this school request to an existing non-login SCHOOL/
          // Organisation contact (issue #1255): the confirmed booking — and the
          // Xero invoice raised after commit — reuse that contact instead of
          // spawning a duplicate school member (and Xero contact). Teachers are
          // still created fresh below. The guard rejects any login-capable
          // target.
          const mappedId = await assertMappableOwnerContact(
            tx,
            input.ownerContactMemberId
          );
          schoolMember = { id: mappedId };
        } else {
          // The school is the invoiced party and Xero contact: name = school,
          // email = contact email. Owned by a non-login Member (canLogin: false).
          schoolMember = await tx.member.create({
            data: {
              email: request.contactEmail,
              passwordHash: placeholderPasswordHash,
              emailVerified: true,
              firstName: schoolName.slice(0, 100),
              lastName: "",
              role: "SCHOOL",
              ageTier: AgeTier.ADULT,
              active: true,
              canLogin: false,
              phoneNumber: request.contactPhone,
            },
            select: { id: true },
          });
        }

        // CONFIRMED holds capacity (issue #709 locked decision); pay-on-account
        // via INTERNET_BANKING so the existing invoice/reconciliation path runs.
        booking = await tx.booking.create({
          data: {
            memberId: schoolMember.id,
            lodgeId: bookingLodgeId,
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            status: BookingStatus.CONFIRMED,
            totalPriceCents,
            finalPriceCents: totalPriceCents,
            hasNonMembers: true,
            notes: request.message,
            createdById: input.adminMemberId,
            // Exclusive whole-lodge hold when the request asked for it (#121).
            ...exclusiveHoldData,
            guests: {
              create: guestCreates,
            },
          },
          select: { id: true },
        });
      }

      // ADR-001 bed-allocation short-circuit (#2285): a hold granted at
      // approval means the booking must own NO per-bed rows. The held
      // conversion above deliberately preserves pre-assigned beds across the
      // guest swap (#1254) — right for an ordinary approval, but rows on a
      // now-held booking would be invisible on the board and contradict the
      // invariant. Run the same flag-keyed reconcile the admin toggle uses:
      // with wholeLodgeHold freshly stamped it is a pure whole-booking prune
      // (no placement). Fresh creates own no rows yet, so there it is an
      // idempotent no-op. Non-exclusive approvals are untouched — their
      // #1254 bed preservation stands.
      if (request.exclusivityRequested) {
        // Recoverability (#2285 review): a held CONVERSION can prune beds an
        // officer pre-assigned to the held booking (#1254 preserves them across
        // the guest swap). Capture what is about to be destroyed BEFORE the
        // prune, then audit it — the toggle route records the same list in its
        // own `booking.exclusiveHold.set` entry, and this path previously
        // recorded nothing at all for the prune.
        const prunedAllocations = await tx.bedAllocation.findMany({
          where: { bookingId: booking.id },
          select: {
            bookingGuestId: true,
            roomId: true,
            bedId: true,
            stayDate: true,
            source: true,
            approvedAt: true,
          },
          orderBy: [{ stayDate: "asc" }, { bedId: "asc" }],
          take: MAX_AUDITED_PRUNED_ALLOCATIONS + 1,
        });

        const reconcile = await reconcileBedAllocationsForBooking({
          bookingId: booking.id,
          db: tx,
        });

        if (reconcile.deletedCount > 0) {
          await createAuditLog(
            {
              action: "BED_ALLOCATION_HELD_BOOKING_PRUNED",
              memberId: input.adminMemberId,
              actorMemberId: input.adminMemberId,
              subjectMemberId: schoolMember.id,
              targetId: booking.id,
              entityType: "Booking",
              entityId: booking.id,
              category: "lodge",
              severity: "important",
              outcome: "success",
              summary:
                "Bed assignments removed because the approved school request granted an exclusive whole-lodge hold",
              details:
                "Approving this school request granted sole occupancy of the lodge, so the converted booking owns no per-bed assignments (ADR-001). The assignments it carried were removed and are listed here so the placement can be reconstructed if the hold is later cleared.",
              metadata: {
                issue: 2285,
                requestId: request.id,
                bookingId: booking.id,
                deletedCount: reconcile.deletedCount,
                promotedCount: reconcile.promotedCount,
                removedAllocations: prunedAllocations
                  .slice(0, MAX_AUDITED_PRUNED_ALLOCATIONS)
                  .map((row) => ({
                    bookingGuestId: row.bookingGuestId,
                    roomId: row.roomId,
                    bedId: row.bedId,
                    stayDate: formatDateOnly(row.stayDate),
                    source: row.source,
                    approvedAt: row.approvedAt?.toISOString() ?? null,
                  })),
                removedAllocationsTruncated:
                  prunedAllocations.length > MAX_AUDITED_PRUNED_ALLOCATIONS,
              },
            },
            tx,
          );
        }
      }

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amountCents: totalPriceCents,
          status: PaymentStatus.PENDING,
          source: PaymentSource.INTERNET_BANKING,
          reference: buildInternetBankingPaymentReference(booking.id),
        },
      });

      const teacherAssignments: Array<{
        memberId: string;
        assignmentId: string;
        email: string;
        firstName: string;
        pin: string;
      }> = [];
      for (const plan of teacherPlans) {
        const teacherMember = await tx.member.create({
          data: {
            email: plan.email,
            passwordHash: placeholderPasswordHash,
            emailVerified: true,
            firstName: plan.teacher.firstName.slice(0, 100),
            lastName: plan.teacher.lastName.slice(0, 100),
            role: "SCHOOL",
            ageTier: AgeTier.ADULT,
            active: true,
            canLogin: false,
          },
          select: { id: true, firstName: true, email: true },
        });

        const teacherAssignment = await tx.hutLeaderAssignment.create({
          data: {
            memberId: teacherMember.id,
            startDate: request.checkIn,
            endDate: request.checkOut,
            hutLeaderPin: plan.hutLeaderPin,
            // A hut leader serves one lodge (ADR-001 Q5): stamp the booking's
            // lodge so school-created assignments are lodge-scoped like the
            // manual and cron paths, not left null.
            lodgeId: bookingLodgeId,
          },
          select: { id: true },
        });

        teacherAssignments.push({
          memberId: teacherMember.id,
          assignmentId: teacherAssignment.id,
          email: teacherMember.email,
          firstName: teacherMember.firstName,
          pin: plan.pin,
        });
      }

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: booking.id,
          convertedMemberId: schoolMember.id,
          version: { increment: 1 },
          // Keep the request snapshot consistent with what was actually booked
          // when the admin varied the quantity.
          ...(input.guestOverride
            ? { guests: guests as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });

      return {
        bookingId: booking.id,
        lodgeId: bookingLodgeId,
        schoolMemberId: schoolMember.id,
        teacherAssignments,
        ownerSubstitution,
        alreadyConverted: false as const,
      };
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

  // On the idempotent replay path the tx body was skipped: the booking already
  // exists and its Xero invoice was already queued by the first accept, and
  // teacherAssignments is empty. Guard EVERY post-tx side effect on
  // !alreadyConverted so the money-critical Xero invoice (or manual-invoice
  // email) is NOT raised a second time and no teacher PIN is re-sent (#1232).
  let invoiceMode: "xero" | "manual" = "manual";
  // Conflict surfacing for the school entry point (issue #119): populated below
  // when a hold was set at approval. Informational only (decision 1).
  let exclusiveHoldConflicts: HoldConflictBooking[] = [];
  if (!conversion.alreadyConverted) {
    // Teacher PIN emails (after commit; failures are logged, not fatal).
    for (const assignment of conversion.teacherAssignments) {
      sendHutLeaderAssignmentEmail({
        email: assignment.email,
        firstName: assignment.firstName,
        startDate: request.checkIn,
        endDate: request.checkOut,
        pin: assignment.pin,
        assignmentId: assignment.assignmentId,
      }).catch((err) =>
        logger.error(
          { err, bookingId: conversion.bookingId, memberId: assignment.memberId },
          "Failed to send hut leader assignment email for school teacher"
        )
      );
    }

    // Raise + email the Xero invoice via the existing outbox, or notify admins
    // to invoice manually when the Xero module is off (issue #709 req 6).
    if (await isEffectiveModuleEnabled("xeroIntegration")) {
      invoiceMode = "xero";
      try {
        const queued = await enqueueXeroBookingInvoiceOperation(conversion.bookingId, {
          createdByMemberId: input.adminMemberId,
        });
        if (queued.queueOperationId) {
          await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
        }
      } catch (err) {
        logger.error(
          { err, bookingId: conversion.bookingId },
          "Failed to queue Xero invoice for school booking"
        );
      }
    } else {
      // Decision 3 (issue #1255 residual risk): name the party actually being
      // invoiced — the booking owner (the mapped contact when the request was
      // mapped), which can differ from the raw request school/contact. On the
      // non-mapped path the owner's name/email equal schoolName/contactEmail, so
      // this resolves to the same values (no behaviour change).
      const invoiceOwner = await prisma.member.findUnique({
        where: { id: conversion.schoolMemberId },
        select: { firstName: true, lastName: true, email: true },
      });
      const invoiceName =
        [invoiceOwner?.firstName, invoiceOwner?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || schoolName;
      const invoiceEmail = invoiceOwner?.email ?? request.contactEmail;
      sendAdminSchoolManualInvoiceEmail({
        schoolName: invoiceName,
        contactEmail: invoiceEmail,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guestCount: guests.length,
        totalCents: totalPriceCents,
      }).catch((err) =>
        logger.error(
          { err, bookingId: conversion.bookingId },
          "Failed to send school manual-invoice admin notification"
        )
      );
    }

    logAudit({
      action: "booking_request.school_approved",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      subjectMemberId: conversion.schoolMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "School booking request approved and confirmed",
      metadata: {
        schoolName,
        bookingId: conversion.bookingId,
        schoolMemberId: conversion.schoolMemberId,
        priceCents: totalPriceCents,
        guestCount: guests.length,
        teacherCount: conversion.teacherAssignments.length,
        invoiceMode,
        exclusivityRequested: Boolean(request.exclusivityRequested),
        wholeLodgeHold: Boolean(request.exclusivityRequested),
        checkIn: request.checkIn.toISOString(),
        checkOut: request.checkOut.toISOString(),
      },
    });

    // Exclusive whole-lodge hold set at approval (issue #121, ADR-001): record
    // a dedicated, durable audit row for the capacity-affecting flag, mirroring
    // the admin exclusive-hold route's action name so both entry points share
    // one audit vocabulary. Only fires when the request asked for exclusivity
    // and the conversion actually ran (not on the idempotent replay path).
    if (request.exclusivityRequested) {
      // Conflict surfacing (ADR-001 decision 1, issue #119): read-only list of
      // existing capacity-holding bookings overlapping the held nights, so the
      // officer sees the clash. Runs post-commit (outside the advisory lock),
      // never refuses/displaces. Best-effort — a failure here must not undo the
      // already-committed approval.
      try {
        exclusiveHoldConflicts = await findOverlappingCapacityHoldingBookings(
          prisma,
          {
            lodgeId: conversion.lodgeId,
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            excludeBookingId: conversion.bookingId,
          },
        );
      } catch (err) {
        logger.error(
          { err, bookingId: conversion.bookingId },
          "Failed to compute exclusive-hold conflicts for approved school request",
        );
      }

      logAudit({
        action: "booking.exclusiveHold.set",
        memberId: input.adminMemberId,
        actorMemberId: input.adminMemberId,
        subjectMemberId: conversion.schoolMemberId,
        targetId: conversion.bookingId,
        entityType: "Booking",
        entityId: conversion.bookingId,
        category: "booking",
        severity: "important",
        outcome: "success",
        summary: "Exclusive whole-lodge hold set from an approved school request",
        metadata: {
          bookingId: conversion.bookingId,
          requestId: request.id,
          source: "school_request_approval",
          setByMemberId: input.adminMemberId,
          // Overlapping bookings the officer must resolve (issue #119).
          overlappingConflictCount: exclusiveHoldConflicts.length,
          overlappingConflictBookingIds: exclusiveHoldConflicts.map((c) => c.id),
        },
      });
    }

    // The held school owner failed re-validation and a fresh contact was
    // substituted (issue #1255 residual-risk decision 1). Surface it for admin
    // follow-up: the confirmed booking (and its Xero invoice / manual-invoice
    // notice) now bill the fresh contact rather than the intended mapped
    // organisation, so an admin must reconcile the Xero contact. Two attention
    // channels run post-commit (outside the tx/advisory lock, under
    // !alreadyConverted so a replay never re-fires): a durable audit row AND an
    // active admin email alert (F20 residual #2 / #1377) routed to the
    // Xero-sync-error audience. School org contacts are the case most likely to
    // be substituted-and-billed, so the alert must fire here for parity with the
    // generic approveBookingRequest path.
    if (conversion.ownerSubstitution) {
      const ownerSubstitution = conversion.ownerSubstitution;
      logger.warn(
        {
          bookingRequestId: request.id,
          bookingId: conversion.bookingId,
          invalidMemberId: ownerSubstitution.invalidMemberId,
          substituteMemberId: ownerSubstitution.substituteMemberId,
          reason: ownerSubstitution.reason,
        },
        "Held school booking owner was invalid at conversion; substituted a fresh non-login contact"
      );
      logAudit({
        action: "booking_request.owner_substituted",
        memberId: input.adminMemberId,
        actorMemberId: input.adminMemberId,
        subjectMemberId: conversion.schoolMemberId,
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: "success",
        summary:
          "Held school booking-request owner was no longer a valid non-login contact at conversion; a fresh contact was substituted so the accept could proceed",
        metadata: {
          bookingId: conversion.bookingId,
          requestId: request.id,
          invalidMemberId: ownerSubstitution.invalidMemberId,
          substituteMemberId: ownerSubstitution.substituteMemberId,
          reason: ownerSubstitution.reason,
        },
      });

      // Fire-and-forget admin email alert. A failed alert must NOT fail the
      // conversion (the booking is already committed), so it mirrors the
      // teacher-PIN/manual-invoice try/catch above. Names are a best-effort
      // readability lookup outside the tx; ids are the source of truth.
      await sendOwnerSubstitutionAdminAlert({
        request,
        bookingId: conversion.bookingId,
        ownerSubstitution,
        failureLogMessage:
          "Failed to send owner-substitution admin alert for school conversion",
      });
    }
  } else {
    // Observability-only note that a duplicate accept was absorbed (#1232).
    logAudit({
      action: "booking_request.school_approve_idempotent_replay",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary:
        "School booking request approve replayed idempotently; no second conversion",
      metadata: { bookingId: conversion.bookingId, requestId: request.id },
    });
  }

  return {
    type: "approved",
    requestId: request.id,
    bookingId: conversion.bookingId,
    schoolMemberId: conversion.schoolMemberId,
    priceCents: totalPriceCents,
    invoiceMode,
    teacherCount: conversion.teacherAssignments.length,
    exclusiveHoldConflicts,
  };
}
