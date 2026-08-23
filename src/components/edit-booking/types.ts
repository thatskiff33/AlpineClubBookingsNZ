import type { AgeTier } from "@prisma/client";
import type { MinimumStayViolation } from "@/lib/booking-policies";
import type { AggregatedPolicyExceptions } from "@/lib/booking-policy-exceptions";

/**
 * The wire shapes the edit-booking panel is handed and the ones it reads back.
 *
 * Moved here verbatim from `edit-booking-panel.tsx` (#2690). Nothing on this page
 * is derived or computed: every field is either serialised by the booking page or
 * returned by `POST /api/bookings/<id>/modify-quote`, and the comments explaining
 * why a field is optional, absent-rather-than-false, or read straight off the
 * quote are the load-bearing part.
 */

export interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: string[] | null;
  priceCents: number;
  /**
   * Other Lodges epic: true when this NON-MEMBER guest is priced at the club's
   * own member rate as a recognised member of the booking's partner lodge.
   * Optional so pre-existing fixtures stay valid; absent reads as false.
   */
  otherLodgeMember?: boolean;
  /**
   * The member-guest consent badge, composed server-side (#2307) and threaded
   * through unchanged. MG4 (#2309) reads only its TONE, and only to name the
   * remove control honestly: taking a row off while its consent request is
   * still unanswered is cancelling a request, not removing a guest, and the
   * person on the other end gets a different email for each. Absent - not
   * null-valued - on family and non-member rows.
   */
  consent?: {
    tone: "pending" | "ok" | "blocked";
    label: string;
    /**
     * The classified sub-state (`member-guest-consent.ts`'s eight-shape table),
     * computed server-side from the persisted columns.
     *
     * The TONE cannot stand in for it: `"ok"` covers an ordinary consent, a
     * notify-only auto-confirm and an admin placement alike, and the helper
     * sentence under the row is different for the last of those. Absent on
     * every row that has no badge.
     */
    subState?: string | null;
  };
}

export interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
}

export interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
  // Set when this discount came from a work party (working bee) event's
  // internal promo rather than a manually entered code.
  workPartyEventName?: string | null;
}

export interface BookingData {
  id: string;
  checkIn: string;
  checkOut: string;
  guests: Guest[];
  viewerRole: string;
  finalPriceCents: number;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  promo: PromoInfo | null;
  canEditNonMemberGuestNames: boolean;
  // Fully paid: only an identity-preserving spelling correction is allowed on a
  // free-text non-member guest (#1386). The server enforces the similarity guard.
  canFixNonMemberGuestNameTypos: boolean;
  editPolicy: {
    mode: "future" | "in-progress" | null;
    today: string;
    editableFrom: string | null;
    checkInEditable: boolean;
    // Issue #1668: an admin may override the date-window locks for this booking.
    // Optional so pre-existing fixtures stay valid; the booking page sets it.
    adminOverrideAvailable?: boolean;
  };
  // #2104: an already-flagged/reviewed booking (requiresAdminReview && a
  // non-null adminReviewStatus) must not re-prompt for a justification — the
  // server only demands a reason on the FIRST no-adult trip. Optional so
  // pre-existing fixtures/callers stay valid.
  requiresAdminReview?: boolean;
  adminReviewStatus?: string | null;
  // #2259 honesty rule: the booking's "No emails" switch. With it on, the
  // change-notification email is withheld by the mailer whatever the admin
  // picks, so the notify dialog stops offering the choice and states the
  // position instead. Optional so pre-existing fixtures/callers stay valid;
  // the booking page sets it. NEVER surfaced on a member-facing control — a
  // member must not learn the switch exists — and the panel only reads it on
  // the admin (`actingAsAdmin`) dialog path.
  noEmails?: boolean;
  // #2266: the account-credit card (owner-decided: its own card above the
  // Return-method radio). Null/absent when this booking cannot carry a credit
  // election — the card is then not rendered at all. `electionCents` is the
  // stored #2265 election; `appliedCents` is ledger credit already applied.
  credit?: {
    availableCents: number;
    electionCents: number | null;
    appliedCents: number;
  } | null;
  // #2266: booking OWNER's member id, for on-behalf promo validation.
  memberId?: string;
  // #2266: the booking's lodge, so promo lodge restrictions validate against
  // the right lodge in the shared PromoCodeInput.
  lodgeId?: string | null;
  /**
   * MG4 (#2309): the member-guest surface's server-computed shape.
   *
   * SERVER-PROVIDED, NOT A CLIENT GUESS, and threaded through the booking page
   * rather than fetched by the panel: the module flag and both policy values are
   * settings reads, and a client that decided for itself would show a finder
   * that 404s when used. Absent entirely — not false-valued — when the module is
   * off, so a club that never adopted the feature ships the same payload it did
   * before MG4.
   */
  memberGuest?: {
    /** The `memberGuests` module, effectively enabled for this club. */
    enabled: boolean;
    /**
     * Whether the name type-ahead is available to THIS reader: the club's
     * open-search setting for a member, `membership:view` for an officer (D-20).
     */
    openSearchEnabled: boolean;
    /** `MemberGuestSettings.approvalRequired` (D-3) — copy only. */
    approvalRequired: boolean;
  };
  /**
   * #2337: true when this booking is a MEMBER whole-lodge booking (not a SCHOOL
   * one) AND the viewer is an admin/officer — the exact audience and booking
   * class the placeholder→member link is fenced to. Server-computed
   * (`isMemberWholeLodgeBooking`), never guessed here, so the panel only offers
   * the "Link to member" control where the save path will honour it. Absent — not
   * false-valued — on every other booking, so their payload is unchanged.
   */
  memberWholeLodge?: boolean;
  /**
   * Other Lodges epic: the partner lodge this booking claims, or null/absent.
   */
  otherLodgeId?: string | null;
  /**
   * Other Lodges epic: the partner-lodge registry, in name order — ADMIN-ONLY
   * and absent for every other viewer (see the booking page's conditional
   * spread). Its presence is what offers the "Member of Other Lodge" control:
   * the panel never guesses the audience, exactly as with `memberWholeLodge`.
   */
  otherLodges?: Array<{ id: string; name: string }>;
  /**
   * #2978: the guests an officer may tick as an other-lodge member - resolved
   * server-side by `resolveOtherLodgeRateEligibleGuestIds`, which is also what
   * the save fences on, so the screen can never offer a tick the save refuses.
   *
   * ADMIN-ONLY, and a conditional spread for the same reason `otherLodges` is:
   * ineligibility can mean "this member's unpaid subscription has repriced
   * them", so shipping it to every viewer would leak subscription standing over
   * the RSC wire.
   */
  otherLodgeRateEligibleGuestIds?: string[];
}

// #2266: an eligible promo chip, as returned by GET /api/promo-codes/available
// (the same endpoint and shape the create wizard's review step consumes).
export interface AvailablePromoCode {
  code: string;
  description: string | null;
}

export interface NewGuest {
  key: string; // client-side key for React
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
  // Explicit included nights (issue #713), set in the multi date range grid.
  nights?: string[];
  // #1746 (admin only): this guest is added as the second occupant of a
  // shared double with their confirmed partner (a member already on the
  // booking) — capacity runs through the reserved partner slots.
  partnerSharedWithMemberId?: string;
  /**
   * MG4 (#2309): what SAVING this edit will do to this person's consent, for
   * the badge and helper line shown before the booker saves.
   *
   * A PREDICTION, and undefined for every other kind of added guest — family
   * quick-adds (consent-free under D-6), partner adds and typed-in non-members
   * all stay byte-identical to before. Predicted rather than fetched because
   * nothing has been written yet: the row does not exist, so there is no
   * `consentRequestedAt` and no real expiry to show, and inventing one is how a
   * fake deadline ends up on screen. The server recomputes the family boundary
   * and is the only thing that decides what is persisted.
   */
  memberGuestConsentPreview?: "PENDING" | "NOTIFY_ONLY" | "ADMIN_ASSIGNED";
}

// Server-computed partner-sharer quick-add candidate (#1746): a confirmed
// partner of a member already on the booking.
export interface PartnerSharingCandidate {
  id: string;
  firstName: string;
  lastName: string;
  partnerOfMemberId: string;
  partnerOfName: string;
}

export interface ItemizedChange {
  label: string;
  amountCents: number;
}

export interface SettlementOptions {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
}

export interface QuoteResult {
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  changeFeeCents: number;
  netChargeCents: number;
  settlementOptions: SettlementOptions | null;
  // #2266: the member's live credit balance (create-flow quote parity).
  availableCreditCents?: number;
  capacityAvailable: boolean;
  // #1746: why a partner-shared admission was rejected (shown verbatim).
  partnerSharedReason?: string | null;
  promoStillValid: boolean;
  // #2390: present only when a promotion's usage cap stops it reaching somebody
  // this edit adds. The edit still saves and everyone already covered keeps
  // their discount — the member is simply told, before they save, who is
  // covered and who is at the normal rate.
  promoCoverage?: {
    promoCode: string;
    coveredNames: string[];
    excludedNames: string[];
    message: string;
  } | null;
  promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null;
  itemizedChanges: ItemizedChange[];
  /**
   * Other Lodges epic: the per-person fees this edit would write, keyed by
   * existing guest id, so each name can show its recalculated fee before the
   * officer saves.
   *
   * The WHOLE remaining party, not only the re-rated rows — a party-wide reprice
   * moves numbers on rows nobody ticked, and showing stored fees beside a new
   * total is how a screen starts lying. Absent on an in-progress edit, which
   * prices through the range planner rather than this breakdown; the panel then
   * keeps showing the stored fees.
   */
  guestPrices?: { guestId: string; priceCents: number }[];
  nightDetails?: { date: string; availableBeds: number }[];
  // Issue #1668: set under an admin override when the target nights are over
  // capacity — the UI shows a warning and an explicit confirm rather than a
  // hard block.
  overCapacityConfirmRequired?: boolean;
  // #2124: whole-stay minimum-stay verdict. ADVISORY on this self-service path
  // — rendered as a warning, never gates Save (matching the pre-existing
  // future-edit semantics; the hard block lives on the create path).
  minimumStayValid?: boolean;
  minimumStayViolations?: MinimumStayViolation[];
  exceptionReview?: AggregatedPolicyExceptions;
  // #2543: the server's own member-facing sentence saying that a membership
  // subscription on this booking is unpaid, so member rates are not available
  // for those nights. Rendered VERBATIM beside the repriced totals — never
  // re-worded here. Null whenever nobody on the party is being repriced; absent
  // only on an old cached response predating the field, which renders as null.
  // Read straight off `quote`, never copied into its own state, so a fresh quote
  // that returns null cannot leave a stale notice on screen.
  //
  // There is deliberately no `paidUpAdultMemberMissing` counterpart here: this
  // path does not warn about the paid-up-adult rule, it is REFUSED by it —
  // modify-quote answers 409 `PAID_UP_ADULT_MEMBER_REQUIRED` instead of a quote,
  // so the refusal already lands in the quote-error slot via
  // `quoteRefusalMessage`, and there is no quote body to carry a flag on.
  subscriptionMemberRateNotice?: string | null;
  /**
   * #2770 D2. Non-null only when the club runs a group discount and has turned
   * it off for later edits (`GroupDiscountSetting.applyToEdits = false`,
   * INV-MOD-026), so the person looking at the price is told the nights this
   * edit adds are deliberately not discounted. Absent — not "false" — in every
   * other state: a club with no discount has nothing to explain, and a club
   * whose switch is on is getting the discount.
   */
  groupDiscountEditNotice?: string | null;
}
