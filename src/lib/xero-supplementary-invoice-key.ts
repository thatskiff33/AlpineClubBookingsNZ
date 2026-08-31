import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/**
 * THE ONE MINT of a supplementary invoice's correlation/idempotency key
 * (#3193, epic #2797).
 *
 * Three places need this exact string: `xero-operation-outbox.ts` writes it on
 * the outbox row, `restatePendingSupplementaryInvoiceAmount` rewrites it when it
 * raises an amount (the key moves with the amount because it is built FROM the
 * amount), and `xero-supplementary-invoices.ts` sends it to Xero as the
 * create-invoice idempotency key.
 *
 * WHY A MODULE OF ITS OWN, stated accurately (#3193 fix round - the first
 * version of this note said neither module could host the mint without a cycle,
 * and that was half wrong). The import edge runs one way: the outbox imports the
 * invoice module and the invoice module imports nothing from the outbox. So
 * hosting the mint in the OUTBOX would create a cycle, and hosting it in the
 * invoice module would not. It sits here anyway, on cohesion and budget: the mint
 * belongs to neither side of that edge in particular, `xero-sync.ts` (where it
 * started) is 172 lines over its budget already, and a shared string with one
 * obvious home is harder to fork than one living inside a large module that also
 * does the sending.
 *
 * They used to build it from three copies of the same literal shape. #3170
 * already lost money to a supplementary-invoice key that did not mean what a
 * reader thought it did - it embedded the AMOUNT, so $200 and $30 were two keys,
 * two operations and two invoices for one booking change. Adding a fourth anchor
 * to three separate copies would have been an invitation to that class
 * (`INV-SSOT`).
 */

/**
 * WHAT A SUPPLEMENTARY INVOICE IS ANCHORED TO, and therefore what its key is.
 *
 * `BookingModification` is the booking change's own supplementary invoice, and
 * `Booking` is the same thing on the legacy branch that supplies no modification
 * id. `ManualRefundTask` is the SECOND ASK: one settled review share's own small
 * invoice, raised because the change's invoice had already gone out and could
 * not be raised to include it. A second ask therefore never shares an anchor, a
 * correlation key or a Xero idempotency key with the invoice it follows - which
 * is what stops the two being taken for one another in either direction.
 */
export type XeroSupplementaryInvoiceAnchorModel =
  | "BookingModification"
  | "Booking"
  | "ManualRefundTask";

export function buildXeroSupplementaryInvoiceKey({
  localModel,
  localId,
  priceDiffCents,
  changeFeeCents,
}: {
  localModel: XeroSupplementaryInvoiceAnchorModel;
  localId: string;
  priceDiffCents: number;
  changeFeeCents: number;
}): string {
  return buildXeroIdempotencyKey(
    localModel === "BookingModification"
      ? "booking-mod"
      : localModel === "ManualRefundTask"
        ? "review-task"
        : "booking",
    localId,
    // A DIFFERENT segment, not only a different id: the second ask is a
    // different kind of document to a person reading an operation row, and a key
    // that only differed in the id would read as the same invoice re-keyed.
    localModel === "ManualRefundTask"
      ? "supplementary-shortfall-invoice"
      : "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );
}
