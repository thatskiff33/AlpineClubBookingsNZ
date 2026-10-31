/**
 * #4531 (`INV-INT-031`): the one-off backfill for payment links whose Xero
 * payment was deleted before the inbound reconcile learned to retire them.
 *
 * Report-only by default. It lists the payments Xero itself reports DELETED
 * (`GET /Payments?where=Status=="DELETED"`, a page per 100, the status checked
 * again on every row) and names each ACTIVE local payment link that points at
 * one. `--apply` asks Xero about each such payment once more
 * (`confirmXeroPaymentDeleted`, the inbound reconcile's own check) and retires
 * only a confirmed DELETED one, through the inbound reconcile's own guarded
 * write. Every call spends the daily budget only below the usage panel's
 * "critical" threshold, so a run stopped short says so and can be run again.
 * Runbook: docs/MAINTENANCE.md, "Retire links to payments deleted in Xero".
 */
import { prisma } from "@/lib/prisma";
import { callXeroApi, XeroDailyLimitError, XeroTransientOutageError, type getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { xeroDailyBudgetAllowsDeferrableCall } from "@/lib/xero-api-usage";
import {
  confirmXeroPaymentDeleted,
  DELETED_PAYMENT_LINK_SELECT,
  retireDeletedXeroPaymentLink,
  type DeletedPaymentLinkRow,
} from "@/lib/xero-inbound/deleted-payment-links";
import { DELETED_XERO_PAYMENT_STATUS, isDeletedXeroPaymentStatus } from "@/lib/xero-inbound/object-links";
import { writeXeroInboundAuditLogs } from "@/lib/xero-inbound/audit";

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
            undefined,
            page,
            DELETED_PAYMENT_LIST_PAGE_SIZE,
          ),
        {
          operation: "getPayments",
          resourceType: "PAYMENT",
          workflow: "xeroDeletedPaymentLinkBackfill",
          context: `xeroDeletedPaymentLinkBackfill(page ${page})`,
        },
      );
      payments = response.body.payments ?? [];
    } catch (err) {
      if (err instanceof XeroDailyLimitError || err instanceof XeroTransientOutageError) {
        if (!err.preHttp) calls += 1;
        break;
      }
      throw err;
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

/** The dry run: every active payment link whose payment Xero lists as DELETED. */
export async function findDeletedPaymentLinkBackfill(
  session: XeroClientSession,
  scope?: { paymentIds?: string[] },
): Promise<DeletedPaymentBackfillReport> {
  const listed = await listDeletedXeroPaymentIds(session);
  const wanted = scope?.paymentIds?.length ? new Set(scope.paymentIds) : null;
  const ids = [...listed.ids].filter((id) => !wanted || wanted.has(id));
  const rows =
    ids.length === 0
      ? []
      : await prisma.xeroObjectLink.findMany({
          where: { xeroObjectType: "PAYMENT", active: true, xeroObjectId: { in: ids } },
          select: DELETED_PAYMENT_LINK_SELECT,
          orderBy: [{ xeroObjectId: "asc" }, { id: "asc" }],
        });
  const byPayment = new Map<string, DeletedPaymentLinkRow[]>();
  for (const row of rows) {
    byPayment.set(row.xeroObjectId, [...(byPayment.get(row.xeroObjectId) ?? []), row]);
  }
  return {
    listedDeletedPayments: listed.ids.size,
    pagesRead: listed.pagesRead,
    listComplete: listed.complete,
    xeroCalls: listed.calls,
    candidates: [...byPayment].map(([paymentId, links]) => ({ paymentId, links })),
  };
}

/** `--apply`: retire the candidates' links whose payment Xero confirms DELETED once more. */
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
    retiredLinks: 0,
  };
  const retired: DeletedPaymentLinkRow[] = [];
  let stop = false;
  for (const candidate of report.candidates) {
    if (stop) {
      result.deferred.push(candidate.paymentId);
      continue;
    }
    const { confirmation, called } = await confirmXeroPaymentDeleted(session, candidate.paymentId, {
      workflow: "xeroDeletedPaymentLinkBackfill",
    });
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
        if (await retireDeletedXeroPaymentLink(link)) retired.push(link);
      }
    }
  }
  result.retiredLinks = retired.length;
  await writeXeroInboundAuditLogs({
    source: DELETED_PAYMENT_BACKFILL_AUDIT_SOURCE,
    links: retired.map((link) => ({
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: "PAYMENT",
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      role: link.role,
    })),
    metadata: { status: DELETED_XERO_PAYMENT_STATUS },
  });
  return result;
}

function linkDocument(metadata: unknown): string {
  const record = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  if (typeof record.invoiceId === "string") return `invoice ${record.invoiceId}`;
  if (typeof record.creditNoteId === "string") return `credit note ${record.creditNoteId}`;
  return "no document recorded";
}

export function formatDeletedPaymentLinkBackfillReport(report: DeletedPaymentBackfillReport): string {
  const lines = [
    `Xero lists ${report.listedDeletedPayments} deleted payment(s) (${report.pagesRead} page(s), ${report.xeroCalls} call(s)).`,
    report.listComplete
      ? "The list is complete."
      : "The list stopped early (daily budget, Xero's daily limit or the page bound): run again later for the rest.",
    `${report.candidates.length} of them still have an active link here:`,
  ];
  for (const candidate of report.candidates) {
    lines.push(`- payment ${candidate.paymentId} (Xero: DELETED)`);
    for (const link of candidate.links) {
      lines.push(`    link ${link.id}: ${link.localModel} ${link.localId}, ${link.role}, ${linkDocument(link.metadata)}`);
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
  ].join("\n");
}
