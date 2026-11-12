"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";
import { useConfirm } from "@/components/confirm-dialog";

type DeleteBookingMode = "draft" | "cancelled";

type DeleteBookingResponse = {
  error?: string;
  blockers?: Array<{ code: string; label: string; count: number }>;
};

export function DeleteBookingButton({
  bookingId,
  mode,
  returnHref,
}: {
  bookingId: string;
  mode: DeleteBookingMode;
  returnHref: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<
    Array<{ code: string; label: string; count: number }>
  >([]);
  const [deleting, setDeleting] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const requiresReason = mode === "cancelled";

  async function handleDelete() {
    setError(null);
    setBlockers([]);

    if (requiresReason && reason.trim().length < 3) {
      setError("Enter a deletion reason.");
      return;
    }

    if (
      mode === "draft" &&
      !(await confirm({
        title: "Delete this draft booking?",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }

    setDeleting(true);
    try {
      const response = await fetch(`/api/bookings/${bookingId}`, {
        method: "DELETE",
        headers: requiresReason ? { "Content-Type": "application/json" } : undefined,
        body: requiresReason ? JSON.stringify({ reason }) : undefined,
      });
      const body = (await response.json().catch(() => ({}))) as DeleteBookingResponse;

      if (!response.ok) {
        setError(body.error ?? "Failed to delete booking");
        setBlockers(body.blockers ?? []);
        return;
      }

      router.push(returnHref);
      router.refresh();
    } catch {
      setError("Failed to delete booking");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-danger-6 bg-danger-3 p-4">
      {confirmDialog}
      {requiresReason ? (
        <div className="space-y-1">
          <label
            htmlFor="delete-booking-reason"
            className="text-sm font-medium text-danger-11"
          >
            Deletion reason
          </label>
          <textarea
            id="delete-booking-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-20 w-full rounded-md border border-danger-6 bg-card px-3 py-2 text-sm shadow-sm"
            maxLength={500}
          />
        </div>
      ) : null}

      <FocusedActionError id={`delete-booking-${bookingId}-error`} error={error ?? ""} />
      {blockers.length > 0 ? (
        <ul className="space-y-1 text-sm text-danger-11">
          {blockers.map((blocker) => (
            <li key={blocker.code}>
              {blocker.label} ({blocker.count})
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={handleDelete}
        disabled={deleting || (requiresReason && reason.trim().length < 3)}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {deleting
          ? "Deleting..."
          : mode === "draft"
            ? "Delete Draft"
            : "Delete Cancelled Booking"}
      </Button>
    </div>
  );
}
