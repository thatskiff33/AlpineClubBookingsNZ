"use client";

import { useEffect, useState } from "react";

import { useClubFormat } from "@/components/club-format-provider";
import type { EditReviewStillOwedPreview } from "@/lib/edit-financial-review-still-owed";
import { stillOwedNoticeText } from "@/lib/manual-refund-task-copy";

/**
 * #3835: on the settle dialog of a financial review, what the typed share will
 * actually give back when the booking was cancelled first - asked of the
 * server (`previewEditReviewStillOwed`, the completion's own rule) whenever the
 * share changes, so the officer hands back the netted amount BEFORE completing.
 *
 * `shareCents` is null until a refund-to-member amount above zero is typed;
 * nothing is asked or shown then. Permanently mounted and empty when there is
 * nothing to say, as the zero-amount refusal beside it is, so the live region
 * is announced when it fills.
 */
export function ManualRefundTaskStillOwedNotice({ taskId, shareCents }: { taskId: string; shareCents: number | null }) {
  const format = useClubFormat();
  const [preview, setPreview] = useState<EditReviewStillOwedPreview | null>(null);

  useEffect(() => {
    setPreview(null);
    if (shareCents === null || shareCents <= 0) return;
    // A GET with no init, and a stale answer is dropped rather than aborted.
    let current = true;
    fetch(`/api/admin/payments/manual-refund-tasks/${encodeURIComponent(taskId)}/still-owed?shareCents=${shareCents}`)
      .then(async (response) => (response.ok ? ((await response.json()) as { preview?: EditReviewStillOwedPreview | null }) : null))
      .then((body) => {
        if (current) setPreview(body?.preview ?? null);
      })
      // Advice only: a failed read leaves the dialog as it was, and the
      // completion still settles the netted figure.
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [taskId, shareCents]);

  const text = stillOwedNoticeText(preview, format);
  return (
    <p
      aria-live="polite"
      className="text-sm font-medium text-warning-11"
      {...(text ? { "data-testid": "manual-refund-task-still-owed" } : {})}
    >
      {text ?? ""}
    </p>
  );
}
