/**
 * #4434 (`INV-PAY-139`): how a change-capture receipt splits one capture across
 * the invoices that bill it. Pure. The worker
 * (`additional-capture-xero-receipt.ts`) reads Xero and sends; this decides the
 * cents and recognises a plan already stored.
 */
import type { AdditionalCaptureReceiptLeg, AdditionalCaptureReceiptPlan, AdditionalCaptureReceiptTarget } from "@/lib/additional-capture-receipt-payload";
import { asRecord } from "@/lib/xero-json";

/** What one invoice can take of the capture, as Xero shows it now. */
export type ReceiptCandidate = {
  target: AdditionalCaptureReceiptTarget;
  invoiceId: string;
  /** Cents this capture may be recorded against; 0 when it can take none. */
  roomCents: number;
};

/**
 * THE ONE-INVOICE DECISION, pure: the first candidate with room, in the order
 * given, and the capture's cents capped at that room. Null when none has any.
 */
export function chooseAdditionalCaptureReceiptTarget(
  capturedCents: number,
  candidates: readonly ReceiptCandidate[],
): { target: AdditionalCaptureReceiptTarget; invoiceId: string; amountCents: number } | null {
  const [leg] = fillAdditionalCaptureReceiptLegs(capturedCents, candidates);
  return leg ?? null;
}

/**
 * The capture across the candidates, in order, each capped at its own room.
 * An invoice with no room is skipped. Nothing is recorded past a room, and the
 * same invoice is never a second leg.
 */
export function fillAdditionalCaptureReceiptLegs(
  capturedCents: number,
  candidates: readonly ReceiptCandidate[],
): AdditionalCaptureReceiptLeg[] {
  if (!Number.isInteger(capturedCents) || capturedCents <= 0) return [];
  const legs: AdditionalCaptureReceiptLeg[] = [];
  const seen = new Set<string>();
  let left = capturedCents;
  for (const candidate of candidates) {
    if (left <= 0) break;
    if (!Number.isInteger(candidate.roomCents) || candidate.roomCents <= 0 || seen.has(candidate.invoiceId)) continue;
    seen.add(candidate.invoiceId);
    const amountCents = Math.min(left, candidate.roomCents);
    legs.push({ target: candidate.target, invoiceId: candidate.invoiceId, amountCents });
    left -= amountCents;
  }
  return legs;
}

/** The stored plan. Its top-level fields are the first leg, so an older release reads that leg alone. */
export function buildStoredReceiptPlan(input: {
  legs: readonly AdditionalCaptureReceiptLeg[];
  capturedCents: number;
  date: string;
  targetInvoiceIds: readonly string[];
}): AdditionalCaptureReceiptPlan {
  const first = input.legs[0];
  if (!first) throw new Error("A receipt plan needs a leg");
  return {
    target: first.target,
    invoiceId: first.invoiceId,
    amountCents: first.amountCents,
    capturedCents: input.capturedCents,
    date: input.date,
    legs: input.legs.map((leg) => ({ ...leg })),
    targetInvoiceIds: [...input.targetInvoiceIds],
  };
}

/** The invoices a receipt's target list names, in order, skipping one not in Xero yet. */
export function invoiceIdsForReceiptTargets(
  targets: readonly { kind: string; link?: { active: boolean; xeroObjectId: string } | null }[],
  primaryInvoiceId: string,
): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    const invoiceId = target.kind === "PRIMARY_INVOICE" ? primaryInvoiceId : target.link?.active ? target.link.xeroObjectId : null;
    if (invoiceId && !ids.includes(invoiceId)) ids.push(invoiceId);
  }
  return ids;
}

/** Whether two ordered invoice lists are the decision the receipt stored. */
export function sameInvoiceIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Every planned leg has an active payment link naming its invoice. */
export function everyPlannedLegLinked(
  legs: readonly { invoiceId: string }[],
  links: readonly { metadata: unknown }[],
): boolean {
  const linked = new Set(
    links.flatMap((link) => {
      const invoiceId = asRecord(link.metadata)?.invoiceId;
      return typeof invoiceId === "string" ? [invoiceId] : [];
    }),
  );
  return legs.length > 0 && legs.every((leg) => linked.has(leg.invoiceId));
}
