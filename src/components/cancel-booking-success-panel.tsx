"use client";

import type { Ref } from "react";
import { formatCents } from "@/lib/utils";
import type { OrganiserRefundMethod, OwnCardRefundMethod } from "@/lib/booking-modified-email-copy";
import type { useClubFormat } from "@/components/club-format-provider";
import { HandBackRefundConfirmation, OrganiserRefundConfirmation, OwnCardRefundConfirmation } from "@/components/cancel-booking-payment-notes";

export interface CancelResult {
  refundAmountCents: number;
  refundMethod: string;
  /** #4911 (`INV-PAY-154`): the card payment is disputed, so the refund went to the treasurer. */
  refundDisputed?: boolean;
  creditAmountCents?: number;
  creditRestoredCents?: number;
  organiserRefund?: { method: OrganiserRefundMethod; amountCents: number };
  ownCardRefund?: { method: OwnCardRefundMethod; amountCents: number; byHandCents?: number; toCheckCents?: number };
}

/**
 * The cancel flow's final panel (#4949). The heading takes focus when the step
 * commits, and names the refund, credit or manual-refund sentence below it as
 * its description, so a screen-reader user hears the whole outcome once —
 * through focus, not also through a live region.
 */
export function CancelBookingSuccessPanel({
  idPrefix,
  headingRef,
  result,
  onBehalfOfMember,
  notifiedMember,
  noEmailsSuppressesChoice,
  format,
}: {
  idPrefix: string;
  headingRef: Ref<HTMLParagraphElement>;
  result: CancelResult | null;
  onBehalfOfMember: boolean;
  notifiedMember: boolean | null;
  noEmailsSuppressesChoice: boolean;
  format: ReturnType<typeof useClubFormat>;
}) {
  const refund = result?.refundAmountCents || 0;
  const isCredit = result?.refundMethod === "credit";
  const detailId = `${idPrefix}-success-detail`;
  // Issue #1705: when the admin chose "Cancel booking, no email", the standard
  // email-promise copy would be untrue — state the recorded choice instead.
  //
  // #2259: the switch has to count here too. Since H1 the suppressed path
  // sends NO choice (so the mailer records the withhold), which leaves
  // `notifiedMember` null — and null used to mean "emails normally". Without
  // this disjunct the panel would promise a confirmation email for the one
  // booking guaranteed not to get one.
  const emailSuppressed = notifiedMember === false || noEmailsSuppressesChoice;
  const emailNote = emailSuppressed ? "" : onBehalfOfMember ? " They will receive a confirmation email shortly." : " You will receive a confirmation email shortly.";
  return (
    <div className="rounded-md border border-success-6 bg-success-3 p-4 space-y-1">
      <p
        ref={headingRef}
        tabIndex={-1}
        aria-describedby={detailId}
        className="text-sm font-medium text-success-11 outline-none"
      >
        {onBehalfOfMember
          ? "Booking cancelled on behalf of the member"
          : "Booking cancelled successfully"}
      </p>
      <div id={detailId} className="space-y-1">
        {result?.creditRestoredCents && result.creditRestoredCents > 0 && (
          <p className="text-sm text-success-11">
            {formatCents(result.creditRestoredCents, format)} of previously applied credit has been returned to {onBehalfOfMember ? "the member's" : "your"} account.
          </p>
        )}
        {/* B5 (#2262): a manual (cash / off-Xero) settlement has no card to
            refund to and mints no account credit — the club hands the money
            back directly. The plan-forbidden sentence ("processed to your
            original payment method") must never render for this outcome.
            #4911: a disputed card payment is handed to the treasurer the same
            way, and says so, even when an organiser would otherwise be refunded. */}
        {refund > 0 && result?.refundMethod === "manual" && (result.refundDisputed || !result.organiserRefund) ? (
          <HandBackRefundConfirmation disputed={result.refundDisputed === true} amountCents={refund} format={format} onBehalfOfMember={onBehalfOfMember} />
        ) : result?.organiserRefund ? (
          <OrganiserRefundConfirmation organiserRefund={result.organiserRefund} format={format} emailNote={emailNote} />
        ) : refund > 0 && isCredit ? (
          <p className="text-sm text-success-11">
            A credit of {formatCents(refund, format)} has been added to {onBehalfOfMember ? "the member's" : "your"} account for future bookings.
          </p>
        ) : refund > 0 ? (
          <OwnCardRefundConfirmation amountCents={result?.ownCardRefund?.amountCents ?? refund} byHandCents={result?.ownCardRefund?.byHandCents} toCheckCents={result?.ownCardRefund?.toCheckCents} pending={result?.ownCardRefund?.method === "card_pending"} format={format} emailNote={emailNote} onBehalfOfMember={onBehalfOfMember} />
        ) : emailSuppressed ? null : (
          <p className="text-sm text-success-11">
            {onBehalfOfMember
              ? "The member will receive a confirmation email shortly."
              : "You will receive a confirmation email shortly."}
          </p>
        )}
        {/*
          #2259: with the switch on there was no choice to record — the send was
          attempted and withheld — so pointing at "your choice in the audit log"
          would send the officer looking for an entry that does not exist. This
          is the most consequential message in the flow: the member has just
          lost a booking and will hear nothing, so point at the list that names
          the withheld notice instead.
        */}
        {emailSuppressed && (
          <p className="text-sm text-success-11">
            {noEmailsSuppressesChoice
              ? "The member was not emailed: emails are off for this booking. The withheld cancellation notice is listed on the booking — tell the member yourself."
              : "The member was not emailed about this cancellation — your choice is recorded in the audit log."}
          </p>
        )}
      </div>
    </div>
  );
}
