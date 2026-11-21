import "server-only";

import { prisma } from "@/lib/prisma";
import { XERO_ACTIVE_OPERATION_STATUSES, XERO_RERUNNABLE_OPERATION_STATUSES } from "@/lib/xero-active-operation-statuses";
import { asRecord, readString } from "@/lib/xero-json";
import {
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import { isSkippedPrimaryInvoiceUpdate } from "@/lib/xero-primary-invoice-update-skip";

/**
 * WHETHER THE BOOKING'S XERO DOCUMENTS SHOW ITS LATEST CHANGE (#5066; owner
 * decision on PR #5201, 17 Nov 2026: where the app knows an edit could not
 * update the invoice in Xero, the booking page says so in plain words).
 *
 * Read from the app's own outbox rows, never from Xero:
 *
 * - updates of the PRIMARY invoice (OUTBOUND INVOICE UPDATE, on the Payment or
 *   a BookingModification). `UPDATING` while one is queued or running;
 *   otherwise the latest ended row decides: skipped
 *   (`isSkippedPrimaryInvoiceUpdate`: by the edit's policy, or by the worker on
 *   a paid, credited, voided or deleted invoice) is `INVOICE_AS_ISSUED`, which
 *   is final for that row: no update is queued for it, so its notice must
 *   not say "yet" (re-review of 20 Nov 2026); failed and not marked resolved
 *   in Xero is `NOT_UPDATED`; a success or a resolved row is `CURRENT`. Rows
 *   naming a different invoice id are ignored.
 * - the credit notes a change raises against it (OUTBOUND CREDIT_NOTE CREATE,
 *   on the Booking, its Payment or a BookingModification, of the queue types
 *   the page's credit-note list reads; review F2). Until one succeeds it has no
 *   Xero id, so the list cannot show it: queued or running is `UPDATING`,
 *   failed or partial and not resolved in Xero is `NOT_UPDATED`. A retry
 *   re-runs the same row, so a recovered note leaves no failed row behind.
 *
 * The page shows the worse of the two: a failed row outranks one still on its
 * way, which outranks an invoice kept as issued.
 */
export type PrimaryInvoiceUpdateState = "CURRENT" | "INVOICE_AS_ISSUED" | "UPDATING" | "NOT_UPDATED";

export type PrimaryInvoiceUpdateRow = {
  status: string;
  createdAt: Date;
  manuallyResolvedAt: Date | null;
  requestPayload: unknown;
  responsePayload: unknown;
};

export type CreditNoteCreateRow = { status: string; manuallyResolvedAt: Date | null };

const ACTIVE: readonly string[] = XERO_ACTIVE_OPERATION_STATUSES;
const ENDED_UNAPPLIED: readonly string[] = XERO_RERUNNABLE_OPERATION_STATUSES.filter((status) => !ACTIVE.includes(status));
const STATE_RANK: Readonly<Record<PrimaryInvoiceUpdateState, number>> = {
  CURRENT: 0,
  INVOICE_AS_ISSUED: 1,
  UPDATING: 2,
  NOT_UPDATED: 3,
};

/** The queue types of the credit notes `readBookingCreditNotes` can list. */
const BOOKING_CREDIT_NOTE_QUEUE_TYPES = [
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
];

/** Pure: the state the primary-invoice update rows for invoice `xeroInvoiceId` describe. */
export function classifyPrimaryInvoiceUpdates(
  rows: readonly PrimaryInvoiceUpdateRow[],
  xeroInvoiceId: string,
): PrimaryInvoiceUpdateState {
  const own = rows.filter((row) => {
    const invoiceId = readString(asRecord(row.requestPayload)?.xeroInvoiceId);
    return invoiceId === null || invoiceId === xeroInvoiceId;
  });
  if (own.some((row) => !isSkippedPrimaryInvoiceUpdate(row) && ACTIVE.includes(row.status))) return "UPDATING";
  const latest = own
    .filter((row) => isSkippedPrimaryInvoiceUpdate(row) || !ACTIVE.includes(row.status))
    .reduce<PrimaryInvoiceUpdateRow | null>((last, row) => (!last || row.createdAt > last.createdAt ? row : last), null);
  if (!latest || isResolvedInXero(latest)) return "CURRENT";
  if (isSkippedPrimaryInvoiceUpdate(latest)) return "INVOICE_AS_ISSUED";
  return latest.status === "SUCCEEDED" ? "CURRENT" : "NOT_UPDATED";
}

/** Pure: the state the booking's credit-note create rows describe. */
export function classifyCreditNoteCreates(rows: readonly CreditNoteCreateRow[]): PrimaryInvoiceUpdateState {
  const open = rows.filter((row) => !isResolvedInXero(row));
  if (open.some((row) => ENDED_UNAPPLIED.includes(row.status))) return "NOT_UPDATED";
  if (open.some((row) => ACTIVE.includes(row.status))) return "UPDATING";
  return "CURRENT";
}

export async function readPrimaryInvoiceUpdateState(
  booking: { bookingId: string; paymentId: string; xeroInvoiceId: string; modificationIds: readonly string[] },
  db: Pick<typeof prisma, "xeroSyncOperation"> = prisma,
): Promise<PrimaryInvoiceUpdateState> {
  const paymentOrModifications = [
    { localModel: "Payment", localId: booking.paymentId },
    ...(booking.modificationIds.length > 0
      ? [{ localModel: "BookingModification", localId: { in: [...booking.modificationIds] } }]
      : []),
  ];
  const [updates, creditNotes] = await Promise.all([
    db.xeroSyncOperation.findMany({
      where: { direction: "OUTBOUND", entityType: "INVOICE", operationType: "UPDATE", OR: paymentOrModifications },
      select: { status: true, createdAt: true, manuallyResolvedAt: true, requestPayload: true, responsePayload: true },
    }),
    db.xeroSyncOperation.findMany({
      where: {
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        queueType: { in: BOOKING_CREDIT_NOTE_QUEUE_TYPES },
        OR: [{ localModel: "Booking", localId: booking.bookingId }, ...paymentOrModifications],
      },
      select: { status: true, manuallyResolvedAt: true },
    }),
  ]);
  const states = [classifyPrimaryInvoiceUpdates(updates, booking.xeroInvoiceId), classifyCreditNoteCreates(creditNotes)];
  return states.reduce((worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst), "CURRENT");
}

/** The plain-words line for the booking page, or null when the club's accounts show the latest change. */
export function primaryInvoiceUpdateNotice(state: PrimaryInvoiceUpdateState): string | null {
  switch (state) {
    case "CURRENT":
      return null;
    case "INVOICE_AS_ISSUED":
      return "A later change to this booking is not shown on the invoice, which stays as it was issued. The summary here is from the booking itself.";
    case "UPDATING":
      return "A recent change to this booking is still on its way to the club's accounts, so the invoice and its credit notes may not show it yet.";
    case "NOT_UPDATED":
      return "A change to this booking has not fully reached the club's accounts: the invoice, or a credit for the change, does not show it yet. The summary here is from the booking itself.";
  }
}
