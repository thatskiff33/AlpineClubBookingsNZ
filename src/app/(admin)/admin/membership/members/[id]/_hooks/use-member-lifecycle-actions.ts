"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";

interface UseMemberLifecycleActionsParams {
  id: string;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

export function useMemberLifecycleActions({
  id,
  fetchMember,
  setLoading,
}: UseMemberLifecycleActionsParams) {
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveReviewNotes, setArchiveReviewNotes] = useState<
    Record<string, string>
  >({});
  const [archiveActionLoading, setArchiveActionLoading] = useState<
    string | null
  >(null);
  const [archiveError, setArchiveError] = useState("");
  const [cancellationReason, setCancellationReason] = useState("");
  const [cancellationSubmitting, setCancellationSubmitting] = useState(false);
  const [cancellationError, setCancellationError] = useState("");

  const handleSubmitArchiveRequest = async () => {
    const reason = archiveReason.trim();
    if (!reason) {
      setArchiveError("Archive reason is required");
      return;
    }

    setArchiveActionLoading("request");
    setArchiveError("");
    try {
      const res = await fetch(`/api/admin/members/${id}/lifecycle/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to request archive");
      }

      setArchiveReason("");
      toast.success("Archive request submitted");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setArchiveError(
        err instanceof Error ? err.message : "Failed to request archive",
      );
    } finally {
      setArchiveActionLoading(null);
    }
  };

  const handleReviewArchiveRequest = async (
    requestId: string,
    action: "approve" | "reject",
    // #1788: absent = notify (default), false = suppress the member email. Only
    // the two-button dialog passes an explicit value; a member with no email
    // reviews directly with no flag.
    notifyMember?: boolean,
  ) => {
    setArchiveActionLoading(`${action}:${requestId}`);
    setArchiveError("");
    try {
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests/${requestId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note: archiveReviewNotes[requestId]?.trim() || undefined,
            ...(notifyMember === undefined ? {} : { notifyMember }),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to review archive request");
      }

      setArchiveReviewNotes((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
      const baseMessage =
        action === "approve" ? "Member archived" : "Archive request rejected";
      toast.success(
        notifyMember === false
          ? `${baseMessage}. The member was not emailed.`
          : baseMessage,
      );
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setArchiveError(
        err instanceof Error ? err.message : "Failed to review archive request",
      );
    } finally {
      setArchiveActionLoading(null);
    }
  };

  const handleSubmitCancellationRequest = async () => {
    const reason = cancellationReason.trim();
    if (!reason) {
      setCancellationError("Cancellation reason is required");
      return;
    }

    setCancellationSubmitting(true);
    setCancellationError("");
    try {
      const res = await fetch(
        `/api/admin/members/${id}/membership-cancellation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to request cancellation");
      }

      setCancellationReason("");
      toast.success("Cancellation request submitted");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setCancellationError(
        err instanceof Error ? err.message : "Failed to request cancellation",
      );
    } finally {
      setCancellationSubmitting(false);
    }
  };

  return {
    archiveReason,
    archiveReviewNotes,
    archiveActionLoading,
    archiveError,
    cancellationReason,
    cancellationSubmitting,
    cancellationError,
    setArchiveReason,
    setArchiveReviewNotes,
    setCancellationReason,
    handleSubmitArchiveRequest,
    handleReviewArchiveRequest,
    handleSubmitCancellationRequest,
  };
}
