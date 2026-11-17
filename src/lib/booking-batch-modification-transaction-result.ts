// The batch edit's transaction result, moved verbatim from
// `booking-batch-modification-service.ts` to keep that file under its size
// ceiling (#5145). Types only.
import type { Booking, BookingGuest, Payment, PaymentSource, PaymentStatus } from "@prisma/client";

import type { BookingModificationPaymentContext } from "@/lib/booking-modification-settlement";
import type { BookingModificationSettlementMethod, ResolvedGuestNameUpdate } from "@/lib/booking-modify";
import type { FinishedStayChangeFeeRule, FinishedStayCorrection } from "@/lib/booking-finished-stay-correction";
import type { OfficerWorkPartyCorrection } from "@/lib/booking-batch-work-party-correction";
import type { MemberGuestAddNotificationRow } from "@/lib/member-guest-add-policy";
import type { PromoCoverageNotice } from "@/lib/promo-cap-coverage";
import type { PromoChangeNotAppliedNotice } from "@/lib/promo-change-not-applied";

export type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

export type BatchModificationTransactionResult =
  BookingModificationPaymentContext & {
    /** #3954: the reduction cancelled the unpaid ask outright, for the member's email. */
    unpaidAskCancelled: boolean;
    /**
     * The plain figure the emails, the response body and the Xero leg read.
     * Inherited from `BookingModificationPaymentContext` until #3371 replaced
     * that field with `additionalAsk`; it is restated here because those
     * consumers want a number and the minter must not be handed one.
     */
    additionalAmountCents: number;
    billedToOrganiserCents: number; // #4299: invoiced to the group organiser, not asked of this member
    booking: ModifiedBooking;
    /** #3232: the deferred hosting reconciliation, when the caller asked for it. */
    pendingHostingReconcile?: () => Promise<void>;
    priceDiffCents: number;
    changeFeeCents: number;
    /**
     * #3232 D2: this booking's change fee was WAIVED, not absent.
     *
     * Without it a waived fee is an unmarked zero, and "no fee was due" and "we
     * waived it because our own supervision rule compelled this move" are the
     * same 0 in the modification row, the audit trail and the Xero leg. A
     * treasurer reconciling change-fee income against the club setting has
     * nothing to reconcile against, and the dependent's history reads as an
     * ordinary member-initiated edit to a booking the member never asked to
     * move.
     */
    changeFeeWaived: boolean;
    /**
     * #3232 (fix round): this edit's settlement genuinely needs a card-or-credit
     * choice, whichever way it was priced.
     *
     * `calculateModificationSettlementOptions` answers this as
     * `cardRefundAmountCents > 0 || creditRefundAmountCents > 0` — an OR over BOTH
     * options — and the two are computed from separate policy tiers, so one can
     * resolve to zero while the other does not. A caller that inferred the need
     * from the RESOLVED amounts of a quote priced one way therefore disagreed with
     * the write's own refusal, and the disagreement deadlocked the member: see
     * `combineLinkedMoveQuote`.
     */
    requiresSettlementMethod: boolean;
    refundAmountCents: number;
    accountCreditAmountCents: number;
    promoRemoved: boolean;
    promoChanged: boolean;
    // #2390: set only when a usage cap stopped the promotion reaching somebody
    // on the repriced booking; null means everyone it applies to is covered.
    promoCoverage: PromoCoverageNotice | null;
    // #3179: set only when this edit carried a promo-code change it could not
    // honour and dropped. Null means nothing the member asked for was left
    // undone — never "there was no promo code".
    promoChangeNotApplied: PromoChangeNotAppliedNotice | null;
    choreWarnings: string[];
    datesChanged: boolean;
    adminOverride: boolean;
    /**
     * #3750: set only on a finished-stay correction — the change request it
     * executed and which half of the owner's fee rule priced it — so the audit
     * row says why a finished booking moved.
     */
    finishedStayCorrection:
      | (FinishedStayCorrection & {
          changeFeeRule: FinishedStayChangeFeeRule;
          confirmOverCapacity: boolean;
        })
      | null;
    /** Fork #119: set only on an officer's work-party correction, for the audit. */
    officerWorkPartyCorrection: OfficerWorkPartyCorrection | null;
    notifyMember: boolean;
    capacityOverridden: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    oldGuestCount: number;
    addedGuests: BookingGuest[]; // #4030: the rows this edit created, named in its change email
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    paymentSource: PaymentSource | null;
    paymentReference: string | null;
    xeroInvoiceNumber: string | null;
    zeroDollarAutoPaid: boolean;
    supersededPrimaryPaymentIntents: { length: number };
    xeroAdditionalAmountCents: number;
    xeroRefundAmountCents: number;
    appliedCreditGivenBackCents: number;
    refundedExcessCreditCents: number; // F20 (#1887): an unpaid booking's applied credit the lower price freed
    settlementMethod: BookingModificationSettlementMethod | null;
    policyRetainedAmountCents: number;
    guestNameUpdates: ResolvedGuestNameUpdate[];
    guestIdentityChanged: boolean;
    identityOnlyModification: boolean;
    // #2266: this edit changed ONLY the stored credit election (#2265) — no
    // member email, exactly like an identity-only edit.
    creditElectionOnlyModification: boolean;
    // #2266: the election as stored after this edit, and whether it moved.
    creditElectionCents: number | null;
    creditElectionChanged: boolean;
    // #1372: this edit newly dropped a paid (capacity-holding) booking into the
    // blocked minors-only review state, so the post-tx step alerts admins.
    minorsOnlyReviewNewlyFlagged: boolean;
    // MG2 #2307: cross-family member guests added by this edit, to be told after
    // the commit. Empty on every family-scope modification.
    memberGuestNotificationRows: MemberGuestAddNotificationRow[];
    // MG4 #2309: cross-family member guests this edit took OFF the booking, to
    // be told after the commit. Empty on every family-scope modification.
    withdrawnMemberGuests: Array<{
      targetMemberId: string;
      context: "REQUEST_CANCELLED" | "TAKEN_OFF";
    }>;
  };
