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
  HutLeaderAssignmentSource,
  PaymentSource,
  PaymentStatus,
  Prisma,
  SchoolCateringPreference,
} from "@prisma/client";
import { z } from "zod";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { issueActionToken } from "@/lib/action-tokens";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { reconcileAdultMemberHostingReviewWithSiblings } from "@/lib/adult-member-hosting-review";
import { createAuditLog, logAudit } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";
import {
  MAX_AUDITED_PRUNED_ALLOCATIONS,
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
} from "@/lib/bed-allocation-lifecycle";
import {
  assertMappableOwnerContact,
  BOOKING_REQUEST_VERIFICATION_TTL_MS,
  BookingRequestError,
  buildMemberWholeLodgePlaceholderGuests,
  isMemberWholeLodgeRequest,
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
  planBookingRequestGuestConsent,
  sendOwnerSubstitutionAdminAlert,
  toPipelineGuestCreateData,
  type OwnerSubstitution,
} from "@/lib/booking-request-shared";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  type MemberGuestAddNotificationRow,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
  findOverlappingCapacityHoldingBookings,
  type HoldConflictBooking,
} from "@/lib/capacity";
import {
  sendAdminSchoolManualInvoiceEmail,
  sendAdminWholeLodgeManualInvoiceEmail,
  sendBookingConfirmedEmail,
  sendBookingRequestVerificationEmail,
  sendHutLeaderAssignmentEmail,
} from "@/lib/email";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { generateHutLeaderPin, hashHutLeaderPin } from "@/lib/lodge-pin-session";
import logger from "@/lib/logger";
// #2483: the club's own applied-credit total, so the admin's hand-written
// invoice asks for the same figure the member's confirmation does.
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import {
  priceBookingGuests,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { priceWholeLodgeFlat } from "@/lib/policies/pricing";
import type { PriceBreakdown } from "@/lib/policies/pricing";
import {
  resolveGroupDiscountRateType,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { SCHOOL_CHILD_NAME_PREFIX } from "@/lib/placeholder-guest-names";
import { nameField } from "@/lib/zod-helpers";

/** Age tiers a school can request counts for. Teachers are always ADULT. */
const SCHOOL_CHILD_TIERS = [
  AgeTier.INFANT,
  AgeTier.CHILD,
  AgeTier.YOUTH,
] as const;

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
    seasonYear: seasonYearOfStoredDate(input.checkIn),
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

/**
 * The flat whole-lodge price for a stay (#2338), or null when it cannot be flat
 * priced (no active season covers a night, or a covering season has no flat
 * rate set). Mirrors `priceSchoolGuests`' season lookup — same active +
 * date-overlap + null-tolerant lodge scope — but selects only the per-season
 * flat rate and hands the night-by-night arithmetic to `priceWholeLodgeFlat`,
 * which charges each night at its own covering season's rate and ignores
 * headcount. Exported so the admin queue can preview the same figure the
 * approval will compute.
 */
export async function resolveWholeLodgeFlatPriceCents(input: {
  checkIn: Date;
  checkOut: Date;
  lodgeId?: string | null;
}): Promise<number | null> {
  const requestLodgeId = input.lodgeId ?? (await getDefaultLodgeId(prisma));
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: input.checkOut },
      endDate: { gte: input.checkIn },
      ...lodgeNullTolerantScope(requestLodgeId),
    },
    // Deterministic order so, should a night ever be covered by two active
    // seasons (normally impossible — overlaps are rejected on create/update —
    // but a null-lodgeId expand-release artifact could co-exist with a real
    // season), the first-match this and the batched preview pick is identical.
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
    select: {
      startDate: true,
      endDate: true,
      flatWholeLodgeNightCents: true,
    },
  });
  return priceWholeLodgeFlat(input.checkIn, input.checkOut, seasons);
}

/**
 * Preview the flat whole-lodge price (#2338) for a batch of member whole-lodge
 * requests, so the admin queue can offer the "price as whole lodge" toggle only
 * where a flat rate actually covers the stay — and show the officer the figure
 * the approval will charge. Returns request id -> flat total cents, or null when
 * the stay cannot be flat priced (no flat rate covers some night). Fetches
 * active seasons ONCE per distinct lodge, never once per request; the night-by-
 * night arithmetic (which ignores every non-covering season) is pure and shared
 * with the authoritative approve path, so the preview and the approval agree.
 */
export async function resolveWholeLodgeFlatPricesForRequests(
  requests: Array<{
    id: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string | null;
  }>
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (requests.length === 0) return result;

  const defaultLodgeId = await getDefaultLodgeId(prisma);
  const scopedLodgeId = (lodgeId: string | null) => lodgeId ?? defaultLodgeId;
  const distinctLodgeIds = Array.from(
    new Set(requests.map((request) => scopedLodgeId(request.lodgeId)))
  );
  const seasonsByLodgeId = new Map(
    await Promise.all(
      distinctLodgeIds.map(
        async (lodgeId) =>
          [
            lodgeId,
            await prisma.season.findMany({
              where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
              // Same deterministic order as the authoritative approve-time query
              // (resolveWholeLodgeFlatPriceCents) so the queue preview and the
              // charge can never first-match different seasons for a night.
              orderBy: [{ startDate: "asc" }, { id: "asc" }],
              select: {
                startDate: true,
                endDate: true,
                flatWholeLodgeNightCents: true,
              },
            }),
          ] as const
      )
    )
  );

  for (const request of requests) {
    const seasons = seasonsByLodgeId.get(scopedLodgeId(request.lodgeId)) ?? [];
    result.set(
      request.id,
      priceWholeLodgeFlat(request.checkIn, request.checkOut, seasons)
    );
  }
  return result;
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
  // #2342: strict-read the STORED guests unconditionally, even when the admin
  // supplies a count override that replaces them. The override branch used to
  // skip this parse entirely, which made a request whose stored guest list
  // cannot be read back approvable, priceable, capacity-checkable and
  // invoiceable from admin-typed numbers alone — and the admin panel prefills
  // those numbers from the SALVAGED list, in which an unreadable age tier
  // counts as zero, so a 30-child request could be invoiced for two people.
  // A row we cannot read is not convertible by any route: decline it, or
  // repair the stored data.
  const storedGuests = parseBookingRequestGuests(request.guests);
  // When the admin varies the quantity, regenerate the guest list from the
  // preserved teachers + the new child counts; otherwise use the submitted
  // snapshot. The new list then drives pricing, capacity and the booking below.
  const guests = input.guestOverride
    ? generateSchoolGuests({
        teachers,
        childCounts: input.guestOverride.childCounts,
      })
    : storedGuests;
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
  // #2739: set ONLY on the branch where the engine priced each guest, so the
  // written BookingGuestNight rows carry the rates it really resolved (a season
  // boundary or a per-night group discount makes those nights genuinely
  // different prices) instead of a flat re-split of the guest's total. Left
  // undefined on the officer-total branches, which have no per-night truth.
  let guestPerNightCents: Array<readonly number[] | undefined> | undefined;
  if (request.priceCents != null) {
    totalPriceCents = request.priceCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else if (price && price.guests.length === guests.length) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = price.guests.map((guest) => guest.priceCents);
    guestPerNightCents = price.guests.map((guest) => guest.perNightCents);
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

  // MG4-D-b (#2309). Read before the transaction, per the ordering rule in
  // `member-guest-add-policy.ts`. A school request routinely carries teacher
  // rows an officer linked to real member accounts, and until MG4 those landed
  // on the converted booking with no consent record and no word to the member.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  const memberGuestActor: MemberGuestAddActor = {
    kind: "BOOKING_REQUEST",
    adminMemberId: input.adminMemberId,
  };

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
    memberGuestNotificationRows: MemberGuestAddNotificationRow[];
    displacedMemberGuestIds: string[];
    ownerSubstitution:
      | { invalidMemberId: string; substituteMemberId: string; reason: string }
      | null;
    alreadyConverted: boolean;
  };

  // #3123 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), resolved BEFORE the transaction below takes the global
  // booking lock (`INV-LOCK-001`), the per-lodge capacity key and a per-member
  // night lock for every linked guest. The person-night guard inside
  // `buildApprovalGuestCreates` takes it as a value: a `clubTimeSettings` read
  // under those locks would need a second pooled connection while they are held
  // (`INV-LOCK-004`).
  //
  // The global lock is named in prose rather than spelled as its raw call,
  // because `advisory-lock-guard.test.ts` counts that literal inside this
  // approval block and reads a second occurrence as a second acquisition.
  //
  // The runtime reader rather than `club-time/server`, matching its sibling
  // `booking-request.ts`: `src/instrumentation.node.ts` reaches this family
  // through the booking-request cron chain, and `server-only` is a bare throw
  // at import outside the `react-server` condition.
  const clubTodayDateOnly = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );

  try {
    conversion = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      // Both fresh creation and held reuse reconcile bed allocations in this
      // transaction. Take the canonical global tier once, then the concrete
      // lodge tier below: global fences cancellation/pruning while lodge
      // fences capacity and allocation writers.

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
          // A replay wrote no rows and owes no mail.
          memberGuestNotificationRows: [] as MemberGuestAddNotificationRow[],
          displacedMemberGuestIds: [] as string[],
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
        guestPerNightCents,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        adminMemberId: input.adminMemberId,
        // #3123 — the club day resolved before this transaction opened; the
        // person-night guard inside `buildApprovalGuestCreates` takes it as a
        // value rather than reading the club's zone under these locks
        // (`INV-LOCK-004`).
        today: clubTodayDateOnly,
        heldBookingId: request.heldBookingId ?? null,
      });

      let booking: { id: string };
      let schoolMember: { id: string };
      // MG4-D-b (#2309): collected in whichever branch runs, dispatched after
      // the commit.
      let memberGuestNotificationRows: MemberGuestAddNotificationRow[] = [];
      let displacedMemberGuestIds: string[] = [];
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
        const reassigned = await reassignHeldBookingGuests(
          tx,
          held.id,
          guestCreates,
          {
            bookingOwnerMemberId: ownerId,
            actor: memberGuestActor,
            policy: memberGuestPolicy,
            bookingCheckIn: request.checkIn,
          }
        );
        memberGuestNotificationRows = reassigned.memberGuestNotificationRows;
        displacedMemberGuestIds = reassigned.displacedMemberIds;
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
        const consentPlan = await planBookingRequestGuestConsent(tx, {
          bookingOwnerMemberId: schoolMember.id,
          guests: guestCreates,
          actor: memberGuestActor,
          policy: memberGuestPolicy,
          bookingCheckIn: request.checkIn,
        });
        const createdBooking = await tx.booking.create({
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
              create: consentPlan.guests.map(toPipelineGuestCreateData),
            },
          },
          select: { id: true, guests: { select: { id: true, memberId: true } } },
        });
        booking = { id: createdBooking.id };
        // Short-circuited on the plan, not on the rows: an ordinary booking
        // request owes nothing, and skipping the walk keeps the common path
        // free of it (the same shape `admin-booking-copy.ts` uses).
        memberGuestNotificationRows =
          consentPlan.entriesByMemberId.size === 0
            ? []
            : matchMemberGuestNotificationRows({
                createdGuests: createdBooking.guests,
                entriesByMemberId: consentPlan.entriesByMemberId,
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

        const reconcile = await reconcileBedAllocationsForBookingWithLodgeLockHeld({
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

      // #2364. A school party is every non-member guest and no member
      // participant, so at a club running the rule it always carries uncovered
      // guest-nights. Recorded in the approving transaction — covering the
      // fresh create and the held conversion alike — so the hazard is on the
      // booking from the moment it exists rather than appearing months later on
      // the first unrelated edit. PENDING, never APPROVED: approving the
      // REQUEST is not the explicit, reasoned acceptance of a hosting exception
      // that D-R4 requires, and approval is never blocked by it.
      // #2569 §13 — school and organisation workflows are EXCLUDED from the
      // enforced consequence: they run a separate officer-managed process and may
      // be supervised by teachers, leaders or custodians who do not map onto the
      // adult club-member host rule. The hazard is still evaluated and recorded so
      // an officer sees it; the booking is never stopped by this policy.
      await reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx, {
        enforcement: "REVIEW_ONLY",
      });

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
            // #2926: the stamp that keeps teacher rows out of the hut-leader
            // overlap predicate. Written once, here, and never updated — why
            // that has to be the row and not the member is in
            // `findHutLeaderOverlapRefusal`'s docblock.
            source: HutLeaderAssignmentSource.SCHOOL_BOOKING,
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
        memberGuestNotificationRows,
        displacedMemberGuestIds,
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


  // #2576 §7. Every path that can ENQUEUE bounded re-evaluation work must also
  // drain it: a queue row with nobody draining it turns the owner's "immediate
  // re-evaluation" into "within three hours", which is how long an officer-created
  // booking that has just RESTORED cover would leave a critical incident standing,
  // or one that removed it would leave the owner un-notified. Best-effort and
  // scoped to this booking's owner; the cron sweep is the authority on completion.
  if (!conversion.alreadyConverted) {
    await settleHostingCoverageAfterCommit({ bookingId: conversion.bookingId });
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
    // MG4-D-b (#2309), AFTER the commit and outside both advisory locks. Two
    // directions, because an approval can do both at once: a swap adds one
    // member guest and drops another, and telling only the newcomer would leave
    // the person who was dropped believing they still have a bed.
    if (
      conversion.memberGuestNotificationRows.length > 0 ||
      conversion.displacedMemberGuestIds.length > 0
    ) {
      const {
        sendMemberGuestAddNotifications,
        sendMemberGuestWithdrawnNotifications,
      } = await import("@/lib/member-guest-consent-notifications");
      try {
        if (conversion.memberGuestNotificationRows.length > 0) {
          await sendMemberGuestAddNotifications({
            bookingId: conversion.bookingId,
            rows: conversion.memberGuestNotificationRows,
            actor: memberGuestActor,
          });
        }
        if (conversion.displacedMemberGuestIds.length > 0) {
          await sendMemberGuestWithdrawnNotifications({
            bookingId: conversion.bookingId,
            targetMemberIds: conversion.displacedMemberGuestIds,
            context: "BOOKING_REQUEST_REPLACED",
          });
        }
      } catch (err) {
        logger.error(
          { err, bookingId: conversion.bookingId, bookingRequestId: request.id },
          "Failed to dispatch member-guest notifications after a school booking-request approval",
        );
      }
    }

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

// ---------------------------------------------------------------------------
// Member whole-lodge approval (#2263, epic #2245)
// ---------------------------------------------------------------------------

/**
 * Admin override of the approved headcount, and the manual price, for a member
 * whole-lodge request (#2263). Validated in the approve route exactly like the
 * school `childCounts` override.
 */
export const memberWholeLodgeApprovalSchema = z.object({
  /**
   * The headcount the officer is actually pricing and booking, after talking to
   * the member. Omitted keeps the submitted approximate number.
   */
  pricedHeadcount: z.number().int().min(1).max(500).optional(),
  /**
   * Manual total price in integer cents. MANDATORY fallback when no active
   * season covers the requested dates — without it the season-rate branch has
   * nothing to price from and the approval 409s (the member-request path has no
   * quote/price op to fall back on, so this field is the only way through).
   * Split across the guest rows by splitPriceAcrossGuests.
   */
  priceOverrideCents: z.number().int().min(0).max(100_000_000).optional(),
  /**
   * The officer's per-approval pricing choice (#2338). When true and a flat
   * whole-lodge rate is set for every night's covering season, the stay prices
   * `nights x flat rate` and headcount is ignored; otherwise it falls back to
   * per-guest pricing (owner decision 1 Aug 2026: the officer chooses per
   * approval, it is NOT automatic on every whole-lodge booking). Omitted/false
   * keeps today's per-guest behaviour so nothing changes silently. The manual
   * `priceOverrideCents` still wins over both.
   */
  priceAsWholeLodge: z.boolean().optional(),
});

export type MemberWholeLodgeApprovalOverride = z.infer<
  typeof memberWholeLodgeApprovalSchema
>;

type ApproveMemberWholeLodgeRequestOutcome =
  | {
      type: "approved";
      requestId: string;
      bookingId: string;
      memberId: string;
      /**
       * The booking's committed total. On a fresh conversion this is what was
       * just booked; on an idempotent REPLAY it is re-read from the committed
       * booking row, never echoed from this call's recomputed figures — a second
       * approve with a different headcount/override must not report numbers that
       * were never written (#2263 review finding M4).
       */
      priceCents: number;
      guestCount: number;
      /**
       * Whether the receivable was invoiced through Xero or handed to admins to
       * invoice by hand. School parity, and the officer's toast says which.
       * Null on the idempotent replay path: the first approve raised it and this
       * call raised nothing, so claiming either mode would be a fabrication.
       */
      invoiceMode: "xero" | "manual" | null;
      /**
       * Existing capacity-holding bookings overlapping the approved booking's
       * nights, computed post-commit. ADMIN-ONLY (ADR-001 decision 6): this
       * never reaches a member surface, and the approval never refuses or
       * displaces on account of it (decision 1) — the officer resolves it.
       */
      exclusiveHoldConflicts: HoldConflictBooking[];
    }
  | { type: "capacityExceeded"; fullNights: string[] };

/**
 * Approve a signed-in member's whole-lodge request (#2263), converting it into a
 * CONFIRMED booking that holds the whole lodge.
 *
 * This lives beside `approveSchoolBookingRequest` on purpose (binding owner
 * decision): the hold-vs-capacity-lock ordering, the `exclusiveHoldData`
 * stamping, the idempotency claim, the ADR-001 bed-allocation prune (#2285) and
 * the post-commit conflict surfacing exist in ONE place, so a correction to any
 * of them cannot land on the school path and miss this one.
 *
 * School parity, deliberately:
 *   - the booking is created **CONFIRMED**, which is capacity-holding in its own
 *     right (CAPACITY_HOLDING_BOOKING_STATUSES) — no dependence on the PENDING
 *     `originBookingRequest` clause;
 *   - `paymentSource: INTERNET_BANKING` with a PENDING Payment row, so the
 *     finance surfaces see the receivable, and — like every sibling path that
 *     creates one — that receivable is INVOICED post-commit: the Xero invoice
 *     operation plus the #1620 applied-credit allocation when the module is on,
 *     the delivery-locked manual-invoice admin alert when it is off. An unpaid
 *     confirmed booking that nobody was ever asked to invoice is money the club
 *     silently never collects;
 *   - `hasNonMembers: true`, because the placeholder guests are rated
 *     NON_MEMBER (owner decision OD-A: conservative revenue default; guests
 *     re-rate per-guest through the ordinary booking-modification path as real
 *     names and member links are edited in).
 *
 * School DIVERGENCE, deliberately:
 *   - the booking is owned by the REQUESTING LOGIN MEMBER. No non-login member
 *     is minted, no teachers, no PINs, no school Xero contact, and there is no
 *     owner-substitution path to run (the owner is a live account, not a
 *     materialised contact).
 *   - NO `PaymentLink` row and NO tokenised payment-link email. That flow is the
 *     GENERAL *non-login* approval path; a member pays through the member
 *     booking surfaces they are already signed in to. The confirmation email
 *     therefore has to carry the internet-banking reference itself, and it says
 *     the amount is OWING — never "Total Paid" — because nothing has been paid.
 *   - NO `nonMemberHoldUntil`. The hold clock belongs to the PENDING
 *     non-member path (it is what the bump cron reads); a CONFIRMED booking has
 *     already been admitted, exactly as a school booking has. Stamping a hold
 *     deadline onto a CONFIRMED booking that holds the WHOLE LODGE would arm a
 *     bump clock against the one booking that must not be bumped.
 */
export async function approveMemberWholeLodgeRequest(input: {
  requestId: string;
  adminMemberId: string;
  override?: MemberWholeLodgeApprovalOverride;
}): Promise<ApproveMemberWholeLodgeRequestOutcome> {
  const initialRequest = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!initialRequest) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  let request = initialRequest;
  if (!isMemberWholeLodgeRequest(request)) {
    throw new BookingRequestError(
      "This is not a member whole-lodge booking request",
      400
    );
  }
  /*
    ALREADY CONVERTED: replay, do not refuse.

    This is what an officer double-clicking Approve actually hits, and it has to
    be answered BEFORE the status guard below. The #1232 idempotency claim
    (claimAlreadyConvertedBookingRequest, inside the transaction) was written to
    handle it, but a CONVERTED row could never reach it: the pre-lock guard
    rejected the status first, so the replay path was dead code and the second
    approve answered 409 instead of naming the booking it had already made. No
    money was ever at risk — the guard did stop a second booking, payment and
    invoice — but a documented, unit-tested replay that the route can never
    produce is worse than useless. It took a Playwright run to prove it never ran.

    Handled here rather than by widening the guard because everything between the
    guard and the transaction prices the stay, and a booking approved on a manual
    price override in a season-less window would throw "cannot price this
    whole-lodge booking" on the way to its own replay.

    No lock is needed: a conversion is write-once (convertedBookingId and
    convertedMemberId are set in the converting transaction and never rewritten),
    so there is nothing here another writer can change underneath us. The
    committed figures are read from the booking, never recomputed (finding M4).
  */
  if (request.status === BookingRequestStatus.CONVERTED) {
    if (!request.convertedBookingId) {
      throw new BookingRequestError(
        "This booking request is marked converted but has no booking; it needs manual repair",
        409
      );
    }
    const committed = await prisma.booking.findUnique({
      where: { id: request.convertedBookingId },
      select: { finalPriceCents: true, _count: { select: { guests: true } } },
    });
    logAudit({
      action: "booking_request.member_whole_lodge_approve_idempotent_replay",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary:
        "Member whole-lodge request approve replayed idempotently; no second conversion",
      metadata: {
        bookingId: request.convertedBookingId,
        requestId: request.id,
        preLock: true,
      },
    });
    return {
      type: "approved",
      requestId: request.id,
      bookingId: request.convertedBookingId,
      // isMemberWholeLodgeRequest above already proved requestedByMemberId is set.
      memberId: request.convertedMemberId ?? request.requestedByMemberId!,
      priceCents: committed?.finalPriceCents ?? 0,
      guestCount: committed?._count?.guests ?? 0,
      // Nothing was raised by THIS call, so no mode is claimed.
      invoiceMode: null,
      // Conflict surfacing belongs to the approval that actually granted the
      // hold; a replay computes none rather than re-reporting a stale list.
      exclusiveHoldConflicts: [],
    };
  }

  if (
    request.status !== BookingRequestStatus.VERIFIED &&
    request.status !== BookingRequestStatus.PRICED
  ) {
    throw new BookingRequestError(
      "Only open member whole-lodge requests can be approved",
      409
    );
  }
  // A member request never enters the quote lifecycle (the service-layer
  // rejections in booking-request-quotes.ts refuse quote/send/hold on it), so it
  // can never carry a held booking. Refuse rather than silently take a
  // held-conversion branch this path does not implement.
  if (request.heldBookingId) {
    throw new BookingRequestError(
      "This request unexpectedly holds beds; release the hold before approving",
      409
    );
  }
  const requesterMemberId = request.requestedByMemberId!;

  const approvalLodgeId = request.lodgeId ?? null;

  // The officer-confirmed headcount drives pricing, capacity and the guest rows.
  // Omitted keeps the member's submitted approximate number.
  const submittedGuests = parseBookingRequestGuests(request.guests);
  const headcount = input.override?.pricedHeadcount ?? submittedGuests.length;
  if (headcount < 1) {
    throw new BookingRequestError("At least one guest is required", 422);
  }
  const lodgeCapacity = approvalLodgeId
    ? await getLodgeCapacity(approvalLodgeId)
    : await getDefaultLodgeCapacity();
  if (headcount > lodgeCapacity) {
    throw new BookingRequestError(
      `A whole-lodge booking cannot exceed the lodge capacity of ${lodgeCapacity} guests`,
      422
    );
  }
  const guests =
    headcount === submittedGuests.length
      ? submittedGuests
      : buildMemberWholeLodgePlaceholderGuests(headcount);

  // Owner decision OD-A: the placeholder guests are unnamed and unlinked, so
  // they price at NON-MEMBER rates — the same engine, rate class and group
  // discount the school path uses. `priceSchoolGuests` returns null when no
  // active season covers the dates.
  const price = await priceSchoolGuests({
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests,
    lodgeId: approvalLodgeId,
  });

  const priceOverrideCents = input.override?.priceOverrideCents;
  // #2338 (owner decision 1 Aug 2026): the officer chooses per approval whether
  // to charge the flat whole-lodge rate. The flat branch is only reached when
  // the officer ticked "price as whole lodge" AND no manual override is given;
  // it then charges `nights x the covering season's flat rate` and ignores
  // headcount. `resolveWholeLodgeFlatPriceCents` returns null when no flat rate
  // covers the stay, so an officer who ticked the box on a season with no flat
  // rate falls through to per-guest exactly as before — nothing to price from
  // is never silently charged as zero.
  const flatWholeLodgeCents =
    input.override?.priceAsWholeLodge && priceOverrideCents == null
      ? await resolveWholeLodgeFlatPriceCents({
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          lodgeId: approvalLodgeId,
        })
      : null;

  let totalPriceCents: number;
  let guestPriceCents: number[];
  // #2739: see the school approval — set only where the engine priced each
  // guest, so the night rows store the engine's own per-night vector rather than
  // a flat re-split of a total that was itself built out of varying rates.
  let guestPerNightCents: Array<readonly number[] | undefined> | undefined;
  if (priceOverrideCents != null) {
    // Officer's manual total wins over BOTH flat and per-guest, split in integer
    // cents with the remainder on the first guest (splitPriceAcrossGuests) — no
    // bespoke arithmetic.
    totalPriceCents = priceOverrideCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else if (flatWholeLodgeCents != null) {
    // Officer chose whole-lodge pricing and a flat rate covers every night:
    // `nights x flat rate`, headcount ignored. Split across the guest rows so
    // each carries a share and the rows still sum EXACTLY to the total.
    totalPriceCents = flatWholeLodgeCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else if (price && price.guests.length === guests.length) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = price.guests.map((guest) => guest.priceCents);
    guestPerNightCents = price.guests.map((guest) => guest.perNightCents);
  } else if (price) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else {
    throw new BookingRequestError(
      "Cannot price this whole-lodge booking: no active season covers the requested dates. Set a price before approving.",
      409
    );
  }

  const reviewedAt = new Date();
  // ADR-001 decision 1: the hold is stamped regardless of any existing
  // overlapping bookings — never an empty-lodge precondition. Stamped by the
  // approving admin, because granting exclusivity is the ADMIN's capacity
  // action; the member request only recorded the ASK.
  const exclusiveHoldData = {
    wholeLodgeHold: true,
    wholeLodgeHoldAt: reviewedAt,
    wholeLodgeHoldByMemberId: input.adminMemberId,
  };

  let capacityFullNights: string[] | null = null;
  let conversion: {
    bookingId: string;
    lodgeId: string;
    memberId: string;
    /** The reference the member must quote on their internet-banking payment. */
    paymentReference: string;
    /**
     * What the committed booking actually says. On the replay path these are
     * re-read from the row rather than taken from this call's recomputation, so
     * a second approve can never report figures that were never written (M4).
     */
    committedPriceCents: number;
    committedGuestCount: number;
    alreadyConverted: boolean;
  };

  // #3123 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), resolved BEFORE the transaction below takes the global
  // booking lock (`INV-LOCK-001`), the per-lodge capacity key and a per-member
  // night lock for every linked guest. The person-night guard inside
  // `buildApprovalGuestCreates` takes it as a value: a `clubTimeSettings` read
  // under those locks would need a second pooled connection while they are held
  // (`INV-LOCK-004`).
  //
  // The global lock is named in prose rather than spelled as its raw call,
  // because `advisory-lock-guard.test.ts` counts that literal inside this
  // approval block and reads a second occurrence as a second acquisition.
  //
  // The runtime reader rather than `club-time/server`, matching its sibling
  // `booking-request.ts`: `src/instrumentation.node.ts` reaches this family
  // through the booking-request cron chain, and `server-only` is a bare throw
  // at import outside the `react-server` condition.
  const clubTodayDateOnly = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );

  try {
    conversion = await prisma.$transaction(async (tx) => {
      // Whole-lodge conversion composes a booking lifecycle transition with
      // allocation pruning, so it joins the global cohort before the booking's
      // lodge capacity key. The held reconcile below reuses that lock prefix.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const bookingLodgeId = request.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      const lockedRequest = await tx.bookingRequest.findUnique({
        where: { id: request.id },
      });
      if (!lockedRequest) {
        throw new BookingRequestError("Booking request not found", 404);
      }

      // Idempotency (#1232 double-charge guard) BEFORE the stale-snapshot fence,
      // so a legitimate double approval replays the committed conversion instead
      // of 409ing on the version the first approval bumped.
      const committedConversion = await claimAlreadyConvertedBookingRequest(
        tx,
        request.id
      );
      if (committedConversion) {
        // M4: report what the FIRST approval committed, not what this call just
        // recomputed. A replay carrying a different pricedHeadcount or
        // priceOverrideCents would otherwise hand the officer a total and a
        // guest count that exist nowhere in the database.
        const committedBooking = await tx.booking.findUnique({
          where: { id: committedConversion.convertedBookingId },
          select: {
            finalPriceCents: true,
            payment: { select: { reference: true } },
            _count: { select: { guests: true } },
          },
        });
        return {
          bookingId: committedConversion.convertedBookingId,
          lodgeId: bookingLodgeId,
          memberId: committedConversion.convertedMemberId,
          paymentReference:
            committedBooking?.payment?.reference ??
            buildInternetBankingPaymentReference(
              committedConversion.convertedBookingId,
            ),
          committedPriceCents: committedBooking?.finalPriceCents ?? 0,
          committedGuestCount: committedBooking?._count?.guests ?? 0,
          alreadyConverted: true as const,
        };
      }

      // Optimistic version fence (#1923): any edit landing after the pre-lock
      // read invalidates this approval's snapshot. Fences on the integer
      // version, never on updatedAt (millisecond-collidable).
      if (
        lockedRequest.version !== request.version ||
        (lockedRequest.heldBookingId ?? null) !== null
      ) {
        throw new BookingRequestError(
          "This booking request changed while it was being approved; review it and try again",
          409
        );
      }
      request = lockedRequest;

      if (
        !isMemberWholeLodgeRequest(request) ||
        (request.status !== BookingRequestStatus.VERIFIED &&
          request.status !== BookingRequestStatus.PRICED)
      ) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      // Status-claim so two admins cannot approve concurrently.
      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: request.id,
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

      // The booking's OWN admission is capacity-checked, school parity. ADR-001
      // decision 1 governs only what happens to OTHER bookings on the held
      // nights (nothing — they are surfaced, never displaced); it does not
      // license admitting this booking over capacity.
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        request.checkIn,
        request.checkOut,
        guests.map(() => ({
          stayStart: request.checkIn,
          stayEnd: request.checkOut,
        })),
        undefined,
        tx
      );
      if (!capacity.available) {
        capacityFullNights = getCapacityFullNights(capacity.nightDetails);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      // The owner is the requesting LOGIN member. No member row is created and
      // none is re-validated: unlike the school/public paths there is no
      // materialised non-login contact whose state could have drifted.
      const owner = await tx.member.findUnique({
        where: { id: requesterMemberId },
        select: { id: true, active: true },
      });
      if (!owner || !owner.active) {
        throw new BookingRequestError(
          "The member who made this request no longer has an active account",
          409
        );
      }

      const guestCreates = await buildApprovalGuestCreates(tx, {
        guests,
        // A member whole-lodge request carries no admin guest links — the guests
        // are unnamed placeholders, which is what makes them NON_MEMBER-rated
        // (OD-A).
        linkedMembers: new Map<number, string>(),
        guestPriceCents,
        guestPerNightCents,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        adminMemberId: input.adminMemberId,
        // #3123 — the club day resolved before this transaction opened; the
        // person-night guard inside `buildApprovalGuestCreates` takes it as a
        // value rather than reading the club's zone under these locks
        // (`INV-LOCK-004`).
        today: clubTodayDateOnly,
        heldBookingId: null,
      });

      const booking = await tx.booking.create({
        data: {
          memberId: owner.id,
          lodgeId: bookingLodgeId,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          // CONFIRMED holds capacity in its own right (school parity).
          status: BookingStatus.CONFIRMED,
          totalPriceCents,
          finalPriceCents: totalPriceCents,
          // OD-A: the placeholder guests are NON_MEMBER-rated, so the booking
          // genuinely carries non-members. No nonMemberHoldUntil — see the
          // function docstring.
          hasNonMembers: true,
          notes: request.message,
          createdById: input.adminMemberId,
          ...exclusiveHoldData,
          // #2739: routed through the same shaper as the other pipeline write
          // points. It is what nests each guest's canonical night set, and this
          // create used to hand `guestCreates` to Prisma raw — the one write
          // point that would have kept producing night-less guests.
          guests: { create: guestCreates.map(toPipelineGuestCreateData) },
        },
        select: { id: true },
      });

      // ADR-001 bed-allocation short-circuit (#2285): a booking granted an
      // exclusive hold must own NO per-bed rows. A fresh create owns none yet,
      // so this is an idempotent no-op here — it is run anyway, and audited on
      // the same terms as the school path, so the invariant is enforced by the
      // same call on every approval route rather than by an assumption about
      // which branch created the booking.
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
      const reconcile = await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: booking.id,
        db: tx,
      });
      if (reconcile.deletedCount > 0) {
        await createAuditLog(
          {
            action: "BED_ALLOCATION_HELD_BOOKING_PRUNED",
            memberId: input.adminMemberId,
            actorMemberId: input.adminMemberId,
            subjectMemberId: owner.id,
            targetId: booking.id,
            entityType: "Booking",
            entityId: booking.id,
            category: "lodge",
            severity: "important",
            outcome: "success",
            summary:
              "Bed assignments removed because the approved member whole-lodge request granted an exclusive whole-lodge hold",
            details:
              "Approving this member's whole-lodge request granted sole occupancy of the lodge, so the converted booking owns no per-bed assignments (ADR-001). The assignments it carried were removed and are listed here so the placement can be reconstructed if the hold is later cleared.",
            metadata: {
              issue: 2263,
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

      // #2364. The requesting member owns this booking but is NOT a guest row on
      // it, and ownership never proves attendance — so a whole-lodge party of
      // NON_MEMBER-rated placeholder guests (OD-A) has nobody hosting it, and at
      // a club running the rule that is a real hazard an admin should see. Under
      // the REVIEW consequence it opens PENDING and never blocks the approval; if
      // the member adds themselves or another adult member to the party, the next
      // reconciliation clears it with no admin action.
      //
      // #2569: NOT `REVIEW_ONLY`, and that is the point. A member whole-lodge
      // request is a MEMBER-OWNED booking flow, which the owner's first release
      // covers in as many words; the §13 exclusion names school and organisation
      // request approvals only, and it is theirs because of teachers, organisation
      // leaders and custodians who do not map onto the adult club-member rule —
      // none of which is true of a member booking the whole lodge for their own
      // party. So an enforcing lodge refuses this approval, the throw rolls it back
      // untouched, and the route names the rule to the approving officer with no
      // exception door, because that officer IS the authority the door leads to.
      // Their remedies are to put a qualifying adult member in the party, move the
      // request to another lodge, or change the lodge's setting.
      await reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx);

      // Receivable for the finance surfaces. Pay-on-account via the existing
      // INTERNET_BANKING source; NO PaymentLink row is created, so no tokenised
      // payment page exists for this booking. The reference is surfaced to the
      // member in their confirmation email (post-commit), so it must be captured
      // here rather than recomputed from an assumption about its shape.
      const paymentReference = buildInternetBankingPaymentReference(booking.id);
      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amountCents: totalPriceCents,
          status: PaymentStatus.PENDING,
          source: PaymentSource.INTERNET_BANKING,
          reference: paymentReference,
        },
      });

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: booking.id,
          convertedMemberId: owner.id,
          version: { increment: 1 },
          // Keep the request snapshot consistent with what was actually booked
          // when the officer varied the headcount.
          ...(headcount === submittedGuests.length
            ? {}
            : { guests: guests as unknown as Prisma.InputJsonValue }),
        },
      });

      return {
        bookingId: booking.id,
        lodgeId: bookingLodgeId,
        memberId: owner.id,
        paymentReference,
        committedPriceCents: totalPriceCents,
        committedGuestCount: guests.length,
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


  // #2576 §7. Every path that can ENQUEUE bounded re-evaluation work must also
  // drain it: a queue row with nobody draining it turns the owner's "immediate
  // re-evaluation" into "within three hours", which is how long an officer-created
  // booking that has just RESTORED cover would leave a critical incident standing,
  // or one that removed it would leave the owner un-notified. Best-effort and
  // scoped to this booking's owner; the cron sweep is the authority on completion.
  if (!conversion.alreadyConverted) {
    await settleHostingCoverageAfterCommit({ bookingId: conversion.bookingId });
  }

  // Every post-commit side effect is guarded on !alreadyConverted so a replayed
  // approve never re-emails the member, never re-raises the money-critical
  // invoice, and never re-audits a conversion (#1232).
  let exclusiveHoldConflicts: HoldConflictBooking[] = [];
  let invoiceMode: "xero" | "manual" | null = null;
  if (!conversion.alreadyConverted) {
    logAudit({
      action: "booking_request.member_whole_lodge_approved",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      subjectMemberId: conversion.memberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary:
        "Member whole-lodge request approved and confirmed with an exclusive hold",
      metadata: {
        requestId: request.id,
        bookingId: conversion.bookingId,
        memberId: conversion.memberId,
        priceCents: totalPriceCents,
        // #2338: distinguish the flat whole-lodge branch from ordinary
        // per-guest season pricing so the audit trail names the money decision
        // (override > flat > per-guest, mirroring the pricing precedence above).
        priceSource:
          priceOverrideCents != null
            ? "admin_override"
            : flatWholeLodgeCents != null
              ? "whole_lodge_flat"
              : "season_rates",
        guestCount: guests.length,
        submittedGuestCount: submittedGuests.length,
        checkIn: request.checkIn.toISOString(),
        checkOut: request.checkOut.toISOString(),
        exclusivityRequested: true,
        wholeLodgeHold: true,
      },
    });

    // Conflict surfacing (ADR-001 decision 1, issue #119): read-only, ADMIN-ONLY,
    // computed AFTER the commit and outside the advisory lock. It never refuses
    // or displaces, and a failure here must not undo a committed approval.
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
        "Failed to compute exclusive-hold conflicts for an approved member whole-lodge request",
      );
    }

    logAudit({
      action: "booking.exclusiveHold.set",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      subjectMemberId: conversion.memberId,
      targetId: conversion.bookingId,
      entityType: "Booking",
      entityId: conversion.bookingId,
      category: "booking",
      severity: "important",
      outcome: "success",
      summary:
        "Exclusive whole-lodge hold set from an approved member whole-lodge request",
      metadata: {
        bookingId: conversion.bookingId,
        requestId: request.id,
        source: "member_request_approval",
        setByMemberId: input.adminMemberId,
        overlappingConflictCount: exclusiveHoldConflicts.length,
        overlappingConflictBookingIds: exclusiveHoldConflicts.map((c) => c.id),
      },
    });

    // Invoice the receivable, exactly as the school path and every other
    // INTERNET_BANKING creator does. Without this the PENDING Payment row above
    // is a receivable nobody was ever asked to collect: no Xero invoice, no
    // admin nudge, and a member who has been told an invoice is coming.
    if (await isEffectiveModuleEnabled("xeroIntegration")) {
      invoiceMode = "xero";
      try {
        const queuedInvoice = await enqueueXeroBookingInvoiceOperation(
          conversion.bookingId,
          { createdByMemberId: input.adminMemberId },
        );
        // #1620 floating-credit parity with the Internet Banking create path
        // (booking-create.ts): allocate the member's existing credit notes
        // against this invoice so they pay the credit-reduced amount. Enqueued
        // AFTER the invoice op (older createdAt is processed first). The owner
        // here is a real member who may well be carrying account credit — the
        // school path's non-login contact never is, which is why the school
        // block omits it.
        //
        // NO-OP TODAY (#2444 review, 1 Aug 2026) — the paragraph above states
        // the INTENT, not the behaviour. The enqueue only queues an op when the
        // booking already carries applied-credit ledger rows: the MemberCredit
        // type whose name #2328's guard greps this whole module for and never
        // finds. This conversion mints a brand-new booking and writes none, so
        // the call always returns `{ queueOperationId: null, message: "No
        // unallocated applied credit; nothing to allocate." }` and the Xero
        // invoice stands at the full price. It is kept as the structural hook
        // for the day this path can carry applied credit. Until then NOTHING
        // member-facing may claim the netting happens — see
        // `bookingPaymentDueNote`, whose first draft did exactly that.
        const queuedAllocation =
          await enqueueXeroAppliedCreditAllocationOperation(
            conversion.bookingId,
            { createdByMemberId: input.adminMemberId },
          );
        if (queuedInvoice.queueOperationId || queuedAllocation.queueOperationId) {
          await kickQueuedXeroOutboxOperationsIfConnected({ limit: 2 });
        }
      } catch (err) {
        logger.error(
          { err, bookingId: conversion.bookingId },
          "Failed to queue the Xero invoice for an approved member whole-lodge booking",
        );
      }
    } else {
      invoiceMode = "manual";
      // #2483: the member's confirmation nets the booking's price against the
      // club's own applied-credit ledger. On THIS branch there is no Xero
      // invoice and no allocation op, so nothing downstream would ever
      // reconcile an admin who invoiced the gross price against a member who
      // was told to transfer the netted one — the club would chase a shortfall
      // its own ledger says does not exist. So the admin's instruction is built
      // from the same ledger read. Zero today (this conversion mints a
      // brand-new booking and writes no `MemberCredit` row, which the #2328
      // module guard pins), so the alert is byte-for-byte unchanged; both sides
      // arm together the instant this path can carry applied credit. Fails open
      // to zero: an unreadable ledger must not withhold an invoice instruction.
      const manualInvoiceCreditCents = await deriveBookingAppliedCreditCents(
        conversion.bookingId,
      ).catch((err) => {
        logger.error(
          { err, bookingId: conversion.bookingId },
          "Failed to read applied credit for a manual whole-lodge invoice alert; invoicing the full price",
        );
        return 0;
      });
      sendAdminWholeLodgeManualInvoiceEmail({
        memberName: `${request.contactFirstName} ${request.contactLastName}`.trim(),
        contactEmail: request.contactEmail,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guestCount: guests.length,
        totalCents: totalPriceCents,
        appliedCreditCents: manualInvoiceCreditCents,
        paymentReference: conversion.paymentReference,
      }).catch((err) =>
        logger.error(
          { err, bookingId: conversion.bookingId },
          "Failed to send the manual-invoice admin notification for an approved member whole-lodge booking",
        )
      );
    }

    // Member-facing confirmation. Deliberately the ordinary booking-confirmed
    // message: it carries dates, guest count and total and NOTHING about
    // occupancy, exclusivity or the conflicts above — a member is never told the
    // lodge is exclusively held (ADR-001 decision 6). It is booking-scoped, so
    // the per-booking "No emails" switch can withhold it (#2258).
    //
    // `paymentDue` is what makes it TRUE: this booking is CONFIRMED but nothing
    // has been paid, so the message must not say "Total Paid" or "Payment has
    // been processed successfully". It states the amount owing and the
    // internet-banking reference (there is no PaymentLink to send them to), and
    // it only claims an invoice was emailed when one actually was.
    //
    // Sent to the OWNER's live account email, not the request-time snapshot: the
    // booking belongs to a live account whose address may have changed since the
    // request was submitted, and the request snapshot is a historical record.
    // Falls back to the snapshot only if the lookup fails.
    const ownerContact = await prisma.member
      .findUnique({
        where: { id: conversion.memberId },
        select: { email: true, firstName: true },
      })
      .catch(() => null);
    sendBookingConfirmedEmail(
      {
        bookingId: conversion.bookingId,
        recipientMemberId: conversion.memberId,
      },
      ownerContact?.email ?? request.contactEmail,
      ownerContact?.firstName ?? request.contactFirstName,
      request.checkIn,
      request.checkOut,
      guests.length,
      totalPriceCents,
      {
        lodgeId: conversion.lodgeId,
        paymentDue: {
          reference: conversion.paymentReference,
          invoiceEmailed: invoiceMode === "xero",
        },
      },
    ).catch((err) =>
      logger.error(
        { err, bookingId: conversion.bookingId },
        "Failed to send booking confirmation for an approved member whole-lodge request",
      )
    );
  } else {
    logAudit({
      action: "booking_request.member_whole_lodge_approve_idempotent_replay",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary:
        "Member whole-lodge request approve replayed idempotently; no second conversion",
      metadata: { bookingId: conversion.bookingId, requestId: request.id },
    });
  }

  return {
    type: "approved",
    requestId: request.id,
    bookingId: conversion.bookingId,
    memberId: conversion.memberId,
    // M4: the COMMITTED figures. Identical to totalPriceCents/guests.length on a
    // fresh conversion; re-read from the booking row on a replay, so the officer
    // is never shown a total this call computed but never wrote.
    priceCents: conversion.committedPriceCents,
    guestCount: conversion.committedGuestCount,
    invoiceMode,
    exclusiveHoldConflicts,
  };
}
