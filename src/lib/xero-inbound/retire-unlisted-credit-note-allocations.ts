/**
 * #4447: a live credit note no longer allocated to an invoice in Xero.
 *
 * The inbound sync writes one allocation link per invoice the note still
 * lists, and this turns off the note's links for every other invoice, in
 * that same pass, so a later refunded-total recount stops counting the
 * allocation the officer removed. Both writes go through the link funnel
 * (`upsertXeroObjectLink`). Turning one off keeps the stored metadata and
 * sets the link inactive.
 *
 * A voided reading turns nothing off: the recount already leaves a voided
 * note out. A live reading that a stored snapshot of the note refuses — a
 * newer one, or a void — turns nothing off either. And a link whose own
 * stamp is newer than this reading is left as the newer write recorded it,
 * under that link's row lock. That covers the write for an invoice this
 * reading still lists, so an older sync cannot turn the removed allocation
 * back on after the newer one switched it off.
 */
import { prisma } from "@/lib/prisma";
import { type XeroObjectLinkInput, upsertXeroObjectLink } from "@/lib/xero-sync";
import { asRecord, readString } from "@/lib/xero-json";
import { NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE } from "@/lib/xero-clearing-allocations";
import {
  type XeroCreditNoteSnapshotSource,
  isIncludedRefundCreditNoteStatus,
  judgeRefundNoteWrite,
  readRefundNoteSnapshotAt,
  REFUND_NOTE_SNAPSHOT_AT_KEY,
  xeroCreditNoteSnapshotMetadata,
} from "@/lib/xero-refund-note-status";

const RETIRED_ALLOCATION_ROLES = [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE] as const;

/** The snapshot time an allocation link records, beside the amount it applied. */
export function creditNoteAllocationSnapshotStamp(
  creditNote: XeroCreditNoteSnapshotSource,
): Record<string, string | null> {
  const at = readRefundNoteSnapshotAt(xeroCreditNoteSnapshotMetadata(creditNote));
  return { [REFUND_NOTE_SNAPSHOT_AT_KEY]: at?.toISOString() ?? null };
}

/** Every stored snapshot of this credit note, active or not, before a write replaces one. */
export async function readStoredCreditNoteSnapshots(creditNoteId: string): Promise<unknown[]> {
  const rows = await prisma.xeroObjectLink.findMany({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId },
    select: { metadata: true },
  });
  return rows.map((row) => row.metadata);
}

function readingMayRetireAllocations(readingMetadata: unknown, storedSnapshots: readonly unknown[]): boolean {
  return storedSnapshots.every((metadata) => judgeRefundNoteWrite(readingMetadata, metadata) === "apply");
}

function isLiveCreditNoteStatus(status: unknown): boolean {
  return typeof status === "string" && isIncludedRefundCreditNoteStatus(status);
}

/**
 * A missing stamp on either side is not newer. That is `judgeRefundNoteWrite`:
 * equal timestamps are the same snapshot, and a reading with no timestamp applies.
 */
function storedAllocationStampIsNewer(storedMetadata: unknown, readingAt: Date | null): boolean {
  const storedAt = readRefundNoteSnapshotAt(storedMetadata);
  return storedAt !== null && readingAt !== null && storedAt.getTime() > readingAt.getTime();
}

/**
 * Write one allocation link unless the locked row already carries a newer
 * snapshot. A still-listed invoice reserves a missing row first, so two first
 * writers of it serialise on that row; turning one off does not, because the
 * row is already there. Returns whether this reading wrote the row.
 */
export async function writeCurrentCreditNoteAllocation(link: XeroObjectLinkInput): Promise<boolean> {
  const readingAt = readRefundNoteSnapshotAt(link.metadata);
  return prisma.$transaction(async (tx) => {
    if (link.active !== false) {
      // A missing row cannot be locked. The reservation rolls back with this
      // transaction, the same way a refund-note write reserves its own row.
      await tx.xeroObjectLink.createMany({
        data: [{
          localModel: link.localModel,
          localId: link.localId,
          xeroObjectType: link.xeroObjectType,
          xeroObjectId: link.xeroObjectId,
          role: link.role,
          active: false,
        }],
        skipDuplicates: true,
      });
    }
    // The allocation row only. The decision and the funnel write share it, so
    // a newer sync's write of this same link is either already visible or
    // waits until this transaction ends.
    await tx.$executeRaw`
      SELECT 1 FROM "XeroObjectLink"
      WHERE "localModel" = ${link.localModel} AND "localId" = ${link.localId}
        AND "xeroObjectType" = ${link.xeroObjectType} AND "xeroObjectId" = ${link.xeroObjectId}
        AND "role" = ${link.role}
      FOR UPDATE`;
    const current = await tx.xeroObjectLink.findUnique({
      where: {
        localModel_localId_xeroObjectType_xeroObjectId_role: {
          localModel: link.localModel,
          localId: link.localId,
          xeroObjectType: link.xeroObjectType,
          xeroObjectId: link.xeroObjectId,
          role: link.role,
        },
      },
      select: { active: true, metadata: true },
    });
    if (storedAllocationStampIsNewer(current?.metadata, readingAt)) return false;
    // Already off: leave the row the write that turned it off recorded.
    if (link.active === false && !current?.active) return false;
    await upsertXeroObjectLink(link, { store: tx });
    return true;
  });
}

/**
 * Turn off this note's active allocation links whose invoice is not in
 * `listedInvoiceIds`. Returns how many were turned off.
 */
export async function retireUnlistedCreditNoteAllocations(input: {
  creditNoteId: string;
  status: unknown;
  readingMetadata: unknown;
  priorSnapshots: readonly unknown[];
  listedInvoiceIds: ReadonlySet<string>;
}): Promise<number> {
  if (!isLiveCreditNoteStatus(input.status)) return 0;
  const currentSnapshots = await readStoredCreditNoteSnapshots(input.creditNoteId);
  if (!readingMayRetireAllocations(input.readingMetadata, [...input.priorSnapshots, ...currentSnapshots])) return 0;

  const links = await prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "ALLOCATION",
      active: true,
      role: { in: [...RETIRED_ALLOCATION_ROLES] },
      metadata: { path: ["creditNoteId"], equals: input.creditNoteId },
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      xeroObjectId: true,
      xeroObjectNumber: true,
      xeroObjectUrl: true,
      role: true,
      metadata: true,
    },
  });

  const readingAt = readRefundNoteSnapshotAt(input.readingMetadata);
  let retired = 0;
  for (const link of links) {
    const metadata = asRecord(link.metadata);
    const invoiceId = readString(metadata?.invoiceId);
    if (readString(metadata?.creditNoteId) !== input.creditNoteId) continue;
    if (!invoiceId || input.listedInvoiceIds.has(invoiceId)) continue;

    const turnedOff = await writeCurrentCreditNoteAllocation({
      ...link,
      active: false,
      metadata: { [REFUND_NOTE_SNAPSHOT_AT_KEY]: readingAt?.toISOString() ?? null },
      mergeMetadata: true,
    });
    if (turnedOff) retired += 1;
  }
  return retired;
}
