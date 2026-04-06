"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatCents } from "@/lib/utils";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";

interface QuoteResult {
  newTotalPriceCents: number;
  newDiscountCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  changeFeeCents: number;
  capacityAvailable: boolean;
  promoStillValid: boolean;
  nightDetails?: { date: string; availableBeds: number }[];
}

interface ChangeDatesDialogProps {
  bookingId: string;
  currentCheckIn: string;
  currentCheckOut: string;
  currentFinalPriceCents: number;
}

export function ChangeDatesDialog({
  bookingId,
  currentCheckIn,
  currentCheckOut,
  currentFinalPriceCents,
}: ChangeDatesDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [checkIn, setCheckIn] = useState(currentCheckIn);
  const [checkOut, setCheckOut] = useState(currentCheckOut);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  // Additional payment state (when modification increases price)
  const [additionalPaymentClientSecret, setAdditionalPaymentClientSecret] = useState<string | null>(null);
  const [additionalAmountCents, setAdditionalAmountCents] = useState(0);
  const [paymentComplete, setPaymentComplete] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  async function fetchQuote() {
    setQuoteError("");
    setQuote(null);
    setQuoteLoading(true);

    try {
      const res = await fetch(`/api/bookings/${bookingId}/modify-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkIn, checkOut }),
      });

      const data = await res.json();
      if (!res.ok) {
        setQuoteError(data.error || "Failed to get quote");
        return;
      }
      setQuote(data);
    } catch {
      setQuoteError("Failed to get quote");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function handleConfirm() {
    setConfirmError("");
    setConfirming(true);

    try {
      const res = await fetch(`/api/bookings/${bookingId}/modify-dates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkIn, checkOut }),
      });

      const data = await res.json();
      if (!res.ok) {
        setConfirmError(data.error || "Failed to change dates");
        return;
      }

      if (data.additionalPaymentClientSecret) {
        // Price increased - collect additional payment before closing
        setAdditionalPaymentClientSecret(data.additionalPaymentClientSecret);
        setAdditionalAmountCents(data.additionalAmountCents);
      } else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setConfirmError("Failed to change dates");
    } finally {
      setConfirming(false);
    }
  }

  async function handlePaymentSuccess(paymentIntentId: string) {
    try {
      await fetch(`/api/bookings/${bookingId}/confirm-modification-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      });
    } catch {
      // Non-fatal: webhook will also confirm
    }
    setPaymentComplete(true);
    setTimeout(() => {
      setOpen(false);
      router.refresh();
    }, 1500);
  }

  function handleOpenChange(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen) {
      setCheckIn(currentCheckIn);
      setCheckOut(currentCheckOut);
      setQuote(null);
      setQuoteError("");
      setConfirmError("");
      setAdditionalPaymentClientSecret(null);
      setAdditionalAmountCents(0);
      setPaymentComplete(false);
    }
  }

  const datesChanged = checkIn !== currentCheckIn || checkOut !== currentCheckOut;
  const returnUrl = typeof window !== "undefined"
    ? `${window.location.origin}/bookings/${bookingId}`
    : `/bookings/${bookingId}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">Change Dates</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change Booking Dates</DialogTitle>
          <DialogDescription>
            Select new check-in and check-out dates. A price preview will be shown before confirming.
          </DialogDescription>
        </DialogHeader>

        {/* Additional payment step */}
        {additionalPaymentClientSecret ? (
          <div className="space-y-4">
            {paymentComplete ? (
              <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
                <p className="font-medium">Payment successful!</p>
                <p className="mt-1">Your dates have been updated and payment processed.</p>
              </div>
            ) : (
              <>
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                  <p className="font-medium">Additional payment required</p>
                  <p className="mt-1">
                    Your dates have been updated. Please pay the additional{" "}
                    {formatCents(additionalAmountCents)} to complete the modification.
                  </p>
                </div>
                <StripeProvider clientSecret={additionalPaymentClientSecret}>
                  <PaymentForm
                    bookingId={bookingId}
                    amountCents={additionalAmountCents}
                    returnUrl={returnUrl}
                    onSuccess={handlePaymentSuccess}
                    onError={(err) => setConfirmError(err)}
                  />
                </StripeProvider>
                {confirmError && (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                    {confirmError}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* Normal date-selection step */
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="change-checkin">Check-in</Label>
                <Input
                  id="change-checkin"
                  type="date"
                  value={checkIn}
                  min={today}
                  onChange={(e) => {
                    setCheckIn(e.target.value);
                    setQuote(null);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="change-checkout">Check-out</Label>
                <Input
                  id="change-checkout"
                  type="date"
                  value={checkOut}
                  min={checkIn || today}
                  onChange={(e) => {
                    setCheckOut(e.target.value);
                    setQuote(null);
                  }}
                />
              </div>
            </div>

            <div className="text-sm text-gray-500">
              Current: {currentCheckIn} to {currentCheckOut} ({formatCents(currentFinalPriceCents)})
            </div>

            {datesChanged && !quote && (
              <Button
                onClick={fetchQuote}
                disabled={quoteLoading || !checkIn || !checkOut || checkOut <= checkIn}
                className="w-full"
              >
                {quoteLoading ? "Checking availability..." : "Check Availability & Price"}
              </Button>
            )}

            {quoteError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                {quoteError}
              </div>
            )}

            {quote && (
              <div className="space-y-3">
                {!quote.capacityAvailable ? (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                    <p className="font-medium">Not enough beds available</p>
                    {quote.nightDetails && (
                      <ul className="mt-1 list-disc pl-4">
                        {quote.nightDetails
                          .filter((n) => n.availableBeds < 0)
                          .map((n) => (
                            <li key={n.date}>
                              {n.date}: {Math.abs(n.availableBeds)} bed(s) short
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="rounded-md bg-gray-50 p-3 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span>New total</span>
                      <span className="font-medium">{formatCents(quote.newFinalPriceCents)}</span>
                    </div>
                    {quote.priceDiffCents !== 0 && (
                      <div className="flex justify-between">
                        <span>Price difference</span>
                        <span
                          className={`font-medium ${
                            quote.priceDiffCents > 0 ? "text-red-600" : "text-green-600"
                          }`}
                        >
                          {quote.priceDiffCents > 0 ? "+" : ""}
                          {formatCents(quote.priceDiffCents)}
                        </span>
                      </div>
                    )}
                    {quote.changeFeeCents > 0 && (
                      <div className="flex justify-between text-amber-600">
                        <span>Late-notice change fee</span>
                        <span className="font-medium">{formatCents(quote.changeFeeCents)}</span>
                      </div>
                    )}
                    {!quote.promoStillValid && (
                      <div className="text-amber-600">
                        Your promo code is no longer valid and will be removed.
                      </div>
                    )}
                    {quote.priceDiffCents > 0 && (
                      <div className="text-sm text-gray-600 pt-1">
                        Additional payment of {formatCents(quote.priceDiffCents + quote.changeFeeCents)} will be collected after confirming.
                      </div>
                    )}
                    {quote.priceDiffCents < 0 && (
                      <div className="text-sm text-green-600 pt-1">
                        You will be refunded {formatCents(Math.abs(quote.priceDiffCents))}.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {confirmError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                {confirmError}
              </div>
            )}
          </div>
        )}

        {!additionalPaymentClientSecret && (
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!quote || !quote.capacityAvailable || confirming}
            >
              {confirming ? "Updating..." : "Confirm Date Change"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
