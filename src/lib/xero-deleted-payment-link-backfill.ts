/**
 * #4531 (`INV-INT-031`): the one-off backfill for payment links whose Xero
 * payment was deleted before the inbound reconcile learned to retire them.
 *
 * Report-only by default: it changes no link (its Xero calls still record usage
 * rows). It lists the payments Xero itself reports DELETED
 * (`GET /Payments?where=Status=="DELETED"`, oldest change first, a page per
 * 100, the status checked again on every row) and names each ACTIVE local
 * payment link that points at one. With `--payment` it asks Xero about just
 * those payments (`GET /Payments/{id}`) instead of listing. `--apply` retires
 * only payments Xero confirms DELETED (`confirmXeroPaymentDeleted`, the inbound
 * reconcile's own check): each listed candidate is asked about once more, and
 * a `--payment` id's direct answer is that confirmation. It writes through the
 * inbound reconcile's own guarded write. Every call is one attempt and spends
 * the daily budget only below the usage panel's "critical" threshold, so a run
 * stopped short says so; a re-run lists again from the start.
 * Runbook: docs/MAINTENANCE.md, "Retire links to payments deleted in Xero".
 */
import { prisma } from "@/lib/prisma";
import { callXeroApi, type getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { xeroDailyBudgetAllowsDeferrableCall } from "@/lib/xero-api-usage";
import {
  auditRetiredPaymentLinks,
  confirmXeroPaymentDeleted,
  DEFERRABLE_XERO_READ,
  deferrableXeroFailure,
  DELETED_PAYMENT_LINK_SELECT,
  documentNamedByLink,
  groupByPayment,
  holdBackIfEveryLinkBlocked,
  retireDeletedXeroPaymentLink,
  type DeletedPaymentLinkRow,
} from "@/lib/xero-inbound/deleted-payment-links";
import { isDeletedXeroPaymentStatus } from "@/lib/xero-inbound/object-links";

type XeroClientSession = Awaited<ReturnType<typeof getAuthenticatedXeroClient>>;

export const DELETED_PAYMENT_LIST_PAGE_SIZE = 100;
/** Bounds one run's list calls; a larger organisation reports the list incomplete. */
export const DELETED_PAYMENT_LIST_MAX_PAGES = 50;
export const DELETED_PAYMENT_BACKFILL_AUDIT_SOURCE = "xero-deleted-payment-link-backfill";

export type DeletedPaymentBackfillCandidate = {
  paymentId: string;
  links: DeletedPaymentLinkRow[];
};

export type DeletedPaymentBackfillReport = {
  /** "list": Xero's DELETED list was paged; "direct": each `--payment` id was asked about. */
  source: "list" | "direct";
  listedDeletedPayments: number;
  pagesRead: number;
  /** False when the list stopped early: the budget, Xero's daily limit, or the page bound. */
  listComplete: boolean;
  xeroCalls: number;
  candidates: DeletedPaymentBackfillCandidate[];
};

export type DeletedPaymentBackfillApplyResult = {
  report: DeletedPaymentBackfillReport;
  xeroCalls: number;
  confirmedDeleted: string[];
  confirmedLive: string[];
  unconfirmed: string[];
  deferred: string[];
  /** Payments with a link held back by an operation on its record that may still run; marked for the scheduled re-check. */
  blocked: string[];
  retiredLinks: number;
};

async function listDeletedXeroPaymentIds(session: XeroClientSession) {
  const ids = new Set<string>();
  let pagesRead = 0;
  let calls = 0;
  let complete = false;
  for (let page = 1; page <= DELETED_PAYMENT_LIST_MAX_PAGES; page += 1) {
    if (!(await xeroDailyBudgetAllowsDeferrableCall())) break;
    let payments: Array<{ paymentID?: string; status?: unknown }>;
    try {
      const response = await callXeroApi(
        () =>
          session.xero.accountingApi.getPayments(
            session.tenantId,
            undefined,
            'Status=="DELETED"',
            // Oldest change first, so a payment deleted mid-run lands on a later page.
            "UpdatedDateUTC ASC",
            page,
            DELETED_PAYMENT_LIST_PAGE_SIZE,
          ),
        {
          operation: "getPayments",
          resourceType: "PAYMENT",
          workflow: "xeroDeletedPaymentLinkBackfill",
          context: `xeroDeletedPaymentLinkBackfill(page ${page})`,
          ...DEFERRABLE_XERO_READ,
        },
      );
      payments = response.body.payments ?? [];
    } catch (err) {
      const deferrable = deferrableXeroFailure(err);
      if (!deferrable) throw err;
      if (deferrable.called) calls += 1;
      break;
    }
    calls += 1;
    pagesRead += 1;
    for (const payment of payments) {
      // The filter is Xero's; the status is checked here as well, so a filter
      // Xero ignored can never make a live payment a candidate.
      if (payment.paymentID && isDeletedXeroPaymentStatus(payment.status)) ids.add(payment.paymentID);
    }
    if (payments.length < DELETED_PAYMENT_LIST_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  return { ids, pagesRead, calls, complete };
}

/** `--payment`: ask Xero about just these payments, keeping those it confirms DELETED. */
async function confirmNamedDeletedPayments(session: XeroClientSession, paymentIds: string[]) {
  const ids = new Set<string>();
  let calls = 0;
  let complete = true;
  for (const paymentId of [...new Set(paymentIds)]) {
    const { confirmation, called } = await confirmXeroPaymentDeleted(session, paymentId, {
      workflow: "xeroDeletedPaymentLinkBackfill",
    });
    if (called) calls += 1;
    if (confirmation === "DEFERRED") {
      complete = false;
      break;
    }
    if (confirmation === "DELETED") ids.add(paymentId);
  }
  return { ids, pagesRead: 0, calls, complete };
}

/** The dry run: every active payment link whose payment Xero reports DELETED. */
export async function findDeletedPaymentLinkBackfill(
  session: XeroClientSession,
  scope?: { paymentIds?: string[] },
): Promise<DeletedPaymentBackfillReport> {
  const direct = Boolean(scope?.paymentIds?.length);
  const listed = direct
    ? await confirmNamedDeletedPayments(session, scope!.paymentIds!)
    : await listDeletedXeroPaymentIds(session);
  const ids = [...listed.ids];
  const rows =
    ids.length === 0
      ? []
      : await prisma.xeroObjectLink.findMany({
          where: { xeroObjectType: "PAYMENT", active: true, xeroObjectId: { in: ids } },
          select: DELETED_PAYMENT_LINK_SELECT,
          orderBy: [{ xeroObjectId: "asc" }, { id: "asc" }],
        });
  const byPayment = groupByPayment(rows);
  return {
    source: direct ? "direct" : "list",
    listedDeletedPayments: listed.ids.size,
    pagesRead: listed.pagesRead,
    listComplete: listed.complete,
    xeroCalls: listed.calls,
    candidates: [...byPayment].map(([paymentId, links]) => ({ paymentId, links })),
  };
}

/**
 * `--apply`: retire the candidates' links whose payment Xero confirms DELETED:
 * a listed candidate is asked about once more; a `--payment` id was already
 * asked directly, and that answer is its confirmation.
 */
export async function applyDeletedPaymentLinkBackfill(
  session: XeroClientSession,
  scope?: { paymentIds?: string[] },
): Promise<DeletedPaymentBackfillApplyResult> {
  const report = await findDeletedPaymentLinkBackfill(session, scope);
  const result: DeletedPaymentBackfillApplyResult = {
    report,
    xeroCalls: report.xeroCalls,
    confirmedDeleted: [],
    confirmedLive: [],
    unconfirmed: [],
    deferred: [],
    blocked: [],
    retiredLinks: 0,
  };
  const retired: DeletedPaymentLinkRow[] = [];
  let stop = false;
  for (const candidate of report.candidates) {
    if (stop) {
      result.deferred.push(candidate.paymentId);
      continue;
    }
    // Not while an operation on the link's record may still run and pay again.
    if (await holdBackIfEveryLinkBlocked(candidate.links)) {
      result.blocked.push(candidate.paymentId);
      continue;
    }
    const { confirmation, called } =
      report.source === "direct"
        ? { confirmation: "DELETED" as const, called: false }
        : await confirmXeroPaymentDeleted(session, candidate.paymentId, { workflow: "xeroDeletedPaymentLinkBackfill" });
    if (called) result.xeroCalls += 1;
    if (confirmation === "DEFERRED") {
      stop = true;
      result.deferred.push(candidate.paymentId);
    } else if (confirmation === "LIVE") {
      result.confirmedLive.push(candidate.paymentId);
    } else if (confirmation === "UNCONFIRMED") {
      result.unconfirmed.push(candidate.paymentId);
    } else {
      result.confirmedDeleted.push(candidate.paymentId);
      for (const link of candidate.links) {
        const outcome = await retireDeletedXeroPaymentLink(link);
        if (outcome === "retired") retired.push(link);
        else if (outcome === "blocked" && !result.blocked.includes(candidate.paymentId)) result.blocked.push(candidate.paymentId);
      }
    }
  }
  result.retiredLinks = retired.length;
  await auditRetiredPaymentLinks(DELETED_PAYMENT_BACKFILL_AUDIT_SOURCE, retired, {});
  return result;
}

function linkDocument(link: DeletedPaymentLinkRow): string {
  const document = documentNamedByLink(link);
  if (!document) return "no document recorded";
  return document.kind === "INVOICE" ? `invoice ${document.id}` : `credit note ${document.id}`;
}

export function formatDeletedPaymentLinkBackfillReport(report: DeletedPaymentBackfillReport): string {
  const lines = [
    report.source === "direct"
      ? `Xero confirms ${report.listedDeletedPayments} of the named payment(s) DELETED (${report.xeroCalls} call(s)).`
      : `Xero lists ${report.listedDeletedPayments} deleted payment(s) (${report.pagesRead} page(s), ${report.xeroCalls} call(s)).`,
    report.listComplete
      ? "The list is complete."
      : "The run stopped early (daily budget, a Xero rate limit or outage, or the page bound). Run it again later: it starts again from the beginning.",
    `${report.candidates.length} of them still have an active link here:`,
  ];
  for (const candidate of report.candidates) {
    lines.push(`- payment ${candidate.paymentId} (Xero: DELETED)`);
    for (const link of candidate.links) {
      lines.push(`    link ${link.id}: ${link.localModel} ${link.localId}, ${link.role}, ${linkDocument(link)}`);
    }
  }
  return lines.join("\n");
}

export function formatDeletedPaymentLinkBackfillApply(result: DeletedPaymentBackfillApplyResult): string {
  return [
    `Retired ${result.retiredLinks} link(s) of ${result.confirmedDeleted.length} payment(s) Xero confirmed DELETED (${result.xeroCalls} Xero call(s) in all).`,
    ...(result.confirmedLive.length ? [`Left active, Xero reports live: ${result.confirmedLive.join(", ")}`] : []),
    ...(result.unconfirmed.length ? [`Left active, not confirmed: ${result.unconfirmed.join(", ")}`] : []),
    ...(result.deferred.length ? [`Left for a later run (budget): ${result.deferred.join(", ")}`] : []),
    ...(result.blocked.length
      ? [`Left active, an operation on its record may still run (marked; re-checked automatically once it is done): ${result.blocked.join(", ")}`]
      : []),
  ].join("\n");
}
