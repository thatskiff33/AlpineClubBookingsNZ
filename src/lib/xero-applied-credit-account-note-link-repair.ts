/**
 * #4712: the one-off repair for the `ACCOUNT_CREDIT_NOTE` links the inbound
 * credit-note reconcile wrote before #4712 through #1925's local provenance.
 * That path linked the note to every payment on the bookings an applied credit
 * was SPENT on, as if the note had been raised for them. Such a link blocks the
 * booking's own cancellation note from being queued ("already linked"), and
 * every later refund recount of the payment counted the note as money paid back.
 *
 * A link is STALE, and retired, only when nothing says the note was raised for
 * its payment - no outbound create of the note for that payment, and no
 * cancellation credit of the payment's booking holding it - and something says
 * it was spent there: a slice stamped with the note, or an applied-credit
 * ledger row of it, on the payment's booking. A link neither explains is
 * listed as UNEXPLAINED and never touched. No Xero call is made.
 *
 * Report-only by default. `--apply` is bound to the reviewed payment ids:
 * each link is classified again, retired with a guarded write (still active),
 * audited, and the payment's refunded total recounted with no note being
 * synced (`repairRefundedPaymentBusinessState`, the #4095 recount), so the
 * note stops counting. Runbook: docs/MAINTENANCE.md, "Retire account-credit
 * note links written on bookings a credit was applied to (#4712)".
 */
import { CreditType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeXeroInboundAuditLogs } from "@/lib/xero-inbound/audit";
import { repairRefundedPaymentBusinessState } from "@/lib/xero-inbound/credit-note-repairs";

export const APPLIED_CREDIT_ACCOUNT_NOTE_LINK_REPAIR_AUDIT_SOURCE = "xero-applied-credit-account-note-link-repair";
const RETIRED_AUDIT_SUMMARY = "Account-credit note link retired: the note was applied to this booking, not raised for it (#4712)";

export type AccountNoteLinkClass = "STALE" | "RAISED_FOR_PAYMENT" | "UNEXPLAINED";

export type AccountNoteLinkCandidate = {
  linkId: string;
  paymentId: string;
  bookingId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  classification: AccountNoteLinkClass;
};

export type AccountNoteLinkRepairReport = {
  stale: AccountNoteLinkCandidate[];
  unexplained: AccountNoteLinkCandidate[];
  /** Active links the note was raised for: correct, and left alone. */
  raisedForPayment: number;
};

export type AccountNoteLinkRepairApplyResult = {
  retired: AccountNoteLinkCandidate[];
  /** Named for apply but no longer stale on the fresh read (or already retired): left alone. */
  notStale: { paymentId: string; reason: string }[];
  /** Payments whose recount lost its claim twice to a concurrent writer; their links are retired, their refunded total needs a look. */
  recountUnsettledPaymentIds: string[];
};

async function readActiveAccountNoteLinks(paymentIds?: readonly string[]) {
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      active: true,
      ...(paymentIds ? { localId: { in: [...paymentIds] } } : {}),
    },
    select: { id: true, localId: true, xeroObjectId: true, xeroObjectNumber: true },
    orderBy: [{ localId: "asc" }, { id: "asc" }],
  });
  const payments = await prisma.payment.findMany({
    where: { id: { in: [...new Set(links.map((link) => link.localId))] } },
    select: { id: true, bookingId: true },
  });
  const bookingByPayment = new Map(payments.map((payment) => [payment.id, payment.bookingId]));
  return links.flatMap((link) => {
    const bookingId = bookingByPayment.get(link.localId);
    return bookingId ? [{ ...link, bookingId }] : [];
  });
}

async function classify(link: { localId: string; xeroObjectId: string; bookingId: string }): Promise<AccountNoteLinkClass> {
  const [raisedForPayment, cancellationCredit, slice, appliedRow] = await Promise.all([
    // Any outbound create of this note for this payment: only the app's own
    // account-credit create links the role, so its row is the proof.
    prisma.xeroSyncOperation.findFirst({
      where: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: link.localId, xeroObjectId: link.xeroObjectId },
      select: { id: true },
    }),
    // The inbound reconcile's own account-credit resolver.
    prisma.memberCredit.findFirst({
      where: { type: CreditType.CANCELLATION_REFUND, xeroCreditNoteId: link.xeroObjectId, sourceBookingId: link.bookingId },
      select: { id: true },
    }),
    prisma.memberCreditNoteAllocation.findFirst({
      where: { xeroCreditNoteId: link.xeroObjectId, appliedToBookingId: link.bookingId },
      select: { id: true },
    }),
    // The ledger keeps the application after a deallocation deleted its slice.
    prisma.memberCredit.findFirst({
      where: { type: CreditType.BOOKING_APPLIED, xeroCreditNoteId: link.xeroObjectId, appliedToBookingId: link.bookingId },
      select: { id: true },
    }),
  ]);
  if (raisedForPayment || cancellationCredit) return "RAISED_FOR_PAYMENT";
  return slice || appliedRow ? "STALE" : "UNEXPLAINED";
}

/** The dry run: every active ACCOUNT_CREDIT_NOTE payment link, classified. Writes nothing. */
export async function findStaleAppliedCreditAccountNoteLinks(scope?: { paymentIds?: string[] }): Promise<AccountNoteLinkRepairReport> {
  const report: AccountNoteLinkRepairReport = { stale: [], unexplained: [], raisedForPayment: 0 };
  for (const link of await readActiveAccountNoteLinks(scope?.paymentIds)) {
    const classification = await classify(link);
    if (classification === "RAISED_FOR_PAYMENT") {
      report.raisedForPayment += 1;
      continue;
    }
    const candidate: AccountNoteLinkCandidate = {
      linkId: link.id,
      paymentId: link.localId,
      bookingId: link.bookingId,
      creditNoteId: link.xeroObjectId,
      creditNoteNumber: link.xeroObjectNumber,
      classification,
    };
    (classification === "STALE" ? report.stale : report.unexplained).push(candidate);
  }
  return report;
}

/**
 * `--apply`: retire the reviewed payments' links that are still stale on a
 * fresh read, then recount each such payment's refunded total.
 */
export async function applyStaleAppliedCreditAccountNoteLinkRepair(paymentIds: readonly string[]): Promise<AccountNoteLinkRepairApplyResult> {
  if (paymentIds.length === 0) {
    throw new Error("The repair applies only to reviewed payment ids; name at least one.");
  }
  const result: AccountNoteLinkRepairApplyResult = { retired: [], notStale: [], recountUnsettledPaymentIds: [] };
  const report = await findStaleAppliedCreditAccountNoteLinks({ paymentIds: [...paymentIds] });
  const stalePayments = new Set(report.stale.map((candidate) => candidate.paymentId));
  for (const paymentId of new Set(paymentIds)) {
    if (!stalePayments.has(paymentId)) result.notStale.push({ paymentId, reason: "no stale account-credit note link on a fresh read" });
  }

  for (const candidate of report.stale) {
    const { count } = await prisma.xeroObjectLink.updateMany({ where: { id: candidate.linkId, active: true }, data: { active: false } });
    if (count === 1) result.retired.push(candidate);
    else result.notStale.push({ paymentId: candidate.paymentId, reason: `link ${candidate.linkId} was no longer active` });
  }

  await writeXeroInboundAuditLogs({
    source: APPLIED_CREDIT_ACCOUNT_NOTE_LINK_REPAIR_AUDIT_SOURCE,
    summary: RETIRED_AUDIT_SUMMARY,
    links: result.retired.map((candidate) => ({
      localModel: "Payment",
      localId: candidate.paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: candidate.creditNoteId,
      xeroObjectNumber: candidate.creditNoteNumber,
      role: "ACCOUNT_CREDIT_NOTE",
    })),
    metadata: { issue: 4712 },
  });

  const recountPaymentIds = [...new Set(result.retired.map((candidate) => candidate.paymentId))];
  for (const paymentId of recountPaymentIds) {
    // One payment a call: a single payment is the recount's own scope (#4095).
    const recount = await repairRefundedPaymentBusinessState({
      creditNoteId: null,
      creditNote: {},
      directPaymentIds: [paymentId],
      modificationRefundAmountsByPaymentId: new Map(),
    });
    if (recount.unsettledPaymentIds?.length) result.recountUnsettledPaymentIds.push(...recount.unsettledPaymentIds);
  }
  return result;
}

function describeCandidate(candidate: AccountNoteLinkCandidate) {
  return `- payment ${candidate.paymentId} (booking ${candidate.bookingId}): link ${candidate.linkId} to credit note ${candidate.creditNoteNumber ?? candidate.creditNoteId} (${candidate.creditNoteId})`;
}

export function formatAppliedCreditAccountNoteLinkReport(report: AccountNoteLinkRepairReport): string {
  return [
    `${report.raisedForPayment} active account-credit note link(s) were raised for their payment and are left alone.`,
    `${report.stale.length} stale link(s): the note was applied to the payment's booking, never raised for it. --apply retires these:`,
    ...report.stale.map(describeCandidate),
    `${report.unexplained.length} unexplained link(s): neither raised for nor applied to the payment's booking. Never retired by this repair; check them by hand:`,
    ...report.unexplained.map(describeCandidate),
  ].join("\n");
}

export function formatAppliedCreditAccountNoteLinkApply(result: AccountNoteLinkRepairApplyResult): string {
  return [
    `Retired ${result.retired.length} link(s) and recounted the refunded total of ${new Set(result.retired.map((candidate) => candidate.paymentId)).size} payment(s).`,
    ...result.notStale.map((entry) => `Left alone: payment ${entry.paymentId} - ${entry.reason}.`),
    ...(result.recountUnsettledPaymentIds.length
      ? [`The recount lost its claim twice to a concurrent writer for: ${result.recountUnsettledPaymentIds.join(", ")}. Their links are retired; check each one's refunded total by hand.`]
      : []),
  ].join("\n");
}
