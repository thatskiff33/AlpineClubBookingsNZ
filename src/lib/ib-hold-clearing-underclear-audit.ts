/**
 * Read-only audit for Internet-Banking hold-expiry invoices left open.
 *
 * Before #1597, `releaseOneHold` (internet-banking-payment-cron.ts) sized the
 * invoice-clearing credit note at `payment.amountCents` — the credit-REDUCED
 * effectivePriceCents — while the booking invoice is raised at the FULL
 * finalPriceCents. Where a released hold carried an issued invoice AND applied
 * credit, the invoice was left open by exactly the applied-credit slice.
 *
 * Every hold is judged against the INV-PAY-017 size the release uses today
 * (`unpaidInvoiceClearingAmountCents`), and against what was ACTUALLY
 * ALLOCATED to the booking's invoices by the notes raised for it — never what
 * was merely queued or created. A FAILED operation created nothing; a note
 * that was created but not allocated left the invoice open. Two note shapes
 * exist (#3535):
 *
 * - since #3535, the booking-anchored clearing note (`MODIFICATION_CREDIT_NOTE`),
 *   which the builder allocates itself; its allocations are the booking's
 *   `MODIFICATION_CREDIT_NOTE_ALLOCATION` links;
 * - before it, the payment's refund note (`REFUND_CREDIT_NOTE`), which was
 *   NEVER allocated by the system (`REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON`).
 *   It counts only as far as someone allocated it by hand in Xero, which the
 *   inbound reconcile records as allocation links on the payment. Otherwise it
 *   is reported as issued with the invoice NOT cleared.
 *
 * Split out of `ib-hold-clearing-audit.ts` (#3535), which keeps the #1620 and
 * card applied-credit enumerations the same script prints after this one.
 *
 * This module reports those bookings using ONLY local data (no Xero calls). It
 * never writes and never touches a live provider — the operator applies any
 * repair by hand (see docs/MAINTENANCE.md).
 */
import { PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { unpaidInvoiceClearingAmountCents } from "@/lib/invoice-clearing-amount";
import {
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";

/**
 * A note raised against a released hold's invoice: the allocated clearing note
 * (#3535 onward) or the payment's refund note (before it).
 */
export interface IbHoldClearingNote {
  kind: "allocated-clearing-note" | "refund-note";
  /** The Xero credit note, or null when none was created (e.g. a FAILED op). */
  creditNoteId: string | null;
  /** The size its operation recorded, or null when no operation row exists. */
  amountCents: number | null;
  /** The operation's status (PENDING, SUCCEEDED, PARTIAL, FAILED…), or null. */
  operationStatus: string | null;
  /** What was actually allocated from this note to an invoice. */
  allocatedCents: number;
}

export interface IbHoldClearingRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  changeFeeCents: number;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  finalPriceCents: number;
  /** Applied credit already allocated to the invoice as a Xero credit note —
   * the precise allocation ledger the release reads (INV-PAY-017), positive. */
  xeroAllocatedAppliedCreditCents: number;
  clearingNotes: IbHoldClearingNote[];
}

export interface UnderClearedIbHoldFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  /** xeroInvoiceNumber when present, else the raw xeroInvoiceId. */
  invoiceRef: string;
  /** The notes raised for this hold; empty means none — the invoice may be
   * fully open. */
  clearingNotes: IbHoldClearingNote[];
  finalPriceCents: number;
  changeFeeCents: number;
  xeroAllocatedAppliedCreditCents: number;
  /** The INV-PAY-017 size (`unpaidInvoiceClearingAmountCents`). */
  expectedClearingCents: number;
  /** What the notes raised for this hold actually allocated. */
  allocatedClearingCents: number;
  /** expected − allocated; always > 0 for a finding. */
  deltaCents: number;
}

export interface IbHoldClearingAuditResult {
  scannedReleasedHolds: number;
  invoiceBearingHolds: number;
  /** Released holds with NO issued invoice (the create-time hold-slots shape).
   * Pre-#1597 these enqueued a refund note the worker could not process
   * ("No Xero invoice linked to payment"); post-fix they enqueue nothing.
   * Reported for visibility, not as under-cleared invoices. */
  noInvoiceReleasedHolds: number;
  underCleared: UnderClearedIbHoldFinding[];
  totalDeltaCents: number;
}

/**
 * Pure per-row judgement. Returns a finding for a hold that carried an issued
 * invoice whose notes allocated less than the INV-PAY-017 size; otherwise null.
 */
export function deriveIbHoldClearingFinding(
  row: IbHoldClearingRow,
): UnderClearedIbHoldFinding | null {
  // No issued invoice: nothing was (or should be) cleared. Surfaced separately.
  if (!row.xeroInvoiceId) {
    return null;
  }

  const xeroAllocatedAppliedCreditCents = Math.max(
    0,
    row.xeroAllocatedAppliedCreditCents,
  );
  const expectedClearingCents = unpaidInvoiceClearingAmountCents({
    finalPriceCents: row.finalPriceCents,
    changeFeeCents: row.changeFeeCents,
    xeroAllocatedAppliedCreditCents,
  });
  const allocatedClearingCents = row.clearingNotes.reduce(
    (sum, note) => sum + Math.max(0, note.allocatedCents),
    0,
  );
  const deltaCents = expectedClearingCents - allocatedClearingCents;
  if (deltaCents <= 0) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    invoiceRef: row.xeroInvoiceNumber ?? row.xeroInvoiceId,
    clearingNotes: row.clearingNotes,
    finalPriceCents: row.finalPriceCents,
    changeFeeCents: row.changeFeeCents,
    xeroAllocatedAppliedCreditCents,
    expectedClearingCents,
    allocatedClearingCents,
    deltaCents,
  };
}

/**
 * The size an operation recorded: the queued payload's `refundAmountCents`
 * (both shapes; the clearing note keeps it after execution), else an executed
 * refund note's intended `allocation.amount`, in dollars.
 */
function recordedNoteCents(requestPayload: unknown): number | null {
  const payload = asRecord(requestPayload);
  const queued = readNumber(payload?.refundAmountCents);
  if (queued !== null) return queued;
  const dollars = readNumber(asRecord(payload?.allocation)?.amount);
  return dollars === null ? null : Math.round(dollars * 100);
}

type ClearingOperation = {
  localModel: string | null;
  status: string;
  requestPayload: unknown;
  xeroObjectId: string | null;
};
type AllocationLink = { localModel: string; metadata: unknown };

/** Sum of one credit note's allocation links on its anchor, each allocation once. */
function allocatedFromNote(
  links: AllocationLink[],
  anchor: "Booking" | "Payment",
  creditNoteId: string | null,
): number {
  if (!creditNoteId) return 0;
  const seen = new Map<string, number>();
  for (const link of links) {
    if (link.localModel !== anchor) continue;
    const metadata = asRecord(link.metadata);
    if (readString(metadata?.creditNoteId) !== creditNoteId) continue;
    const invoiceId = readString(metadata?.invoiceId);
    const amountCents = readNumber(metadata?.amountCents);
    if (!invoiceId || amountCents === null || amountCents <= 0) continue;
    // The builder's link and the inbound reconcile's link describe the same
    // allocation; count it once.
    seen.set(`${invoiceId}:${amountCents}`, amountCents);
  }
  return [...seen.values()].reduce((sum, cents) => sum + cents, 0);
}

/**
 * The notes raised against one released hold, from its operations newest first
 * (the newest per shape) and its allocation links. A refund note known only
 * from `payment.xeroRefundCreditNoteId` (no operation row) is kept, size
 * unknown.
 */
export function resolveIbHoldClearingNotes(input: {
  operations: ClearingOperation[];
  allocationLinks: AllocationLink[];
  xeroRefundCreditNoteId: string | null;
}): IbHoldClearingNote[] {
  const notes: IbHoldClearingNote[] = [];
  const clearing = input.operations.find((op) => op.localModel === "Booking");
  if (clearing) {
    notes.push({
      kind: "allocated-clearing-note",
      creditNoteId: clearing.xeroObjectId,
      amountCents: recordedNoteCents(clearing.requestPayload),
      operationStatus: clearing.status,
      allocatedCents: allocatedFromNote(input.allocationLinks, "Booking", clearing.xeroObjectId),
    });
  }
  const refund = input.operations.find((op) => op.localModel === "Payment");
  if (refund || input.xeroRefundCreditNoteId) {
    const creditNoteId = refund?.xeroObjectId ?? input.xeroRefundCreditNoteId;
    notes.push({
      kind: "refund-note",
      creditNoteId,
      amountCents: refund ? recordedNoteCents(refund.requestPayload) : null,
      operationStatus: refund?.status ?? null,
      allocatedCents: allocatedFromNote(input.allocationLinks, "Payment", creditNoteId),
    });
  }
  return notes;
}

/**
 * Scan every released Internet-Banking hold and report the ones whose invoice
 * was not fully cleared. Read-only: it issues only SELECTs.
 */
export async function auditIbHoldClearingUnderclears(options?: {
  db?: typeof prisma;
}): Promise<IbHoldClearingAuditResult> {
  const db = options?.db ?? prisma;

  const released = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      internetBankingHoldSlots: true,
      internetBankingHoldReleasedAt: { not: null },
    },
    select: {
      id: true,
      bookingId: true,
      changeFeeCents: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      xeroRefundCreditNoteId: true,
      booking: { select: { finalPriceCents: true, status: true } },
    },
    orderBy: { internetBankingHoldReleasedAt: "asc" },
  });

  const result: IbHoldClearingAuditResult = {
    scannedReleasedHolds: released.length,
    invoiceBearingHolds: 0,
    noInvoiceReleasedHolds: 0,
    underCleared: [],
    totalDeltaCents: 0,
  };

  for (const payment of released) {
    if (!payment.xeroInvoiceId) {
      result.noInvoiceReleasedHolds += 1;
      continue;
    }
    result.invoiceBearingHolds += 1;

    // The ledger the release itself reads (INV-PAY-017): precise allocation
    // slices, not the MemberCredit note stamp, which survives a partial
    // deallocation and so misstates the clearing amount.
    const allocated = await db.memberCreditNoteAllocation.aggregate({
      where: { appliedToBookingId: payment.bookingId },
      _sum: { amountCents: true },
    });
    const operations = await db.xeroSyncOperation.findMany({
      where: {
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        OR: [
          {
            localModel: "Booking",
            localId: payment.bookingId,
            queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
          },
          {
            localModel: "Payment",
            localId: payment.id,
            queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          },
        ],
      },
      select: { localModel: true, status: true, requestPayload: true, xeroObjectId: true },
      orderBy: { createdAt: "desc" },
    });
    const allocationLinks = await db.xeroObjectLink.findMany({
      where: {
        xeroObjectType: "ALLOCATION",
        active: true,
        OR: [
          { localModel: "Booking", localId: payment.bookingId },
          { localModel: "Payment", localId: payment.id },
        ],
      },
      select: { localModel: true, metadata: true },
    });

    const finding = deriveIbHoldClearingFinding({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus: payment.booking.status,
      changeFeeCents: payment.changeFeeCents,
      xeroInvoiceId: payment.xeroInvoiceId,
      xeroInvoiceNumber: payment.xeroInvoiceNumber,
      finalPriceCents: payment.booking.finalPriceCents,
      xeroAllocatedAppliedCreditCents: allocated._sum.amountCents ?? 0,
      clearingNotes: resolveIbHoldClearingNotes({
        operations,
        allocationLinks,
        xeroRefundCreditNoteId: payment.xeroRefundCreditNoteId,
      }),
    });

    if (finding) {
      result.underCleared.push(finding);
      result.totalDeltaCents += finding.deltaCents;
    }
  }

  return result;
}

function describeClearingNote(note: IbHoldClearingNote, format: ClubFormat): string {
  const size = note.amountCents === null ? "size not recorded" : formatCents(note.amountCents, format);
  const status = note.operationStatus ? `, ${note.operationStatus}` : "";
  const allocated = `${formatCents(note.allocatedCents, format)} allocated`;
  if (note.kind === "refund-note") {
    // Never allocated by the system: issued, but the invoice is NOT cleared
    // unless someone allocated it by hand.
    return `refund note (before #3535) issued, invoice NOT cleared unless allocated by hand (${size}${status}; ${allocated})`;
  }
  if (!note.creditNoteId) {
    return `clearing note (#3535) NOT created (${size}${status})`;
  }
  return `allocated clearing note (#3535) (${size}${status}; ${allocated})`;
}

function describeClearingNotes(notes: IbHoldClearingNote[], format: ClubFormat): string {
  if (notes.length === 0) return "none - the invoice may be fully open";
  return notes.map((note) => describeClearingNote(note, format)).join("; ");
}

export function formatIbHoldClearingAuditReport(
  result: IbHoldClearingAuditResult,
  format: ClubFormat,
): string {
  const lines: string[] = [];
  lines.push("Internet-Banking hold-expiry invoice-clearing audit (#1597, #3535)");
  lines.push("REPORT ONLY — no changes were made and no provider was called.");
  lines.push("");
  lines.push(`Released holds scanned:        ${result.scannedReleasedHolds}`);
  lines.push(`  with an issued invoice:      ${result.invoiceBearingHolds}`);
  lines.push(`  with no invoice (skipped):   ${result.noInvoiceReleasedHolds}`);
  lines.push(`Under-cleared invoices found:  ${result.underCleared.length}`);
  lines.push(`Total open delta:              ${formatCents(result.totalDeltaCents, format)}`);
  lines.push("");

  if (result.underCleared.length === 0) {
    lines.push("No under-cleared invoices. Nothing to repair.");
    return lines.join("\n");
  }

  lines.push(
    "Each row's invoice was allocated less than its true outstanding. Where a",
  );
  lines.push(
    "note already exists but is not allocated, allocate it in Xero; otherwise",
  );
  lines.push(
    "issue a clearing credit note for exactly the delta by hand (see",
  );
  lines.push(
    "docs/MAINTENANCE.md). A FAILED clearing note can be retried from the Xero",
  );
  lines.push("operations screen. Until #3639 lands, do NOT run xero-booking-repair");
  lines.push("--apply on a hold that already carries a refund note: it would raise a");
  lines.push("second clearing note beside it.");
  lines.push("");

  for (const finding of result.underCleared) {
    lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
    lines.push(`    booking status:   ${finding.bookingStatus}`);
    lines.push(`    invoice:          ${finding.invoiceRef}`);
    lines.push(`    clearing notes:   ${describeClearingNotes(finding.clearingNotes, format)}`);
    lines.push(`    final price:      ${formatCents(finding.finalPriceCents, format)}`);
    lines.push(`    change fee:       ${formatCents(finding.changeFeeCents, format)}`);
    lines.push(
      `    Xero-allocated credit: ${formatCents(finding.xeroAllocatedAppliedCreditCents, format)}`,
    );
    lines.push(`    expected clearing: ${formatCents(finding.expectedClearingCents, format)}`);
    lines.push(`    allocated:         ${formatCents(finding.allocatedClearingCents, format)}`);
    lines.push(`    OPEN DELTA:        ${formatCents(finding.deltaCents, format)}`);
  }

  return lines.join("\n");
}
