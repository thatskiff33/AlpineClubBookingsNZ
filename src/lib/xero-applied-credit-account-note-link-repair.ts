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
 * listed as UNEXPLAINED; one both explain is listed as CONFLICTING - the
 * outbox may have completed the booking's own cancellation note with the
 * stale link's note ("stamps the wrong note") - and neither is ever touched.
 * No Xero call is made.
 *
 * Report-only by default. `--apply` is bound to the reviewed payment ids and
 * works one payment at a time: its links are classified again, retired with a
 * guarded write (still active), audited, and the payment's refunded total
 * recounted with no note being synced (`repairRefundedPaymentBusinessState`,
 * the #4095 recount), so the note stops counting. Runbook:
 * docs/MAINTENANCE.md, "Retire account-credit note links written on bookings
 * a credit was applied to (#4712)".
 */
import { CreditType } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { accountCreditNoteRaisedFor } from "@/lib/xero-account-credit-note-stamp";
import { writeXeroInboundAuditLogs } from "@/lib/xero-inbound/audit";
import { repairRefundedPaymentBusinessState } from "@/lib/xero-inbound/credit-note-repairs";

export const APPLIED_CREDIT_ACCOUNT_NOTE_LINK_REPAIR_AUDIT_SOURCE = "xero-applied-credit-account-note-link-repair";
const RETIRED_AUDIT_SUMMARY = "Account-credit note link retired: the note was applied to this booking, not raised for it (#4712)";

export type AccountNoteLinkClass = "STALE" | "RAISED_FOR_PAYMENT" | "CONFLICTING" | "UNEXPLAINED";

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
  /** Raised for the payment AND spent on its booking: listed for review, never retired. */
  conflicting: AccountNoteLinkCandidate[];
  unexplained: AccountNoteLinkCandidate[];
  /** Active links the note was raised for: correct, and left alone. */
  raisedForPayment: number;
};

export type AccountNoteLinkRepairApplyResult = {
  retired: AccountNoteLinkCandidate[];
  /** Named for apply but no longer stale on the fresh read (or already retired): left alone. */
  notStale: { paymentId: string; reason: string }[];
  /** Each payment whose links were retired: its refunded total in cents before and after the recount. */
  recounted: { paymentId: string; bookingId: string; refundedBeforeCents: number; refundedAfterCents: number }[];
  /**
   * Retired, but the recount did not settle: it lost its claim twice to a
   * concurrent writer, threw, or a concurrent inbound sync made the link
   * active again. The refunded total needs a look.
   */
  needsAttention: { paymentId: string; reason: string }[];
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
    // The outbox raised the note as this payment's account-credit note (#4705).
    accountCreditNoteRaisedFor({ creditNoteId: link.xeroObjectId, paymentIds: [link.localId] }),
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
  const raised = raisedForPayment.paymentIds.length > 0 || cancellationCredit !== null;
  const spent = slice !== null || appliedRow !== null;
  if (raised) return spent ? "CONFLICTING" : "RAISED_FOR_PAYMENT";
  return spent ? "STALE" : "UNEXPLAINED";
}

/** The dry run: every active ACCOUNT_CREDIT_NOTE payment link, classified. Writes nothing. */
export async function findStaleAppliedCreditAccountNoteLinks(scope?: { paymentIds?: string[] }): Promise<AccountNoteLinkRepairReport> {
  const report: AccountNoteLinkRepairReport = { stale: [], conflicting: [], unexplained: [], raisedForPayment: 0 };
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
    ({ STALE: report.stale, CONFLICTING: report.conflicting, UNEXPLAINED: report.unexplained })[classification].push(candidate);
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
  const result: AccountNoteLinkRepairApplyResult = { retired: [], notStale: [], recounted: [], needsAttention: [] };
  const report = await findStaleAppliedCreditAccountNoteLinks({ paymentIds: [...paymentIds] });
  for (const paymentId of new Set(paymentIds)) {
    const stale = report.stale.filter((candidate) => candidate.paymentId === paymentId);
    if (stale.length === 0) {
      result.notStale.push({ paymentId, reason: "no stale account-credit note link on a fresh read" });
      continue;
    }
    // One payment at a time, so a failure leaves the others repaired and is named.
    try {
      await retireAndRecount(paymentId, stale, result);
    } catch (error) {
      result.needsAttention.push({ paymentId, reason: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}

async function retireAndRecount(paymentId: string, stale: AccountNoteLinkCandidate[], result: AccountNoteLinkRepairApplyResult) {
  const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmountCents: true } });
  const retired: AccountNoteLinkCandidate[] = [];
  for (const candidate of stale) {
    const { count } = await prisma.xeroObjectLink.updateMany({ where: { id: candidate.linkId, active: true }, data: { active: false } });
    if (count === 1) retired.push(candidate);
    else result.notStale.push({ paymentId, reason: `link ${candidate.linkId} was no longer active` });
  }
  // Narrowed here, not by a length check, so the booking below is typed.
  const [firstRetired] = retired;
  if (!firstRetired) return;
  result.retired.push(...retired);

  await writeXeroInboundAuditLogs({
    source: APPLIED_CREDIT_ACCOUNT_NOTE_LINK_REPAIR_AUDIT_SOURCE,
    summary: RETIRED_AUDIT_SUMMARY,
    links: retired.map((candidate) => ({
      localModel: "Payment",
      localId: candidate.paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: candidate.creditNoteId,
      xeroObjectNumber: candidate.creditNoteNumber,
      role: "ACCOUNT_CREDIT_NOTE",
    })),
    metadata: { issue: 4712 },
  });

  // One payment a call: a single payment is the recount's own scope (#4095).
  const recount = await repairRefundedPaymentBusinessState({
    creditNoteId: null,
    creditNote: {},
    directPaymentIds: [paymentId],
    modificationRefundAmountsByPaymentId: new Map(),
  });
  if (recount.unsettledPaymentIds?.length) {
    result.needsAttention.push({ paymentId, reason: "the recount lost its claim twice to a concurrent writer" });
  }
  // An inbound sync of the note that read the link before it was retired
  // writes it back active (and recounts the note in again).
  const reactivated = await prisma.xeroObjectLink.count({ where: { id: { in: retired.map((candidate) => candidate.linkId) }, active: true } });
  if (reactivated > 0) {
    result.needsAttention.push({ paymentId, reason: "a concurrent inbound sync made a retired link active again; run the repair again" });
  }
  const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmountCents: true } });
  result.recounted.push({
    paymentId,
    bookingId: firstRetired.bookingId,
    refundedBeforeCents: before.refundedAmountCents,
    refundedAfterCents: after.refundedAmountCents,
  });
}

function describeCandidate(candidate: AccountNoteLinkCandidate) {
  return `- payment ${candidate.paymentId} (booking ${candidate.bookingId}): link ${candidate.linkId} to credit note ${candidate.creditNoteNumber ?? candidate.creditNoteId} (${candidate.creditNoteId})`;
}

export function formatAppliedCreditAccountNoteLinkReport(report: AccountNoteLinkRepairReport): string {
  return [
    `${report.raisedForPayment} active account-credit note link(s) were raised for their payment and are left alone.`,
    `${report.stale.length} stale link(s): the note was applied to the payment's booking, never raised for it. --apply retires these:`,
    ...report.stale.map(describeCandidate),
    `${report.conflicting.length} conflicting link(s): raised for the payment AND applied to its booking, so the booking's own cancellation note may have been completed with this one. Never retired by this repair; check them in Xero by hand:`,
    ...report.conflicting.map(describeCandidate),
    `${report.unexplained.length} unexplained link(s): neither raised for nor applied to the payment's booking. Never retired by this repair; check them by hand:`,
    ...report.unexplained.map(describeCandidate),
  ].join("\n");
}

export function formatAppliedCreditAccountNoteLinkApply(result: AccountNoteLinkRepairApplyResult, format: ClubFormat): string {
  return [
    `Retired ${result.retired.length} link(s) on ${result.recounted.length} payment(s).`,
    ...result.recounted.map(
      (entry) =>
        `- payment ${entry.paymentId} (booking ${entry.bookingId}): refunded total ${formatCents(entry.refundedBeforeCents, format)} -> ${formatCents(entry.refundedAfterCents, format)}. Next: pnpm run xero:booking-repair --booking ${entry.bookingId} --dry-run`
    ),
    ...result.notStale.map((entry) => `Left alone: payment ${entry.paymentId} - ${entry.reason}.`),
    ...result.needsAttention.map((entry) => `Needs a look: payment ${entry.paymentId} - ${entry.reason}.`),
  ].join("\n");
}
