import { LineAmountTypes, type LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { modificationChangeFeeKey } from "../../booking-ledger-posting-keys";
import { CHANGE_FEE_LINE_DESCRIPTION, invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import { bookingChargeIdentity } from "./booking-charges";
import { componentKey, liveComponentGross, liveComponentSplit, type PostedRevenueLeg } from "./components";
import { primaryInvoicePayloadHash, type PrimaryInvoiceCoverage } from "./primary-invoice-plan";

/**
 * THE SUPPLEMENTARY BOOKING INVOICE, PLANNED FROM THE JOURNAL (#4525, Ledger
 * M13; ALP-436). Pure: no database, clock, settings or provider. The sender
 * keeps building and sending its own lines; this says which journal money
 * those lines bill, or why they do not, and the export manifest records it.
 *
 * WHAT A SUPPLEMENTARY INVOICE BILLS. An edit "corrects the whole stay
 * component and charges the remainder" (`booking-charges.ts`), so the stay
 * component is never the edit's alone: the primary invoice billed it as it
 * stood, and each later edit moves it. The invoice therefore covers a SLICE of
 * the stay component, the net movement the edit's own journal event posted,
 * named by that event's key (`sliceKey`). The edit's change fee is a component
 * of its own, created by the edit, and is covered whole.
 *
 * The match, in cents through `invoiceLineItemsTotalCents`: the lines other
 * than the change-fee line equal the event's stay movement, the change-fee
 * line equals the edit's fee component, whose live gross is what the event
 * posted. A second ask (a review task's further share) bills the stay movement
 * of the task's one live review closure and no fee. A reduction netted against
 * a fee bills no component whole or as a slice: a conflict, never a guess.
 */

/** The event an invoice's slice is cut from, as the store reads it. */
export interface SliceEvent {
  eventKey: string;
  /** A later journal reversed it: its movement no longer stands. */
  reversed: boolean;
  /** The event's own BOOKING_REVENUE and FEE_REVENUE legs. */
  legs: readonly PostedRevenueLeg[];
}

export type SupplementaryAnchor =
  | { kind: "MODIFICATION"; modificationId: string }
  | { kind: "SECOND_ASK"; modificationId: string; taskId: string };

export interface SupplementaryInvoicePlanInput {
  bookingId: string;
  anchor: SupplementaryAnchor;
  /** The sender's idempotency key (`buildXeroSupplementaryInvoiceKey`): the manifest's legacy key. */
  legacyKey: string;
  /** The lines the sender sent. */
  lines: LineItem[];
  /** How the lines were built (`priceLines` on the sync operation), frozen beside them. */
  priceLines: unknown;
  /**
   * The event this invoice's slice is cut from: the edit's `modification:` event,
   * or a second ask's one review closure. Null when the journal holds none;
   * "AMBIGUOUS" when a second ask's task closed more than once.
   */
  sliceEvent: SliceEvent | null | "AMBIGUOUS";
  /** The booking's posted BOOKING_REVENUE and FEE_REVENUE legs (`readBookingChargeLegs`). */
  postedLegs: readonly PostedRevenueLeg[];
}

export interface SupplementaryInvoiceCoverage extends PrimaryInvoiceCoverage {
  /** The event whose slice a row bills; absent for a component covered whole. */
  sliceKey?: string;
}

interface SupplementaryRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

export type SupplementaryInvoicePlan =
  | (SupplementaryRendering & { outcome: "COVERED"; coverage: SupplementaryInvoiceCoverage[] })
  | (SupplementaryRendering & { outcome: "CONFLICT"; reason: MemberMoneyExportConflictReason; problem: string });

/** Plan the supplementary invoice the sender sent: its coverage or its conflict. */
export function planSupplementaryBookingInvoice(input: SupplementaryInvoicePlanInput): SupplementaryInvoicePlan {
  const { bookingId, anchor, lines, sliceEvent, postedLegs } = input;
  const isFee = (line: LineItem) => line.description === CHANGE_FEE_LINE_DESCRIPTION;
  const stayCents = invoiceLineItemsTotalCents(lines.filter((line) => !isFee(line)));
  const feeCents = invoiceLineItemsTotalCents(lines.filter(isFee));
  const lineTotalCents = invoiceLineItemsTotalCents(lines);
  const rendering = (coverage: SupplementaryInvoiceCoverage[]): SupplementaryRendering => ({
    legacyKey: input.legacyKey,
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      source: "BUILT",
      anchor,
      priceLines: input.priceLines ?? null,
      lineCodes: lines.map((line) => ({ accountCode: line.accountCode ?? null, itemCode: line.itemCode ?? null })),
      taxType: "OUTPUT2",
      lineAmountTypes: LineAmountTypes.Inclusive,
      componentTaxCodes: coverage.map(({ account, chargeIdentity, sliceKey, taxCode }) =>
        ({ account, chargeIdentity, sliceKey: sliceKey ?? null, taxCode })),
    },
    lineTotalCents,
  });
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): SupplementaryInvoicePlan =>
    ({ outcome: "CONFLICT", reason, problem, ...rendering([]) });

  if (stayCents < 0) return conflict("REDUCTION_NETTED", "the invoice nets a price reduction against a fee");
  if (sliceEvent === "AMBIGUOUS") return conflict("COMPONENT_UNUSABLE", "the review task closed more than once; which closure this bills is unknown");
  if (!sliceEvent) return conflict("COMPONENT_UNUSABLE", "the journal holds no event for what this invoice bills");
  if (sliceEvent.reversed) return conflict("COMPONENT_UNUSABLE", `the journal reversed ${sliceEvent.eventKey}`);

  const stayIdentity = bookingChargeIdentity(bookingId);
  const moved = liveComponentGross(sliceEvent.legs);
  const otherStay = [...moved].find(([key, cents]) =>
    cents !== 0 && key.startsWith(componentKey("BOOKING_REVENUE", "")) && key !== componentKey("BOOKING_REVENUE", stayIdentity));
  if (otherStay) return conflict("COMPONENT_UNUSABLE", `${sliceEvent.eventKey} moves booking revenue other than the stay charge`);

  const coverage: SupplementaryInvoiceCoverage[] = [];
  const stayMoved = moved.get(componentKey("BOOKING_REVENUE", stayIdentity)) ?? 0;
  if (stayMoved !== stayCents) return conflict("STAY_CENTS", `the stay lines do not bill what ${sliceEvent.eventKey} moved the stay charge by`);
  if (stayCents > 0) {
    const slice = liveComponentSplit(sliceEvent.legs, "BOOKING_REVENUE", stayIdentity);
    if (!slice || "problem" in slice) return conflict("COMPONENT_UNUSABLE", slice ? slice.problem : "the event posts no stay charge");
    if (slice.bookingId !== bookingId) return conflict("COMPONENT_UNUSABLE", `the stay charge ${stayIdentity} names another booking`);
    coverage.push({ account: "BOOKING_REVENUE", chargeIdentity: stayIdentity, sliceKey: sliceEvent.eventKey, coveredCents: stayCents, taxCode: slice.taxCode });
  }

  // A second ask bills a review's share, never a fee; an edit bills its own fee and no other.
  const ownFee = anchor.kind === "MODIFICATION" ? modificationChangeFeeKey(anchor.modificationId) : null;
  const feesMoved = [...moved].filter(([key, cents]) => cents !== 0 && key.startsWith(componentKey("FEE_REVENUE", "")));
  if (feesMoved.some(([key]) => ownFee === null || key !== componentKey("FEE_REVENUE", ownFee))) {
    return conflict("FEE_CENTS", `${sliceEvent.eventKey} moves a fee this invoice does not bill`);
  }
  const feeMoved = feesMoved.reduce((sum, [, cents]) => sum + cents, 0);
  if (feeMoved !== feeCents) return conflict("FEE_CENTS", "the change-fee line does not bill the fee the edit posted");
  if (feeCents > 0 && ownFee !== null) {
    const fee = liveComponentSplit(postedLegs, "FEE_REVENUE", ownFee);
    if (!fee || "problem" in fee) return conflict("COMPONENT_UNUSABLE", fee ? fee.problem : `the journal holds no fee ${ownFee}`);
    if (fee.bookingId !== bookingId) return conflict("COMPONENT_UNUSABLE", `the fee ${ownFee} names another booking`);
    if (fee.grossCents !== feeCents) return conflict("FEE_CENTS", `the fee ${ownFee} no longer carries what the edit posted`);
    coverage.push({ account: "FEE_REVENUE", chargeIdentity: ownFee, coveredCents: feeCents, taxCode: fee.taxCode });
  }
  if (coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the slice and fee carry");
  }
  return { outcome: "COVERED", coverage, ...rendering(coverage) };
}
