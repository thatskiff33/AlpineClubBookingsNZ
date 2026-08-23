"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { useClubTime } from "@/components/club-time-provider";

/**
 * Member-facing "Acknowledge" control, shown only for notices that require
 * acknowledgement. Posts to the acknowledge route (memberId comes from the
 * session server-side) and reflects the acknowledged state.
 */
/**
 * When the member acknowledged the notice.
 *
 * A real INSTANT, projected through the club's PERSISTED timezone (CT-4, #2870;
 * INV-CONFIG-002) rather than the container's `TZ`. `instantDate` keeps the
 * medium "16 Apr 2026" shape this line has always shown; only the zone's
 * AUTHORITY moved. The zone reaches this browser as data through
 * `ClubTimeProvider` - never from the viewer's own clock.
 */
function useAcknowledgedAtFormatter() {
  const clubTime = useClubTime();
  return (value: string) => clubTime.instantDate(new Date(value));
}

export function NoticeAcknowledgeButton({
  noticeId,
  acknowledged: initialAcknowledged,
  acknowledgedAt,
}: {
  noticeId: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
}) {
  const formatAcknowledgedAt = useAcknowledgedAtFormatter();
  const router = useRouter();
  const [acknowledged, setAcknowledged] = useState(initialAcknowledged);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (acknowledged) {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-medium text-success-11">
        <Check className="h-4 w-4" />
        Acknowledged
        {acknowledgedAt
          ? ` on ${formatAcknowledgedAt(acknowledgedAt)}`
          : ""}
      </p>
    );
  }

  const acknowledge = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/notices/${noticeId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        setError("Could not record your acknowledgement. Please try again.");
        return;
      }
      setAcknowledged(true);
      router.refresh();
    } catch {
      setError("Could not record your acknowledgement. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button onClick={acknowledge} disabled={submitting}>
        {submitting ? "Saving…" : "Acknowledge"}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
