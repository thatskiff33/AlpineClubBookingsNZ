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
import { PaymentSource, PaymentStatus, type Prisma } from "@prisma/client";
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
import { getNextRefundedPaymentStatus } from "./amounts";
import { type BankTransferFloorAlert, bankTransferFloorCents, sendBankTransferFloorAlert } from "./credit-note-bank-transfer-floor";
import { decideLinkedRefundedTotalCents } from "./linked-refunded-total";
import { uncapturedPrimaryStatus } from "./modification-note-refunds";

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
 * and its captured receipt read. The floor's alert is returned for the caller
 * to send after the commit.
 */
export async function writeCurrentCreditNoteAllocation(
  link: XeroObjectLinkInput,
  options: { paymentId?: string } = {},
): Promise<{ written: boolean; floorAlert: BankTransferFloorAlert | null }> {
  const readingAt = readRefundNoteSnapshotAt(link.metadata);
  const { paymentId } = options;
  return prisma.$transaction(async (tx) => {
    if (paymentId) await lockPaymentForRefundedTotal(tx, paymentId);
    const written = await writeLockedAllocation(tx, link, readingAt);
    const floorAlert = paymentId ? await decideBankTransferRefundedTotal(tx, paymentId, link) : null;
    return { written, floorAlert };
  }, paymentId ? PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS : undefined);
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
 * it, under the Payment row lock this transaction holds: clamped to the
 * payment, held at its own refund detail (`bankTransferFloorCents`,
 * `INV-ADDPAY-021`), and its status as the recount derives it
 * (`getNextRefundedPaymentStatus`; a total falling to nothing on a payment
 * never captured returns it to its uncaptured state, `uncapturedPrimaryStatus`).
 * Written only when either changes.
 */
async function decideBankTransferRefundedTotal(
  tx: Prisma.TransactionClient,
  paymentId: string,
  link: XeroObjectLinkInput,
): Promise<BankTransferFloorAlert | null> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, bookingId: true, amountCents: true, refundedAmountCents: true, status: true, source: true, xeroInvoiceId: true, booking: { select: { organiserSettled: true } } },
  });
  if (!payment || payment.source !== PaymentSource.INTERNET_BANKING) return null;
  const linked = await decideLinkedRefundedTotalCents(tx, [payment]);
  const creditNoteId = readString(asRecord(link.metadata)?.creditNoteId) ?? null;
  const floored = await bankTransferFloorCents(tx, {
    payment,
    xeroDerivedCents: Math.min(Math.max(linked.get(payment.id) ?? 0, 0), payment.amountCents),
    creditNoteId,
  });
  let status = getNextRefundedPaymentStatus(payment.status, payment.amountCents, floored.cents);
  if (
    status === PaymentStatus.SUCCEEDED &&
    (payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED) &&
    !payment.booking.organiserSettled
  ) {
    status = (await uncapturedPrimaryStatus(payment.id, tx)) ?? status;
  }
  const data = {
    ...(floored.cents !== payment.refundedAmountCents ? { refundedAmountCents: floored.cents } : {}),
    ...(status && status !== payment.status ? { status } : {}),
  };
  if (Object.keys(data).length === 0) return floored.alert;
  // A claim on the row as re-read under its lock (`INV-LOCK-002`). The lock
  // means nothing can move it in between, so a lost claim is a broken
  // invariant: thrown, it rolls back the allocation write with it, and the
  // inbound event is retried. The alert is returned only for a committed write.
  const claimed = await tx.payment.updateMany({
    where: { id: payment.id, status: payment.status, refundedAmountCents: payment.refundedAmountCents },
    data,
  });
  if (claimed.count !== 1) throw new Error(`Refunded-total claim lost under the Payment row lock (#4449): ${payment.id}`);
  return floored.alert;
}

/**
 * The inbound credit-note sync's allocation writes (#4447), each through
 * `writeCurrentCreditNoteAllocation`. #4449 (`INV-PAY-126`): for a
 * modification note, a link whose invoice is the one invoice of exactly one
 * payment, a bank-transfer one, names that payment, whose refunded total that
 * write decides; any floor alert goes out after the loop. An invoice matched
 * to several payments names none, as the repair after it skips one
 * (`resolvePaymentIdsByInvoiceTargets`), and a payment found only by its link
 * is decided by that repair alone.
 */
export async function writeCurrentCreditNoteAllocations(
  links: readonly XeroObjectLinkInput[],
  input: { isModificationNote: boolean },
): Promise<void> {
  const bankTransferPaymentIdByInvoiceId = new Map<string, string>();
  const invoiceIds = [
    ...new Set(links.map((link) => readString(asRecord(link.metadata)?.invoiceId)).filter((id): id is string => Boolean(id))),
  ];
  if (input.isModificationNote && invoiceIds.length > 0) {
    const payments = await prisma.payment.findMany({
      where: { xeroInvoiceId: { in: invoiceIds } },
      select: { id: true, xeroInvoiceId: true, source: true },
    });
    for (const invoiceId of invoiceIds) {
      const [only, ...more] = payments.filter((payment) => payment.xeroInvoiceId === invoiceId);
      if (only && more.length === 0 && only.source === PaymentSource.INTERNET_BANKING) {
        bankTransferPaymentIdByInvoiceId.set(invoiceId, only.id);
      }
    }
  }
  const floorAlerts: BankTransferFloorAlert[] = [];
  for (const link of links) {
    const invoiceId = readString(asRecord(link.metadata)?.invoiceId);
    const paymentId = invoiceId ? bankTransferPaymentIdByInvoiceId.get(invoiceId) : undefined;
    const { floorAlert } = await writeCurrentCreditNoteAllocation(link, paymentId ? { paymentId } : {});
    if (floorAlert) floorAlerts.push(floorAlert);
  }
  if (floorAlerts.length === 0) return;
  const format = await getClubFormat();
  for (const alert of floorAlerts) await sendBankTransferFloorAlert(alert, format);
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

    const { written: turnedOff } = await writeCurrentCreditNoteAllocation({
      ...link,
      active: false,
      metadata: { [REFUND_NOTE_SNAPSHOT_AT_KEY]: readingAt?.toISOString() ?? null },
      mergeMetadata: true,
    });
    if (turnedOff) retired += 1;
  }
  return retired;
}
