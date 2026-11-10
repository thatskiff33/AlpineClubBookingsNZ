/**
 * #3954 review round 6: WHAT XERO BILLED OF THE ASK A REDUCTION RETIRED,
 * DECIDED FROM EVIDENCE.
 *
 * A reduction set against an unpaid ask splits its offset between the smaller
 * re-issue's own invoice (decision A) and an invoice-correction note on the
 * primary invoice for what that invoice had already billed (owner decision
 * 10 Oct 2026, `splitUnpaidAskOffsetForXero`). Which part of the ask the
 * primary invoice billed used to be inferred from the supplementary invoices
 * found parked on it: anything not parked was "billed by the primary". But an
 * increase queues its supplementary invoice after its edit commits, so a
 * reduction saved moments later found none and credit-noted money no invoice
 * had billed.
 *
 * Now each row of the ask says how its money was billed:
 *
 * - a row's OWN money (its amount less what it carried) was asked by an
 *   increase. Its parked invoice covers it; without one, the asking edit's own
 *   answer to whether the primary invoice existed says which invoice bills it
 *   (round 7) - true, its supplementary invoice (still to be queued); false, the
 *   primary invoice raised afterwards. A row a failed mint's recovery minted
 *   reads that recovery's frozen answer (`hadIssuedXeroInvoice`, #3181); a row
 *   the edit's door minted reads the answer the door stamped on it. (Round 6
 *   dated the row's write against the primary invoice's link instead, which a
 *   recovery minting hours later, or a link backfilled later, gets wrong.)
 * - money a row carried from outside the chain is a re-issue's, or the
 *   asks an increase folded in (re-issues and increase retries): billed by
 *   their recorded invoices, the rest by the primary invoice. An unsure part
 *   is reported, not guessed. The re-issue is found through the recovery that
 *   minted the row, or the increase through the fold its history records -
 *   or, for a row minted since round 8, through the edit its mint stamped on it;
 * - a waiting recovery's figures were recorded at its edit's save
 *   (`hadIssuedXeroInvoice`), and `retireUnpaidAskChain` has counted them.
 *
 * Where any of that cannot be established - an answer nobody recorded (a row
 * minted before round 7, or by the draining colour of that deploy), a row whose
 * carried figure does not add up, a carried part nothing names, or a carried
 * re-issue whose own reduction was itself unsure of its invoice (round 8) - the evidence
 * is `established: false`, and the edit records the offset, and what the
 * re-issue's invoice may still owe, for a person
 * (`unpaidAskBilledOffsetUnsureCents`, `reissuedAskInvoiceUnsureCents`) rather
 * than act on a guess.
 */
import type { Prisma } from "@prisma/client";
import { PaymentRecoveryOperationType } from "@prisma/client";

import type { RetiredUnpaidAsk, UnpaidPriceAskRow } from "@/lib/additional-ask-reduction";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
  REISSUED_ASK_REASON,
} from "@/lib/payment-recovery-keys";
import {
  recordedFoldedAskCents,
  recordedFoldedIncreaseAsks,
  recordedFoldedReissuedAskModificationIds,
  recordedReissuedAskInvoiceCents,
  recordedReissuedAskInvoiceUnsureCents,
} from "@/lib/unpaid-ask-offset-marker";

export type UnpaidAskBillingEvidence = {
  /** The ask's money a supplementary invoice bills or will bill - parked, or still to be queued. */
  supplementaryInvoicedCents: number;
  /** Whether the rest is established as billed by the primary invoice. */
  established: boolean;
};

/** The recovery that minted an intent: its edit, and that edit's frozen invoice answer. */
export type IntentMinter = { modificationId: string; hadIssuedXeroInvoice: boolean | null };

type EvidenceModification = {
  id: string;
  priceDiffCents: number;
  changeFeeCents: number;
  newData: unknown;
  createdAt: Date;
};

/** The pure reading, given what the loader read (`unpaidAskBillingEvidence`). */
export function classifyUnpaidAskBilling({
  rows,
  retired,
  modifications,
  intentMinters,
}: {
  rows: readonly UnpaidPriceAskRow[];
  retired: Pick<RetiredUnpaidAsk, "invoicedCents" | "parkedOps" | "invoiceEvidenceUnknown">;
  modifications: readonly EvidenceModification[];
  /** The recovery that minted each intent, by intent id; a door-minted row has none. */
  intentMinters: ReadonlyMap<string, IntentMinter>;
}): UnpaidAskBillingEvidence {
  let supplementaryInvoicedCents = retired.invoicedCents;
  let established = !retired.invoiceEvidenceUnknown;
  const modification = (id: string) => modifications.find((row) => row.id === id) ?? null;
  const isReduction = (id: string) => {
    const row = modification(id);
    return row !== null && row.priceDiffCents + row.changeFeeCents < 0;
  };

  rows.forEach((row, index) => {
    const previous = index > 0 ? rows[index - 1]! : null;
    const ownCents = row.amountCents - row.carriedAskCents;
    const carriedInCents = row.carriedAskCents - (previous?.amountCents ?? 0);
    if (ownCents < 0 || carriedInCents < 0) {
      established = false;
      return;
    }
    const parkedAnchors = retired.parkedOps.flatMap((op) =>
      op.intentId !== null && op.intentId === row.stripePaymentIntentId && op.anchorId ? [op.anchorId] : [],
    );
    // #4744: a row that names its edit is covered only by that edit's parked
    // invoice. A folded increase's invoice waiting on this same intent is the
    // earlier edit's, so it does not cover this row's own money. A row that
    // names no edit keeps the older rule: any parked invoice that is not a
    // re-issue's covers it.
    const ownEditId =
      (row.stripePaymentIntentId ? intentMinters.get(row.stripePaymentIntentId)?.modificationId : undefined) ??
      row.bookingModificationId ??
      undefined;
    const coveredByOwnParkedInvoice =
      ownEditId !== undefined
        ? parkedAnchors.includes(ownEditId)
        : parkedAnchors.some((anchorId) => !isReduction(anchorId));
    if (ownCents > 0 && !coveredByOwnParkedInvoice) {
      const minter = row.stripePaymentIntentId ? intentMinters.get(row.stripePaymentIntentId) : undefined;
      const hadIssuedXeroInvoice = minter ? minter.hadIssuedXeroInvoice : row.hadIssuedXeroInvoice;
      if (hadIssuedXeroInvoice === null) established = false;
      else if (hadIssuedXeroInvoice) supplementaryInvoicedCents += ownCents;
    }
    if (carriedInCents > 0) {
      const carried = carriedFoldParts(row, previous, carriedInCents);
      if (!carried) {
        established = false;
        return;
      }
      if (carried.unsure) established = false;
      for (const part of carried.parts) {
        if (part.unsure) established = false;
        if (parkedAnchors.includes(part.modificationId)) continue;
        supplementaryInvoicedCents += part.invoiceCents;
      }
    }
  });
  return { supplementaryInvoicedCents, established };

  /** The folded asks a row carried in, or null where nothing names that money. */
  function carriedFoldParts(
    row: UnpaidPriceAskRow,
    previous: UnpaidPriceAskRow | null,
    carriedInCents: number,
  ): { parts: { modificationId: string; invoiceCents: number; unsure: boolean }[]; unsure: boolean } | null {
    const minter =
      (row.stripePaymentIntentId ? intentMinters.get(row.stripePaymentIntentId)?.modificationId : undefined) ??
      row.bookingModificationId ??
      undefined;
    if (row.reason === REISSUED_ASK_REASON) {
      if (!minter || !isReduction(minter)) return null;
      return {
        parts: [
          {
            modificationId: minter,
            invoiceCents: recordedReissuedAskInvoiceCents(modification(minter)?.newData),
            unsure: recordedReissuedAskInvoiceUnsureCents(modification(minter)?.newData) > 0,
          },
        ],
        unsure: false,
      };
    }
    const increase = minter
      ? modification(minter)
      : (() => {
          const candidates = modifications.filter(
            (candidate) =>
              recordedFoldedAskCents(candidate.newData) === carriedInCents &&
              candidate.createdAt <= row.createdAt &&
              (!previous || candidate.createdAt > previous.createdAt),
          );
          return candidates.length === 1 ? candidates[0]! : null;
        })();
    if (!increase || recordedFoldedAskCents(increase.newData) !== carriedInCents) return null;
    const nested = recordedFoldedIncreaseAsks(increase.newData);
    return {
      unsure: nested.unsure,
      parts: [
        ...recordedFoldedReissuedAskModificationIds(increase.newData).map((reductionId) => ({
          modificationId: reductionId,
          invoiceCents: recordedReissuedAskInvoiceCents(modification(reductionId)?.newData),
          unsure: recordedReissuedAskInvoiceUnsureCents(modification(reductionId)?.newData) > 0,
        })),
        ...nested.entries.map((entry) => ({
          modificationId: entry.modificationId,
          invoiceCents: entry.invoiceCents,
          unsure: entry.invoiceUnsure,
        })),
      ],
    };
  }
}

/**
 * Read the evidence inside the reduction's transaction, after
 * `retireUnpaidAskChain`: the booking's edits and the recoveries that minted
 * the ask's rows, with their frozen invoice answers.
 */
export async function unpaidAskBillingEvidence(
  db: Pick<Prisma.TransactionClient, "bookingModification" | "paymentRecoveryOperation">,
  {
    bookingId,
    paymentId,
    rows,
    retired,
  }: {
    bookingId: string;
    paymentId: string;
    rows: readonly UnpaidPriceAskRow[];
    retired: Pick<RetiredUnpaidAsk, "invoicedCents" | "parkedOps" | "invoiceEvidenceUnknown">;
  },
): Promise<UnpaidAskBillingEvidence> {
  if (rows.length === 0) {
    return { supplementaryInvoicedCents: retired.invoicedCents, established: !retired.invoiceEvidenceUnknown };
  }
  const intentIds = rows.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  const modifications = await db.bookingModification.findMany({
    where: { bookingId },
    select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true, createdAt: true },
  });
  const recoveries =
    intentIds.length > 0
      ? await db.paymentRecoveryOperation.findMany({
          where: {
            paymentId,
            type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
            paymentIntentId: { in: intentIds },
          },
          select: { paymentIntentId: true, idempotencyKey: true, hadIssuedXeroInvoice: true },
        })
      : [];
  const intentMinters = new Map<string, IntentMinter>();
  for (const recovery of recoveries) {
    if (isEditFinancialReviewAdditionalIntentRecoveryKey(recovery.idempotencyKey)) continue;
    const modificationId = bookingModificationIdForAdditionalIntentRecoveryKey(recovery.idempotencyKey);
    if (modificationId) {
      intentMinters.set(recovery.paymentIntentId, {
        modificationId,
        hadIssuedXeroInvoice: recovery.hadIssuedXeroInvoice,
      });
    }
  }
  return classifyUnpaidAskBilling({ rows, retired, modifications, intentMinters });
}
