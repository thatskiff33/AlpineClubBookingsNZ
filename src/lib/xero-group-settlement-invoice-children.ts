/**
 * #4525 (ALP-437): which children a combined group invoice bills, read by both
 * the invoice's lines (`xero-group-settlement-invoice-lines`) and the export
 * manifest's replay. A leaf module, so the member-money manifest can read
 * these without importing the lines module and its alert and email imports,
 * which would close a static import cycle (INV-SSOT-008).
 */
import { BookingStatus, type Prisma } from "@prisma/client";

/**
 * The children a stored combined-invoice CREATE request billed
 * (`operationRecord.childBookingIds`), or null for a request written before
 * #4525 recorded them. The one reader of that key (`INV-SSOT`).
 */
export function storedGroupInvoiceChildBookingIds(requestPayload: unknown): string[] | null {
  if (requestPayload === null || typeof requestPayload !== "object" || Array.isArray(requestPayload)) return null;
  const ids = (requestPayload as Record<string, unknown>).childBookingIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) return null;
  return ids as string[];
}

/**
 * The children a settlement commits and its combined invoice bills: the
 * organiser's CONFIRMED, organiser-settled, undeleted children. The one
 * definition the lines and the export manifest's replay read (`INV-SSOT`).
 */
export function committedGroupChildrenWhere(organiserBookingId: string) {
  return {
    parentBookingId: organiserBookingId,
    organiserSettled: true,
    deletedAt: null,
    status: BookingStatus.CONFIRMED,
  } satisfies Prisma.BookingWhereInput;
}
