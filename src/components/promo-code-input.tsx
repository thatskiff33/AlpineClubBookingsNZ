"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatSignedCents } from "@/lib/utils";

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
  // NZ date-only lodge nights (`yyyy-MM-dd`), #2474 — never a local-midnight
  // `Date` re-serialised here.
  checkIn: string;
  checkOut: string;
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
  // Lodge the booking is for (multi-lodge phase 8); promo lodge
  // restrictions validate against it. Omitted = the club's default lodge.
  lodgeId?: string | null;
  prefillCode?: string;
  // Disables entry (e.g. while a working bee discount is selected) and
  // explains why.
  disabled?: boolean;
  disabledReason?: string;
  // True when this widget sits on an EDIT to an existing booking rather than in
  // a create flow (#2770, INV-MOD-026). It decides which group-discount mapper
  // the validator uses, because the club's `applyToEdits` switch governs edits
  // only — so a switch-off club's promo preview stops sizing its adjustment on
  // discounted rates the quote beside it will not give.
  forBookingEdit?: boolean;
}

export function PromoCodeInput({
  checkIn,
  checkOut,
  guests,
  onPromoApplied,
  appliedPromo,
  forMemberId,
  lodgeId,
  prefillCode,
  disabled = false,
  disabledReason,
  forBookingEdit = false,
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
          checkIn,
          checkOut,
          guests: guests.map((g) => ({
            ageTier: g.ageTier,
            isMember: g.isMember,
            ...(g.memberId ? { memberId: g.memberId } : {}),
            ...(g.stayStart ? { stayStart: g.stayStart } : {}),
            ...(g.stayEnd ? { stayEnd: g.stayEnd } : {}),
          })),
          ...(selectionRequired ? { promoGuestIndexes: selectedGuestIndexes } : {}),
          ...(forMemberId ? { forMemberId } : {}),
          ...(lodgeId ? { lodgeId } : {}),
          // #2770: sent only when it is true, so the create flows' request
          // bodies are byte-identical to what they send today.
          ...(forBookingEdit ? { forBookingEdit: true } : {}),
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
        <div className="flex items-center justify-between rounded-md bg-success-3 p-3 text-sm">
          <div>
            <span className="font-medium text-success-11">
              {appliedPromo.code}
            </span>
            {appliedPromo.description && (
              <span className="text-success-11 ml-2">
                - {appliedPromo.description}
              </span>
            )}
            <span className="text-success-11 ml-2">
              ({formatSignedCents(appliedPromo.promoAdjustmentCents)})
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            className="text-success-11 hover:text-success-11"
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
      {error && <p className="text-sm text-danger-11">{error}</p>}
    </div>
  );
}
