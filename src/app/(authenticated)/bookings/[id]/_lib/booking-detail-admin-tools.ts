import { prisma } from "@/lib/prisma";
import type { FeatureFlags } from "@/config/schema";
import {
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import { strandNightPriceOffersForBooking } from "@/lib/stored-night-price-strand-reconcile";
import { getBookingManualPaymentState } from "@/lib/manual-booking-payment-state";
import { getWithheldBookingEmailSummary } from "@/lib/booking-email-suppression";
import { bookingHasLiveWaitlistOffer } from "@/lib/booking-no-emails-service";
import { findUnresolvedWaitlistStrandReport } from "@/lib/waitlist-return-contract";
import {
  getBookingFinancialReviewWarnings,
  getBookingProviderMismatches,
} from "@/lib/booking-provider-mismatches";
import type { BookingDetailRecord } from "./load-booking-detail";

/**
 * WHAT THE ADMIN TOOLS CARD IS TOLD (#2958): every admin-gated read the booking
 * page performs for officers and nobody else — provider and finance
 * diagnostics, the "No emails" switch and what it withheld, the cash-settlement
 * state, the stored-night-price offers, the stranded waitlist confirm and the
 * exclusive-hold conflicts. Each read keeps the gate it always had
 * (`isAdmin` or `canSeeAdminTools`, plus `!isDeleted` where it applied), so a
 * member's page still runs none of these queries. Advisory only: every route
 * behind the card re-derives its own conditions under its own locks.
 *
 * `financialReviewPending` is the flag `booking-detail-history.ts` read once
 * (#3033) and is reused here, never re-queried.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export async function loadBookingDetailAdminTools({
  booking,
  modules,
  isAdmin,
  canSeeAdminTools,
  isDeleted,
  financialReviewPending,
}: {
  booking: BookingDetailRecord;
  modules: FeatureFlags;
  isAdmin: boolean;
  canSeeAdminTools: boolean;
  isDeleted: boolean;
  financialReviewPending: boolean;
}) {
  const providerMismatches = isAdmin
    ? await getBookingProviderMismatches(booking.id)
    : [];

  /*
    #3033: the admin-side warning row. Derived from the flag already read above
    rather than re-queried, so the member's banner and the admin's warning can
    never disagree about the same booking on the same page load.
  */
  const financialReviewWarnings =
    isAdmin && financialReviewPending
      ? await getBookingFinancialReviewWarnings(booking.id)
      : [];

  /*
    #2259 (owner decision D10) — the "No emails" switch and the persistent
    record of what it has actually withheld.

    Read ONLY behind `canSeeAdminTools`, exactly like the exclusive-hold
    conflicts above, and for the same reason stated more strongly: a member must
    never learn this switch exists. Not the control, not the banner, not a
    count, not a field on anything rendered to them. Computing the list outside
    the gate would put withheld subjects one careless prop away from a member's
    screen, so the query does not run for them at all.

    The withheld rows are audit records, not a static sentence: the admin has to
    know WHICH messages the member never received in order to relay them — and
    that list includes the invoice emails Xero would have sent on our behalf,
    which are inside the same guarantee.
  */
  const withheldEmails = canSeeAdminTools
    ? await getWithheldBookingEmailSummary(booking.id)
    : { total: 0, groups: [] };
  const withheldEmailGroups = withheldEmails.groups.map((group) => ({
    templateName: group.templateName,
    label: group.label,
    count: group.count,
    subject: group.subject,
    latestAt: group.latestAt.toISOString(),
    remedy: group.remedy,
  }));
  const noEmailsState = canSeeAdminTools
    ? {
        noEmails: booking.noEmails,
        noEmailsAt: booking.noEmailsAt?.toISOString() ?? null,
        setByName: booking.noEmailsBy
          ? `${booking.noEmailsBy.firstName} ${booking.noEmailsBy.lastName}`
          : null,
        // Same predicate the setter evaluates, so the dialog's warning and the
        // route's response flag cannot disagree about what "live" means.
        hasLiveWaitlistOffer: bookingHasLiveWaitlistOffer(booking),
        // A silenced WAITLISTED entry is skipped for offers entirely, so that
        // consequence produces no withheld row and has to be stated up front.
        isWaitlisted: booking.status === "WAITLISTED",
      }
    : null;

  // B5 (#2262): cash / off-Xero payment controls. Advisory only — the settle
  // path re-derives every condition under lock(1) + the per-lodge lock — so a
  // stale page can cause a 409 and never a wrong write. Skipped for a deleted
  // booking, which settles nothing.
  const manualPaymentState =
    canSeeAdminTools && !isDeleted
      ? await getBookingManualPaymentState(booking.id)
      : null;

  /*
    #3214 (epic #2797): strands whose stored night prices cannot be read back,
    offered to an officer to record.

    WITHHELD WHILE A REVIEW IS OPEN, and `financialReviewPending` — already read
    above — is what says so rather than a second query, exactly as
    `financialReviewWarnings` reuses it. While a review is open the settle screen
    owns these figures, because its target also includes the amount being
    settled; the route refuses on the same condition, re-read under its own
    transaction, so this only decides what to OFFER.

    Admin-gated like every other tools-card input: the list names guest strands,
    which is a thing a member never receives.

    ON `canSeeAdminTools` RATHER THAN ON FINANCE-VIEW, deliberately, and the
    question was asked (#3214 review): a Booking Officer with no finance area
    receives this payload read-only, and the route then refuses them at 403. Three
    things settle it in favour of the wider gate.

      1. `manualPaymentState` a few lines above does exactly this on the same
         card, and carries MORE - what is owing, and the payment records behind
         it. That is the governing precedent, so narrowing only the newer of the
         two would leave the card inconsistent without closing anything.
      2. The incremental disclosure is smaller than the precedent's, because the
         guest-strand id and the strand's stored total are ALREADY in
         `editorData` above, which every viewer of the booking receives -
         including the member whose booking it is. What this adds is the
         per-night split of a figure the viewer already holds, plus the
         plain-English reason it cannot be read back.
      3. Withholding it would break the sentence #3214 exists to make true. The
         other-lodge refusal a Booking Officer meets on their OWN edit names this
         control and sends them to Admin tools; an empty card there is precisely
         the dead end that refusal was rewritten to remove. Seeing the work and
         who can do it beats seeing nothing.

    Editing stays finance-gated on both sides: the section's controls hang off
    `useAdminAreaEditAccess("finance")` and the route requires `finance:edit`.
  */
  const storedNightPriceOffers =
    canSeeAdminTools && !isDeleted && !financialReviewPending
      ? await strandNightPriceOffersForBooking(booking.id, prisma)
      : [];

  /*
    #2649: the stranded zero-dollar waitlist confirm.

    The three cheap conditions — free, `PAYMENT_PENDING`, no payment record — are
    NOT the stranded shape on their own. Six other producers reach them, none of
    them a waitlist confirmation, including the `20260511113000` backfill
    migration, which has no price predicate at all. So the
    button is offered only where the route will accept it: on an unresolved
    `waitlist.confirm_offer_release_failed` report, the same provenance test the
    route re-runs under its locks (`findUnresolvedWaitlistStrandReport`). Without
    this the banner would state as fact — about an ordinary confirmed booking —
    that "the waitlist offer that created it has been used up".

    The audit read runs only when the cheap shape matches, which is rare, so an
    ordinary booking page issues no extra query. Admin-gated like every other
    tools-card input above.
  */
  const strandedWaitlistConfirmShape =
    canSeeAdminTools &&
    !isDeleted &&
    modules.waitlist &&
    booking.status === "PAYMENT_PENDING" &&
    booking.finalPriceCents === 0 &&
    !booking.payment;
  const showReturnToWaitlist = strandedWaitlistConfirmShape
    ? Boolean(await findUnresolvedWaitlistStrandReport(prisma, booking.id))
    : false;

  // Admin conflict surfacing (ADR-001 decision 1, issue #119): when this
  // booking exclusively holds the whole lodge, list the existing
  // capacity-holding bookings overlapping its nights so the officer can resolve
  // the clash. Admin-only — never computed or shown for members (decision 6).
  const exclusiveHoldConflicts =
    canSeeAdminTools && booking.wholeLodgeHold && booking.lodgeId
      ? [
          ...(await findOverlappingCapacityHoldingBookings(prisma, {
            lodgeId: booking.lodgeId,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            excludeBookingId: booking.id,
          })),
          // Override-settle blind spot (ADR-001 decision 1, issue #177): also
          // list overridden-but-not-yet-holding overlaps (marked `overridden`)
          // so the officer keeps seeing the future settle onto the held nights,
          // matching what the exclusive-hold route surfaces at set time.
          ...(await findOverlappingOverriddenNonHoldingBookings(prisma, {
            lodgeId: booking.lodgeId,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            excludeBookingId: booking.id,
          })),
        ]
      : [];

  return {
    providerMismatches,
    financialReviewWarnings,
    withheldEmails,
    withheldEmailGroups,
    noEmailsState,
    manualPaymentState,
    storedNightPriceOffers,
    showReturnToWaitlist,
    exclusiveHoldConflicts,
  };
}
