/**
 * #3980 (`INV-PAY-136`): AN EDIT THAT READ "NO PRIMARY INVOICE YET" CONFIRMS IT
 * ON THE PAYMENT ROW, AND SAYS SO ON ITS HISTORY ROW.
 *
 * An edit decides whether to adjust the booking's primary Xero invoice from the
 * invoice link it read (`hasIssuedPrimaryXeroInvoice`). Reading none, it raises
 * no Xero document of its own: the primary invoice bills the booking as it then
 * stands. That holds only if the edit commits before the invoice create reads
 * the booking. The create reads once, calls Xero, and saves the link seconds
 * later (`persistPrimaryInvoiceLink`), so an edit can land in between, or after.
 *
 * Two halves close it, as #3955 closed it for a finished-stay correction's fee:
 *
 *  - THE CLAIM ({@link claimPrimaryInvoiceStillUnlinked}). One guarded write on
 *    the Payment row, `updateMany where {id, xeroInvoiceId: null}`, carrying the
 *    edit's fee increment when it records one and an increment of 0 otherwise.
 *    It puts every such edit and the link's save on the same row lock: whichever
 *    writes second sees the other. An edit that loses is refused whole with
 *    {@link PrimaryInvoiceRaisedDuringEditError} (409, try again); on the retry it
 *    reads the link and adjusts the invoice like any edit.
 *  - THE MARKER ({@link SETTLED_AGAINST_PRIMARY_INVOICE_PATH}). The edit's
 *    `BookingModification.newData` records that it settled against the primary
 *    invoice. An edit that won the claim before the link was saved, but after
 *    the create read the booking, is in the worth the link's save reads back and
 *    not in the lines Xero billed; the create bills that gap on a supplementary
 *    invoice anchored on a marked edit (`queuePrimaryInvoiceWorthGap`). A marked
 *    edit raised no document of its own, so an invoice anchored on one is the
 *    gap's and nothing else's.
 *
 * A leaf module (only `ApiError` and the transient race refusal) so the edit
 * doors, the guests route, the other price writers that claim (the review
 * re-base, the school pending-adult naming) and the gap check share one
 * marker and one write ({@link writeEditOnPayment}) without pulling each
 * other's graphs in (`INV-SSOT-001`).
 */
import type { Prisma } from "@prisma/client";

import { AdditionalAskChangedDuringReductionError } from "@/lib/additional-ask-reduction-error";

/** The member-facing refusal when the primary invoice was linked while the edit ran. */
export const PRIMARY_INVOICE_RAISED_DURING_EDIT_MESSAGE =
  "This booking's invoice was being raised while your change was being saved, so nothing was changed. Please try again in a moment.";

/**
 * The refusal itself: TRANSIENT, like the unpaid-ask race it extends, so every
 * place that already recognises that race treats this one the same way. A
 * member-guest consent decline or expiry propagates it rather than marking its
 * row BLOCKED for good, and the consent route answers it with its own "try
 * again" sentence (`CONSENT_ANSWER_RACED_MESSAGE`). Every other door maps an
 * `ApiError` straight to its message and status.
 */
export class PrimaryInvoiceRaisedDuringEditError extends AdditionalAskChangedDuringReductionError {
  constructor(message: string = PRIMARY_INVOICE_RAISED_DURING_EDIT_MESSAGE) {
    super(message);
    this.name = "PrimaryInvoiceRaisedDuringEditError";
  }
}

/** The `newData` path of the marker; read by the gap check's anchor query. */
export const SETTLED_AGAINST_PRIMARY_INVOICE_PATH = [
  "primaryInvoiceSettlement",
  "settledAgainstPrimaryInvoice",
] as const;

/** Whether an edit that read this payment settles against the primary invoice: it read no invoice link. */
export function settlesAgainstPrimaryInvoice(
  payment: { xeroInvoiceId: string | null } | null | undefined,
): boolean {
  return !payment?.xeroInvoiceId;
}

/**
 * How the edit settled its own money, beside the marker (#3980 review M5): what
 * it refunded, credited, gave back of applied credit and took off an unpaid
 * ask. A treasurer told the primary invoice bills more than the booking is
 * worth needs it to raise the credit note and record the refund paid out.
 */
export type PrimaryInvoiceEditSettlement = {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  appliedCreditGivenBackCents: number;
  unpaidAskOffsetCents: number;
};

export type PrimaryInvoiceSettlementMarker = { settledAgainstPrimaryInvoice: true } & PrimaryInvoiceEditSettlement;

/** The `newData` fields an edit writes for the marker, or none. */
export function primaryInvoiceSettlementHistory(
  edit: { settledAgainstPrimaryInvoice: boolean } & Partial<PrimaryInvoiceEditSettlement>,
): { primaryInvoiceSettlement?: PrimaryInvoiceSettlementMarker } {
  if (!edit.settledAgainstPrimaryInvoice) return {};
  return {
    primaryInvoiceSettlement: {
      settledAgainstPrimaryInvoice: true,
      refundAmountCents: edit.refundAmountCents ?? 0,
      accountCreditAmountCents: edit.accountCreditAmountCents ?? 0,
      appliedCreditGivenBackCents: edit.appliedCreditGivenBackCents ?? 0,
      unpaidAskOffsetCents: edit.unpaidAskOffsetCents ?? 0,
    },
  };
}

/** The settlement a marked edit recorded, or null for an unmarked one. */
export function recordedPrimaryInvoiceSettlement(newData: unknown): PrimaryInvoiceEditSettlement | null {
  const record = asObject(asObject(newData)?.primaryInvoiceSettlement);
  if (!record || record.settledAgainstPrimaryInvoice !== true) return null;
  const cents = (value: unknown) => (Number.isInteger(value) ? (value as number) : 0);
  return {
    refundAmountCents: cents(record.refundAmountCents),
    accountCreditAmountCents: cents(record.accountCreditAmountCents),
    appliedCreditGivenBackCents: cents(record.appliedCreditGivenBackCents),
    unpaidAskOffsetCents: cents(record.unpaidAskOffsetCents),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The claim. Run by an edit that read a payment row with no invoice link
 * ({@link settlesAgainstPrimaryInvoice}), inside the edit's own transaction, so
 * a refusal rolls the whole edit back. `changeFeeIncrementCents` is the fee the
 * edit records on the payment, 0 when it records none: the write is the fee's
 * own write, never a second one. An edit with no payment row has nothing to
 * claim; the create needs one to run at all.
 */
export async function claimPrimaryInvoiceStillUnlinked(
  tx: Pick<Prisma.TransactionClient, "payment">,
  input: {
    paymentId: string;
    changeFeeIncrementCents: number;
    /** A door whose actor retries differently words it itself (a finished-stay correction is approved again). */
    refusalMessage?: string;
  },
): Promise<void> {
  const claimed = await tx.payment.updateMany({
    where: { id: input.paymentId, xeroInvoiceId: null },
    data: { changeFeeCents: { increment: Math.max(0, input.changeFeeIncrementCents) } },
  });
  if (claimed.count !== 1) {
    throw new PrimaryInvoiceRaisedDuringEditError(input.refusalMessage);
  }
}

/**
 * The edit's write on its payment row, made once by `applyPaymentAdjustments`
 * after its arms: read no invoice link, the claim, carrying the fee the edit
 * records (`changeFeeCents`, 0 for none); read one, the fee alone, as every
 * edit recorded it before #3980. Returns whether the edit settled against the
 * primary invoice, which the door writes to its history row.
 */
export async function writeEditOnPayment(
  tx: Pick<Prisma.TransactionClient, "payment">,
  input: {
    payment: { id: string; xeroInvoiceId: string | null } | null | undefined;
    changeFeeCents: number;
    refusalMessage?: string;
    /** Organiser-paid children have a combined invoice, never a primary of their own. */
    settledAgainstCombinedInvoice?: boolean;
  },
): Promise<boolean> {
  const settled = !input.settledAgainstCombinedInvoice && settlesAgainstPrimaryInvoice(input.payment);
  if (!input.payment) return settled;
  if (settled) {
    await claimPrimaryInvoiceStillUnlinked(tx, {
      paymentId: input.payment.id,
      changeFeeIncrementCents: input.changeFeeCents,
      refusalMessage: input.refusalMessage,
    });
  } else if (input.changeFeeCents > 0) {
    await tx.payment.update({
      where: { id: input.payment.id },
      data: { changeFeeCents: { increment: input.changeFeeCents } },
    });
  }
  return settled;
}
