import type { Prisma } from "@prisma/client";

/**
 * The states in which a supplementary invoice for this anchor is still going to
 * be sent, so a second one must not be queued behind it. Wider than the
 * restatable set by `RUNNING`: an operation the outbox is executing right now
 * cannot have its amount changed, but it is very much still an invoice.
 *
 * Its own leaf (#3502) so the primary booking invoice can read it without
 * importing `xero-operation-outbox.ts`, which imports the primary invoice;
 * that module re-exports it, so no importer moved.
 */
export const OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
] as const;

/**
 * THE ONE CHANGE-SCOPED READ THAT MATCHES ON THE PAYLOAD, not on the anchor -
 * and therefore the one that could see a second ask (#3193 fix round).
 *
 * A second ask is anchored on `ManualRefundTask/<taskId>`, which is what keeps
 * it invisible to every read that decides whether this booking change already
 * has an invoice going out. This read is the exception: it matches
 * `requestPayload.bookingModificationId`, and a second ask carries that id in
 * its payload because the invoice it bills still belongs to that change.
 *
 * Until now nothing but a constant stopped it. A second ask is enqueued with
 * `waitForConfirmedAdditionalPayment: false`, so it is never `WAITING_PAYMENT`
 * and never matched - but that is the wrapper's call-site value, not a property
 * of the anchor, and a future caller flipping it would park an already-settled
 * share's invoice on a PaymentIntent that is already paid, released by nothing
 * and reaped after fourteen days with no invoice raised. That is precisely the
 * shape #3202 exists to fix.
 *
 * `localModel: "BookingModification"` makes it structural instead. It changes
 * nothing for existing rows: an operation anchored on the BOOKING carries a null
 * `bookingModificationId` in its payload, so it never matched this filter
 * anyway. `INV-SSOT` - unrepresentable beats policed.
 */
export function waitingSupplementaryInvoiceOperationsWhere(
  bookingModificationId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    status: "WAITING_PAYMENT",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "BookingModification",
    requestPayload: {
      path: ["bookingModificationId"],
      equals: bookingModificationId,
    },
  };
}
