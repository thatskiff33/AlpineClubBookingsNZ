import { PaymentSource, type Prisma } from "@prisma/client";

import { hasVoidAwaitingFollowUp } from "@/lib/bank-refund-void-scan";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { formatCents } from "@/lib/utils";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";

/**
 * #4230 (owner decision 22 Oct 2026, `INV-ADDPAY-021`): what the floor's alert
 * tells the officer to do. Below the detail is a real shortfall in Xero. The
 * alert never fires while a voided refund note waits for the nightly follow-up
 * (`hasVoidAwaitingFollowUp`, below), so the cause it usually means is a refund
 * whose note was never raised: a later refund on a bank-transfer payment can be
 * counted under the payment's first refund note instead of getting its own
 * (#4287). A void reaches it only once the follow-up or a person has answered
 * it (a marker on the note's link) with the cash still recorded, and its
 * replacement comes from that answer, never by hand. The one wording, shown in
 * the alert and quoted by the Xero guide's troubleshooting row, which a test
 * holds to this constant.
 */
export const BANK_TRANSFER_REFUND_SHORTFALL_ADVICE =
  "A refund on this payment may have no Xero credit note of its own: a later refund can be counted under the payment's first refund note instead of getting its own. Check the booking's invoice in Xero and raise a credit note by hand only for a refund whose credit note was never raised. Never raise one by hand for a refund whose credit note was voided in Xero: a voided note is handled on the treasurer's refund list or on Stuck States, and once it has been answered there, any replacement note comes from that answer.";

/** The floor's alert, in plain English: where to look, the two totals, what was kept, and the advice above. */
function bankTransferRefundShortfallMessage(input: {
  paymentId: string;
  bookingId: string;
  creditNoteNumber: string | null;
  xeroTotal: string;
  recordedTotal: string;
}): string {
  const found = input.creditNoteNumber ? ` Found when credit note ${input.creditNoteNumber} changed in Xero.` : "";
  return `Bank-transfer payment ${input.paymentId} on booking ${input.bookingId}: the refunds Xero accounts for on it add up to ${input.xeroTotal}, less than the refunds the club recorded on it (${input.recordedTotal}). The recorded refunds were kept.${found} ${BANK_TRANSFER_REFUND_SHORTFALL_ADVICE}`;
}

/** A floor's alert, held until the writer's transaction commits (`sendBankTransferFloorAlert`). */
export type BankTransferFloorAlert = {
  paymentId: string;
  bookingId: string;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  xeroDerivedCents: number;
  floorCents: number;
};

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-021`): THE BANK-TRANSFER
 * FLOOR on every writer of a refunded total from Xero (#4449: through
 * `decideXeroRefundedColumns`, in the recount, the kept settle and the allocation write).
 *
 * A bank-transfer payment's refunded total is never lowered below its own
 * transaction detail - the hand-backs the treasurer recorded - by what Xero's
 * live notes say. A voided refund note is carried through the detail, the
 * ledger line and the total together by the nightly follow-up
 * (`bank-refund-void-follow-up.ts`, `INV-ADDPAY-042`), never by this recount
 * alone. When Xero shows less, the detail is kept, logged and alerted, as the
 * card floor is (#1353) - at info and with no alert while a voided refund note
 * on the payment waits for that follow-up, which is the expected divergence.
 * What the alert advises is `BANK_TRANSFER_REFUND_SHORTFALL_ADVICE`.
 * A total already below its detail is never raised here; one above it may
 * still come down to it. Any other source passes through untouched.
 *
 * #4449: the floor's decision on the caller's client, its alert returned, not
 * sent, so a writer deciding the total inside its locked transaction (the kept
 * settle, the note sync's allocation write) sends it after its commit.
 */
export async function bankTransferFloorCents(
  store: Prisma.TransactionClient,
  input: {
    payment: { id: string; bookingId: string; source: PaymentSource; refundedAmountCents: number };
    xeroDerivedCents: number;
    creditNoteId: string | null;
    creditNoteNumber?: string | null;
  },
): Promise<{ cents: number; alert: BankTransferFloorAlert | null }> {
  const { payment, xeroDerivedCents } = input;
  if (payment.source !== PaymentSource.INTERNET_BANKING || xeroDerivedCents >= payment.refundedAmountCents) {
    return { cents: xeroDerivedCents, alert: null };
  }
  const detail = await store.paymentTransaction.aggregate({ where: { paymentId: payment.id }, _sum: { refundedAmountCents: true } });
  const floorCents = Math.min(payment.refundedAmountCents, Math.max(0, detail._sum.refundedAmountCents ?? 0));
  if (xeroDerivedCents >= floorCents) return { cents: xeroDerivedCents, alert: null };
  // A voided refund note the nightly follow-up has not handled yet explains
  // the divergence and resolves it: logged, not alerted (review, security 12).
  if (await hasVoidAwaitingFollowUp(store, payment.id)) {
    logger.info(
      { creditNoteId: input.creditNoteId, paymentId: payment.id, detailCents: floorCents, xeroDerivedRefundedTotalCents: xeroDerivedCents },
      "Bank-transfer refund total kept at its detail while a voided refund note waits for the nightly follow-up (#4162 floor)",
    );
    return { cents: floorCents, alert: null };
  }
  logger.warn(
    {
      creditNoteId: input.creditNoteId,
      paymentId: payment.id,
      localRefundedAmountCents: payment.refundedAmountCents,
      detailCents: floorCents,
      xeroDerivedRefundedTotalCents: xeroDerivedCents,
    },
    "Xero-derived refund total is below the bank-transfer payment's own refund detail; keeping the detail (#4162 floor)",
  );
  return {
    cents: floorCents,
    alert: {
      paymentId: payment.id,
      bookingId: payment.bookingId,
      creditNoteId: input.creditNoteId,
      creditNoteNumber: input.creditNoteNumber ?? null,
      xeroDerivedCents,
      floorCents,
    },
  };
}

/** The floor's alert (`BANK_TRANSFER_REFUND_SHORTFALL_ADVICE`), sent outside any transaction. */
export async function sendBankTransferFloorAlert(alert: BankTransferFloorAlert, format: ClubFormat): Promise<void> {
  await notifyXeroSyncError({
    errorType: "refund-ledger-divergence",
    operation: `inbound-credit-note-repair:${alert.creditNoteId ?? `recount:${alert.paymentId}`}`,
    errorMessage: bankTransferRefundShortfallMessage({
      paymentId: alert.paymentId,
      bookingId: alert.bookingId,
      creditNoteNumber: alert.creditNoteNumber,
      xeroTotal: formatCents(alert.xeroDerivedCents, format),
      recordedTotal: formatCents(alert.floorCents, format),
    }),
  });
}
