/**
 * `INV-PAY-017` (#3535): how much a note must clear to close an unpaid
 * booking's Xero invoicing — the ONE home of that sizing. The internet-banking
 * hold-expiry release, the never-captured cancel path, the repair tool's
 * cancelled-open-invoice arm and the hold-clearing audit all read it here, so
 * none of them can size the same invoice differently.
 *
 * The booking is invoiced at its FULL price (the primary invoice, plus a
 * supplementary invoice for any upward edit and its change fee), never at the
 * credit-reduced amount the member was asked to pay. What is still open is that
 * total less only the applied credit already allocated to the invoice AS A XERO
 * CREDIT NOTE (the `MemberCreditNoteAllocation` slices); credit applied locally
 * never reduced a Xero balance, so it is not subtracted. Floored at zero.
 *
 * Pure: the caller reads the three figures (under whatever locks it holds).
 */
export function unpaidInvoiceClearingAmountCents(input: {
  finalPriceCents: number;
  changeFeeCents: number;
  /** Sum of the booking's `MemberCreditNoteAllocation.amountCents` (positive). */
  xeroAllocatedAppliedCreditCents: number;
}): number {
  return Math.max(
    0,
    input.finalPriceCents +
      input.changeFeeCents -
      Math.max(0, input.xeroAllocatedAppliedCreditCents),
  );
}
