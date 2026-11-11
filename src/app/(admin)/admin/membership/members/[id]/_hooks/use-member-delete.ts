"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { MemberDetail, MemberLifecycleActionRequest } from "../_types";

interface UseMemberDeleteParams {
  member: MemberDetail | null;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  onDeleted: () => void;
}

export function useMemberDelete({
  member,
  fetchMember,
  setLoading,
  onDeleted,
}: UseMemberDeleteParams) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteReviewDialog, setDeleteReviewDialog] = useState<{
    request: MemberLifecycleActionRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [deleteReviewNote, setDeleteReviewNote] = useState("");
  const [deleteReviewError, setDeleteReviewError] = useState("");
  const [deleteReviewSubmitting, setDeleteReviewSubmitting] = useState(false);

  const handleCreateDeleteRequest = async () => {
    if (!member) return;
    setDeleteSubmitting(true);
    setDeleteError("");
    try {
      const res = await fetch(
        `/api/admin/members/${member.id}/lifecycle/delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: deleteReason }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to create delete request");
      }

      setDeleteDialogOpen(false);
      setDeleteReason("");
      toast.success("Delete request submitted for second-admin review");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to create delete request",
      );
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const handleReviewDeleteRequest = async () => {
    if (!deleteReviewDialog) return;
    setDeleteReviewSubmitting(true);
    setDeleteReviewError("");
    try {
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests/${deleteReviewDialog.request.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: deleteReviewDialog.action,
            note: deleteReviewNote || undefined,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to review delete request");
      }

      setDeleteReviewDialog(null);
      setDeleteReviewNote("");
      toast.success(deleteReviewDialog.action === "approve"
          ? "Member deleted and snapshot retained"
          : "Delete request rejected",);
      if (deleteReviewDialog.action === "approve") {
        onDeleted();
        return;
      }
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setDeleteReviewError(
        err instanceof Error ? err.message : "Failed to review delete request",
      );
    } finally {
      setDeleteReviewSubmitting(false);
    }
  };

  return {
    deleteDialogOpen,
    deleteReason,
    deleteError,
    deleteSubmitting,
    deleteReviewDialog,
    deleteReviewNote,
    deleteReviewError,
    deleteReviewSubmitting,
    setDeleteDialogOpen,
    setDeleteReason,
    setDeleteError,
    setDeleteReviewDialog,
    setDeleteReviewNote,
    setDeleteReviewError,
    handleCreateDeleteRequest,
    handleReviewDeleteRequest,
  };
}
