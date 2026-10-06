import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  type GroupDiscountConfig,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  toEditTimeGroupDiscountConfig,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { applyBookingPromotions } from "@/lib/booking-promotions";
import { validateSeveralPromoCodes } from "@/lib/promo-codes-preview";
import { clubTime } from "@/lib/club-time/server";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { refuseOnBehalfUnlessBookingOfficer } from "@/lib/on-behalf-booking";
import {
  BookingGuestStayRangeValidationError,
  type NormalizedBookingGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { workPartyWindowOverlapsStay } from "@/lib/work-party";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { normalizePromoCodeInput } from "@/lib/promo-code-list-rules";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { loadMemberGuestAddPolicy, planMemberGuestConsentWrites } from "@/lib/member-guest-add-policy";
import { guestConsentStatus } from "@/lib/member-guest-consent";
import { bookingForPromoLookup } from "@/lib/promo-guest-codes";
import type { MemberGuestConsentStatus } from "@prisma/client";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const validateSchema = z
  .object({
    code: z.string().min(1).optional(),
    // Work party (working bee) event preview: resolves the event's internal
    // promo server-side; the internal code is never sent to or accepted
    // from the client.
    workPartyEventId: z.string().min(1).optional(),
    checkIn: dateOnlyString.transform(parseDateOnly),
    checkOut: dateOnlyString.transform(parseDateOnly),
    guests: z
      .array(
        z.object({
          ageTier: bookableAgeTierEnum,
          isMember: z.boolean(),
          memberId: z.string().min(1).optional(),
          stayStart: z.string().optional(),
          stayEnd: z.string().optional(),
          // #3827 (D-3813-4): optional, and it can only make a guest MORE
          // pending. Whether a guest awaits acceptance is decided server-side
          // below, the way the create decides it; no client sends this today.
          awaitingAcceptance: z.boolean().optional(),
          // #3492: on an edit preview (`bookingId` below), the row this guest
          // already is on that booking, so their STORED consent is used — the
          // way `modify-quote` and the save judge them — instead of re-deciding
          // it as a fresh add. Ignored without an owned `bookingId`.
          bookingGuestId: z.string().min(1).max(64).optional(),
        })
      )
      .min(1),
    forMemberId: z.string().optional(),
    promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
    // #3827: several codes, in the booker's order (D-3813-2), each with its own
    // guest choice. Combines with a working bee (D-3813-3). The response then
    // answers per code plus the booking's totals.
    codes: z
      .array(
        z.object({
          code: z.string().min(1).max(50),
          promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    // Lodge the booking under quote is for (multi-lodge phase 8): promo
    // lodge restrictions and season pricing validate against this lodge.
    // Omitted resolves to the default lodge, so single-lodge clients keep
    // working unchanged.
    lodgeId: z.string().min(1).optional(),
    // WHICH KIND OF PURCHASE this preview is for (#2770, INV-MOD-026). This one
    // route serves both the create wizard (a first purchase) and the edit panel
    // (a later edit), and the two resolve their group discount through different
    // mappers, because the club's `applyToEdits` switch governs edits only. The
    // caller has to say which, because the route cannot tell from the body: the
    // guests, dates and code look the same either way.
    //
    // Optional and defaulting to a FIRST purchase, so every existing client — the
    // member wizard, the admin book page — keeps behaving exactly as it does now.
    // A client that lied about this could only mislead ITSELF: the preview is
    // never the charge. `modify-quote` recomputes the promo on its own gated
    // pricing and the save path recomputes it again, so the money is decided
    // there, not here (#1095).
    forBookingEdit: z.boolean().optional(),
    // #3492: the booking an EDIT preview is for. Read only for its guests'
    // stored consent (above); the caller must own it or hold the
    // booking-management role, and any other id answers exactly as a missing
    // booking does (404), so it confirms nothing about an id.
    bookingId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (data) =>
      data.codes
        ? !data.code
        : Boolean(data.code) !== Boolean(data.workPartyEventId),
    {
      message: "Provide either a promo code or a working bee event, not both",
    },
  )
  .refine((data) => !data.workPartyEventId || Boolean(data.lodgeId), {
    message: "lodgeId is required for a working bee event",
    path: ["lodgeId"],
  });

export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = validateSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { code, checkIn, checkOut } = parsed.data;
  let guests: Array<(typeof parsed.data.guests)[number] & NormalizedBookingGuestStayRange>;
  try {
    guests = normalizeGuestStayRanges(parsed.data.guests, { checkIn, checkOut });
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  // On-behalf promo validation follows the booking create/quote rule (#1442):
  // bookings:edit holders validate against the target member; an unauthorized
  // forMemberId is rejected rather than silently checked against the caller.
  const onBehalfRefusal = refuseOnBehalfUnlessBookingOfficer(session.user, parsed.data.forMemberId);
  if (onBehalfRefusal) return onBehalfRefusal;
  const effectiveMemberId = parsed.data.forMemberId ?? session.user.id;
  // #3492: an edit preview judges a guest already on the booking by the consent
  // stored on their row (D-3492-4: a confirmed cross-family guest's code counts),
  // exactly as `modify-quote` does. Unowned or missing: one 404, no difference.
  //
  // A row's stored consent belongs to the MEMBER on that row, never to whatever
  // member the request names beside its id: it is used only when the row's
  // member is the request guest's member. Otherwise — a borrowed booker or
  // family row paired with a stranger's id, a row on another booking, an
  // unknown id — the guest is judged as a fresh add, the same answer as sending
  // no row id at all, so the pairing neither widens who counts as present
  // (D-3492-3/4, D-3813-4) nor tells the caller anything.
  let storedGuestById: Map<string, { memberId: string | null; consentStatus: MemberGuestConsentStatus | null }> | null =
    null;
  if (parsed.data.bookingId) {
    const booking = await bookingForPromoLookup({
      bookingId: parsed.data.bookingId,
      actorMemberId: session.user.id,
      isBookingOfficer: bookingManagementAuthorizationRole(session.user) === "ADMIN",
    });
    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    const bookingGuestIds = guests.flatMap((guest) => (guest.bookingGuestId ? [guest.bookingGuestId] : []));
    storedGuestById = new Map(
      bookingGuestIds.length
        ? (
            await prisma.bookingGuest.findMany({
              where: { bookingId: booking.id, id: { in: bookingGuestIds } },
              select: { id: true, memberId: true, consentStatus: true },
            })
          ).map((row) => [row.id, { memberId: row.memberId, consentStatus: row.consentStatus }])
        : [],
    );
  }
  /** The stored row for this guest, only when it is this guest's own member's row. */
  const storedRowFor = (guest: { bookingGuestId?: string; memberId?: string }) => {
    const row = guest.bookingGuestId ? storedGuestById?.get(guest.bookingGuestId) : undefined;
    const memberId = guest.memberId?.trim();
    return row && row.memberId && memberId && row.memberId === memberId ? row : undefined;
  };
  // Finding 2 (privacy re-review of MG3 #2308). Taken here rather than at the
  // top of the handler because everything above is schema and authorization —
  // the collapsed refusal cannot be raised until the party is priced.
  const memberGuestRefusalStartedAt = startMemberGuestRefusalClock();
  const isAuthorizedOnBehalf = Boolean(parsed.data.forMemberId);

  let promoCode:
    | (Awaited<ReturnType<typeof prisma.promoCode.findUnique>> & {
        assignments: { memberId: string }[];
        lodges: { lodgeId: string }[];
      })
    | null = null;
  let workPartyEvent: { id: string; name: string; discountPercent: number } | null = null;

  if (parsed.data.workPartyEventId) {
    const event = await prisma.workPartyEvent.findUnique({
      where: { id: parsed.data.workPartyEventId },
      include: {
        promoCode: {
          include: {
            assignments: { select: { memberId: true } },
            lodges: { select: { lodgeId: true } },
          },
        },
      },
    });
    if (!event) {
      return NextResponse.json(
        { valid: false, error: "Working bee event not found" },
        { status: 400 }
      );
    }
    if (!event.active || !event.promoCode.active || event.promoCode.archivedAt) {
      return NextResponse.json(
        { valid: false, error: "This working bee event is no longer active" },
        { status: 400 }
      );
    }
    if (!workPartyWindowOverlapsStay(event, checkIn, checkOut)) {
      return NextResponse.json(
        {
          valid: false,
          error: "This working bee event does not overlap your booking dates",
        },
        { status: 400 }
      );
    }
    promoCode = event.promoCode;
    workPartyEvent = {
      id: event.id,
      name: event.name,
      discountPercent: event.discountPercent,
    };
  } else if (code && !parsed.data.codes) {
    const normalizedCode = normalizePromoCodeInput(code);
    const found = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: {
        assignments: { select: { memberId: true } },
        lodges: { select: { lodgeId: true } },
      },
    });
    // Internal promos (work party events) are system-applied only; a
    // manually entered internal code behaves like a nonexistent one.
    promoCode = found && !found.internal ? found : null;
  }

  const assignedMemberIds = promoCode?.assignments?.length
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  // Calculate the booking price to determine discount
  const quoteLodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  );
  if (!quoteLodgeId) {
    return NextResponse.json(
      { error: "Unknown or inactive lodgeId" },
      { status: 400 },
    );
  }
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
      ...lodgeNullTolerantScope(quoteLodgeId),
    },
    include: { membershipTypeRates: true },
  });

  // #2756: through the shared mapper. This one already carried `type` and its
  // prices do not move — it is routed here so `toSeasonRateData` is the tree's
  // ONLY production season mapping, which is what the census can then enforce.
  const seasonData: SeasonRateData[] = toSeasonRateData(seasons);

  // #2770 (INV-MOD-026): through the shared mappers, never hand-rolled.
  //
  // This used to build the four-key `GroupDiscountConfig` literal inline behind
  // `if (gds?.enabled)`, which is the same defect class #2756 closed for seasons:
  // a second, hand-written copy of a config the tree resolves in one place, free
  // to drift from it silently. Here it had already drifted — it consulted
  // `enabled` alone, so the club's edit-time switch never reached the promo
  // preview, and the edit panel could show a promo adjustment sized on
  // group-discounted per-night rates while the quote beside it, and the save
  // behind it, priced the same nights undiscounted.
  //
  // The mapper is chosen by what is being priced, exactly as everywhere else: an
  // edit consults the switch, a first purchase does not. Only ONE of the two runs
  // per request, so this route never holds two different configs at once. The
  // rate membership type the discount substitutes for true non-members (#1930,
  // E4) comes across in the mapper, so it is no longer restated here.
  // `group-discount-edit-switch-census.test.ts` declares this file with both
  // counts and refuses any file that builds such a literal by hand again.
  const gds = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  const groupDiscount: GroupDiscountConfig | undefined = parsed.data
    .forBookingEdit
    ? toEditTimeGroupDiscountConfig(gds)
    : toGroupDiscountConfig(gds);

  try {
    const price = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
      ownerMemberId: effectiveMemberId,
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
    });

    // D-3813-4, decided HERE exactly as the create decides it — the booker's
    // family boundary, the club's member-guest policy and who is acting
    // (`planMemberGuestConsentWrites`) — so the preview prices a guest awaiting
    // acceptance the way the save will. The client's `awaitingAcceptance` can
    // only add to that answer, never take a pending guest out of it.
    // With the member-guest module off nobody awaits acceptance, so the family
    // is not read at all.
    const memberGuestPolicy = await loadMemberGuestAddPolicy();
    const consentPlan = memberGuestPolicy.wideningEnabled
      ? planMemberGuestConsentWrites({
          guests,
          boundary: await computeMemberGuestBoundary(
            prisma,
            effectiveMemberId,
            [...new Set(guests.flatMap((guest) => (guest.memberId?.trim() ? [guest.memberId.trim()] : [])))],
          ),
          actor: isAuthorizedOnBehalf
            ? { kind: "ADMIN", adminMemberId: session.user.id }
            : { kind: "MEMBER" },
          now: new Date(),
          bookingCheckIn: checkIn,
          policy: memberGuestPolicy,
        })
      : null;

    // Walked over the guests the pricing pass was GIVEN, each paired with the
    // row that priced it, rather than over the breakdown with the input read
    // back by position (#2801). The engine returns one row per input guest, but
    // `PriceBreakdown` declares no such relation, so a short breakdown is a
    // wiring defect: refused by name, because a promo allocated against the
    // wrong guest's nightly rates quotes a discount the save will not honour.
    const promoGuests = guests.map((guest, index) => {
      const priced = price.guests[index];
      if (priced === undefined) {
        throw new Error(
          `Promo validation has no priced guest at breakdown position ${index} of ${price.guests.length} (#3031).`
        );
      }
      const stored = storedRowFor(guest);
      return {
        memberId: guest.memberId ?? null,
        isMember: priced.isMember,
        perNightRates: priced.perNightCents,
        nightDates: priced.nightDates,
        // Dates the positional rates so internal work-party promos restrict
        // the discount to the event's night window.
        firstNight: guest.stayStart ?? checkIn,
        consentStatus: guest.awaitingAcceptance
          ? ("PENDING" as const)
          : stored
            ? stored.consentStatus
            : consentPlan
              ? guestConsentStatus(consentPlan.guests[index]!)
              : null,
      };
    });

    if (parsed.data.codes) {
      return NextResponse.json(
        await validateSeveralPromoCodes({
          codes: parsed.data.codes,
          workPartyPromo: workPartyEvent ? promoCode : null,
          workPartyEvent,
          memberId: effectiveMemberId,
          checkIn,
          totalPriceCents: price.totalPriceCents,
          guests: promoGuests,
          lodgeId: quoteLodgeId,
          todayAtClub: (await clubTime()).today(),
        }),
      );
    }

    // #3827: through the one orchestrator, so the preview of a single code is
    // priced exactly as the save prices it — a guest awaiting acceptance
    // included (D-3813-4). One code in, the engine's own answer out.
    const [outcome] = (
      await applyBookingPromotions(
        promoCode
          ? [
              {
                code: promoCode.code,
                promoCode,
                assignedMemberIds,
                selectedGuestIndexes: parsed.data.promoGuestIndexes,
                capOverflow: "reject" as const,
              },
            ]
          : [],
        {
          memberId: effectiveMemberId,
          bookingCheckIn: checkIn,
          totalPriceCents: price.totalPriceCents,
          guests: promoGuests,
          db: prisma,
          lodgeId: quoteLodgeId,
          // #3123 — the CLUB's day, from its persisted zone (`INV-CONFIG-002`),
          // and what the promotion's validity window is judged against. No
          // transaction is open on this route, and it is not reachable from a
          // CLI or from instrumentation, so the request-scoped `server-only`
          // binding is the right reader.
          todayAtClub: (await clubTime()).today(),
        },
      )
    ).outcomes;
    const application = outcome?.result ?? {
      error: "Promo code not found",
      beneficiaryMemberIds: [],
    };
    if (application.requiresGuestSelection) {
      return NextResponse.json({
        valid: false,
        requiresGuestSelection: true,
        error: application.error,
        code: promoCode!.code,
        description: promoCode!.description,
        type: promoCode!.type,
        selectableGuestIndexes: application.selectableGuestIndexes ?? [],
      });
    }
    if (application.error || !application.discount) {
      return NextResponse.json(
        { valid: false, error: application.error ?? "Promo code could not be applied" },
        { status: 400 }
      );
    }
    const promoResult = application.discount;

    return NextResponse.json({
      valid: true,
      // Never expose the internal code for work-party validations; the
      // client identifies the discount by the event instead.
      code: workPartyEvent ? null : promoCode!.code,
      description: workPartyEvent ? null : promoCode!.description,
      type: promoCode!.type,
      workPartyEvent,
      discountCents: promoResult.discountCents,
      promoAdjustmentCents: promoResult.priceAdjustmentCents,
      freeNightsUsed: promoResult.freeNightsUsed,
      eligibleGuestCount: promoResult.eligibleGuestCount,
      remainingFreeNights: application.remainingFreeNights,
      selectedGuestIndexes: application.selectedGuestIndexes,
      totalPriceCents: price.totalPriceCents,
      finalPriceCents: bookingFinalPriceCents({
        totalPriceCents: price.totalPriceCents,
        promoAdjustmentCents: promoResult.priceAdjustmentCents,
      }),
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). This route is a member-facing
      // surface that can now answer D-8's collapsed refusal, so it owes the same
      // three mitigations as the six add paths: the throttle unit, the audit row
      // naming actor and target, and the timing floor. Collapsed-but-uncounted is
      // the exact gap finding H2 closed on `bookings/modify`. A no-op for every
      // other membership-type block.
      await handleMemberGuestAddRefusal({
        request: req,
        actorMemberId: session.user.id,
        error: err,
        route: "promo-codes/validate",
        startedAt: memberGuestRefusalStartedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization: isAuthorizedOnBehalf,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err }, "Promo code validation failed");
    return NextResponse.json(
      { error: "Failed to calculate price" },
      { status: 400 }
    );
  }
}

