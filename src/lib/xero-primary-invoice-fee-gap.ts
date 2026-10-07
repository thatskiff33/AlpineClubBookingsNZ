/**
 * #3955 review X4 (`INV-PAY-119`): the primary invoice bills the change fee
 * recorded on the payment (`recordedChangeFeeCents`), but it is built before
 * Xero is asked for anything. Two things can leave it billing less:
 *
 *  - a finished-stay correction that recorded a fee on the unpaid booking while
 *    the create was in flight (its lines were already built); and
 *  - a lost response retried under the same idempotency key, which makes Xero
 *    hand back the ORIGINAL invoice whatever the retry's payload now says.
 *
 * So once the create has persisted its link and read the recorded fee back in
 * the same statement, the fee on the invoice Xero returned is compared with it
 * and any gap is billed on a supplementary invoice — never dropped. The
 * correction claims its fee write against the invoice link it read, which is
 * what makes the read-back complete: a fee written after the link was
 * persisted is refused, and the edit routes it again on its next approval.
 */
import type { LineItem } from "xero-node";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  CHANGE_FEE_LINE_DESCRIPTION,
  invoiceLineItemsTotalCents,
} from "@/lib/xero-modification-line-items";
import { enqueueXeroSupplementaryInvoiceOperation } from "@/lib/xero-operation-outbox";

/** The change fee an invoice's lines bill: its change-fee lines, as Xero adds them. */
export function billedChangeFeeCents(lineItems: ReadonlyArray<LineItem>): number {
  return invoiceLineItemsTotalCents(
    lineItems.filter((line) => line.description === CHANGE_FEE_LINE_DESCRIPTION),
  );
}

export async function queuePrimaryInvoiceChangeFeeGap(input: {
  bookingId: string;
  billedLineItems: ReadonlyArray<LineItem>;
  recordedChangeFeeCents: number;
  createdByMemberId?: string;
}): Promise<{ gapCents: number; queueOperationId: string | null }> {
  const billedCents = billedChangeFeeCents(input.billedLineItems);
  const gapCents = input.recordedChangeFeeCents - billedCents;
  if (gapCents <= 0) {
    if (gapCents < 0) {
      // No writer lowers a recorded fee, so an invoice billing MORE than the
      // payment records was built from figures that no longer stand. Loud, not
      // corrected: a credit note is a treasurer's decision.
      logger.error(
        { bookingId: input.bookingId, billedCents, recordedChangeFeeCents: input.recordedChangeFeeCents },
        "The booking's primary Xero invoice bills more change fee than its payment records (#3955 X4)",
      );
    }
    return { gapCents: 0, queueOperationId: null };
  }

  // A supplementary invoice is anchored on an edit. The fee in the gap was
  // recorded by an edit made while no invoice existed, so none of those edits
  // raised a document of its own; the latest fee-bearing one carries it.
  const anchor = await prisma.bookingModification.findFirst({
    where: { bookingId: input.bookingId, changeFeeCents: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!anchor) {
    logger.error(
      { bookingId: input.bookingId, gapCents },
      "The booking's primary Xero invoice bills less change fee than its payment records, and no edit recorded one to anchor the remainder on (#3955 X4)",
    );
    return { gapCents, queueOperationId: null };
  }

  const queued = await enqueueXeroSupplementaryInvoiceOperation(
    {
      bookingId: input.bookingId,
      priceDiffCents: 0,
      changeFeeCents: gapCents,
      bookingModificationId: anchor.id,
    },
    { createdByMemberId: input.createdByMemberId },
  );
  logger.warn(
    {
      bookingId: input.bookingId,
      bookingModificationId: anchor.id,
      gapCents,
      queueOperationId: queued.queueOperationId,
    },
    "The booking's primary Xero invoice was built before a change fee was recorded; the remainder is billed on a supplementary invoice (#3955 X4)",
  );
  return { gapCents, queueOperationId: queued.queueOperationId };
}
