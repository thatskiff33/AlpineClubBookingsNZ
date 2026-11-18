import "server-only";

import { prisma } from "@/lib/prisma";
import { XERO_ACTIVE_OPERATION_STATUSES } from "@/lib/xero-active-operation-statuses";
import { asRecord, readString } from "@/lib/xero-json";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";

/**
 * WHETHER THE BOOKING'S XERO INVOICE SHOWS ITS LATEST CHANGE (#5066; owner
 * decision on PR #5201, 17 Nov 2026: where the app knows an edit could not
 * update the invoice in Xero, the booking page says so in plain words).
 *
 * Read from the app's own outbox rows for the PRIMARY invoice, never from Xero:
 *
 * - an in-place update queued by an edit or repair
 *   (`enqueueXeroBookingInvoiceUpdateOperation`: OUTBOUND INVOICE UPDATE,
 *   anchored to the Payment);
 * - an update the edit's policy skipped
 *   (`recordSkippedXeroBookingInvoiceUpdateOperation`: anchored to the
 *   BookingModification, `requestPayload.skippedByPolicy`).
 *
 * `UPDATING` while any update is still queued or running (the PDF may not show
 * the change yet); otherwise the latest ended row decides: a skip, or a failure
 * no officer has marked resolved in Xero, is `NOT_UPDATED`; a success or a
 * resolved row is `CURRENT`. Rows naming a different invoice id are ignored.
 */
export type PrimaryInvoiceUpdateState = "CURRENT" | "UPDATING" | "NOT_UPDATED";

export type PrimaryInvoiceUpdateRow = {
  status: string;
  createdAt: Date;
  manuallyResolvedAt: Date | null;
  requestPayload: unknown;
};

const ACTIVE: readonly string[] = XERO_ACTIVE_OPERATION_STATUSES;

function isSkippedByPolicy(row: PrimaryInvoiceUpdateRow): boolean {
  return asRecord(row.requestPayload)?.skippedByPolicy === true;
}

/** Pure: the state the rows for invoice `xeroInvoiceId` describe. */
export function classifyPrimaryInvoiceUpdates(
  rows: readonly PrimaryInvoiceUpdateRow[],
  xeroInvoiceId: string,
): PrimaryInvoiceUpdateState {
  const own = rows.filter((row) => {
    const invoiceId = readString(asRecord(row.requestPayload)?.xeroInvoiceId);
    return invoiceId === null || invoiceId === xeroInvoiceId;
  });
  if (own.some((row) => !isSkippedByPolicy(row) && ACTIVE.includes(row.status))) return "UPDATING";
  const latest = own
    .filter((row) => isSkippedByPolicy(row) || !ACTIVE.includes(row.status))
    .reduce<PrimaryInvoiceUpdateRow | null>((last, row) => (!last || row.createdAt > last.createdAt ? row : last), null);
  if (!latest || isResolvedInXero(latest)) return "CURRENT";
  if (isSkippedByPolicy(latest)) return "NOT_UPDATED";
  return latest.status === "SUCCEEDED" ? "CURRENT" : "NOT_UPDATED";
}

export async function readPrimaryInvoiceUpdateState(
  booking: { paymentId: string; xeroInvoiceId: string; modificationIds: readonly string[] },
  db: Pick<typeof prisma, "xeroSyncOperation"> = prisma,
): Promise<PrimaryInvoiceUpdateState> {
  const rows = await db.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      OR: [
        { localModel: "Payment", localId: booking.paymentId },
        ...(booking.modificationIds.length > 0
          ? [{ localModel: "BookingModification", localId: { in: [...booking.modificationIds] } }]
          : []),
      ],
    },
    select: { status: true, createdAt: true, manuallyResolvedAt: true, requestPayload: true },
  });
  return classifyPrimaryInvoiceUpdates(rows, booking.xeroInvoiceId);
}

/** The plain-words line for the booking page, or null when the invoice is current. */
export function primaryInvoiceUpdateNotice(state: PrimaryInvoiceUpdateState): string | null {
  switch (state) {
    case "CURRENT":
      return null;
    case "UPDATING":
      return "A recent change to this booking is still being made to the invoice in the club's accounts, so the invoice may not show it yet.";
    case "NOT_UPDATED":
      return "A change to this booking could not be made to the invoice in the club's accounts, so the invoice does not show it. The summary here is from the booking itself.";
  }
}
