import Link from "next/link";
import { formatCents } from "@/lib/utils";
import type { BookingNarrativeState } from "@/lib/booking-narrative";
import { resolveCreditElectionNoticeAudience } from "@/lib/booking-credit-election";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BoundClubTime } from "@/lib/club-time";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { BookingDetailLinkedParty } from "../_lib/booking-detail-linked-party";
import type { BookingDetailPayment } from "../_lib/booking-detail-payment";
import type { BookingDetailHistory } from "../_lib/booking-detail-history";
import type { BookingDetailMessages } from "../_lib/booking-detail-messages";

/**
 * THE BANNERS ABOVE THE BOOKING (#2958): payment required, deleted, the shared
 * lifecycle narrative, the three provisional/split-party notices and the #2266
 * saved-credit promise. Presentation only, over projections the page derived;
 * every audience gate (owner second person, admin third person, linked guest
 * nothing) is the one the page applied. Moved verbatim from `page.tsx`.
 */
export function BookingStatusBanners({
  booking,
  club,
  viewer,
  access,
  party,
  payment,
  history,
  messages,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  party: BookingDetailLinkedParty;
  payment: BookingDetailPayment;
  history: BookingDetailHistory;
  messages: BookingDetailMessages;
}) {
// States with a self-contained outcome worth surfacing as a banner. Active
// states (payable / under_review) already have their own dedicated UI below.
const NARRATIVE_BANNER_STATES = new Set<BookingNarrativeState>([
  "paid",
  "bumped",
  "cancelled_pre_payment",
  "cancelled_post_payment",
  "declined",
  // #3033: a self-contained outcome like the five above — the stay change is
  // settled and the money is with the club — so it belongs in the banner rather
  // than in one of the active states' dedicated UI.
  "financial_review_pending",
]);

const narrativeBannerClasses: Record<string, string> = {
  paid: "border-success-6 bg-success-3 text-success-11",
  bumped: "border-info-6 bg-info-3 text-info-11",
  cancelled_pre_payment: "border-warning-6 bg-warning-3 text-warning-11",
  cancelled_post_payment: "border-warning-6 bg-warning-3 text-warning-11",
  declined: "border-danger-6 bg-danger-3 text-danger-11",
  // #3033: INFO, not warning or danger. Nothing is wrong with this booking and
  // the member has nothing to fix — the club owes them a figure. A warning tone
  // beside a saved stay change is exactly the alarm owner decision D1 said the
  // wording had to avoid.
  financial_review_pending: "border-info-6 bg-info-3 text-info-11",
};

  const { isBookingOwner, nonOwnerAdminViewer } = viewer;
  const { isDeleted } = access;
  const {
    hasProvisionalChildren,
    provisionalChildGuestCount,
    isProvisionalChild,
    isFlaggedProvisional,
  } = party;
  const { showCompletePaymentCard } = payment;
  const { bookingNarrative } = history;
  const { paymentRequiredDescription, financialReviewPendingDescription } =
    messages;
  return (
    <>
      {showCompletePaymentCard && (
        <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p className="font-medium">Payment required</p>
          <p>{paymentRequiredDescription}</p>
          <p className="mt-1">
            <a href="#payment" className="font-medium underline">
              Go to payment
            </a>
          </p>
        </div>
      )}

      {isDeleted ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
          <p className="font-medium">Deleted cancelled booking</p>
          <p>
            Deleted {booking.deletedAt ? club.instantDateTime(booking.deletedAt) : ""}
            {booking.deletedBy
              ? ` by ${booking.deletedBy.firstName} ${booking.deletedBy.lastName}`
              : ""}
            .
          </p>
          {booking.deletedReason ? (
            <p className="mt-1">Reason: {booking.deletedReason}</p>
          ) : null}
        </div>
      ) : null}

      {NARRATIVE_BANNER_STATES.has(bookingNarrative.state) ? (
        <div
          className={`space-y-1 rounded-md border px-4 py-3 text-sm ${
            narrativeBannerClasses[bookingNarrative.state] ??
            "border-border bg-muted text-foreground"
          }`}
        >
          <p className="font-medium">{bookingNarrative.headline}</p>
          <p>{bookingNarrative.message}</p>
          {/* #3033: the club's configurable explanation, inside the banner and
              between the facts and the next step, which is where a member reads
              it as part of one message rather than as a second notice. */}
          {bookingNarrative.state === "financial_review_pending" &&
          financialReviewPendingDescription ? (
            <p data-testid="booking-financial-review-description">
              {financialReviewPendingDescription}
            </p>
          ) : null}
          <p className="opacity-80">{bookingNarrative.nextStep}</p>
        </div>
      ) : null}

      {hasProvisionalChildren ? (
        <div className="space-y-1 rounded-md border border-info-6 bg-info-3 px-4 py-3 text-sm text-info-11">
          <p className="font-medium">
            {provisionalChildGuestCount} non-member guest
            {provisionalChildGuestCount === 1 ? "" : "s"} held provisionally
          </p>
          {nonOwnerAdminViewer ? (
            <p>
              The member&apos;s own place is confirmed once they pay for this
              booking. Their non-member guests are held in a linked provisional
              booking — <strong>no beds are reserved for them</strong> until
              they are confirmed and paid for closer to the stay.
            </p>
          ) : (
            <p>
              Your own place is confirmed once you pay for this booking. Your
              non-member guests are held in a linked provisional booking —{" "}
              <strong>no beds are reserved for them</strong> until they are
              confirmed and paid for closer to your stay. We&apos;ll be in touch
              before then.
            </p>
          )}
        </div>
      ) : null}

      {isProvisionalChild ? (
        <div className="space-y-1 rounded-md border border-info-6 bg-info-3 px-4 py-3 text-sm text-info-11">
          <p className="font-medium">Provisional non-member guests</p>
          <p>
            This is the non-member portion of{" "}
            {nonOwnerAdminViewer ? "the" : "your"} party, linked to{" "}
            {nonOwnerAdminViewer ? "the" : "your"}{" "}
            <Link
              href={`/bookings/${booking.parentBooking!.id}`}
              className="font-medium underline"
            >
              member booking
            </Link>
            . <strong>No beds are held</strong> for these guests until they are
            confirmed and paid for — nothing has been charged yet.
          </p>
        </div>
      ) : null}

      {isFlaggedProvisional ? (
        <div className="space-y-1 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p className="font-medium">Provisional booking — no beds held yet</p>
          {nonOwnerAdminViewer ? (
            <p>
              The member asked us to only confirm this booking if their guests
              can come, so{" "}
              <strong>no beds are held and nothing has been charged</strong>.
              The whole party — the member and their guests — is confirmed once
              the guests are confirmed and paid for closer to the stay.
            </p>
          ) : (
            <p>
              You asked us to only confirm this booking if your guests can come,
              so <strong>no beds are held and nothing has been charged</strong>.
              We&apos;ll confirm the whole party — you and your guests — once
              your guests are confirmed and paid for closer to your stay.
            </p>
          )}
        </div>
      ) : null}

      {/* #2266 (absorbing #2265's notice surface): a stored credit election is
          a promise the pay step keeps, and the member must see that promise on
          every re-entry — draft save lands here, Resume lands here. Wording is
          the owner-decided sentence from the signed-off mockup. Only shown
          while a consumer will still honour the election (the same statuses
          the edit path may write one onto), and never on a deleted booking.

          Audience (MED-2): the OWNER hears the second-person promise, an
          admin-type viewer the third-person one; a linked-guest viewer sees
          nothing at all — the election is the owner's money, and every other
          money surface on this page is likewise withheld from linked guests
          (see resolveCreditElectionNoticeAudience). */}
      {(() => {
        const creditNoticeAudience = resolveCreditElectionNoticeAudience({
          isBookingOwner,
          isNonOwnerAdminViewer: nonOwnerAdminViewer,
        });
        return !isDeleted &&
          creditNoticeAudience !== null &&
          booking.creditElectionCents != null &&
          booking.creditElectionCents > 0 &&
          ["DRAFT", "AWAITING_REVIEW", "PAYMENT_PENDING"].includes(
            booking.status,
          ) ? (
          <div className="space-y-1 rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
            <p className="font-medium">
              {creditNoticeAudience === "admin"
                ? `The member's ${formatCents(booking.creditElectionCents)} credit choice is saved and will be applied when they confirm.`
                : `Your ${formatCents(booking.creditElectionCents)} credit choice is saved and will be applied when you confirm.`}
            </p>
            <p className="opacity-80">
              {creditNoticeAudience === "admin"
                ? "No credit has been taken from their balance yet — it is applied at payment, against the balance and price at that moment."
                : "Nothing has been taken from your balance yet — your credit is applied when you pay, against your balance and the price at that moment."}
            </p>
          </div>
        ) : null;
      })()}
    </>
  );
}
