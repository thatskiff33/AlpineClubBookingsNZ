"use client";

import Link from "next/link";
import { RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { FocusedActionError } from "@/components/focused-action-error";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActionFailure } from "@/hooks/use-action-failure";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useXeroOrgShortCode } from "@/hooks/use-xero-org-short-code";
import { adminHref } from "@/lib/admin-hubs";
import { apiErrorMessageFromBody, readApiObjectOrEmpty } from "@/lib/api-error-message";
import { formatStayDateOrNull, requireInstant } from "@/lib/club-time";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { formatCents } from "@/lib/utils";
import { buildXeroContactUrl } from "@/lib/xero-links";
import type { XeroCashCreditQueue, XeroCashCreditQueueRow } from "@/lib/xero-cash-credits";

/** What `GET /api/admin/xero/cash-credits` sends: the server's own shapes, with the instant as JSON text. */
type QueueRow = XeroCashCreditQueueRow;
type Queue = Omit<XeroCashCreditQueue, "refreshedAt"> & { refreshedAt: string | null };

const KIND_LABEL: Record<QueueRow["kind"], string> = { OVERPAYMENT: "Overpayment", PREPAYMENT: "Prepayment" };

/**
 * #5204: money a contact paid the club in Xero that no invoice has taken yet.
 * Read-only in this release: finance sees each document and who it belongs to,
 * and finance edit can refresh the list from Xero. Nothing here turns one into
 * credit.
 */
export default function XeroUnallocatedPaymentsPage() {
  const format = useClubFormat();
  const clubTime = useClubTime();
  const canEdit = useAdminAreaEditAccess("finance");
  const { shortCode } = useXeroOrgShortCode(true);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const { error: actionError, attentionKey, fail: failAction, clear: clearActionError } = useActionFailure();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/xero/cash-credits");
      const body = await readApiObjectOrEmpty(res);
      if (!res.ok) throw new Error(apiErrorMessageFromBody(body, "Could not load unallocated payments."));
      setQueue(body as unknown as Queue);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load unallocated payments.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshStatus(null);
    clearActionError();
    try {
      const res = await fetch("/api/admin/xero/cash-credits", { method: "POST" });
      const body = await readApiObjectOrEmpty(res);
      if (!res.ok) {
        failAction(apiErrorMessageFromBody(body, "Could not refresh from Xero."));
        return;
      }
      setQueue(body.queue as Queue);
      setRefreshStatus("Refreshed from Xero.");
    } catch {
      // The server may have saved the refresh before the reply was lost (#2668).
      failAction(unverifiedWriteMessage("the refresh from Xero was saved", "Reload the page to see the list as it is now."));
    } finally {
      setRefreshing(false);
    }
  }, [clearActionError, failAction]);

  return (
    <div>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6" />
      <div className="space-y-6">
        <AdminPageHeader
          title="Xero Unallocated Payments"
          description="Overpayments and prepayments in Xero that no invoice has used yet, with the member each one belongs to."
          actions={
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw className={`mr-1 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing…" : "Refresh from Xero"}
            </ViewOnlyActionButton>
          }
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Last refreshed:</span>
          <span className="text-muted-foreground">
            {queue?.refreshedAt
              ? clubTime.instantDateTime(requireInstant(queue.refreshedAt))
              : queue
                ? "never. The list fills on the nightly refresh, or when you refresh from Xero."
                : "…"}
          </span>
        </div>
        {refreshStatus ? <p className="text-sm text-success" role="status">{refreshStatus}</p> : null}
        {loadError ? <p className="text-sm text-danger" role="alert">{loadError}</p> : null}
        <FocusedActionError id="xero-unallocated-payments-action-error" error={actionError} attentionKey={attentionKey} />

        {queue && queue.rows.length === 0 ? (
          <EmptyState icon={Wallet} title="No unallocated payments" description="Xero showed no overpayment or prepayment with a balance left at the last refresh." />
        ) : queue ? (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Member</TableHead>
                    <TableHead>Xero</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{KIND_LABEL[row.kind]}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatStayDateOrNull(row.documentDate, format) ?? "No date"}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <span className="font-medium">{formatCents(row.remainingCents, format)}</span>
                        {row.currencyCode !== format.currencyCode ? (
                          // Xero holds the cents in the document's own currency.
                          <span className="block text-xs text-warning">in {row.currencyCode}</span>
                        ) : null}
                        {row.remainingCents !== row.totalCents ? (
                          <span className="block text-xs text-muted-foreground">of {formatCents(row.totalCents, format)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {row.member ? (
                          <Link href={adminHref("member-detail", { id: row.member.id })} className="text-primary hover:underline">
                            {row.member.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">No member linked</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {/* Xero documents no web address for an overpayment or prepayment;
                            the contact's page lists it. */}
                        <a href={buildXeroContactUrl(row.xeroContactId, { shortCode })} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          Open contact in Xero
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
