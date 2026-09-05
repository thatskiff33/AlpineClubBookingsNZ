import { prisma } from "@/lib/prisma";
import type { auth } from "@/lib/auth";
import type { BoundClubTime } from "@/lib/club-time";
import type { BookingEditorData } from "@/components/booking-editor";
import type { BookingEditPolicy } from "@/lib/booking-edit-policy";
import {
  hasAdminAreaAccess,
  type bookingManagementAuthorizationRole,
} from "@/lib/admin-permissions";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  deriveBookingAppliedCreditCents,
  getMemberCreditBalance,
} from "@/lib/member-credit";
import { isMemberWholeLodgeBooking } from "@/lib/booking-modify";
import { formatDateOnly } from "@/lib/date-only";
import {
  describeMemberGuestConsentBadge,
  type MemberGuestConsentBadgeAudience,
} from "@/lib/member-guest-consent-card";
import { MEMBER_GUEST_MODULE_KEY } from "@/lib/member-guest-consent";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { loadMemberGuestSettings } from "@/lib/member-guest-settings";
import { resolveMemberGuestNameSearchAccess } from "@/lib/member-guest-find";
import { resolveOtherLodgeRateEligibleGuestIds } from "@/lib/membership-type-policy";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { getPublicOtherLodges } from "@/lib/booking-request";
import type { BookingDetailRecord } from "./load-booking-detail";

/**
 * WHAT THE EDIT PANEL IS HANDED (#2958): the `BookingEditorData` payload — the
 * booking, its guests with their consent badges, the credit election card's
 * figures, the member-guest finder's answer, the admin-only other-lodge
 * registry and eligibility list, and the serialised edit policy. This object is
 * serialised into a CLIENT component's RSC payload, which is why every
 * admin-only field is a conditional SPREAD gated here, server-side, on
 * `viewerAuthorizationRole === "ADMIN"`; those gates are unchanged.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export async function buildBookingDetailEditorData({
  session,
  booking,
  club,
  nights,
  viewerAuthorizationRole,
  isDeleted,
  canModify,
  canAdminOverride,
  canEditNonMemberGuestNames,
  canFixNonMemberGuestNameTypos,
  editPolicy,
  consentBadgeAudience,
  consentResponderNameById,
}: {
  session: NonNullable<Awaited<ReturnType<typeof auth>>>;
  booking: BookingDetailRecord;
  club: BoundClubTime;
  nights: number;
  viewerAuthorizationRole: ReturnType<typeof bookingManagementAuthorizationRole>;
  isDeleted: boolean;
  canModify: boolean;
  canAdminOverride: boolean;
  canEditNonMemberGuestNames: boolean;
  canFixNonMemberGuestNameTypos: boolean;
  editPolicy: BookingEditPolicy;
  consentBadgeAudience: MemberGuestConsentBadgeAudience;
  consentResponderNameById: ReadonlyMap<string, string>;
}): Promise<BookingEditorData> {
  // #2266: the edit panel's account-credit card (its own card above the
  // Return-method radio — owner-decided placement). Only statuses whose stored
  // election (#2265) a pay-time consumer will honour are eligible; PENDING is
  // deliberately out (see CREDIT_ELECTION_WRITABLE_STATUSES in
  // booking-credit-election.ts), as are organiser-settled bookings and anything
  // with captured money. The balance shown is the BOOKING OWNER's, so an admin
  // editing on behalf offers the member's credit, not their own.
  const creditElectionEligible =
    canModify &&
    !isDeleted &&
    ["DRAFT", "AWAITING_REVIEW", "PAYMENT_PENDING"].includes(booking.status) &&
    !booking.organiserSettled &&
    !hasCapturedPayment(booking.payment);
  const editorCredit = creditElectionEligible
    ? {
        availableCents: await getMemberCreditBalance(booking.memberId),
        electionCents: booking.creditElectionCents,
        appliedCents: await deriveBookingAppliedCreditCents(booking.id),
      }
    : null;

  /**
   * MG4 (#2309): the edit panel's "+ Add Member Guest" surface, decided HERE.
   *
   * SERVER-SIDE, ON PURPOSE. The module flag and the policy singleton are
   * settings reads, and `BookingEditorData` is serialised into a client
   * component's payload — so the panel is handed an answer rather than left to
   * guess one and render a finder whose routes then 404.
   *
   * ABSENT WHEN THE MODULE IS OFF, as a conditional SPREAD rather than a
   * false-valued key. React Flight serialises the key as well as the value, so
   * `memberGuest: undefined` would still ship `"memberGuest":"$undefined"` and
   * change every club's payload; omitting the key leaves a non-adopting club's
   * booking page byte-for-byte what it was.
   *
   * TWO READERS, ONE FIELD. `openSearchEnabled` answers "may THIS reader search
   * by name", which is a different question for each: the club's own privacy
   * setting for a member, and `membership:view` for an officer (owner decision
   * D-20 — an admin picker is not bound by a member-facing privacy switch, and
   * the #1376 persona without membership access falls back to exact email).
   *
   * AND "WHICH READER" IS DECIDED BY THE SAME PREDICATE THE PANEL ROUTES ON,
   * which is `viewerAuthorizationRole === "ADMIN"` — i.e. `bookings:edit`. It
   * was previously `isAdmin || canViewAsAdmin` (`bookings:view`), and the two
   * disagree over a real, shipped persona: a read-only bookings viewer. One
   * holding `membership:view` was handed a name type-ahead while the panel sent
   * them down the MEMBER routes, where the name search 404s unless the club
   * turned open search on — a search box that silently fails. One WITHOUT
   * `membership:view` was denied name search on a club that had deliberately
   * turned it on for every member, including them. Deriving both from one
   * predicate is the fix: whoever is not in admin mode is a member for this
   * purpose and gets exactly the club's member-facing answer.
   *
   * THE FAMILY BOUNDARY IS NOT SHIPPED FROM HERE, and that is deliberate rather
   * than an omission. The panel already fetches the booking owner's family list
   * for its quick-add row — `/api/members/family` for a member, the booking's
   * `eligible-family` for an officer — so it holds the same set this page would
   * have had to query for, and reading it from the row it already renders means
   * the panel's idea of "my family" cannot disagree with the buttons above it.
   * That is the create wizard's rule (`predictMemberGuestConsent`), applied to
   * the second surface rather than re-derived for it.
   */
  const memberGuestModuleEnabled = await isEffectiveModuleEnabled(
    MEMBER_GUEST_MODULE_KEY,
  );
  const memberGuestSettings = memberGuestModuleEnabled
    ? await loadMemberGuestSettings()
    : null;
  // `viewerAuthorizationRole === "ADMIN"` and nothing else: it is the exact
  // value shipped as `viewerRole` below, and the value the panel branches on to
  // choose the admin picker's routes. See the note above.
  const canSearchMembersByName = resolveMemberGuestNameSearchAccess({
    actingAsAdmin: viewerAuthorizationRole === "ADMIN",
    hasMembershipView: hasAdminAreaAccess(session.user, {
      area: "membership",
      level: "view",
    }),
    clubNameSearchEnabled: memberGuestSettings?.openMemberSearchEnabled ?? false,
  });
  /**
   * #2978: the season the other-lodge eligibility fence is judged in — resolved
   * AUTHORITATIVELY rather than from whatever happened to warm the cache.
   *
   * `seasonYearOfStoredDate` reads the process-level financial-year cache in
   * `financial-year.ts`, which serves the March default until a server path
   * seeds it. Every WRITE path reaches `refreshFinancialYearConfig` through
   * `resolveSubscriptionLockoutMode`; a page render does not, so on a cold
   * process a club with any other year-end month would have this page offer
   * ticks judged in one season while `modify-quote` — which reseeds before its
   * own season derivation — fences them in another. The officer would see a tick
   * box and be refused when they used it, which is exactly what acceptance
   * criterion 2 of #2978 exists to prevent. No money is at stake (pricing
   * re-checks eligibility itself), but `subscription-lockout-enforcement.ts` and
   * `adult-member-hosting-review.ts` both refuse to trust this cache in these
   * same words, and a season answer that depends on process history is not one
   * to trust here either.
   *
   * Reseeded only for an admin, since only the admin spread below asks the
   * question. `refreshFinancialYearConfig` reads the club's stored override and,
   * with none set, the connected organisation's year end through its own cache.
   */
  if (viewerAuthorizationRole === "ADMIN") {
    await refreshFinancialYearConfig();
  }
  const editorData: BookingEditorData = {
    id: booking.id,
    checkIn: formatDateOnly(new Date(booking.checkIn)),
    checkOut: formatDateOnly(new Date(booking.checkOut)),
    nights,
    status: booking.status,
    guests: booking.guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
      stayStart: formatDateOnly(g.stayStart),
      stayEnd: formatDateOnly(g.stayEnd),
      priceCents: g.priceCents,
      // Other Lodges epic: the reciprocal other-club rate tick. Sent to every
      // viewer because it is not a secret — it is what a non-member row is being
      // charged — but only an admin is offered the control that changes it.
      otherLodgeMember: g.otherLodgeMember,
      nights: g.nights.map((n) => formatDateOnly(n.stayDate)),
      // #2307 (MG2-M-2): null for family and non-member rows — no badge, no
      // layout change. A conditional spread so those rows' serialised payload
      // carries no `consent` key at all (React Flight serialises the key too).
      ...(() => {
        const consent = describeMemberGuestConsentBadge({
          guest: g,
          audience: consentBadgeAudience,
          responderName: g.consentRespondedByMemberId
            ? (consentResponderNameById.get(g.consentRespondedByMemberId) ?? null)
            : null,
          // #3123 — the badge stamps `consentExpiresAt` / `consentRespondedAt`,
          // which are real instants, so the day they fall on is the club's
          // persisted zone's to name. Taken from the SAME binding this page
          // already resolved for its stay-boundary questions, so one page cannot
          // answer in two zones.
          timeZone: club.zone,
        });
        // MG4 (#2309) adds the SUB-STATE beside the badge, because the edit
        // panel needs to tell "still being asked" from "the club put them
        // here" and a tone of `"ok"` covers both plus every ordinary consent.
        // Classified here, from the persisted columns, rather than inferred
        // client-side from a label string an admin can override.
        return consent
          ? { consent: { ...consent, subState: classifyMemberGuestConsent(g, g.memberId) } }
          : {};
      })(),
    })),
    viewerRole: viewerAuthorizationRole,
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    finalPriceCents: booking.finalPriceCents,
    promo: booking.promoRedemption?.promoCode
      ? {
          code: booking.promoRedemption.promoCode.code,
          type: booking.promoRedemption.promoCode.type,
          description: booking.promoRedemption.promoCode.description,
          workPartyEventName:
            booking.promoRedemption.promoCode.workPartyEvent?.name ?? null,
        }
      : null,
    hasNonMembers: booking.hasNonMembers,
    nonMemberHoldUntil: booking.nonMemberHoldUntil?.toISOString() ?? null,
    canEditNonMemberGuestNames,
    canFixNonMemberGuestNameTypos,
    ...(memberGuestSettings
      ? {
          memberGuest: {
            enabled: true,
            openSearchEnabled: canSearchMembersByName,
            approvalRequired: memberGuestSettings.approvalRequired,
          },
        }
      : {}),
    // #2337: offer the placeholder→member link only to an admin/officer viewing a
    // genuine MEMBER whole-lodge booking — the exact fence the save path enforces
    // (isMemberWholeLodgeBooking, admin-only). Computed server-side so the panel
    // never shows a control the save would refuse. Absent for every other booking.
    ...(viewerAuthorizationRole === "ADMIN" &&
    (await isMemberWholeLodgeBooking(prisma, booking.id))
      ? { memberWholeLodge: true }
      : {}),
    // Other Lodges epic: the partner lodge this booking claims, plus the
    // registry the officer picks from.
    //
    // The LIST is admin-only and a conditional spread, on the same reasoning as
    // `noEmails` above: this object is serialised into the RSC payload of a
    // client component, and React Flight ships the key as well as the value, so
    // a member reading the wire would otherwise learn the whole other-lodge
    // registry exists and what is in it. The stored ELECTION rides the guest
    // rows either way, because it is what the member is being charged.
    otherLodgeId: booking.otherLodgeId,
    ...(viewerAuthorizationRole === "ADMIN"
      ? {
          otherLodges: await getPublicOtherLodges(prisma),
          // #2978: which guests may be ticked. Resolved server-side because the
          // answer needs membership types and the unpaid-subscription set, and
          // shipped in the SAME admin-only spread as the registry above for a
          // second reason: an ineligible row can be ineligible because that
          // member's subscription is unpaid, so this list must not reach an
          // ordinary viewer. Costs no query on the common all-non-members
          // booking, which the helper short-circuits.
          otherLodgeRateEligibleGuestIds: [
            ...(await resolveOtherLodgeRateEligibleGuestIds(prisma, {
              seasonYear: seasonYearOfStoredDate(booking.checkIn),
              guests: booking.guests,
            })),
          ],
        }
      : {}),
    // #2104: an already-flagged/reviewed booking must not re-prompt the member
    // for a justification when the guest list shuffles — the edit panel keys the
    // proactive field on these (the server only demands a reason on the FIRST
    // trip; see resolveModifyReviewUpdate).
    requiresAdminReview: booking.requiresAdminReview,
    adminReviewStatus: booking.adminReviewStatus,
    /*
      #2259: consumed only by the edit panel's admin-only notify dialog. Gated
      on the SAME predicate the panel gates its read on, and gated HERE rather
      than only in the panel, because this object is serialised into the RSC
      payload of a client component.

      A conditional SPREAD, not a conditional value. React Flight serialises the
      KEY as well as the value, so `noEmails: undefined` ships `"noEmails":
      "$undefined"` and `noEmails: false` ships `"noEmails":false` — either way a
      member reading the wire learns the switch exists, even though they never
      learn its state. The spread omits the key entirely, so the payload of a
      member's booking is byte-for-byte what it was before this feature.
    */
    ...(viewerAuthorizationRole === "ADMIN"
      ? { noEmails: booking.noEmails }
      : {}),
    editPolicy: {
      // This is the member (non-override) policy, so mode is never
      // "admin-override" here; the ternary only narrows the widened union.
      mode: editPolicy.mode === "admin-override" ? null : editPolicy.mode,
      today: formatDateOnly(editPolicy.today),
      editableFrom: editPolicy.editableFrom
        ? formatDateOnly(editPolicy.editableFrom)
        : null,
      checkInEditable: editPolicy.checkInEditable,
      adminOverrideAvailable: canAdminOverride,
    },
    // #2266: null (rather than omitted) when ineligible, so the panel renders
    // no credit card at all for a booking whose election nothing would honour.
    credit: editorCredit,
    // #2266: the booking OWNER's member id — the shared PromoCodeInput
    // validates on-behalf promo entry against the member's assignments, not
    // the acting admin's.
    memberId: booking.memberId,
    // #2266: promo lodge restrictions validate against THIS booking's lodge.
    lodgeId: booking.lodgeId,
  };
  return editorData;
}
