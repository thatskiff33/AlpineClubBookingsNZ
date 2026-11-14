"use client";

import { useState, useEffect } from "react";
import { ADMIN_LOAD_FAILED_ERROR, ADMIN_LOAD_NETWORK_ERROR } from "@/lib/admin-query-error";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";

/** One row of the send history, as `/api/admin/communications/history` returns it. */
export interface HistoryEntry {
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
 * What the Communications page loads on mount: the club's hourly bulk-send
 * limit (shown in the compose card and the confirmation) and the send history,
 * with the message to show when that read fails (#4961).
 * `refreshHistory` re-reads the history after a send.
 */
export function useCommunicationsData() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  // #4961: a failed history read is said, never shown as "No bulk
  // communications sent yet."
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [bulkSendLimit, setBulkSendLimit] = useState<number>(1);

  useEffect(() => {
    fetchRateLimit();
    fetchHistory();
  }, []);

  async function fetchRateLimit() {
    try {
      const res = await fetch("/api/admin/communications/send");
      if (!res.ok) return;
      const data = (await res.json()) as { limit?: number };
      if (typeof data.limit === "number" && data.limit > 0) {
        setBulkSendLimit(data.limit);
      }
    } catch {
      // ignore and keep fallback value
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch("/api/admin/communications/history");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.history);
        setHistoryLoadError(null);
      } else {
        setHistory([]);
        setHistoryLoadError(
          await apiErrorMessageFromResponse(res, ADMIN_LOAD_FAILED_ERROR),
        );
      }
    } catch {
      setHistory([]);
      setHistoryLoadError(ADMIN_LOAD_NETWORK_ERROR);
    } finally {
      setLoadingHistory(false);
    }
  }

  return {
    history,
    loadingHistory,
    historyLoadError,
    bulkSendLimit,
    refreshHistory: fetchHistory,
  };
}
