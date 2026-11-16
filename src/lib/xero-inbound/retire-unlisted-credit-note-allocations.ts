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
import { PaymentSource, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClubFormat } from "@/lib/club-format-settings";
import { lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } from "@/lib/payment-transactions";
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
import { type BankTransferFloorAlert, sendBankTransferFloorAlert } from "./credit-note-bank-transfer-floor";
import { decideLinkedRefundedTotalCents } from "./linked-refunded-total";
import { decideXeroRefundedColumns } from "./xero-refunded-columns";

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
 *
 * #4449 (`INV-PAY-126`): given the bank-transfer payment the allocated invoice
 * resolves to, the Payment row is locked FIRST (`lockPaymentForRefundedTotal`,
 * before the reservation and the allocation row, `INV-LOCK-002`), and the
 * payment's refunded total is decided under it from the links as this
 * transaction leaves them (`decideLinkedRefundedTotalCents`), so a kept settle
 * holding that row either already counted this allocation or is waited for
 * and its captured receipt read. That holds for a write that turns a link off
 * as much as one that turns it on. The floor's alert is returned for the
 * caller to send after the commit.
 */
export async function writeCurrentCreditNoteAllocation(
  link: XeroObjectLinkInput,
  options: { payment?: { id: string; invoiceId: string } } = {},
): Promise<{ written: boolean; floorAlert: BankTransferFloorAlert | null }> {
  const readingAt = readRefundNoteSnapshotAt(link.metadata);
  const { payment } = options;
  return prisma.$transaction(async (tx) => {
    if (payment) await lockPaymentForRefundedTotal(tx, payment.id);
    const written = await writeLockedAllocation(tx, link, readingAt);
    const floorAlert = payment ? await decideBankTransferRefundedTotal(tx, payment, link, written) : null;
    return { written, floorAlert };
  }, payment ? PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS : undefined);
}

async function writeLockedAllocation(tx: Prisma.TransactionClient, link: XeroObjectLinkInput, readingAt: Date | null): Promise<boolean> {
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
}

/**
 * #4449: the bank-transfer payment's refunded total as its links now record
 * it, under the Payment row lock this transaction holds, through the step
 * every writer from Xero takes (`decideXeroRefundedColumns`: clamp, the
 * bank-transfer floor of `INV-ADDPAY-021`, the status rule).
 *
 * Re-checked under the lock: the payment is still a bank transfer and still
 * the one payment whose own invoice id is the allocated invoice; otherwise it
 * decides nothing and leaves the payment to the recount after it.
 *
 * Written through a claim on the row as re-read, when the total or status
 * moves, and also whenever this transaction wrote the link: `updatedAt` then
 * moves too, so a lock-free recount that read the links before this write
 * loses its claim on the row it read and decides again.
 */
async function decideBankTransferRefundedTotal(
  tx: Prisma.TransactionClient,
  target: { id: string; invoiceId: string },
  link: XeroObjectLinkInput,
  linkWritten: boolean,
): Promise<BankTransferFloorAlert | null> {
  const payment = await tx.payment.findUnique({
    where: { id: target.id },
    select: { id: true, bookingId: true, amountCents: true, refundedAmountCents: true, status: true, source: true, xeroInvoiceId: true, updatedAt: true, booking: { select: { organiserSettled: true } } },
  });
  if (!payment || payment.source !== PaymentSource.INTERNET_BANKING || payment.xeroInvoiceId !== target.invoiceId) return null;
  if ((await tx.payment.count({ where: { xeroInvoiceId: target.invoiceId } })) !== 1) return null;
  const linked = await decideLinkedRefundedTotalCents(tx, [payment]);
  const decided = await decideXeroRefundedColumns(tx, {
    payment,
    isOrganiserSettled: () => payment.booking.organiserSettled,
    decidedCents: linked.get(payment.id) ?? 0,
    creditNoteId: readString(asRecord(link.metadata)?.creditNoteId) ?? null,
  });
  const changes = {
    ...(decided.refundedAmountCents !== payment.refundedAmountCents ? { refundedAmountCents: decided.refundedAmountCents } : {}),
    ...(decided.status && decided.status !== payment.status ? { status: decided.status } : {}),
  };
  if (Object.keys(changes).length === 0 && !linkWritten) return decided.floorAlert;
  // A claim on the row as re-read under its lock (`INV-LOCK-002`). The lock
  // means nothing can move it in between, so a lost claim is a broken
  // invariant: thrown, it rolls back the allocation write with it, and the
  // inbound event is retried. The alert is returned only for a committed write.
  // `updatedAt` always moves forward, even on a frozen clock.
  const updatedAt = new Date(Math.max(new Date().getTime(), payment.updatedAt.getTime() + 1));
  const claimed = await tx.payment.updateMany({
    where: { id: payment.id, status: payment.status, refundedAmountCents: payment.refundedAmountCents, updatedAt: payment.updatedAt },
    data: { ...changes, updatedAt },
  });
  if (claimed.count !== 1) throw new Error(`Refunded-total claim lost under the Payment row lock (#4449): ${payment.id}`);
  return decided.floorAlert;
}

/**
 * #4449 (`INV-PAY-126`): for a modification note, the payment each allocated
 * invoice names: the one payment whose own invoice id it is, when that
 * payment is a bank transfer. An invoice matched to several payments names
 * none, as the repair after it skips one (`resolvePaymentIdsByInvoiceTargets`),
 * and a payment found only by its link is decided by that repair alone.
 * Narrower than that resolution on purpose, not a copy of it: the shared
 * decision finds a bank-transfer payment's invoice allocations by the
 * payment's own invoice id, so only such a payment can be decided by an
 * allocation write; for every one it names, the resolution names the same.
 * Read before the lock; `decideBankTransferRefundedTotal` re-checks it under it.
 */
async function bankTransferPaymentIdsByInvoiceId(
  links: ReadonlyArray<{ metadata?: unknown }>,
  isModificationNote: boolean,
): Promise<Map<string, string>> {
  const byInvoiceId = new Map<string, string>();
  const invoiceIds = [
    ...new Set(links.map((link) => readString(asRecord(link.metadata)?.invoiceId)).filter((id): id is string => Boolean(id))),
  ];
  if (!isModificationNote || invoiceIds.length === 0) return byInvoiceId;
  const payments = await prisma.payment.findMany({
    where: { xeroInvoiceId: { in: invoiceIds } },
    select: { id: true, xeroInvoiceId: true, source: true },
  });
  for (const invoiceId of invoiceIds) {
    const [only, ...more] = payments.filter((payment) => payment.xeroInvoiceId === invoiceId);
    if (only && more.length === 0 && only.source === PaymentSource.INTERNET_BANKING) byInvoiceId.set(invoiceId, only.id);
  }
  return byInvoiceId;
}

/** The payment a link's write decides (`bankTransferPaymentIdsByInvoiceId`), if any. */
function decidedPaymentOf(link: { metadata?: unknown }, byInvoiceId: ReadonlyMap<string, string>): { payment?: { id: string; invoiceId: string } } {
  const invoiceId = readString(asRecord(link.metadata)?.invoiceId);
  const id = invoiceId ? byInvoiceId.get(invoiceId) : undefined;
  return id && invoiceId ? { payment: { id, invoiceId } } : {};
}

/** Floor alerts go out after every write's commit, outside any transaction. */
async function sendFloorAlerts(alerts: readonly BankTransferFloorAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  const format = await getClubFormat();
  for (const alert of alerts) await sendBankTransferFloorAlert(alert, format);
}

/**
 * The inbound credit-note sync's allocation writes (#4447), each through
 * `writeCurrentCreditNoteAllocation`. #4449 (`INV-PAY-126`): a modification
 * note's write names the payment `bankTransferPaymentIdsByInvoiceId` finds,
 * whose refunded total that write decides; any floor alert goes out after the loop.
 */
export async function writeCurrentCreditNoteAllocations(
  links: readonly XeroObjectLinkInput[],
  input: { isModificationNote: boolean },
): Promise<void> {
  const byInvoiceId = await bankTransferPaymentIdsByInvoiceId(links, input.isModificationNote);
  const floorAlerts: BankTransferFloorAlert[] = [];
  for (const link of links) {
    const { floorAlert } = await writeCurrentCreditNoteAllocation(link, decidedPaymentOf(link, byInvoiceId));
    if (floorAlert) floorAlerts.push(floorAlert);
  }
  await sendFloorAlerts(floorAlerts);
}

/**
 * Turn off this note's active allocation links whose invoice is not in
 * `listedInvoiceIds`. Returns how many were turned off.
 */
export async function retireUnlistedCreditNoteAllocations(input: {
  creditNoteId: string;
  /** #4449: a modification note's removal decides its bank-transfer payment's total, as its write does. */
  isModificationNote: boolean;
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
  const unlisted = links.filter((link) => {
    const metadata = asRecord(link.metadata);
    const invoiceId = readString(metadata?.invoiceId);
    return readString(metadata?.creditNoteId) === input.creditNoteId && Boolean(invoiceId) && !input.listedInvoiceIds.has(invoiceId!);
  });
  // #4449: the payment's Payment row first, as the write that turned the link on took it.
  const byInvoiceId = await bankTransferPaymentIdsByInvoiceId(unlisted, input.isModificationNote);
  let retired = 0;
  const floorAlerts: BankTransferFloorAlert[] = [];
  for (const link of unlisted) {
    const { written: turnedOff, floorAlert } = await writeCurrentCreditNoteAllocation(
      {
        ...link,
        active: false,
        metadata: { [REFUND_NOTE_SNAPSHOT_AT_KEY]: readingAt?.toISOString() ?? null },
        mergeMetadata: true,
      },
      decidedPaymentOf(link, byInvoiceId),
    );
    if (turnedOff) retired += 1;
    if (floorAlert) floorAlerts.push(floorAlert);
  }
  await sendFloorAlerts(floorAlerts);
  return retired;
}
