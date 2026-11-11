"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { parseSignedDecimalDollarsToCents } from "@/lib/money-input";
import type {
  CreditHistoryItem,
  PendingCreditAdjustmentItem,
} from "../_types";

export function useMemberCredits(id: string) {
  const [creditBalance, setCreditBalance] = useState<number>(0);
  const [creditHistory, setCreditHistory] = useState<CreditHistoryItem[]>([]);
  const [pendingAdjustmentRequests, setPendingAdjustmentRequests] = useState<
    PendingCreditAdjustmentItem[]
  >([]);
  const [creditLoading, setCreditLoading] = useState(true);
  const [creditError, setCreditError] = useState("");
  const [showAdjustmentForm, setShowAdjustmentForm] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentDescription, setAdjustmentDescription] = useState("");
  const [adjustmentIdempotencyKey, setAdjustmentIdempotencyKey] = useState<
    string | null
  >(null);
  const [adjustmentSaving, setAdjustmentSaving] = useState(false);
  const [adjustmentError, setAdjustmentError] = useState("");
  const [reviewingAdjustmentId, setReviewingAdjustmentId] = useState<
    string | null
  >(null);

  const fetchCredits = async () => {
    setCreditLoading(true);
    setCreditError("");
    try {
      const res = await fetch(`/api/admin/members/${id}/credits`);
      if (!res.ok) {
        setCreditError("Failed to load credits");
        return;
      }
      const data = await res.json();
      setCreditBalance(data.balanceCents);
      setCreditHistory(data.history);
      setPendingAdjustmentRequests(data.pendingRequests ?? []);
    } catch {
      setCreditError("Failed to load credits");
    } finally {
      setCreditLoading(false);
    }
  };

  const handleAdjustmentSubmit = async () => {
    /*
      #2685: the exact parser, and the SIGNED one — a credit adjustment can be a
      debit, so "-25.00" is a real amount here. `parseFloat` used to accept a
      malformed entry like "25x" as $25.00 and turn anything it could not read
      at all into a bare "Enter a non-zero amount", which reads as though the
      admin typed a zero rather than a typo.
    */
    const cents = parseSignedDecimalDollarsToCents(adjustmentAmount);
    if (cents === null) {
      setAdjustmentError(
        "Enter an amount in dollars and cents, for example 25.00 (or -25.00 to take credit away)",
      );
      return;
    }
    if (cents === 0) {
      setAdjustmentError("Enter a non-zero amount");
      return;
    }
    if (!adjustmentDescription.trim()) {
      setAdjustmentError("Description is required");
      return;
    }
    const idempotencyKey = adjustmentIdempotencyKey ?? crypto.randomUUID();
    if (!adjustmentIdempotencyKey) {
      setAdjustmentIdempotencyKey(idempotencyKey);
    }
    setAdjustmentSaving(true);
    setAdjustmentError("");
    try {
      const res = await fetch(`/api/admin/members/${id}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents: cents,
          description: adjustmentDescription.trim(),
          idempotencyKey,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to save adjustment");
      }
      setShowAdjustmentForm(false);
      setAdjustmentAmount("");
      setAdjustmentDescription("");
      setAdjustmentIdempotencyKey(null);
      toast.success(data.message || "Credit adjustment submitted for approval");
      await fetchCredits();
    } catch (err) {
      setAdjustmentError(
        err instanceof Error ? err.message : "Failed to save adjustment",
      );
    } finally {
      setAdjustmentSaving(false);
    }
  };

  const toggleAdjustmentForm = () => {
    setAdjustmentError("");
    setAdjustmentIdempotencyKey(
      showAdjustmentForm ? null : crypto.randomUUID(),
    );
    setShowAdjustmentForm((current) => !current);
  };

  const handleReviewAdjustmentRequest = async (
    requestId: string,
    decision: "APPROVE" | "REJECT",
  ) => {
    setReviewingAdjustmentId(requestId);
    setAdjustmentError("");
    try {
      const res = await fetch(`/api/admin/members/${id}/credits/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to review adjustment");
      }

      const data = await res.json();
      toast.success(data.message || "Adjustment reviewed");
      await fetchCredits();
    } catch (err) {
      setAdjustmentError(
        err instanceof Error ? err.message : "Failed to review adjustment",
      );
    } finally {
      setReviewingAdjustmentId(null);
    }
  };

  useEffect(() => {
    fetchCredits();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    creditBalance,
    creditHistory,
    pendingAdjustmentRequests,
    creditLoading,
    creditError,
    showAdjustmentForm,
    adjustmentAmount,
    adjustmentDescription,
    adjustmentSaving,
    adjustmentError,
    reviewingAdjustmentId,
    setAdjustmentAmount,
    setAdjustmentDescription,
    toggleAdjustmentForm,
    handleAdjustmentSubmit,
    handleReviewAdjustmentRequest,
  };
}
