import type { LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import type { XeroTaxRendering } from "../../xero-tax-rendering";
import { componentKey, liveComponentGross } from "./components";
import { frozenLineCodes, primaryInvoicePayloadHash, splitStayAndFeeCents } from "./primary-invoice-plan";
import { matchStaySlices, type SliceEvent, type SupplementaryInvoiceCoverage } from "./supplementary-invoice-plan";

/**
 * AN EDIT'S CREDIT NOTE, PLANNED FROM THE JOURNAL (#4525, Ledger M13;
 * ALP-753). Pure: no database, clock, settings or provider. The sender keeps
 * building and sending its own lines; this says which journal money those
 * lines return, or why they do not, and the export manifest records it.
 *
 * WHAT A NOTE RETURNS. The mirror of the supplementary invoice
 * (`supplementary-invoice-plan.ts`): a reduction moves the stay component
 * down, and the note returns that SLICE, the negated stay movement of the
 * edit's own journal event, keyed by the event (`sliceKey`). A review task's
 * note returns the stay movement of the task's one live review closure. Each
 * settled review share the edit's lines itemise is a slice of its own, keyed
 * by its closure. Slices are covered as positive cents, as the note's lines
 * are, so the coverage adds up to the note's total.
 *
 * WHAT IT CANNOT COVER. A note whose edit also moved a fee nets that fee
 * against the reduction (the fee line is negative on the note): no slice is
 * returned whole, so it is a REDUCTION_NETTED conflict. A give-back of applied
 * credit or a billed-offset correction (`xero-review-task-key.ts`) returns no
 * stay slice of its own. An increase, a reversed or missing event and an
 * ambiguous closure are conflicts too: never partial coverage.
 *
 * TAX (#4632, #5153). The frozen mapping records the line-amount basis and tax
 * type the sender rendered the note with: the booking's own treatment, from
 * its tax anchor, as on the supplementary invoice.
 */

export type ModificationCreditNoteAnchor =
  | { kind: "MODIFICATION"; modificationId: string }
  | { kind: "REVIEW_SHARE"; modificationId: string; taskId: string }
  /** A give-back or billed-offset note: it returns applied credit or a billed offset, not a slice of the journal's stay. */
  | { kind: "OTHER_SCOPE"; modificationId: string; scope: string };

export interface ModificationCreditNotePlanInput {
  bookingId: string;
  anchor: ModificationCreditNoteAnchor;
  /** The sender's idempotency key (`creditNoteIdempotencyKey`): the manifest's legacy key. */
  legacyKey: string;
  /** The lines the sender sent, positive for what the note returns. */
  lines: LineItem[];
  /** The booking's tax rendering the sender built and sent the lines with (#4632). */
  taxRendering: XeroTaxRendering;
  /** How the lines were built (`priceLines` on the sync operation), frozen beside them. */
  priceLines: unknown;
  /**
   * The event this note's slice is cut from: the edit's `modification:` event,
   * or a review task's one live closure. Null when the journal holds none;
   * "AMBIGUOUS" when the task closed more than once. Unread for OTHER_SCOPE.
   */
  sliceEvent: SliceEvent | null | "AMBIGUOUS";
  /** The closures of the settled review shares the lines itemise, as the supplementary invoice reads them; an edit's note only. */
  shareEvents?: ReadonlyArray<SliceEvent | null | "AMBIGUOUS">;
}

interface ModificationCreditNoteRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

export type ModificationCreditNotePlan =
  | (ModificationCreditNoteRendering & { outcome: "COVERED"; coverage: SupplementaryInvoiceCoverage[] })
  | (ModificationCreditNoteRendering & { outcome: "CONFLICT"; reason: MemberMoneyExportConflictReason; problem: string });

/** Plan the edit's credit note the sender sent: its coverage or its conflict. */
export function planModificationCreditNote(input: ModificationCreditNotePlanInput): ModificationCreditNotePlan {
  const { bookingId, anchor, lines, sliceEvent } = input;
  const { stayCents, feeCents } = splitStayAndFeeCents(lines);
  const lineTotalCents = invoiceLineItemsTotalCents(lines);
  const rendering = (coverage: SupplementaryInvoiceCoverage[]): ModificationCreditNoteRendering => ({
    legacyKey: input.legacyKey,
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      source: "BUILT",
      anchor,
      priceLines: input.priceLines ?? null,
      lineCodes: frozenLineCodes(lines),
      // #4632: the treatment the note was sent with, from the booking's tax anchor.
      taxType: input.taxRendering.taxType ?? null,
      lineAmountTypes: input.taxRendering.lineAmountTypes,
      componentTaxCodes: coverage.map(({ account, chargeIdentity, sliceKey, taxCode }) =>
        ({ account, chargeIdentity, sliceKey: sliceKey ?? null, taxCode })),
    },
    lineTotalCents,
  });
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): ModificationCreditNotePlan =>
    ({ outcome: "CONFLICT", reason, problem, ...rendering([]) });

  if (anchor.kind === "OTHER_SCOPE") {
    return conflict("COMPONENT_UNUSABLE", `a ${anchor.scope} note returns no stay slice of the journal`);
  }
  // The fee line, or a fee the event moved, nets a fee against the reduction: no slice is returned whole.
  const eventMovesFee = typeof sliceEvent === "object" && sliceEvent !== null &&
    [...liveComponentGross(sliceEvent.legs)].some(([key, cents]) => cents !== 0 && key.startsWith(componentKey("FEE_REVENUE", "")));
  if (feeCents !== 0 || eventMovesFee) return conflict("REDUCTION_NETTED", "the note nets a change fee against the reduction it returns");

  const matched = matchStaySlices({
    bookingId,
    sliceEvent,
    shareEvents: anchor.kind === "MODIFICATION" ? input.shareEvents ?? [] : [],
    stayCents,
    direction: "RETURNS",
  });
  if (matched.outcome === "CONFLICT") return conflict(matched.reason, matched.problem);
  const { coverage } = matched;
  if (coverage.length === 0 || coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the slices carry");
  }
  return { outcome: "COVERED", coverage, ...rendering(coverage) };
}
