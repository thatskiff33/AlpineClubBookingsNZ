import type { LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { modificationChangeFeeKey } from "../../booking-ledger-posting-keys";
import { invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import type { XeroTaxRendering } from "../../xero-tax-rendering";
import { bookingChargeIdentity } from "./booking-charges";
import { componentKey, liveComponentGross, liveComponentSplit, movedComponents, type PostedRevenueLeg } from "./components";
import { frozenLineCodes, primaryInvoicePayloadHash, splitStayAndFeeCents, type PrimaryInvoiceCoverage } from "./primary-invoice-plan";

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
 *
 * SETTLED REVIEW SHARES. An edit whose lines itemise settled review shares
 * bills the edit's own movement plus each itemised share
 * (`selectModificationDocumentLines`: the stored lines and the shares together
 * explain `priceDiffCents`). Only the shares the sent lines itemise count: a
 * share the single fallback line leaves out, or one settled after the lines
 * were built, is not part of this invoice. Each share's stay movement is posted by its task's
 * review closure (R21), not by the edit's event, so each closure is a slice of
 * its own, keyed by its event: the stay lines equal the sum of the slices, and
 * a closure moves no fee.
 *
 * TAX (#4632). The frozen mapping records the line-amount basis and tax type
 * the sender rendered the invoice with: the booking's own treatment, resolved
 * from its tax anchor (`resolveXeroTaxRendering({ kind: "booking" })`), so an
 * edit to a booking made before a change of treatment records the treatment in
 * force when the booking was made, as its lines carry it. The Xero tax type and
 * the journal's tax codes stay separate namespaces, as on the primary invoice.
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
  /** The booking's tax rendering the sender built and sent the lines with (#4632). */
  taxRendering: XeroTaxRendering;
  /** How the lines were built (`priceLines` on the sync operation), frozen beside them. */
  priceLines: unknown;
  /**
   * The event this invoice's slice is cut from: the edit's `modification:` event,
   * or a second ask's one review closure. Null when the journal holds none;
   * "AMBIGUOUS" when a second ask's task closed more than once.
   */
  sliceEvent: SliceEvent | null | "AMBIGUOUS";
  /**
   * The closures of the settled review shares this invoice itemised, one per
   * share task, each read as a second ask's is (the one live closure, null or
   * "AMBIGUOUS"). Empty for a second ask, which never itemises shares, for the
   * single fallback line, and for an edit whose lines itemise none.
   */
  shareEvents?: ReadonlyArray<SliceEvent | null | "AMBIGUOUS">;
  /** The booking's posted BOOKING_REVENUE and FEE_REVENUE legs (`readBookingChargeLegs`). */
  postedLegs: readonly PostedRevenueLeg[];
}

export interface SupplementaryInvoiceCoverage extends PrimaryInvoiceCoverage {
  /** The event whose slice a row bills; absent for a component covered whole. */
  sliceKey?: string;
}

/** What a slice document's plan freezes beside its outcome: the same for an invoice and an edit's credit note (ALP-753). */
interface SliceDocumentRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

/** A slice document's plan: the slices its lines cover, or the one reason they cover none. */
export type SliceDocumentPlan =
  | (SliceDocumentRendering & { outcome: "COVERED"; coverage: SupplementaryInvoiceCoverage[] })
  | (SliceDocumentRendering & { outcome: "CONFLICT"; reason: MemberMoneyExportConflictReason; problem: string });

export type SupplementaryInvoicePlan = SliceDocumentPlan;

/**
 * The rendering frozen beside a slice document's manifest: its key, the hash
 * and codes of the lines sent, how they were built, the tax treatment they
 * were sent with (#4632: the booking's own, from its tax anchor) and the tax
 * code of each slice covered. The one freeze a supplementary invoice and an
 * edit's credit note share.
 */
export function sliceDocumentRendering(
  input: { anchor: unknown; legacyKey: string; lines: LineItem[]; taxRendering: XeroTaxRendering; priceLines: unknown },
  coverage: readonly SupplementaryInvoiceCoverage[],
): SliceDocumentRendering {
  return {
    legacyKey: input.legacyKey,
    payloadHash: primaryInvoicePayloadHash(input.lines),
    frozenMapping: {
      source: "BUILT",
      anchor: input.anchor,
      priceLines: input.priceLines ?? null,
      lineCodes: frozenLineCodes(input.lines),
      taxType: input.taxRendering.taxType ?? null,
      lineAmountTypes: input.taxRendering.lineAmountTypes,
      componentTaxCodes: coverage.map(({ account, chargeIdentity, sliceKey, taxCode }) =>
        ({ account, chargeIdentity, sliceKey: sliceKey ?? null, taxCode })),
    },
    lineTotalCents: invoiceLineItemsTotalCents(input.lines),
  };
}

/**
 * Which way a document moves the stay charge: an invoice BILLS what its events
 * charged, a credit note RETURNS what they reduced (ALP-753). A slice is always
 * covered as positive cents; the direction says which sign of movement counts.
 */
type StaySliceDirection = "BILLS" | "RETURNS";

const DIRECTION_WORDS: Record<StaySliceDirection, { sign: 1 | -1; document: string; verb: string; netted: string }> = {
  BILLS: { sign: 1, document: "invoice", verb: "bill", netted: "the invoice nets a settled review share's give-back against what the edit charges" },
  RETURNS: { sign: -1, document: "note", verb: "return", netted: "the note nets a settled review share's charge against what the edit returns" },
};

type StaySliceMatch =
  | { outcome: "MATCHED"; event: SliceEvent; moved: Map<string, number>; coverage: SupplementaryInvoiceCoverage[] }
  | { outcome: "CONFLICT"; reason: MemberMoneyExportConflictReason; problem: string };

/**
 * Match a document's stay lines to the stay slices its events moved (#4525,
 * Ledger M13): the anchor's own event and each itemised settled review share's
 * closure, one slice each, keyed by the event. A missing, reversed or ambiguous
 * event, a share that moves a fee, an event that moves other booking revenue,
 * lines that do not carry exactly the slices' movement, or a slice moving the
 * other way than the document are each a conflict, never partial coverage.
 * The one rule a supplementary invoice and an edit's credit note share.
 */
export function matchStaySlices(input: {
  bookingId: string;
  sliceEvent: SliceEvent | null | "AMBIGUOUS";
  shareEvents: ReadonlyArray<SliceEvent | null | "AMBIGUOUS">;
  /** What the document's stay lines carry, positive whichever way it moves money. */
  stayCents: number;
  direction: StaySliceDirection;
}): StaySliceMatch {
  const { bookingId, sliceEvent, stayCents } = input;
  const { sign, document, verb, netted } = DIRECTION_WORDS[input.direction];
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): StaySliceMatch => ({ outcome: "CONFLICT", reason, problem });

  if (sliceEvent === "AMBIGUOUS") return conflict("COMPONENT_UNUSABLE", `the review task closed more than once; which closure this ${verb}s is unknown`);
  if (!sliceEvent) return conflict("COMPONENT_UNUSABLE", `the journal holds no event for what this ${document} ${verb}s`);
  if (sliceEvent.reversed) return conflict("COMPONENT_UNUSABLE", `the journal reversed ${sliceEvent.eventKey}`);
  const shareSlices: SliceEvent[] = [];
  for (const share of input.shareEvents) {
    if (share === "AMBIGUOUS") return conflict("COMPONENT_UNUSABLE", `a settled review share's task closed more than once; which closure this ${verb}s is unknown`);
    if (!share) return conflict("COMPONENT_UNUSABLE", `the journal holds no closure for a settled review share this ${document} ${verb}s`);
    if (share.reversed) return conflict("COMPONENT_UNUSABLE", `the journal reversed ${share.eventKey}`);
    shareSlices.push(share);
  }

  // Each slice moves the stay charge and nothing else of booking revenue; together they are what the stay lines carry.
  const stayIdentity = bookingChargeIdentity(bookingId);
  const stayKey = componentKey("BOOKING_REVENUE", stayIdentity);
  const moved = liveComponentGross(sliceEvent.legs);
  const stayMovements: { event: SliceEvent; cents: number }[] = [];
  for (const event of [sliceEvent, ...shareSlices]) {
    const eventMoved = event === sliceEvent ? moved : liveComponentGross(event.legs);
    if (movedComponents(eventMoved, "BOOKING_REVENUE").some(([key]) => key !== stayKey)) return conflict("COMPONENT_UNUSABLE", `${event.eventKey} moves booking revenue other than the stay charge`);
    if (event !== sliceEvent && movedComponents(eventMoved, "FEE_REVENUE").length > 0) {
      return conflict("FEE_CENTS", `${event.eventKey} moves a fee this ${document} does not ${verb}`);
    }
    // In the document's own direction: a note's slice is the reduction, so its movement counts negated.
    stayMovements.push({ event, cents: sign * (eventMoved.get(stayKey) ?? 0) });
  }
  if (stayMovements.reduce((sum, { cents }) => sum + cents, 0) !== stayCents) {
    return conflict("STAY_CENTS", `the stay lines do not ${verb} what ${stayMovements.map(({ event }) => event.eventKey).join(" and ")} moved the stay charge by`);
  }
  if (stayMovements.some(({ cents }) => cents < 0)) return conflict("REDUCTION_NETTED", netted);

  const coverage: SupplementaryInvoiceCoverage[] = [];
  for (const { event, cents } of stayMovements) {
    if (cents === 0) continue;
    const slice = liveComponentSplit(event.legs, "BOOKING_REVENUE", stayIdentity);
    if (!slice || "problem" in slice) return conflict("COMPONENT_UNUSABLE", slice ? slice.problem : `${event.eventKey} posts no stay charge`);
    if (slice.bookingId !== bookingId) return conflict("COMPONENT_UNUSABLE", `the stay charge ${stayIdentity} names another booking`);
    coverage.push({ account: "BOOKING_REVENUE", chargeIdentity: stayIdentity, sliceKey: event.eventKey, coveredCents: cents, taxCode: slice.taxCode });
  }
  return { outcome: "MATCHED", event: sliceEvent, moved, coverage };
}

/** Plan the supplementary invoice the sender sent: its coverage or its conflict. */
export function planSupplementaryBookingInvoice(input: SupplementaryInvoicePlanInput): SupplementaryInvoicePlan {
  const { bookingId, anchor, lines, sliceEvent, postedLegs } = input;
  const { stayCents, feeCents } = splitStayAndFeeCents(lines);
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): SupplementaryInvoicePlan =>
    ({ outcome: "CONFLICT", reason, problem, ...sliceDocumentRendering(input, []) });

  if (stayCents < 0) return conflict("REDUCTION_NETTED", "the invoice nets a price reduction against a fee");
  const matched = matchStaySlices({
    bookingId,
    sliceEvent,
    shareEvents: anchor.kind === "MODIFICATION" ? input.shareEvents ?? [] : [],
    stayCents,
    direction: "BILLS",
  });
  if (matched.outcome === "CONFLICT") return conflict(matched.reason, matched.problem);
  const { coverage, moved } = matched;

  // A second ask bills a review's share, never a fee; an edit bills its own fee and no other.
  const ownFee = anchor.kind === "MODIFICATION" ? modificationChangeFeeKey(anchor.modificationId) : null;
  const feesMoved = movedComponents(moved, "FEE_REVENUE");
  if (feesMoved.some(([key]) => ownFee === null || key !== componentKey("FEE_REVENUE", ownFee))) {
    return conflict("FEE_CENTS", `${matched.event.eventKey} moves a fee this invoice does not bill`);
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
  const rendering = sliceDocumentRendering(input, coverage);
  if (coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== rendering.lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the slice and fee carry");
  }
  return { outcome: "COVERED", coverage, ...rendering };
}
