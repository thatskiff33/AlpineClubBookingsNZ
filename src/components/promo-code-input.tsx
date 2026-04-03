"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface PromoResult {
  code: string;
  description: string | null;
  type: string;
  discountCents: number;
  totalPriceCents: number;
  finalPriceCents: number;
}

interface PromoCodeInputProps {
  checkIn: Date;
  checkOut: Date;
  guests: { ageTier: string; isMember: boolean }[];
  onPromoApplied: (result: PromoResult | null) => void;
  appliedPromo: PromoResult | null;
}

export function PromoCodeInput({
  checkIn,
  checkOut,
  guests,
  onPromoApplied,
  appliedPromo,
}: PromoCodeInputProps) {
  const [code, setCode] = useState(appliedPromo?.code || "");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");

  async function handleApply() {
    if (!code.trim()) {
      setError("Please enter a promo code");
      return;
    }

    setValidating(true);
    setError("");

    try {
      const res = await fetch("/api/promo-codes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          checkIn: checkIn.toISOString(),
          checkOut: checkOut.toISOString(),
          guests: guests.map((g) => ({ ageTier: g.ageTier, isMember: g.isMember })),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Invalid promo code");
        onPromoApplied(null);
        return;
      }

      onPromoApplied({
        code: data.code,
        description: data.description,
        type: data.type,
        discountCents: data.discountCents,
        totalPriceCents: data.totalPriceCents,
        finalPriceCents: data.finalPriceCents,
      });
    } catch {
      setError("Failed to validate promo code");
      onPromoApplied(null);
    } finally {
      setValidating(false);
    }
  }

  function handleRemove() {
    setCode("");
    setError("");
    onPromoApplied(null);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="promoCode">Promo Code (optional)</Label>
      {appliedPromo ? (
        <div className="flex items-center justify-between rounded-md bg-green-50 p-3 text-sm">
          <div>
            <span className="font-medium text-green-700">
              {appliedPromo.code}
            </span>
            {appliedPromo.description && (
              <span className="text-green-600 ml-2">
                - {appliedPromo.description}
              </span>
            )}
            <span className="text-green-700 ml-2">
              (-${(appliedPromo.discountCents / 100).toFixed(2)})
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            className="text-green-700 hover:text-green-900"
          >
            Remove
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            id="promoCode"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError("");
            }}
            placeholder="Enter promo code"
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleApply}
            disabled={validating || !code.trim()}
          >
            {validating ? "Checking..." : "Apply"}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
