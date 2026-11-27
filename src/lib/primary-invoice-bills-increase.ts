import type { PaymentSource, Prisma } from "@prisma/client";

import { bookingHasExternalSettlement } from "@/lib/booking-external-settlement";
import {
  bookingAmountOwedCents,
  feeOwedAfterEditCents,
  hasCapturedPayment,
  isSettledOnInternetBanking,
} from "@/lib/booking-payment-state";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { unallocatedAppliedCents } from "@/lib/xero-applied-credit-ledger-state";

type IncreaseBooking = {
  id: string;
  status: string;
  finalPriceCents: number;
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: {
    status: string;
    source: PaymentSource;
    amountCents: number;
    changeFeeCents: number | null;
    xeroInvoiceId: string | null;
    manuallyMarkedPaidAt: Date | null;
  } | null;
};

type IncreaseEdit = {
  /** The edit's net: its price change plus its fee, after the unpaid ask took its share. */
  netAmountCents: number;
  priceDiffCents: number;
  /** This edit's fee, whoever records it on the payment. */
  changeFeeCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
};

/**
 * #5288 (`INV-PAY-163`, owner decision 20 Nov 2026): may this edit's increase
 * be billed by raising the booking's primary Xero invoice now? The Internet
 * Banking counterpart of `canAskCardForIncrease`: a settled booking on a
 * settled Internet Banking payment that account credit paid in full, with no
 * primary invoice linked yet. It has no card to ask and no invoice for a
 * supplementary one to sit beside, so the primary invoice, which bills the
 * price plus every recorded fee, carries the increase.
 *
 * Not a booking with bank cash recorded (`hasCapturedPayment`): the invoice
 * bills the booking's whole worth and a create records only card cash against
 * it, so the member would be billed again for a transfer already made. It stays
 * `unasked` in the census, for the treasurer. Not a booking settled outside the
 * app (`bookingHasExternalSettlement`): the invoice enqueue refuses it (#2262),
 * so the member would be told of an invoice that never comes. Not an
 * organiser's place: the organiser's combined invoice bills it (#4299). One the
 * enqueue refuses for a create an officer resolved by hand in Xero (#3635) is
 * still asked; with no link or queued create, the census lists it as `unasked`.
 */
function mayBillIncreaseOnNewPrimaryInvoice(booking: IncreaseBooking, edit: IncreaseEdit): boolean {
  return (
    edit.netAmountCents > 0 &&
    !edit.hasSucceededPayment &&
    !edit.hasIssuedXeroInvoice &&
    !paidByOrganiserInternetBanking(booking) &&
    isSettledOnInternetBanking(booking) &&
    !hasCapturedPayment(booking.payment) &&
    !booking.payment?.xeroInvoiceId &&
    !bookingHasExternalSettlement(booking)
  );
}

/**
 * What a booking's primary invoice shows as due once it is raised and the
 * applied credit is allocated to it (owner decision, 28 Nov 2026: the member is
 * asked for this, not for one edit's increase). ONE FIGURE, built from the two
 * the Xero legs use: the worth the invoice bills (`bookingWorthCents`, inside
 * `bookingAmountOwedCents`: the price plus every recorded fee) less the credit
 * the allocation engine allocates (`unallocatedAppliedCents`). Never below
 * zero: credit kept from an earlier reduction can exceed the new worth, and
 * then nothing is due.
 */
export function primaryInvoiceDueCents(input: {
  finalPriceCents: number;
  changeFeeCents: number | null;
  unallocatedAppliedCreditCents: number;
}): number {
  return Math.max(
    0,
    bookingAmountOwedCents({
      finalPriceCents: input.finalPriceCents,
      changeFeeCents: input.changeFeeCents,
      appliedCreditCents: input.unallocatedAppliedCreditCents,
    }),
  );
}

/**
 * What an edit's increase has Xero bill, and on which invoice. Once the primary
 * is issued: the edit's own net, on its supplementary invoice. With none linked
 * (#5288): what the primary invoice the door raises will show as due
 * (`primaryInvoiceDueCents`), read inside the edit's transaction, after its
 * locks - so an earlier fee nobody was asked for is asked now, and credit the
 * club kept from an earlier reduction is not asked for twice. Nothing due means
 * no invoice and no ask. Zero otherwise: a reduction, a card ask, or a booking
 * nothing bills.
 */
export async function xeroBilledIncrease(
  tx: Pick<Prisma.TransactionClient, "memberCredit">,
  booking: IncreaseBooking,
  edit: IncreaseEdit,
): Promise<{ xeroAdditionalAmountCents: number; primaryInvoiceBillsIncrease: boolean }> {
  if (!mayBillIncreaseOnNewPrimaryInvoice(booking, edit)) {
    const billedOnSupplementary = edit.hasIssuedXeroInvoice && edit.netAmountCents > 0;
    return { xeroAdditionalAmountCents: billedOnSupplementary ? edit.netAmountCents : 0, primaryInvoiceBillsIncrease: false };
  }
  const dueCents = primaryInvoiceDueCents({
    finalPriceCents: booking.finalPriceCents + edit.priceDiffCents,
    changeFeeCents: feeOwedAfterEditCents(booking.payment, edit.changeFeeCents),
    unallocatedAppliedCreditCents: await unallocatedAppliedCents(booking.id, tx),
  });
  return { xeroAdditionalAmountCents: dueCents, primaryInvoiceBillsIncrease: dueCents > 0 };
}
