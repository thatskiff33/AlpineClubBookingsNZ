"use client";

import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import {
  bookingCancelledRefundMade,
  bookingCancelledRefundSentence,
  type OrganiserRefundMethod,
  organiserByHandRefundSentence,
  ownCardRefundPendingSentence,
  ownCardRefundWithShortfallSentence,
} from "@/lib/booking-modified-email-copy";
import type { CancelCardRefundSplit } from "@/lib/cancel-card-refund-shortfall";

/**
 * #3643: the two cancel-dialog lines internet banking needs, and the
 * confirmations of an organiser-paid refund (#3973) and of an own-card refund
 * not made yet (#4084), split out of `cancel-booking-button.tsx` for size.
 * #4119: the preview's card line when the card refund plan is short.
 */

/** No payment the app can refund: none taken, or one settled by hand (DECISION 2). */
export function NoRefundablePaymentNote({ settledByHand }: { settledByHand?: boolean }) {
  return settledByHand ? (
    <p className="text-sm text-muted-foreground" data-testid="payment-settled-by-hand">
      Xero shows a payment against this booking that the app cannot hand back as account
      credit. Cancelling treats the booking as unpaid: no refund or credit is given, and the
      treasurer is alerted to settle that payment by hand.
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">
      No payment has been taken for this booking. No refund applies.
    </p>
  );
}

/** The only outcome for an internet banking payment (`forcedCancelRefundMethod`). */
function ForcedCreditRefundNote({
  creditRefundAmountCents,
  creditRefundPercentage,
  format,
}: {
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  format: ClubFormat;
}) {
  return (
    <div className="space-y-1" data-testid="forced-credit-refund">
      <p>
        <span className="font-medium text-success-11">
          Hold {formatCents(creditRefundAmountCents, format)} as account credit
        </span>
        <span className="text-muted-foreground ml-1">({creditRefundPercentage}% refund)</span>
      </p>
      <p className="text-muted-foreground">
        This booking was paid by internet banking, so any refund is held as account credit.
      </p>
    </div>
  );
}

/** #3653: the only outcome for a booking the group organiser paid for by card. */
function OrganiserCardRefundNote({
  refundAmountCents,
  refundPercentage,
  format,
}: {
  refundAmountCents: number;
  refundPercentage: number;
  format: ClubFormat;
}) {
  return (
    <div className="space-y-1" data-testid="organiser-card-refund">
      <p>
        <span className="font-medium text-success-11">
          Refund {formatCents(refundAmountCents, format)} to the group organiser&apos;s card
        </span>
        <span className="text-muted-foreground ml-1">({refundPercentage}% refund)</span>
      </p>
      <p className="text-muted-foreground">
        The group organiser paid for this booking, so any refund goes back to their card.
      </p>
    </div>
  );
}

/** The one outcome a forced refund method leaves (`forcedCancelRefundMethod`). */
export function ForcedRefundNote({
  preview,
  forced,
  format,
}: {
  preview: {
    refundAmountCents: number;
    refundPercentage: number;
    creditRefundAmountCents: number;
    creditRefundPercentage: number;
  };
  forced: "credit" | "organiser_card" | "organiser_by_hand";
  format: ClubFormat;
}) {
  // #3949 (owner decision, 22 Oct 2026): the organiser paid by Internet Banking, so the club repays them by bank transfer.
  if (forced === "organiser_by_hand") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="cancel-organiser-by-hand-refund-note">
        {organiserByHandRefundSentence(formatCents(preview.refundAmountCents, format))} ({preview.refundPercentage}% refund)
      </p>
    );
  }
  return forced === "organiser_card" ? (
    <OrganiserCardRefundNote
      refundAmountCents={preview.refundAmountCents}
      refundPercentage={preview.refundPercentage}
      format={format}
    />
  ) : (
    <ForcedCreditRefundNote
      creditRefundAmountCents={preview.creditRefundAmountCents}
      creditRefundPercentage={preview.creditRefundPercentage}
      format={format}
    />
  );
}

/**
 * #3973: the confirmation after cancelling a joiner's booking the group
 * organiser paid for by card. The refund is the ORGANISER's, so it never reads
 * "your original payment method": the cancel's own answer of where it went, in
 * the "Booking Cancelled" email's own sentence and tone. `emailNote` is the
 * button's confirmation-email sentence, or nothing when no email goes.
 */
export function OrganiserRefundConfirmation({
  organiserRefund,
  format,
  emailNote,
}: {
  organiserRefund: { method: OrganiserRefundMethod; amountCents: number };
  format: ClubFormat;
  emailNote: string;
}) {
  const { method, amountCents } = organiserRefund;
  const sentence = bookingCancelledRefundSentence(amountCents, formatCents(amountCents, format), method);
  const tone = bookingCancelledRefundMade(amountCents, method) ? "text-success-11" : "text-info-11";
  return <p className={`text-sm ${tone}`}>{sentence + emailNote}</p>;
}

/**
 * The confirmation after a cancel refunded to the member's own card. #4084:
 * when Stripe did not make that refund (the cancel's `ownCardRefund` says
 * `card_pending`, so `pending`), it is the "Booking Cancelled" email's own
 * sentence, as information, never "has been processed"; an officer cancelling
 * on the member's behalf reads "the member's". A made refund keeps its wording.
 * #4097: the parts the card refund could not carry - `byHandCents` by bank
 * transfer, `toCheckCents` the club will be in touch about - are named beside
 * the card's own amount (`amountCents`), as information.
 */
export function OwnCardRefundConfirmation({
  amountCents,
  byHandCents = 0,
  toCheckCents = 0,
  pending,
  format,
  emailNote,
  onBehalfOfMember,
}: {
  amountCents: number;
  byHandCents?: number;
  toCheckCents?: number;
  pending: boolean;
  format: ClubFormat;
  emailNote: string;
  onBehalfOfMember: boolean;
}) {
  const amount = formatCents(amountCents, format);
  const whose = onBehalfOfMember ? "the member's" : "your";
  if (byHandCents + toCheckCents > 0) {
    const shortfall = { bankCents: byHandCents, checkCents: toCheckCents, formatAmount: (cents: number) => formatCents(cents, format) };
    const sentence = ownCardRefundWithShortfallSentence(amountCents, shortfall, pending, whose);
    return <p className="text-sm text-info-11" data-testid="own-card-refund-by-hand-remainder">{sentence + emailNote}</p>;
  }
  if (pending) {
    return <p className="text-sm text-info-11">{ownCardRefundPendingSentence(amount, whose) + emailNote}</p>;
  }
  return (
    <p className="text-sm text-success-11">
      {onBehalfOfMember
        ? `The refund of ${amount} has been processed to the member's original payment method.${emailNote}`
        : `Your refund of ${amount} has been processed to your original payment method.${emailNote}`}
    </p>
  );
}

/**
 * #4119 (`INV-PAY-131`): the card option's label when the card refund plan is
 * short - what goes to the card and what by bank transfer, never the part the
 * club checks first, which is not promised as a refund.
 */
export function cardShortfallOptionLabel(split: CancelCardRefundSplit, format: ClubFormat): string {
  const parts = [
    split.cardCents > 0 ? `${formatCents(split.cardCents, format)} to original payment method` : null,
    split.bankCents > 0 ? `${formatCents(split.bankCents, format)} by bank transfer` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Refund ${parts.join(" and ")}` : "Refund: the club will be in touch";
}

/**
 * #4119 (`INV-PAY-131`): the cancel preview's figures when the card refund plan
 * cannot carry the policy's whole refund - the card's part, the part the club
 * refunds by bank transfer and the part it will be in touch about, sized by the
 * cancel's own sizing (`cancelPreviewCardShortfall`).
 */
export function CardRefundShortfallRows({ split, format }: { split: CancelCardRefundSplit; format: ClubFormat }) {
  // The part to check is not promised as a refund, so it does not read as one.
  const rows: Array<[string, number, string]> = [
    ["Refund to card:", split.cardCents, "text-success-11"],
    ["Refund by bank transfer:", split.bankCents, "text-success-11"],
    ["To be confirmed by the club:", split.checkCents, "text-muted-foreground"],
  ];
  return (
    <>
      {rows
        .filter(([, cents]) => cents > 0)
        .map(([label, cents, tone]) => (
          <div key={label} className="flex justify-between">
            <span className="text-muted-foreground">{label}</span>
            <span className={`font-medium ${tone}`}>{formatCents(cents, format)}</span>
          </div>
        ))}
    </>
  );
}

/**
 * #4119 (`INV-PAY-131`): the same parts as one sentence from the wording home,
 * said before anything is asked of the card ("planned"), under the figures.
 */
export function CardRefundShortfallSentence({
  split,
  format,
  onBehalfOfMember,
}: {
  split: CancelCardRefundSplit;
  format: ClubFormat;
  onBehalfOfMember: boolean;
}) {
  const sentence = ownCardRefundWithShortfallSentence(
    split.cardCents,
    { bankCents: split.bankCents, checkCents: split.checkCents, formatAmount: (cents) => formatCents(cents, format) },
    "planned",
    onBehalfOfMember ? "the member's" : "your",
  );
  return <p className="text-sm text-info-11" data-testid="cancel-preview-card-shortfall">{sentence}</p>;
}
