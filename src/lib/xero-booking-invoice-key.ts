import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/**
 * THE ONE MINT of a booking invoice's correlation/idempotency key (#3001, MAD
 * epic #2725). `INV-SSOT`.
 *
 * ## What this string is, and why it is the booking's stable handle
 *
 * A booking's invoice-create operation is stored with `localModel: "Payment"`
 * and the PAYMENT's id, because that is the record the invoice is raised
 * against. Its `correlationKey`, though, is minted from the BOOKING id — and
 * that makes it the only field on `XeroSyncOperation` that answers "which
 * booking is this invoice for?" without going through the payment row first.
 *
 * #3001 needs exactly that. The officer-facing warning on a booking has to find
 * the operation from the booking it is looking at, and a join through the
 * payment is both an extra read and an extra way to be wrong: a booking whose
 * payment row has NOT BEEN CREATED YET would silently match nothing and the page
 * would report all-clear. (That is the real case, and the only one — the payment
 * is one-to-one with the booking and nothing deletes it. An earlier draft of
 * this note also claimed "missing or replaced", which overstated it.)
 *
 * ## Why a module of its own
 *
 * Two places already built this string from the same four literals —
 * `enqueueXeroBookingInvoiceOperation` in `xero-operation-outbox.ts`, which
 * writes it onto the outbox row and then looks an existing row up by it, and
 * `createXeroInvoiceForBooking` in `xero-booking-invoices.ts`, which sends it to
 * Xero as the create-invoice idempotency key. #3001 would have been the third,
 * and a reader that composes the key for itself is a reader that keeps matching
 * after somebody changes the writers' spelling — reporting "no invoice
 * operation, nothing to see" about a booking whose invoice is sitting failed.
 *
 * It sits here rather than in either caller for the reason
 * `xero-supplementary-invoice-key.ts` states for its own mint: the import edge
 * runs one way (the outbox imports the invoice module, never the reverse), so
 * hosting it in the outbox would be a cycle; and the string belongs to neither
 * side of that edge in particular. `xero-sync.ts`, where `buildXeroIdempotencyKey`
 * lives, is already far over its size budget.
 *
 * ## The `v1` segment is part of the contract
 *
 * It is not decoration. Every operation ever written carries the `v1` spelling,
 * so bumping it does not "version" anything — it orphans every stored row from
 * its booking at once, and both the enqueue dedup and #3001's warning would go
 * quiet rather than loud. Change it only alongside a migration that rewrites the
 * stored keys.
 *
 * `xero-booking-invoice-key.test.ts` pins the exact produced string, so a change
 * to any segment is a failing test naming this consequence rather than a silent
 * one.
 */

/**
 * The correlation key shared by a booking's invoice-create outbox row and the
 * Xero create-invoice call it eventually makes.
 *
 * Scoped to the BOOKING, so it is stable across the payment row's whole life.
 */
export function buildXeroBookingInvoiceCorrelationKey(bookingId: string): string {
  return buildXeroIdempotencyKey("booking", bookingId, "invoice", "v1");
}
