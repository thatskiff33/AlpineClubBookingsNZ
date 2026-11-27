import type { Prisma } from "@prisma/client";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import type { LineItem } from "xero-node";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { isGiveBackNoteScope, isUnpaidAskBilledOffsetNoteScope } from "../../xero-review-task-key";
import type { XeroTaxRendering } from "../../xero-tax-rendering";
import { planModificationCreditNote, type ModificationCreditNoteAnchor, type ModificationCreditNotePlan } from "./modification-credit-note-plan";
import { readItemisedShareSliceEvents, readReviewClosure, readSupplementarySliceEvent } from "./supplementary-invoice-manifest";
import type { SliceEvent } from "./supplementary-invoice-plan";
import { writeExportManifest } from "./store";

/**
 * AN EDIT'S CREDIT NOTE'S EXPORT MANIFEST, FOR THE SENDER (#4525, Ledger M13;
 * ALP-753). `createXeroCreditNoteForModification` records it once its sync
 * operation has completed (or ended PARTIAL: the note exists either way), in a
 * short transaction of its own, as the supplementary invoice's is recorded
 * (`supplementary-invoice-manifest.ts`). Nothing here changes what is sent or
 * how the operation ends: a failure is logged and swallowed.
 *
 * First write wins. The same role and legacy key keeps its first row, and a
 * slice another note of this role still covers (no release on its manifest) is
 * recorded as CONFLICT `ALREADY_COVERED`, with no coverage, as the refund note
 * does (`refund-note-manifest.ts`): a second note for the same reduction never
 * returns it twice. The unique coverage key is the last word; a race that
 * loses to it (P2002) is logged and swallowed.
 *
 * No advisory lock: the manifest changes no booking status, capacity or
 * settlement money, so it joins neither `pg_advisory_xact_lock(1)` nor the
 * lodge capacity lock (`INV-LOCK-001`); its unique keys are the exclusion.
 */

type Db = Prisma.TransactionClient;

/** The anchor a note's scope names (`reviewTaskKeyParts`): the edit's own, a review task's share, or a give-back or billed offset. */
export function modificationCreditNoteAnchor(modificationId: string, reviewTaskId: string | undefined): ModificationCreditNoteAnchor {
  if (!reviewTaskId) return { kind: "MODIFICATION", modificationId };
  if (isGiveBackNoteScope(reviewTaskId) || isUnpaidAskBilledOffsetNoteScope(reviewTaskId)) {
    return { kind: "OTHER_SCOPE", modificationId, scope: reviewTaskId };
  }
  return { kind: "REVIEW_SHARE", modificationId, taskId: reviewTaskId };
}

async function readNoteSliceEvent(db: Pick<Db, "memberMoneyJournal">, bookingId: string, anchor: ModificationCreditNoteAnchor): Promise<SliceEvent | null | "AMBIGUOUS"> {
  if (anchor.kind === "OTHER_SCOPE") return null;
  if (anchor.kind === "REVIEW_SHARE") return readReviewClosure(db, bookingId, anchor.taskId);
  return readSupplementarySliceEvent(db, bookingId, { kind: "MODIFICATION", modificationId: anchor.modificationId });
}

/** A COVERED plan whose slice another live note of this role already covers becomes CONFLICT `ALREADY_COVERED`. */
async function refuseCoveredSlices(db: Db, plan: ModificationCreditNotePlan): Promise<ModificationCreditNotePlan> {
  if (plan.outcome !== "COVERED") return plan;
  const taken = await db.memberMoneyExportCoverage.findFirst({
    where: {
      documentRole: "MODIFICATION_CREDIT_NOTE",
      OR: plan.coverage.map((c) => ({ account: c.account, chargeIdentity: c.chargeIdentity, sliceKey: c.sliceKey ?? "" })),
      manifest: { release: { is: null }, NOT: { legacyKey: plan.legacyKey } },
    },
    select: { sliceKey: true, manifest: { select: { providerInvoiceId: true } } },
  });
  if (!taken) return plan;
  return {
    legacyKey: plan.legacyKey, payloadHash: plan.payloadHash, frozenMapping: plan.frozenMapping, lineTotalCents: plan.lineTotalCents,
    outcome: "CONFLICT",
    reason: "ALREADY_COVERED",
    problem: `the slice ${taken.sliceKey} is already returned by credit note ${taken.manifest.providerInvoiceId}`,
  };
}

/** Record the manifest for the edit's credit note just sent. A key already recorded keeps its first row. Never throws. */
export async function recordModificationCreditNoteManifest(input: {
  bookingId: string;
  modificationId: string;
  /** The note's scope (`reviewTaskId` on the sender): a review task, a give-back or a billed offset; absent for the edit's own. */
  reviewTaskId?: string;
  /** `creditNoteIdempotencyKey`, the key the note was sent under. */
  legacyKey: string;
  lines: LineItem[];
  /** The booking's tax rendering the note was sent with (#4632), frozen beside its lines. */
  taxRendering: XeroTaxRendering;
  priceLines: unknown;
  /** The tasks whose settled shares the sent lines itemise; empty for the single line. */
  itemisedShareTaskIds: readonly string[];
  providerCreditNoteId: string;
}): Promise<void> {
  const { bookingId, providerCreditNoteId } = input;
  try {
    const anchor = modificationCreditNoteAnchor(input.modificationId, input.reviewTaskId);
    const built = planModificationCreditNote({
      bookingId,
      anchor,
      legacyKey: input.legacyKey,
      lines: input.lines,
      taxRendering: input.taxRendering,
      priceLines: input.priceLines,
      sliceEvent: await readNoteSliceEvent(prisma, bookingId, anchor),
      shareEvents: anchor.kind === "MODIFICATION"
        ? await readItemisedShareSliceEvents(prisma, bookingId, anchor, input.itemisedShareTaskIds)
        : [],
    });
    const { plan, result } = await prisma.$transaction(async (tx) => {
      const settled = await refuseCoveredSlices(tx, built);
      const written = await writeExportManifest(tx, {
        documentRole: "MODIFICATION_CREDIT_NOTE",
        legacyKey: settled.legacyKey,
        bookingId,
        outcome: settled.outcome,
        reason: settled.outcome === "CONFLICT" ? settled.reason : null,
        payloadHash: settled.payloadHash,
        frozenMapping: settled.frozenMapping as Prisma.InputJsonObject,
        lineTotalCents: settled.lineTotalCents,
        providerInvoiceId: providerCreditNoteId,
        coverage: settled.outcome === "COVERED" ? settled.coverage : [],
      });
      return { plan: settled, result: written };
    });
    if (plan.outcome === "CONFLICT" && result === "WRITTEN") {
      logger.warn({ bookingId, providerCreditNoteId, reason: plan.reason, problem: plan.problem }, "The edit's credit note does not match the journal; its manifest records a conflict and the note still sent");
    }
    if (result === "KEPT_FIRST") {
      logger.info({ bookingId, providerCreditNoteId }, "The edit's credit note's manifest was already recorded differently; the first row stands");
    }
  } catch (error) {
    if (isPrismaKnownUniqueConstraintError(error)) {
      logger.info({ bookingId, providerCreditNoteId }, "Another run recorded the edit's credit note's manifest, or covered its slice, first; the first row stands");
      return;
    }
    logger.error({ err: error, bookingId, providerCreditNoteId }, "Could not record the edit's credit note's export manifest; the note is unchanged");
  }
}
