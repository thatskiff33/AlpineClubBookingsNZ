"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLocalDateOnly } from "@/lib/date-only";

export interface PromoResult {
  // Null when the discount comes from a work party event's internal promo
  // (the internal code is never sent to the client).
  code: string | null;
  description: string | null;
  type: string;
  discountCents: number;
  promoAdjustmentCents: number;
  totalPriceCents: number;
  finalPriceCents: number;
  selectedGuestIndexes?: number[];
  // Set when this discount came from a selected work party event rather
  // than a manually entered promo code.
  workPartyEvent?: { id: string; name: string; discountPercent: number } | null;
}

interface PromoCodeInputProps {
  checkIn: Date;
  checkOut: Date;
  guests: {
    firstName?: string;
    lastName?: string;
    ageTier: string;
    isMember: boolean;
    memberId?: string;
    stayStart?: string;
    stayEnd?: string;
  }[];
  onPromoApplied: (result: PromoResult | null) => void;
  appliedPromo: PromoResult | null;
  forMemberId?: string;
  prefillCode?: string;
  // Disables entry (e.g. while a working bee discount is selected) and
  // explains why.
  disabled?: boolean;
  disabledReason?: string;
}

export function PromoCodeInput({
  checkIn,
  checkOut,
  guests,
  onPromoApplied,
  appliedPromo,
  forMemberId,
  prefillCode,
  disabled = false,
  disabledReason,
}: PromoCodeInputProps) {
  const [code, setCode] = useState(appliedPromo?.code || "");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [selectableGuestIndexes, setSelectableGuestIndexes] = useState<number[]>([]);
  const [selectedGuestIndexes, setSelectedGuestIndexes] = useState<number[]>([]);

  useEffect(() => {
    if (prefillCode && !appliedPromo) {
      setCode(prefillCode);
    }
  }, [prefillCode, appliedPromo]);

  async function handleApply() {
    if (!code.trim()) {
      setError("Please enter a promo code");
      return;
    }
    if (selectionRequired && selectedGuestIndexes.length === 0) {
      setError("Choose at least one guest for this promo code");
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
          checkIn: formatLocalDateOnly(checkIn),
          checkOut: formatLocalDateOnly(checkOut),
          guests: guests.map((g) => ({
            ageTier: g.ageTier,
            isMember: g.isMember,
            ...(g.memberId ? { memberId: g.memberId } : {}),
            ...(g.stayStart ? { stayStart: g.stayStart } : {}),
            ...(g.stayEnd ? { stayEnd: g.stayEnd } : {}),
          })),
          ...(selectionRequired ? { promoGuestIndexes: selectedGuestIndexes } : {}),
          ...(forMemberId ? { forMemberId } : {}),
        }),
      });

      const data = await res.json();

      if (data.requiresGuestSelection) {
        setSelectionRequired(true);
        setSelectableGuestIndexes(data.selectableGuestIndexes || []);
        setSelectedGuestIndexes([]);
        setError(data.error || "Choose which guests should receive this promo code");
        onPromoApplied(null);
        return;
      }

      if (!res.ok || data.valid === false) {
        setError(data.error || "Invalid promo code");
        onPromoApplied(null);
        return;
      }

      onPromoApplied({
        code: data.code,
        description: data.description,
        type: data.type,
        discountCents: data.discountCents,
        promoAdjustmentCents: data.promoAdjustmentCents,
        totalPriceCents: data.totalPriceCents,
        finalPriceCents: data.finalPriceCents,
        selectedGuestIndexes: data.selectedGuestIndexes,
      });
    } catch {
      setError("Failed to validate promo code");
      onPromoApplied(null);
    } finally {
      setValidating(false);
    }
  }

  function formatSignedCents(cents: number) {
    if (cents === 0) return "$0.00";
    const prefix = cents > 0 ? "+$" : "-$";
    return `${prefix}${(Math.abs(cents) / 100).toFixed(2)}`;
  }

  function handleRemove() {
    setCode("");
    setError("");
    setSelectionRequired(false);
    setSelectableGuestIndexes([]);
    setSelectedGuestIndexes([]);
    onPromoApplied(null);
  }

  function handleCodeChange(value: string) {
    setCode(value.toUpperCase());
    setError("");
    setSelectionRequired(false);
    setSelectableGuestIndexes([]);
    setSelectedGuestIndexes([]);
  }

  function toggleGuestIndex(index: number, checked: boolean) {
    setSelectedGuestIndexes((current) => {
      const next = checked
        ? [...current, index]
        : current.filter((value) => value !== index);
      return [...new Set(next)].sort((a, b) => a - b);
    });
    setError("");
  }

  function guestLabel(index: number) {
    const guest = guests[index];
    const name = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ").trim();
    const label = name || `Guest ${index + 1}`;
    return `${label}${guest?.isMember ? " (member)" : ""}`;
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="promoCode">Promo Code (optional)</Label>
      {appliedPromo && !appliedPromo.workPartyEvent ? (
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
              ({formatSignedCents(appliedPromo.promoAdjustmentCents)})
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
            onChange={(e) => handleCodeChange(e.target.value)}
            placeholder="Enter promo code"
            className="flex-1"
            disabled={disabled}
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleApply}
            disabled={disabled || validating || !code.trim() || (selectionRequired && selectedGuestIndexes.length === 0)}
          >
            {validating ? "Checking..." : selectionRequired ? "Apply Selected" : "Apply"}
          </Button>
        </div>
      )}
      {disabled && disabledReason && (
        <p className="text-sm text-muted-foreground">{disabledReason}</p>
      )}
      {!appliedPromo && selectionRequired && (
        <div className="rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">Choose promo guests</p>
          <div className="space-y-2">
            {selectableGuestIndexes.map((index) => (
              <label key={index} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedGuestIndexes.includes(index)}
                  onChange={(event) => toggleGuestIndex(index, event.target.checked)}
                  className="rounded border-input"
                />
                <span>{guestLabel(index)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
