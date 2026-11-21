"use client";

import { useState, useEffect } from "react";

/**
 * What the Communications page loads on mount: the club's hourly bulk-send
 * limit, shown in the compose card and the confirmation. The send history
 * reads its own pages (`SendHistoryCard`).
 */
export function useCommunicationsData() {
  const [bulkSendLimit, setBulkSendLimit] = useState<number>(1);

  useEffect(() => {
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
    void fetchRateLimit();
  }, []);

  return { bulkSendLimit };
}
