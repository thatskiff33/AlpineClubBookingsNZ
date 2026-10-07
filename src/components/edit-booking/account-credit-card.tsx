"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";

/**
 * Account credit (#2266). Owner-decided placement: its own card, above the
 * Return-method radio (which lives in the Price Summary below). The direction
 * tag distinguishes this card (spending credit on the booking) from the
 * settlement radio (money coming back to you). The checkbox is the create
 * flow's election, stored on the booking (#2265) and applied when the member
 * confirms — nothing moves at save time.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) as pure presentation. Every
 * figure is computed by the panel and handed over: `desiredElectionCents` and
 * the `creditChanged` / `includeCreditInPayload` rules decide what the SAVE
 * sends as well as what this card says, and MED-3 (an untouched stored election
 * follows only a reprice, never the live balance) is a payload rule, not a
 * display one.
 */
export function AccountCreditCard({
  actingAsAdmin,
  ledgerAppliedCreditCents,
  availableCreditCents,
  uncoveredPriceCents,
  useCredit,
  desiredElectionCents,
  creditChanged,
  storedElectionCents,
  onUseCreditChange,
}: {
  actingAsAdmin: boolean;
  ledgerAppliedCreditCents: number;
  availableCreditCents: number;
  uncoveredPriceCents: number;
  useCredit: boolean;
  desiredElectionCents: number;
  creditChanged: boolean;
  storedElectionCents: number;
  onUseCreditChange: (checked: boolean) => void;
}) {
  const format = useClubFormat();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Account credit</CardTitle>
          <span className="rounded-full bg-success-3 px-2 py-0.5 text-xs font-medium text-success-11">
            Credit → booking
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {ledgerAppliedCreditCents > 0 && (
          <p className="text-sm text-muted-foreground">
            {formatCents(ledgerAppliedCreditCents, format)} of account credit is
            already applied to this booking.
          </p>
        )}
        <p className="text-sm text-success-11">
          {actingAsAdmin ? "The member has" : "You have"}{" "}
          <strong>{formatCents(availableCreditCents, format)}</strong> in account
          credit
        </p>
        {(useCredit ||
          (availableCreditCents > 0 && uncoveredPriceCents > 0)) && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-success-11">
            <input
              type="checkbox"
              checked={useCredit}
              disabled={
                !useCredit &&
                !(availableCreditCents > 0 && uncoveredPriceCents > 0)
              }
              onChange={(e) => onUseCreditChange(e.target.checked)}
              className="h-4 w-4 rounded border-success-6"
            />
            Apply credit to this booking
          </label>
        )}
        {useCredit && desiredElectionCents > 0 && (
          <p className="text-sm font-medium text-success-11">
            {(() => {
              const whose = actingAsAdmin
                ? `The member's ${formatCents(desiredElectionCents, format)} credit choice`
                : `Your ${formatCents(desiredElectionCents, format)} credit choice`;
              const confirmer = actingAsAdmin ? "they confirm" : "you confirm";
              return creditChanged || storedElectionCents === 0
                ? `${whose} will be saved with these changes and applied when ${confirmer}.`
                : `${whose} is saved and will be applied when ${confirmer}.`;
            })()}
          </p>
        )}
        {useCredit &&
          desiredElectionCents > 0 &&
          desiredElectionCents >= uncoveredPriceCents && (
            <p className="text-sm font-medium text-success-11">
              Credit covers the entire booking — no card payment needed
            </p>
          )}
        {useCredit && desiredElectionCents === 0 && (
          <p className="text-sm text-warning-11">
            {availableCreditCents === 0
              ? actingAsAdmin
                ? "The member's credit balance is currently $0.00, so this choice cannot be applied right now. It will only apply if credit returns to their account before they pay — or untick it."
                : "Your credit balance is currently $0.00, so this choice cannot be applied right now. It will only apply if credit returns to your account before you pay — or untick it."
              : "There is nothing left for account credit to cover on this booking."}
          </p>
        )}
        {/* MED-3: an untouched saved election is never rewritten for a
            balance dip — but the member deserves to know the balance is
            currently short of it. The saved choice stays whole; the pay
            step clamps and reports (#2265). */}
        {useCredit &&
          desiredElectionCents > 0 &&
          availableCreditCents < desiredElectionCents && (
            <p className="text-sm text-warning-11">
              {actingAsAdmin
                ? `The member's credit balance is currently ${formatCents(availableCreditCents, format)} — below this saved choice. The choice stays saved in full; only the credit in their account when they pay will be applied.`
                : `Your credit balance is currently ${formatCents(availableCreditCents, format)} — below this saved choice. The choice stays saved in full; only the credit in your account when you pay will be applied.`}
            </p>
          )}
      </CardContent>
    </Card>
  );
}
