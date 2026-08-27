import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import {
  PaymentSource,
  type AgeTier,
  type BookingGuest,
} from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import {
  getDefaultLodgeCapacity,
  getLodgeCapacity,
} from "@/lib/lodge-capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  calculateBookingHoldDecision,
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  deletePromoRedemptionAndAdjustCount,
  lockAndRefreshPromoCodeUsage,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import { ApiError as SharedApiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import logger from "@/lib/logger";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { parseJsonRequestBody } from "@/lib/api-json";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  planMemberGuestConsentWrites,
  type MemberGuestConsentGuestFields,
  type MemberGuestConsentWritePlanEntry,
} from "@/lib/member-guest-add-policy";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
  PaidUpAdultMemberRequiredError,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { nameField } from "@/lib/zod-helpers";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTime } from "@/lib/club-time/server";
import { dateOnlyInstantOf } from "@/lib/club-time";
import {
  assertBookingNotQuotePriced,
  lockedNightPricesForGuest,
} from "@/lib/booking-modify";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  buildSameOwnerCoverageRefusalBody,
  hostingCoverageOverrideSchema,
} from "@/lib/adult-member-hosting-same-owner";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import {
  authorizationRoleFromAccessRoles,
  hasAdminAccess,
} from "@/lib/access-roles";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";

const addGuestsSchema = z.object({
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
      })
    )
    .min(1)
    .max(200),
  // #1769b (#1705 semantics): per-action member-email choice on this
  // dual-actor route. Absent = notify (default); false suppresses the
  // booking-modified email. Only an admin actor may carry it (403 gate
  // below); a non-boolean value is rejected with the schema 400.
  notifyMember: z.boolean().optional(),
  // #2576 §7: the officer's explicit confirmation and mandatory reason for
  // overriding a same-owner coverage refusal. Optional in the shape because the
  // first submission never carries it — the officer is asked only when the add
  // would actually strand another booking on the account.
  hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
});

type PromoRedemptionWithTargets = {
  promoCode: {
    assignedMembersOnlyOwnNights?: boolean | null;
    assignments: Array<{ memberId: string }>;
    lodges?: Array<{ lodgeId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

function promoRequiresStoredGuestTargets(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    redemption.promoCode.assignedMembersOnlyOwnNights === false
  );
}

function selectedIndexesForStoredGuestTargets(
  redemption: PromoRedemptionWithTargets,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // #2388: taken at the top so the collapsed-refusal timing floor covers the
  // whole request.
  const startedAt = startMemberGuestRefusalClock();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);
  const actorRole = authorizationRoleFromAccessRoles(session.user);

  const { id: bookingId } = await params;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = addGuestsSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // #1769b (#1705 semantics): only an admin actor may carry the per-action
  // member-email choice on this dual-actor route. A member self-service caller
  // carrying the flag is refused, so a member can never suppress their own
  // booking-modified email; member behaviour is otherwise unchanged.
  if (parsed.data.notifyMember !== undefined && !isAdmin) {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 }
    );
  }
  // Absent for any non-admin caller (defence in depth behind the 403 gate).
  const notifyMember = isAdmin ? parsed.data.notifyMember : undefined;

  const { guests: newGuests } = parsed.data;
  const payloadCapacity = await getDefaultLodgeCapacity();
  if (newGuests.length > payloadCapacity) {
    return NextResponse.json(
      {
        error: "Invalid input",
        details: {
          formErrors: [],
          fieldErrors: {
            guests: [`A booking cannot exceed ${payloadCapacity} guests`],
          },
        },
      },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // "+ Add Member Guest" (epic #2305, MG2 #2307). Read the module flag and the
  // policy singleton HERE, OUTSIDE the transaction below.
  //
  // This is the call site the ordering rule was written for. The resolver runs
  // INSIDE `prisma.$transaction`, after `acquireLodgeCapacityLock`, so the
  // obvious-looking place to read these values is right next to where they are
  // used — and that would hold the lodge's capacity lock across two extra queries
  // on every guest add, including the ones with no member guest in them.
  // `planMemberGuestConsentWrites` is pure, so only the READS have to move out.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  // MG4-D-a, brought forward: `isAdmin` is exactly the flag that passes
  // `skipAuthorization` on this route, so an admin add is consent-free and
  // always-notify, stamped with the admin who made it.
  const memberGuestActor: MemberGuestAddActor = isAdmin
    ? { kind: "ADMIN", adminMemberId: session.user.id }
    : { kind: "MEMBER" };

  // #2543 — read the lockout policy HERE, outside the transaction, for exactly
  // the reason stated above: the gate below runs after `acquireLodgeCapacityLock`
  // and `resolveSubscriptionLockoutMode` can reseed the financial-year cache from
  // Xero. A provider call under the capacity lock is forbidden, so the read moves
  // out and only the decision stays in.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  // #3123 — and the club's day, read HERE for exactly the same reason: the edit
  // policy below runs after `acquireLodgeCapacityLock` and under the global
  // cohort key, and resolving the club's persisted zone in there would be a
  // `clubTimeSettings.findUnique` taking a second pooled connection while those
  // locks are held (`INV-LOCK-004`). `getBookingEditPolicy` is a pure synchronous
  // classifier and now takes the day as a value.
  //
  // ONE day answers three questions on this path, and they must agree: the edit
  // policy's gate, and — inside the transaction — the promotion's validity
  // window (`validateAndCalculatePromoDiscount`) and the reduction refund's
  // settlement tier. Two reads could disagree across club midnight and let an
  // add-guest edit be admitted under one day and priced under another.
  const todayAtClub = (await clubTime()).today();
  const clubTodayDateOnly = dateOnlyInstantOf(todayAtClub);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      // Lock the booking's lodge before re-reading it; the booking's lodge
      // cannot change, so the pre-read outside the lock is safe for key
      // selection.
      const lockTarget = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { lodgeId: true },
      });
      const bookingLodgeId =
        lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          guests: {
            include: {
              nights: { select: { stayDate: true, priceCents: true } },
            },
          },
          payment: true,
          member: true,
          promoRedemption: {
            include: {
              guestTargets: { select: { bookingGuestId: true } },
              promoCode: {
                include: {
                  assignments: { select: { memberId: true } },
                  lodges: { select: { lodgeId: true } },
                },
              },
            },
          },
        },
      });

      if (!booking) {
        throw new ApiError("Booking not found", 404);
      }

      if (
        booking.memberId !== session.user.id &&
        !isAdmin
      ) {
        throw new ApiError("Forbidden", 403);
      }

      if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
        throw new ApiError(
          "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
          400
        );
      }

      const editPolicy = getBookingEditPolicy({
        status: booking.status,
        role: actorRole,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        today: clubTodayDateOnly,
      });
      if (!editPolicy.canModify) {
        throw new ApiError(
          editPolicy.reason ?? "This booking cannot be modified",
          400
        );
      }
      await assertBookingNotQuotePriced(tx, bookingId);
      if (editPolicy.mode !== "future") {
        throw new ApiError(
          "Use the full booking edit flow for in-progress booking guest changes",
          400
        );
      }

      const lodgeCapacity = await getLodgeCapacity(bookingLodgeId, tx);
      if (booking.guests.length + newGuests.length > lodgeCapacity) {
        throw new ApiError(
          `A booking cannot exceed ${lodgeCapacity} guests`,
          400,
        );
      }

      // Normalization can widen a linked guest's tier to the member's
      // stored AgeTier, so the element type widens ageTier (only) beyond
      // the bookable-tier zod inference.
      let normalizedNewGuests: Array<
        Omit<(typeof newGuests)[number], "ageTier"> & { ageTier: AgeTier } &
          MemberGuestConsentGuestFields
      > = newGuests;
      // The cross-family rows this add will create, keyed by target member id.
      // Populated inside the transaction and consumed AFTER it commits.
      let memberGuestEntries = new Map<string, MemberGuestConsentWritePlanEntry>();
      try {
        const { members: linkedMembers, boundary } =
          await resolveLinkedBookingMembersWithBoundary(
            tx,
            booking.memberId,
            newGuests.map((guest) => guest.memberId),
            {
              skipAuthorization: isAdmin,
              memberGuestWideningEnabled: memberGuestPolicy.wideningEnabled,
            }
          );
        await assertLinkedBookingMembersCanBeBooked(
          tx,
          linkedMembers,
          session.user.id,
          {
            actorRole,
            onBehalfOfMemberId: isAdmin ? booking.memberId : null,
            // D-8: a blocked cross-family member is refused neutrally.
            crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
          }
        );
        // Planned before the person-night guard and the unpaid-subscription check
        // below, because both read the D-8 marker this attaches.
        const consentPlan = planMemberGuestConsentWrites({
          guests: normalizeBookingGuestInputs(newGuests, linkedMembers),
          boundary,
          actor: memberGuestActor,
          now: new Date(),
          bookingCheckIn: booking.checkIn,
          policy: memberGuestPolicy,
        });
        normalizedNewGuests = consentPlan.guests;
        memberGuestEntries = consentPlan.entriesByMemberId;
      } catch (error) {
        if (error instanceof BookingGuestValidationError) {
          throw error;
        }
        throw error;
      }

      await assertNoBookingMemberNightConflicts(tx, {
        actorMemberId: session.user.id,
        actorRole,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guests: normalizedNewGuests,
        excludeBookingId: bookingId,
        // Resolved above, before this transaction opened (`INV-LOCK-004`) — the
        // same club day the edit policy and the removal window already read.
        today: clubTodayDateOnly,
      });

      const seasonYear = seasonYearOfStoredDate(booking.checkIn);
      await assertMembershipTypeBookingAllowed(tx, {
        ownerMemberId: booking.memberId,
        guests: [
          ...booking.guests,
          ...normalizedNewGuests.map((guest) => ({
            isMember: guest.isMember,
            memberId: guest.memberId ?? null,
          })),
        ],
        seasonYear,
        // Finding 2 (privacy re-review of MG3 #2308).
        skipAuthorization: isAdmin,
      });

      if (!isAdmin) {
        const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
          bookingMemberId: booking.memberId,
          checkIn: booking.checkIn,
          guests: normalizedNewGuests,
        });

        // #2543: mode-gated exactly as on the four sibling paths. The call above
        // still runs under NON_MEMBER_PRICING so the D-8 cross-family refusal is
        // untouched; only this refusal is the lockout policy's to relax.
        if (
          subscriptionLockoutMode === "HARD_BLOCK" &&
          unpaidMemberGuests.length > 0
        ) {
          throw new ApiError(
            `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
            403
          );
        }

        // #2543 — the paid-up-adult requirement over the party AFTER the add.
        // Adding a guest is a booking write, so a booking that was legal when it
        // was made can be pushed out of compliance by an add, and the same
        // exception-request door opens.
        const nonMemberPricing = await evaluateNonMemberPricingRequirements(tx, {
          mode: subscriptionLockoutMode,
          lodgeId: bookingLodgeId,
          seasonYear,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          // Owner decision, 3 Aug 2026: an unfinancial owner triggers the
          // requirement whether or not they hold a bed on the booking they are
          // adding to.
          bookingOwnerMemberId: booking.memberId,
          // D-12 over the whole post-add party. `toSubscriptionLockoutParticipants`
          // reads a persisted row's `consentStatus` and a pre-persist row's planned
          // `memberGuestConsent.consentStatus`, which is exactly the two shapes
          // here, so both lists go through the one helper rather than each
          // inventing its own mapping. A cross-family member guest is added PENDING
          // — they have not accepted yet — so they must not be the paid-up adult
          // who satisfies the requirement; otherwise the rule is trivially
          // satisfiable, since the invite need never be accepted. A family-scope
          // add carries no consent columns at all, and absent means present,
          // exactly as #2364 has it. An added guest carries no per-guest stay range
          // on this route, so a null envelope falls back to the booking's, which is
          // what the participant mapper does.
          participants: toSubscriptionLockoutParticipants([
            ...booking.guests,
            ...normalizedNewGuests,
          ]),
        });
        if (nonMemberPricing?.violation) {
          throw new PaidUpAdultMemberRequiredError(nonMemberPricing.violation);
        }
      }

      // Capacity check excluding this booking (using tx to participate in advisory lock)
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        booking.checkIn,
        booking.checkOut,
        [
          ...booking.guests,
          ...normalizedNewGuests.map(() => ({
            stayStart: booking.checkIn,
            stayEnd: booking.checkOut,
          })),
        ],
        bookingId,
        tx
      );

      if (!capacity.available) {
        throw new ApiError(
          "Not enough beds available to add these guests",
          400
        );
      }

      // Load seasons for pricing
      const seasons = await tx.season.findMany({
        where: { active: true, ...lodgeNullTolerantScope(bookingLodgeId) },
        include: { membershipTypeRates: true },
      });

      // #2756: through the shared mapper, which carries the season's `type`.
      // INV-MOD-006 names this route as the one that prices the whole post-add
      // party, but the hand-rolled literal it used dropped `type`, so the discount
      // it exists to apply could never qualify at a club on the DEFAULT
      // `summerOnly: true` setting.
      const seasonRateData: SeasonRateData[] = toSeasonRateData(seasons);

      // Calculate price for new guests
      const newGuestInputs = normalizedNewGuests.map((g) => ({
        ageTier: g.ageTier as AgeTier,
        isMember: g.isMember,
        memberId: g.memberId ?? null,
      }));

      // Price the whole post-add party together (#1095): the group discount
      // depends on party size per night, so a new guest joining a qualifying
      // party must price at the discounted rate — a standalone new-guest
      // pricing pass can never see the party. Existing guests are fully
      // locked (#1036), so the new guests' slices of this breakdown are
      // exactly their own prices.
      const allGuestsForPricing = [
        ...booking.guests.map((g) => ({
          bookingGuestId: g.id,
          ageTier: g.ageTier as AgeTier,
          isMember: g.isMember,
          memberId: g.memberId ?? null,
          // Price existing guests over exactly the nights they hold (#1093):
          // their stored night set (or stay envelope for pre-#713 guests
          // without rows), never the full booking range — a partial-stay
          // guest must not grow phantom nights because someone else was added.
          stayStart: g.stayStart,
          stayEnd: g.stayEnd,
          nights: g.nights && g.nights.length > 0 ? g.nights : null,
          // Existing guests keep their booked nightly prices (#1036): adding
          // a guest must cost exactly the added guest's own price.
          lockedNightPrices: lockedNightPricesForGuest(g),
        })),
        ...newGuestInputs,
      ];
      const requiresAdminReview = requiresAdultSupervisionReview(allGuestsForPricing);
      const adminReviewReason = requiresAdminReview
        ? ADULT_SUPERVISION_REVIEW_REASON
        : null;

      const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
        where: { id: "default" },
      });

      let fullPriceBreakdown;
      try {
        fullPriceBreakdown = await priceBookingGuestsWithMembershipTypePolicy(tx, {
          ownerMemberId: booking.memberId,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: allGuestsForPricing,
          seasons: seasonRateData,
          // Edit-time mapper (#2770, INV-MOD-026): adding a guest to an
          // existing booking is the archetypal later edit, so the club's
          // `applyToEdits` switch decides whether the added guest's nights earn
          // the discount. Off resolves to no config, so the added guest prices
          // exactly as they would at a club with no group discount; the party
          // already on the booking keeps its locked nightly prices either way
          // (#1036, INV-MOD-005).
          groupDiscount: toEditTimeGroupDiscountConfig(groupDiscountSetting),
          seasonYear,
          // #2543 — the mode this request already resolved. This call runs inside
          // the transaction holding the per-lodge capacity lock, so being handed
          // the mode also removes a second pooled connection from under the lock.
          subscriptionLockoutMode,
          // Finding 2 (privacy re-review of MG3 #2308).
          skipAuthorization: isAdmin,
        });
      } catch (error) {
        if (error instanceof MembershipTypeBookingPolicyError) {
          throw error;
        }
        throw new ApiError(
          "No season rate found for the booking dates",
          400
        );
      }

      // Create BookingGuest records from their slice of the full-party
      // breakdown, persisting one BookingGuestNight row per priced night
      // (#1093) so added guests join the uniform night-row model: without
      // rows, a later edit would reprice their whole stay at current season
      // rates instead of honouring the prices they booked at (#1036).
      const createdGuests: BookingGuest[] = [];
      for (let i = 0; i < normalizedNewGuests.length; i++) {
        const priced = fullPriceBreakdown.guests[booking.guests.length + i];
        const guest = await tx.bookingGuest.create({
          data: {
            bookingId,
            firstName: normalizedNewGuests[i].firstName,
            lastName: normalizedNewGuests[i].lastName,
            ageTier: normalizedNewGuests[i].ageTier,
            isMember: normalizedNewGuests[i].isMember,
            memberId: normalizedNewGuests[i].memberId || null,
            stayStart: booking.checkIn,
            stayEnd: booking.checkOut,
            priceCents: priced.priceCents,
            // Persist the rate-type snapshot at creation (#1930, E4) so a later
            // Xero line picks the matching item code.
            rateMembershipTypeId: priced.rateMembershipTypeId,
            // Member-guest consent (MG2 #2307), already decided by
            // `buildMemberGuestConsentWrite`. Spread only when present: a
            // family-scope or non-member guest writes exactly what it wrote
            // before.
            ...(normalizedNewGuests[i].memberGuestConsent ?? {}),
            nights: {
              create: (priced.nightDates ?? []).map((stayDate, k) => ({
                stayDate,
                priceCents: priced.perNightCents[k] ?? 0,
              })),
            },
          },
        });
        createdGuests.push(guest);
      }

      const guestNightRates = allGuestsForPricing.map((guest, index) => ({
        bookingGuestId:
          index < booking.guests.length
            ? booking.guests[index].id
            : createdGuests[index - booking.guests.length]?.id ?? null,
        memberId: guest.memberId ?? null,
        isMember: guest.isMember,
        perNightRates: fullPriceBreakdown.guests[index].perNightCents,
        nightDates: fullPriceBreakdown.guests[index].nightDates,
        // nightDates carry each guest's actual priced nights (partial stays
        // included); firstNight remains the booking's check-in so internal
        // work-party promos date their window from the stay start.
        firstNight: booking.checkIn,
      }));

      const newTotalPriceCents = fullPriceBreakdown.totalPriceCents;

      // Recalculate promo discount
      let newDiscountCents = 0;
      let newPromoAdjustmentCents = 0;
      let promoRemoved = false;
      let promoCoverage: PromoCoverageNotice | null = null;

      if (booking.promoRedemption?.promoCode) {
        // Row-lock the promo code and re-read its usage counter before the caps
        // are checked (#2299). Adding a member guest to an assigned promo makes
        // that member a NEW beneficiary, so this path can take a
        // total-redemptions slot, not just keep one — two concurrent add-guest
        // requests on different bookings could otherwise both pass a
        // "one use left" check. The per-lodge capacity lock is already held, so
        // the order stays lodge -> promo row.
        const promo = await lockAndRefreshPromoCodeUsage(
          tx,
          booking.promoRedemption.promoCode
        );
        const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
          booking.promoRedemption,
          guestNightRates
        );
        const application = await validateAndCalculatePromoDiscount(
          promo,
          {
            memberId: booking.memberId,
            bookingCheckIn: booking.checkIn,
            totalPriceCents: newTotalPriceCents,
            guests: guestNightRates,
          },
          promo.assignments.length > 0
            ? promo.assignments.map((assignment) => assignment.memberId)
            : null,
          {
            excludeBookingId: bookingId,
            db: tx,
            selectedGuestIndexes,
            lodgeId: bookingLodgeId,
            // #2390: adding guests is the edit most likely to outgrow a cap.
            // Everyone already benefiting keeps the discount; the new arrivals
            // are priced normally and named in the response.
            capOverflow: "coverExisting",
            // #3123 — resolved above, before this transaction opened
            // (`INV-LOCK-004`).
            todayAtClub,
          }
        );

        if (application.error || !application.discount) {
          promoRemoved = true;
          await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
        } else {
          const promoResult = application.discount;
          newDiscountCents = promoResult.discountCents;
          newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
          promoCoverage = await describePromoCapCoverage(tx, {
            promoCode: promo.code,
            capCoverage: application.capCoverage,
          });

          await replacePromoRedemptionAllocations(
            tx,
            booking.promoRedemption,
            newDiscountCents,
            newPromoAdjustmentCents,
            promoResult.freeNightsUsed,
            promoResult.eligibleGuestCount,
            promoResult.allocations,
            targetBookingGuestIdsForSelectedIndexes(
              guestNightRates,
              application.selectedGuestIndexes
            ),
          );
        }
      }

      const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
      const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

      // Update hasNonMembers
      const addingNonMembers = normalizedNewGuests.some((g) => !g.isMember);
      const hasNonMembers = booking.hasNonMembers || addingNonMembers;

      // Recalculate member-priority hold state if this edit leaves non-members
      // on a pre-payment booking. Disabled or inside-window holds are cleared.
      let nonMemberHoldUntil = booking.nonMemberHoldUntil;
      let holdAdjustedStatus = booking.status;
      if (
        hasNonMembers &&
        (booking.status === "PENDING" || booking.status === "PAYMENT_PENDING")
      ) {
        const holdPolicy = await getNonMemberHoldPolicy(booking.checkIn, booking.lodgeId, tx);
        const holdDecision = calculateBookingHoldDecision({
          hasNonMembers,
          checkIn: booking.checkIn,
          holdDays: holdPolicy.holdDays,
          holdEnabled: holdPolicy.enabled,
        });
        if (holdDecision.shouldBePending && booking.status === "PENDING") {
          nonMemberHoldUntil = new Date(
            new Date(booking.checkIn).getTime() -
              holdPolicy.holdDays * 24 * 60 * 60 * 1000
          );
        } else {
          nonMemberHoldUntil = null;
          if (booking.status === "PENDING") {
            holdAdjustedStatus = "PAYMENT_PENDING";
          }
        }
      } else if (!hasNonMembers) {
        nonMemberHoldUntil = null;
      }

      // Calculate additional amount for confirmed+paid bookings
      let additionalAmountCents = 0;
      const hasSettledPayment =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        booking.payment?.status === "SUCCEEDED";
      const hasSucceededPayment =
        hasSettledPayment && booking.payment?.source === PaymentSource.STRIPE;
      const hasIssuedXeroInvoice =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        !!booking.payment?.xeroInvoiceId;

      if ((hasSucceededPayment || hasIssuedXeroInvoice) && priceDiffCents > 0) {
        additionalAmountCents = priceDiffCents;
      }

      // This route only adds guests, so the no-adult rule can only
      // change from flagged → cleared (by adding an adult). When that
      // happens, wipe the review state and release the booking from
      // AWAITING_REVIEW. The rule cannot newly trip through this route.
      const reviewCleared = booking.requiresAdminReview && !requiresAdminReview;
      const reviewFieldUpdates = reviewCleared
        ? {
            requiresAdminReview: false,
            adminReviewReason: null,
            memberReviewJustification: null,
            adminReviewStatus: null,
            adminReviewNotes: null,
            adminReviewedById: null,
            adminReviewedAt: null,
          }
        : {
            requiresAdminReview,
            adminReviewReason,
          };

      const newStatus =
        reviewCleared && booking.status === "AWAITING_REVIEW"
          ? "PAYMENT_PENDING"
          : holdAdjustedStatus;

      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          promoAdjustmentCents: newPromoAdjustmentCents,
          finalPriceCents: newFinalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          status: newStatus,
          ...reviewFieldUpdates,
        },
        include: { guests: true, payment: true },
      });

      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      // #2364. Adding guests is the most likely way a hosting hazard both
      // appears (a non-member joins nights nobody covers) and disappears (an
      // adult member is added to cover them), so the review is re-derived from
      // the rows just written. `tx` because this transaction holds the per-lodge
      // capacity lock.
      //
      // #2576 §6: adding guests changes the participant-night picture, which can
      // take exact-night cover away from another booking on this account (a night
      // range that shifts, an adult member whose row is replaced). The disposition
      // travels with the actor.
      await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
          ...hostingCoverageActorOptions({
          actorRole,
          hasBookingsEditAccess: isAdmin,
          actorMemberId: session.user.id,
          ...(parsed.data.hostingCoverageOverride
            ? { override: parsed.data.hostingCoverageOverride }
            : {}),
        }),
      });

      // Create BookingModification record
      const bookingModification = await tx.bookingModification.create({
        data: {
          bookingId,
          memberId: session.user.id,
          modificationType: "GUEST_ADD",
          previousData: {
            guestCount: booking.guests.length,
            totalPriceCents: booking.totalPriceCents,
            discountCents: booking.discountCents,
            promoAdjustmentCents: booking.promoAdjustmentCents,
            finalPriceCents: booking.finalPriceCents,
          },
          newData: {
            guestCount: updatedBooking.guests.length,
            addedGuests: normalizedNewGuests.map((g) => ({
              firstName: g.firstName,
              lastName: g.lastName,
              ageTier: g.ageTier,
              isMember: g.isMember,
            })),
            totalPriceCents: newTotalPriceCents,
            discountCents: newDiscountCents,
            promoAdjustmentCents: newPromoAdjustmentCents,
            finalPriceCents: newFinalPriceCents,
            // #2390: the same sentence the member was shown, kept on the
            // booking's own history so the split has an answer later.
            ...(promoCoverage ? { promoCoverageNote: promoCoverage.message } : {}),
          },
          priceDiffCents,
          changeFeeCents: 0,
        },
      });

      return {
        booking: updatedBooking,
        addedGuests: createdGuests,
        priceDiffCents,
        additionalAmountCents,
        promoRemoved,
        promoCoverage,
        oldGuestCount: booking.guests.length,
        hasSucceededPayment,
        hasIssuedXeroInvoice,
        paymentStatus: booking.payment?.status ?? null,
        paymentSource: booking.payment?.source ?? null,
        paymentReference: booking.payment?.reference ?? null,
        xeroInvoiceNumber: booking.payment?.xeroInvoiceNumber ?? null,
        paymentId: booking.payment?.id ?? null,
        paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
        memberEmail: booking.member.email,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        memberId: booking.memberId,
        addedGuestNames: normalizedNewGuests.map((guest) => `${guest.firstName} ${guest.lastName}`),
        bookingModificationId: bookingModification.id,
        // MG2 #2307: the cross-family rows to tell about, matched to the guest
        // ids this transaction actually created. Carried OUT of the transaction
        // so the sends happen after the commit — no provider call may sit inside
        // a booking transaction holding the capacity lock.
        memberGuestNotificationRows: matchMemberGuestNotificationRows({
          createdGuests: createdGuests,
          entriesByMemberId: memberGuestEntries,
        }),
        // #2284 (S2): every member id this add created a guest row for, carried
        // out of the transaction so the family-scope FYI can be sent after the
        // commit. The dispatcher decides which are family scope.
        familyAddMemberIds: createdGuests
          .map((guest) => guest.memberId)
          .filter((memberId): memberId is string => Boolean(memberId)),
      };
    });

    // #2576 §7/§8: drain the bounded re-evaluation this add committed, if any.
    // Adding guests can move an account's cover in either direction, so this both
    // opens incidents and resolves ones the add has just fixed.
    await settleHostingCoverageAfterCommit({ bookingId });

    // AFTER the commit, and awaited rather than fire-and-forget: an unsent consent
    // request leaves a PENDING row holding a bed (D-4) that nobody was ever asked
    // about, and a `void` promise is what a serverless freeze after the response
    // drops.
    if (result.memberGuestNotificationRows.length > 0) {
      // Loaded lazily: the sender pulls in the whole email/template graph, and
      // only a booking that actually added a cross-family member guest needs it.
      const { sendMemberGuestAddNotifications } = await import(
        "@/lib/member-guest-consent-notifications"
      );
      // Belt and braces around a function documented never to reject: the booking
      // is ALREADY COMMITTED here, so an unexpected throw would hand the member an
      // error for a booking that exists. A notification problem is logged, never
      // surfaced as a booking failure.
      try {
        await sendMemberGuestAddNotifications({
          bookingId,
          rows: result.memberGuestNotificationRows,
          actor: memberGuestActor,
        });
      } catch (err) {
        logger.error(
          { err, bookingId },
          "Failed to dispatch member-guest add notifications",
        );
      }
    }

    // #2284 (S2): tell FAMILY co-members (or the adults acting for them) that
    // this add put them on the booking. Runs regardless of the memberGuests
    // module and filters to family scope itself, so it never doubles the
    // member-guest dispatch above.
    if (result.familyAddMemberIds.length > 0) {
      const { sendFamilyMemberBookingAddNotifications } = await import(
        "@/lib/family-booking-add-notifications"
      );
      try {
        await sendFamilyMemberBookingAddNotifications({
          bookingId,
          bookerMemberId: result.booking.memberId,
          actorMemberId: session.user.id,
          addedMemberIds: result.familyAddMemberIds,
        });
      } catch (err) {
        logger.error(
          { err, bookingId },
          "Failed to dispatch family booking-add notifications",
        );
      }
    }

    // Create additional PaymentIntent for price increases (outside transaction
    // to avoid holding the advisory lock). Shared settlement helper (#1096):
    // a transient Stripe failure enqueues a durable recovery operation keyed
    // to this modification instead of only logging.
    const { additionalPaymentClientSecret, additionalPaymentIntentId } =
      await createModificationAdditionalPaymentIntent({
        bookingId,
        // Guest adds never decrease the price, so the shared settlement
        // context's refund side is always zero here.
        result: { ...result, pendingRefundAmountCents: 0 },
        reason: "guest_add_price_increase",
        idempotencyKey: `mod_guest_${bookingId}_${result.bookingModificationId}`,
        failureMessage:
          "Failed to create additional PaymentIntent for guest addition",
      });

    // Audit log
    logAudit({
      action: "booking.modify.guests.add",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking guests added",
      details: JSON.stringify({
        addedGuests: result.addedGuestNames,
        priceDiffCents: result.priceDiffCents,
      }),
      metadata: {
        bookingId,
        addedGuests: result.addedGuestNames,
        priceDiffCents: result.priceDiffCents,
        newGuestCount: result.booking.guests.length,
        // #1769b honesty rule: the guest-add modified email always sends when a
        // member exists, so record the notify choice whenever it was
        // suppressed (notifyMember === false already implies admin via the 403
        // gate above).
        ...(notifyMember === false ? { notifyMember: false } : {}),
      },
      ipAddress,
    });

    void queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId: result.bookingModificationId,
      createdByMemberId: session.user.id,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      originalPaymentStatus: result.paymentStatus,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: 0,
      datesChanged: false,
      requiresAdditionalStripePayment:
        result.hasIssuedXeroInvoice && result.priceDiffCents > 0 && result.hasSucceededPayment,
      additionalPaymentIntentId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for guest addition")
    );

    // Send email
    const member = await prisma.member.findUnique({
      where: { id: result.booking.memberId },
    });
    if (member && notifyMember !== false) {
      sendBookingModifiedEmail({
        bookingId: result.booking.id,
        recipientMemberId: member.id,
        email: member.email,
        firstName: member.firstName,
        modificationType: "GUEST_ADD",
        oldCheckIn: result.booking.checkIn,
        oldCheckOut: result.booking.checkOut,
        newCheckIn: result.booking.checkIn,
        newCheckOut: result.booking.checkOut,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: 0,
        refundAmountCents: 0,
        additionalAmountCents: result.additionalAmountCents,
        additionalPaymentMethod:
          result.additionalAmountCents > 0 &&
          result.paymentSource === PaymentSource.INTERNET_BANKING
            ? "INTERNET_BANKING"
            : result.additionalAmountCents > 0 && result.hasSucceededPayment
              ? "STRIPE"
              : undefined,
        paymentReference: result.paymentReference,
        xeroInvoiceNumber: result.xeroInvoiceNumber,
        // #2390: same words as the edit preview and the booking history.
        promoCoverageNote: result.promoCoverage?.message ?? null,
        lodgeId: result.booking.lodgeId,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    return NextResponse.json({
      booking: result.booking,
      addedGuests: result.addedGuests,
      priceDiffCents: result.priceDiffCents,
      additionalAmountCents: result.additionalAmountCents,
      additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
      promoRemoved: result.promoRemoved,
      // #2390: who the promotion still covers, and who it does not. Null unless
      // a usage cap left somebody out.
      promoCoverage: result.promoCoverage,
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). The membership-type refusal
      // is D-8's FOURTH collapsing refusal, so when it collapsed it owes the
      // same three mitigations as its siblings — the throttle unit, the audit
      // row naming actor and target, and the timing floor. A no-op for every
      // other membership-type block: the handler returns immediately unless the
      // error carries `crossFamilyMemberIds`, which only a collapsed one does.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/guests-add",
        startedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingGuestValidationError) {
      // #2388, refusal path only. Unlike the quote routes, this one resolves its
      // members INSIDE `prisma.$transaction` while holding the per-lodge capacity
      // lock, so the throttle cannot be applied on the success path there — a
      // rate-limit counter write is a second connection, and taking one while
      // holding that lock is how a deadlock gets introduced. Spending the budget
      // here instead (the transaction has already rolled back) still counts every
      // probe, and the channel #2388 describes is built out of refusals anyway. A
      // SUCCESSFUL add on this route is not a probe: it mutates a real booking and
      // emails the person it added.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/guests-add",
        startedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(err),
        { status: err.status }
      );
    }
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #2543 — must be tested BEFORE the shared-ApiError branch below (it is a
    // subclass): the refusal carries the frozen exception evidence that tells
    // the member they may ask a Booking Officer, and the generic branch would
    // flatten it to a bare sentence and close that door.
    if (err instanceof PaidUpAdultMemberRequiredError) {
      return NextResponse.json(buildPaidUpAdultRefusalBody(err.violation), {
        status: err.status,
      });
    }
    // #2569 — same reason, same order: `AdultMemberHostingRequiredError` extends
    // ApiError, so it must be tested BEFORE the generic branch or the ENFORCED
    // hosting refusal is flattened to a bare sentence and the member loses the
    // exception door. Host identities are withheld from this body (#2569 §5).
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(
        buildAdultMemberHostingRefusalBody(err.violation),
        { status: err.status },
      );
    }
    // #2576 §6, ABOVE the shared-ApiError branch below: this refusal is a
    // subclass, and answered generically the member loses the list of their own
    // bookings, lodges and nights that tells them what to fix.
    if (err instanceof SameOwnerCoverageWouldBreakError) {
      return NextResponse.json(buildSameOwnerCoverageRefusalBody(err), {
        status: err.status,
      });
    }
    // #2576 §7. The officer is not refused: they are shown which bookings and
    // nights the change would strand and asked to confirm it with a reason.
    if (err instanceof SameOwnerCoverageOverrideRequiredError) {
      return NextResponse.json(
        buildSameOwnerCoverageOverrideRequiredBody(err),
        { status: err.status },
      );
    }
    // Shared-lib domain errors (e.g. the #1032 quote-priced edit block from
    // assertBookingNotQuotePriced) are the shared ApiError class, distinct
    // from this route's local ApiError above.
    if (err instanceof SharedApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err, bookingId }, "Failed to add guests to booking");
    return NextResponse.json(
      { error: "Failed to add guests" },
      { status: 400 }
    );
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
