"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface CancelPreview {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  creditRestoredCents: number;
  totalPaidCents: number;
  hasPayment: boolean;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function CancelBookingButton({ bookingId }: { bookingId: string }) {
  const [step, setStep] = useState<"idle" | "loading" | "preview" | "cancelling" | "success" | "error">("idle");
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [result, setResult] = useState<{ refundAmountCents: number; refundMethod: string; creditAmountCents?: number; creditRestoredCents?: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [refundMethod, setRefundMethod] = useState<"card" | "credit">("card");
  const router = useRouter();

  async function handleShowPreview() {
    setStep("loading");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel-preview`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to load cancellation details");
        setStep("error");
        return;
      }
      const data: CancelPreview = await res.json();
      setPreview(data);
      setRefundMethod("card");
      setStep("preview");
    } catch {
      setErrorMsg("Failed to load cancellation details");
      setStep("error");
    }
  }

  async function handleConfirmCancel() {
    setStep("cancelling");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refundMethod }),
      });
      if (res.ok) {
        const data = await res.json();
        setResult({
          refundAmountCents: data.refundAmountCents || 0,
          refundMethod: data.refundMethod || "card",
          creditAmountCents: data.creditAmountCents,
          creditRestoredCents: data.creditRestoredCents,
        });
        setStep("success");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to cancel booking");
        setStep("error");
      }
    } catch {
      setErrorMsg("Failed to cancel booking");
      setStep("error");
    }
  }

  if (step === "idle") {
    return (
      <Button variant="destructive" onClick={handleShowPreview}>
        Cancel Booking
      </Button>
    );
  }

  if (step === "loading") {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm text-slate-500">Loading cancellation details...</p>
      </div>
    );
  }

  if (step === "success") {
    const refund = result?.refundAmountCents || 0;
    const isCredit = result?.refundMethod === "credit";
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-1">
        <p className="text-sm font-medium text-green-800">Booking cancelled successfully</p>
        {result?.creditRestoredCents && result.creditRestoredCents > 0 && (
          <p className="text-sm text-green-700">
            {formatDollars(result.creditRestoredCents)} of previously applied credit has been restored to your account.
          </p>
        )}
        {refund > 0 && isCredit ? (
          <p className="text-sm text-green-700">
            A credit of {formatDollars(refund)} has been added to your account for future bookings.
          </p>
        ) : refund > 0 ? (
          <p className="text-sm text-green-700">
            Your refund of {formatDollars(refund)} has been processed to your original payment method. You will receive a confirmation email shortly.
          </p>
        ) : (
          <p className="text-sm text-green-700">
            You will receive a confirmation email shortly.
          </p>
        )}
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-2">
        <p className="text-sm text-red-700">{errorMsg}</p>
        <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
          Try Again
        </Button>
      </div>
    );
  }

  // Preview step
  if (step === "preview" && preview) {
    const hasRefund = preview.refundAmountCents > 0 || preview.creditRefundAmountCents > 0;

    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
        <p className="text-sm font-medium text-red-800">Cancellation Summary</p>

        {!preview.hasPayment ? (
          <p className="text-sm text-slate-700">
            No payment has been taken for this booking. No refund applies.
          </p>
        ) : !hasRefund ? (
          <p className="text-sm text-slate-700">
            No refund applies per cancellation policy.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            {/* Refund method selection */}
            <div className="space-y-2">
              <p className="font-medium text-slate-700">Choose refund method:</p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="refundMethod"
                  value="card"
                  checked={refundMethod === "card"}
                  onChange={() => setRefundMethod("card")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-slate-800">
                    Refund {formatDollars(preview.refundAmountCents)} to original payment method
                  </span>
                  <span className="text-slate-500 ml-1">({preview.refundPercentage}% refund)</span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="refundMethod"
                  value="credit"
                  checked={refundMethod === "credit"}
                  onChange={() => setRefundMethod("credit")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-green-700">
                    Hold {formatDollars(preview.creditRefundAmountCents)} as account credit
                  </span>
                  <span className="text-slate-500 ml-1">({preview.creditRefundPercentage}% refund)</span>
                  {preview.creditRefundAmountCents > preview.refundAmountCents && (
                    <span className="ml-1 text-xs text-green-600 font-medium">
                      +{formatDollars(preview.creditRefundAmountCents - preview.refundAmountCents)} more
                    </span>
                  )}
                </span>
              </label>
            </div>

            {/* Amount summary */}
            <div className="border-t border-red-100 pt-2 space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-600">
                  {refundMethod === "credit" ? "Credit to account:" : "Refund to card:"}
                </span>
                <span className="font-medium text-green-700">
                  {formatDollars(
                    refundMethod === "credit"
                      ? preview.creditRefundAmountCents
                      : preview.refundAmountCents
                  )}
                </span>
              </div>
              {preview.keptAmountCents > 0 && refundMethod === "card" && (
                <div className="flex justify-between">
                  <span className="text-slate-600">
                    Amount kept ({preview.refundPercentage}% refund):
                  </span>
                  <span className="font-medium text-slate-700">{formatDollars(preview.keptAmountCents)}</span>
                </div>
              )}
              {preview.changeFeeCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Change fees (non-refundable):</span>
                  <span className="font-medium text-slate-700">{formatDollars(preview.changeFeeCents)}</span>
                </div>
              )}
              {preview.creditRestoredCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Previously applied credit restored:</span>
                  <span className="font-medium text-green-700">{formatDollars(preview.creditRestoredCents)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirmCancel}
          >
            Confirm Cancellation
          </Button>
          <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
            Keep Booking
          </Button>
        </div>
      </div>
    );
  }

  // Cancelling state
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-500">Cancelling booking...</p>
    </div>
  );
}
