"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Issue #1668: the admin date override.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) as pure presentation. The card
 * decides nothing: whether it renders at all, what turning the switch ON discards,
 * and what turning it OFF resets are all still the panel's, because they touch
 * state spread across every other concern on the screen. Turning the switch on is
 * a date-only edit by construction, so the panel clears the pending guest, range,
 * night, promo and credit edits — a reset that has to see all of them at once.
 */
export function AdminOverrideCard({
  overrideEnabled,
  overridePricingMode,
  onOverrideEnabledChange,
  onPricingModeChange,
}: {
  overrideEnabled: boolean;
  overridePricingMode: "shift" | "recalculate" | null;
  onOverrideEnabledChange: (enabled: boolean) => void;
  onPricingModeChange: (mode: "shift" | "recalculate") => void;
}) {
  return (
    <Card className="border-warning-6">
      <CardHeader>
        <CardTitle headingLevel={2}>Admin override</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={overrideEnabled}
            onChange={(e) => onOverrideEnabledChange(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="font-medium">
              Move locked/past dates (admin override)
            </span>
            <span className="block text-muted-foreground">
              Bypasses the member-facing date locks so you can move an
              in-progress or fully-past booking. This is date-only and
              audited — any pending guest or promo edits are cleared when
              you turn it on. Choose how pricing is handled below.
            </span>
          </span>
        </label>

        {overrideEnabled && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="font-medium">How should pricing be handled?</p>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="overridePricingMode"
                value="shift"
                checked={overridePricingMode === "shift"}
                onChange={() => onPricingModeChange("shift")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Shift dates only</span> — keep
                the current price, payments and invoices.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="overridePricingMode"
                value="recalculate"
                checked={overridePricingMode === "recalculate"}
                onChange={() => onPricingModeChange("recalculate")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Recalculate price</span> —
                reprice the new nights and settle the difference (a change
                fee may apply).
              </span>
            </label>
            {!overridePricingMode && (
              <p className="text-warning-11">
                Choose a pricing mode to preview the change.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
