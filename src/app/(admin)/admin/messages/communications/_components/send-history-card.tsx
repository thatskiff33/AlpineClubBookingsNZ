"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AdminLoadError } from "@/components/admin/admin-load-error";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import type { HistoryEntry } from "../_hooks/use-communications-data";

/** The "Send History" card: past bulk communications, newest first as served. */
export function SendHistoryCard({
  history,
  loading,
  loadError,
  onRetry,
}: {
  history: HistoryEntry[];
  loading: boolean;
  /** Why the history could not be read, or null when it was (#4961). */
  loadError: string | null;
  onRetry: () => void;
}) {
  // When a communication was sent — real INSTANTS, projected through the club's persisted zone rather
  // than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();

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
            onRetry={onRetry}
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
      </CardContent>
    </Card>
  );
}
