/**
 * #4447: a live credit note no longer allocated to an invoice in Xero.
 *
 * The inbound sync upserts one allocation link per invoice the note still
 * lists. This turns off the note's links for every other invoice, in that
 * same pass, so a later refunded-total recount stops counting the allocation
 * the officer removed. Each link is written by the link funnel
 * (`upsertXeroObjectLink`), active false, its stored metadata kept.
 *
 * A voided reading turns nothing off: the recount already leaves a voided
 * note out. A live reading that a stored snapshot of the note refuses — a
 * newer one, or a void — turns nothing off either. And a link whose own
 * stamp is newer than this reading is left as the newer write recorded it,
 * under that link's row lock, so two syncs in flight cannot finish with the
 * older one having switched the newer allocation off.
 */
import { prisma } from "@/lib/prisma";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
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

    const turnedOff = await prisma.$transaction(async (tx) => {
      // The allocation row only. The decision and the funnel write share it,
      // so a newer sync's upsert of this same link is either already visible
      // or waits until this transaction ends.
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
      if (!current?.active) return false;
      const storedAt = readRefundNoteSnapshotAt(current.metadata);
      if (storedAt && readingAt && storedAt.getTime() > readingAt.getTime()) return false;
      await upsertXeroObjectLink(
        {
          localModel: link.localModel,
          localId: link.localId,
          xeroObjectType: link.xeroObjectType,
          xeroObjectId: link.xeroObjectId,
          xeroObjectNumber: link.xeroObjectNumber,
          xeroObjectUrl: link.xeroObjectUrl,
          role: link.role,
          active: false,
          metadata: { [REFUND_NOTE_SNAPSHOT_AT_KEY]: readingAt?.toISOString() ?? null },
          mergeMetadata: true,
        },
        { store: tx },
      );
      return true;
    });
    if (turnedOff) retired += 1;
  }
  return retired;
}
