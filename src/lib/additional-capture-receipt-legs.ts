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

/**
 * The receipt's target list as the decision it stores, in order: each invoice's
 * Xero id, or `pending:<outbox operation>` for one not in Xero yet. Keeping the
 * pending one means an invoice moved onto the capture before it reaches Xero
 * still changes the list, so the plan store sees `target-moved`.
 */
export function invoiceIdsForReceiptTargets(
  targets: readonly { kind: string; operation?: { id: string } | null; link?: { active: boolean; xeroObjectId: string } | null }[],
  primaryInvoiceId: string,
): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    const invoiceId =
      target.kind === "PRIMARY_INVOICE"
        ? primaryInvoiceId
        : target.link?.active
          ? target.link.xeroObjectId
          : `pending:${target.operation?.id ?? target.kind}`;
    if (!ids.includes(invoiceId)) ids.push(invoiceId);
  }
  return ids;
}

/** Whether two ordered invoice lists are the decision the receipt stored. */
export function sameInvoiceIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Every planned leg has an active payment link naming its invoice. */
export function linkedReceiptLegCount(
  legs: readonly { invoiceId: string }[],
  links: readonly { metadata: unknown }[],
): number {
  const linked = new Set(
    links.flatMap((link) => {
      const invoiceId = asRecord(link.metadata)?.invoiceId;
      return typeof invoiceId === "string" ? [invoiceId] : [];
    }),
  );
  return legs.filter((leg) => linked.has(leg.invoiceId)).length;
}

/** Every planned invoice, rather than merely the same number of links. */
export function everyPlannedLegLinked(
  legs: readonly { invoiceId: string }[],
  links: readonly { metadata: unknown }[],
): boolean {
  return legs.length > 0 && linkedReceiptLegCount(legs, links) === legs.length;
}
