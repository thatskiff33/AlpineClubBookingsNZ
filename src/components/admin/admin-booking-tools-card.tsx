import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminCapacityHoldControls } from "@/components/admin/admin-capacity-hold-controls";
import {
  AdminExclusiveHoldControls,
  type ExclusiveHoldConflict,
} from "@/components/admin/admin-exclusive-hold-controls";
import { BookingNoEmailsControls } from "@/components/admin/booking-no-emails-controls";
import {
  BookingManualPaymentControls,
  type BookingManualPaymentState,
} from "@/components/admin/booking-manual-payment-controls";
import { BookingStoredNightPriceControls } from "@/components/admin/booking-stored-night-price-controls";
import { AdminReturnToWaitlistControls } from "@/components/admin/admin-return-to-waitlist-controls";
import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";
import { CopyBookingButton } from "@/components/admin/copy-booking-button";
import type {
  BookingFinancialReviewWarning,
  BookingProviderMismatch,
  BookingWarningRow,
} from "@/lib/booking-provider-mismatches";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { formatDateOnly } from "@/lib/date-only";
import type { StrandNightPriceOffer } from "@/lib/stored-night-price-repair";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";

/**
 * One warning line: what is wrong, and the one link that leads to fixing it.
 *
 * Extracted when #3033 added a second block using the same row shape, so the two
 * cannot drift into rendering the identical data differently. It carries no
 * heading of its own — the block above it says what the group means.
 */
function WarningRow({
  warning,
  returnTo,
}: {
  // The shape, not either producer's id vocabulary: this renders a row, and has
  // no business knowing which of them made it (#3033).
  warning: BookingWarningRow;
  returnTo: string;
}) {
  return (
    <p>
      <span className="font-medium">{warning.label}.</span>{" "}
      {warning.description}{" "}
      <Link
        className="font-medium underline"
        href={buildHrefWithReturnTo(warning.href, returnTo)}
      >
        {warning.linkLabel}
      </Link>
    </p>
  );
}

/**
 * One visually distinct cluster for everything only admins can do on the
 * member-facing booking detail page: the admin actions plus deep links to the
 * related admin surfaces. Rendered only for admins.
 */
export function AdminBookingToolsCard({
  bookingId,
  memberId,
  memberName,
  lodgeId,
  checkIn,
  checkOut,
  copyProps,
  isDeleted,
  paymentId,
  showConfirmPendingGuests,
  hasSavedPaymentMethod,
  finalPriceCents,
  providerMismatches = [],
  financialReviewWarnings = [],
  features,
  capacityHold,
  exclusiveHold,
  noEmails,
  manualPayment,
  storedNightPriceOffers = [],
  showReturnToWaitlist = false,
  returnToWaitlistReleasesHold = false,
}: {
  bookingId: string;
  memberId: string;
  memberName: string;
  /**
   * The booking's own lodge (#2678). NOT NULL in the schema, and deliberately
   * not nullable here: it travels on the bed-allocation deep link so the board
   * opens on the lodge the booking is actually at. The server derives the same
   * lodge from `bookingId` regardless — this keeps the board's own lodge
   * selector agreeing with the scope it was served, rather than showing "all
   * lodges" over a single lodge's data.
   */
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  copyProps: { sourceCheckIn: string; sourceCheckOut: string; minCheckIn: string };
  isDeleted: boolean;
  paymentId: string | null;
  showConfirmPendingGuests: boolean;
  hasSavedPaymentMethod: boolean;
  finalPriceCents: number;
  providerMismatches?: BookingProviderMismatch[];
  /**
   * #3033: money on this booking is held for review — the stay change saved,
   * the adjustment did not. Its own prop, its own block and its own id
   * vocabulary rather than another entry in `providerMismatches`, because that
   * block is headed "Provider state out of step" and this is not a provider
   * disagreement: local state is right and the club owes a decision. The row
   * SHAPE is shared, so both render identically through `WarningRow`.
   */
  financialReviewWarnings?: BookingFinancialReviewWarning[];
  features: FeatureFlags;
  /** Admin capacity hold state (#1764); omitted for deleted bookings. */
  capacityHold?: {
    hasAdminCapacityHold: boolean;
    adminCapacityHoldAt: string | null;
    heldByName: string | null;
    holdsCapacityNaturally: boolean;
    canPlaceHold: boolean;
  };
  /** Exclusive whole-lodge hold state (#121); omitted for deleted bookings. */
  exclusiveHold?: {
    wholeLodgeHold: boolean;
    wholeLodgeHoldAt: string | null;
    heldByName: string | null;
    /**
     * Whether the booking holds lodge capacity (#173). The Set control is
     * gated on this — an exclusive hold on a non-holding booking blocks
     * nothing (ADR-001 capacity rule).
     */
    holdsCapacity: boolean;
    /** Overlapping bookings to resolve when the hold is set (issue #119). */
    conflicts?: ExclusiveHoldConflict[];
  };
  /**
   * Per-booking "No emails" switch (#2258/#2259). Admin-only by construction:
   * this whole card renders behind the page's admin-tools gate, so a member
   * never receives the state, let alone the control. Omitted for a deleted
   * booking, which sends nothing anyway.
   */
  noEmails?: {
    noEmails: boolean;
    noEmailsAt: string | null;
    setByName: string | null;
    hasLiveWaitlistOffer: boolean;
    isWaitlisted: boolean;
  };
  /**
   * B5 (#2262): cash / off-Xero payment controls. Server-computed advisory
   * flags — the settle path re-derives every one under its locks — so this is
   * about what to OFFER, never about what is allowed. Omitted for a deleted
   * booking, which settles nothing.
   */
  manualPayment?: BookingManualPaymentState;
  /**
   * #3214 (epic #2797): guest strands on this booking whose stored night prices
   * cannot be read back, offered to an officer to record.
   *
   * The page supplies an EMPTY LIST rather than deciding not to pass the prop:
   * whether the act is available is a server-side question about the strands
   * themselves, answered once by `strandNightPriceOffersForBooking`, and a second
   * condition here would be a second answer to it (`INV-SSOT`). Empty on the
   * overwhelming majority of bookings, whose rows read back exactly.
   */
  storedNightPriceOffers?: StrandNightPriceOffer[];
  /**
   * #2649: offer the stranded-zero-dollar-waitlist-confirm repair. The page
   * sets this only for a booking the audit log PROVES was stranded by a waitlist
   * confirmation — an unresolved `waitlist.confirm_offer_release_failed` report
   * — on top of the `waitlist` module, not deleted, `PAYMENT_PENDING`,
   * `finalPriceCents === 0` and no `Payment` row. Those last four are a shape
   * ordinary bookings reach, so provenance is what keeps an operator from
   * meeting a button that can only refuse. Advisory: the route re-derives every
   * one of these facts under its own locks.
   */
  showReturnToWaitlist?: boolean;
  /**
   * #2649 review S3: this booking also carries an admin capacity hold or an
   * exclusive whole-lodge hold, which the repair releases with the transition.
   * Surfaced in the confirmation dialog so freeing those nights is a stated
   * consequence rather than something the officer reads in the audit log later.
   */
  returnToWaitlistReleasesHold?: boolean;
}) {
  const returnTo = `/bookings/${bookingId}`;
  const bedAllocationParams = new URLSearchParams({
    from: formatDateOnly(checkIn),
    to: formatDateOnly(checkOut),
    bookingId,
    // #2678: without this the board opened CLUB-WIDE with this booking focused,
    // and its bed pickers offered every lodge's beds for this booking's guests
    // — a choice the writer then refused. The API derives the lodge from
    // `bookingId` too, so this is what keeps the board's lodge selector honest
    // about the scope it was served, not the thing that scopes the read.
    lodgeId,
  });
  const bedAllocationHref = buildHrefWithReturnTo(
    `/admin/bed-allocation?${bedAllocationParams.toString()}`,
    returnTo,
  );

  return (
    <>
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Admin tools</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {providerMismatches.length > 0 && (
            <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              <p className="font-medium">Provider state out of step</p>
              {providerMismatches.map((mismatch) => (
                <WarningRow
                  key={mismatch.id}
                  warning={mismatch}
                  returnTo={returnTo}
                />
              ))}
            </div>
          )}
          {/* #3033: read-only, so it adds no gated control and no view-only
              affordance to this card. Its own heading, because "provider state
              out of step" would misdescribe a booking whose local state is
              exactly right and whose money is waiting on a person. */}
          {financialReviewWarnings.length > 0 && (
            <div
              className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
              data-testid="booking-financial-review-warning"
            >
              <p className="font-medium">Money waiting for review</p>
              {financialReviewWarnings.map((warning) => (
                <WarningRow
                  key={warning.id}
                  warning={warning}
                  returnTo={returnTo}
                />
              ))}
            </div>
          )}
          {!isDeleted && capacityHold && (
            <AdminCapacityHoldControls
              bookingId={bookingId}
              hasAdminCapacityHold={capacityHold.hasAdminCapacityHold}
              adminCapacityHoldAt={capacityHold.adminCapacityHoldAt}
              heldByName={capacityHold.heldByName}
              holdsCapacityNaturally={capacityHold.holdsCapacityNaturally}
              canPlaceHold={capacityHold.canPlaceHold}
            />
          )}
          {!isDeleted && exclusiveHold && (
            <AdminExclusiveHoldControls
              bookingId={bookingId}
              wholeLodgeHold={exclusiveHold.wholeLodgeHold}
              wholeLodgeHoldAt={exclusiveHold.wholeLodgeHoldAt}
              heldByName={exclusiveHold.heldByName}
              holdsCapacity={exclusiveHold.holdsCapacity}
              conflicts={exclusiveHold.conflicts}
            />
          )}
          {/* #2259 (owner decision D10): the per-booking "No emails" switch,
              with its acknowledgement dialog. It sits with the other
              admin-only booking switches rather than in a section of its own —
              the persistent warning about what it has actually withheld is the
              banner the page renders above this card. */}
          {!isDeleted && noEmails && (
            <BookingNoEmailsControls
              bookingId={bookingId}
              noEmails={noEmails.noEmails}
              noEmailsAt={noEmails.noEmailsAt}
              setByName={noEmails.setByName}
              hasLiveWaitlistOffer={noEmails.hasLiveWaitlistOffer}
              isWaitlisted={noEmails.isWaitlisted}
            />
          )}
          {/* B5 (#2262): record (or reverse) a cash / off-Xero bank-transfer
              payment. Gated finance:edit by the component itself, because the
              route it writes is finance-area despite its bookings-shaped path. */}
          {!isDeleted && manualPayment && (
            <BookingManualPaymentControls
              bookingId={bookingId}
              memberName={memberName}
              state={manualPayment}
              noEmails={noEmails?.noEmails ?? false}
            />
          )}
          {/* #3214: recording what a guest's nights sold for. It sits with the
              other money controls on this card rather than on the finance
              queue, because the bookings it is for raise no queue task at all —
              that is the deadlock the issue exists to break. The component is
              finance:edit-gated in its own right, matching the route. */}
          {!isDeleted && storedNightPriceOffers.length > 0 && (
            <BookingStoredNightPriceControls
              bookingId={bookingId}
              offers={storedNightPriceOffers}
            />
          )}
          {/* #2649: the repair for a free waitlist confirm that got half-way.
              It sits with the other booking-state controls rather than on the
              waitlist queue, because a stranded booking is no longer waitlisted
              and so never appears there. */}
          {showReturnToWaitlist && (
            <AdminReturnToWaitlistControls
              bookingId={bookingId}
              releasesHold={returnToWaitlistReleasesHold}
            />
          )}
          {!isDeleted && (
            <CopyBookingButton
              bookingId={bookingId}
              sourceCheckIn={copyProps.sourceCheckIn}
              sourceCheckOut={copyProps.sourceCheckOut}
              minCheckIn={copyProps.minCheckIn}
            />
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link
              className="text-muted-foreground underline hover:text-accent-foreground"
              href={buildHrefWithReturnTo(`/admin/members/${memberId}`, returnTo)}
            >
              Member: {memberName}
            </Link>
            {isFeatureHrefVisible(bedAllocationHref, features) ? (
              <Link
                className="text-muted-foreground underline hover:text-accent-foreground"
                href={bedAllocationHref}
              >
                Bed allocation
              </Link>
            ) : null}
            <Link
              className="text-muted-foreground underline hover:text-accent-foreground"
              href={buildXeroRecordActivityUrl(
                paymentId ? "Payment" : "Booking",
                paymentId ?? bookingId,
                returnTo,
              )}
            >
              Xero activity
            </Link>
            <Link
              className="text-muted-foreground underline hover:text-accent-foreground"
              href={`/admin/audit-log?q=${encodeURIComponent(bookingId)}`}
            >
              Audit log
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Admin: force-confirm non-member guests still on hold (issue #708) */}
      {showConfirmPendingGuests && (
        <ConfirmPendingGuestsButton
          bookingId={bookingId}
          hasSavedPaymentMethod={hasSavedPaymentMethod}
          finalPriceCents={finalPriceCents}
          // #2259 honesty rule: with the switch on there is no email choice to
          // offer, so the dialog states that instead of asking.
          noEmails={noEmails?.noEmails ?? false}
        />
      )}
    </>
  );
}
