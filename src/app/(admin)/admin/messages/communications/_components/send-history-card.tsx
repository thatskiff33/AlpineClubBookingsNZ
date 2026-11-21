"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AdminLoadError } from "@/components/admin/admin-load-error";
import { Pagination } from "@/components/admin/admin-pagination";
import { useAdminQueuePage } from "@/components/admin/use-admin-queue-page";
import { useClubTime } from "@/components/club-time-provider";
import { ADMIN_LOAD_FAILED_ERROR, ADMIN_LOAD_NETWORK_ERROR } from "@/lib/admin-query-error";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import { requireInstant } from "@/lib/club-time";

/** One row of the send history, as `/api/admin/communications/history` returns it. */
interface HistoryEntry {
  id: string;
  sentBy: string;
  subject: string;
  recipientFilter: string;
  totalRecipients: number;
  eligibleRecipients: number;
  queued: number;
  sentAt: string;
}

/**
 * The "Send History" card: past bulk communications, newest first as served,
 * one page at a time through the shared hook and pager (INV-OPS-020). A slower
 * read for a page left behind never replaces the one shown. `refreshVersion`
 * changes after a send: the card re-reads and returns to page 1, where the new
 * send is.
 */
export function SendHistoryCard({ refreshVersion }: { refreshVersion: number }) {
  // When a communication was sent — real INSTANTS, projected through the club's persisted zone rather
  // than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();

  const historyPage = useAdminQueuePage({ filterKey: "send-history" });
  const { page, setPage, receive, beginLoad } = historyPage;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // #4961: a failed history read is said, never shown as "No bulk
  // communications sent yet."
  const [loadError, setLoadError] = useState<string | null>(null);

  // A send lands on page 1, so a refresh from a later page goes back there.
  // Adjusted during render, so the read below runs once, for page 1.
  const [seenVersion, setSeenVersion] = useState(refreshVersion);
  if (seenVersion !== refreshVersion) {
    setSeenVersion(refreshVersion);
    if (page !== 1) setPage(1);
  }

  const fetchHistory = useCallback(async () => {
    const isCurrent = beginLoad();
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      const res = await fetch(`/api/admin/communications/history?${params}`);
      if (!isCurrent()) return; // a newer read owns the list
      if (res.ok) {
        const body = (await res.json()) as { history?: HistoryEntry[] };
        if (!isCurrent()) return;
        const rows = Array.isArray(body?.history) ? body.history : [];
        setHistory(rows);
        setLoadError(null);
        receive(body, rows.length);
      } else {
        const message = await apiErrorMessageFromResponse(res, ADMIN_LOAD_FAILED_ERROR);
        if (!isCurrent()) return;
        setHistory([]);
        setLoadError(message);
      }
    } catch {
      if (!isCurrent()) return;
      setHistory([]);
      setLoadError(ADMIN_LOAD_NETWORK_ERROR);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginLoad, receive, page]);

  // `refreshVersion` re-reads after a send even when the card is on page 1.
  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory, refreshVersion]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send History</CardTitle>
        <CardDescription>Previous bulk communications</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : loadError ? (
          <AdminLoadError
            title="Send history could not be loaded"
            message={loadError}
            onRetry={() => void fetchHistory()}
            data-testid="communications-history-load-error"
          />
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bulk communications sent yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Subject</th>
                  <th className="pb-2 pr-4">Filter</th>
                  <th className="pb-2 pr-4">Recipients</th>
                  <th className="pb-2">Sent</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id} className="border-b">
                    <td className="py-2 pr-4 text-muted-foreground">
                      {clubTime.instantDate(requireInstant(entry.sentAt))}
                    </td>
                    <td className="py-2 pr-4 font-medium">{entry.subject}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {entry.recipientFilter}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {entry.totalRecipients}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {entry.eligibleRecipients}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {historyPage.pagination ? (
          <Pagination
            {...historyPage.pagination}
            aria-label="Send history pages"
            className="mt-4"
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
