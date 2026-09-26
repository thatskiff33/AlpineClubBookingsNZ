"use client";

import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  CLUB_FORMAT_CARD_PAYMENTS,
  CLUB_FORMAT_PROVIDER_CURRENCIES,
  clubFormatCurrencyChangeAcknowledgement,
} from "@/lib/club-format-copy";

/**
 * The card payments a currency change would catch mid-flight, as
 * `/api/admin/club-format` counts them (`club-format-in-flight.ts`). `null`
 * when the server could not count them — shown as such, never as zero.
 */
export type ClubFormatInFlightCardPayments = {
  unpaidCardPayments: number;
  pendingSavedCardCharges: number;
  openRecoveryRetries: number;
} | null;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The extra confirmation a CURRENCY change needs (owner decisions D1, D2 and D8
 * on #3567), shown only when the chosen currency differs from the one in force.
 * Card charges follow the club's currency, so this counts what is already
 * under way, says the Stripe account and Xero base currency must match, and
 * asks for its own tick. It warns rather than refuses; the route refuses a
 * currency change that arrives without the tick.
 */
export function ClubFormatCurrencyChange({
  fromCurrency,
  toCurrency,
  inFlight,
  acknowledged,
  onAcknowledgedChange,
}: {
  fromCurrency: string;
  toCurrency: string;
  inFlight: ClubFormatInFlightCardPayments;
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
}) {
  const acknowledgeId = useId();
  return (
    <div
      className="space-y-3 rounded-md border border-danger-6 bg-danger-3 p-4"
      data-testid="club-format-currency-change"
    >
      <p className="text-sm font-semibold">
        {`Card payments move from ${fromCurrency} to ${toCurrency} when you save`}
      </p>
      <p className="text-sm">{CLUB_FORMAT_CARD_PAYMENTS}</p>
      {inFlight ? (
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="club-format-in-flight">
          <li>
            {`${plural(inFlight.unpaidCardPayments, "card payment", "card payments")} already started and not yet paid — these stay in ${fromCurrency}.`}
          </li>
          <li>
            {`${plural(inFlight.pendingSavedCardCharges, "saved card", "saved cards")} waiting to be charged later — these are charged in ${toCurrency}.`}
          </li>
          <li>
            {`${plural(inFlight.openRecoveryRetries, "payment-recovery retry", "payment-recovery retries")} still open — the payment provider refuses these after the change.`}
          </li>
        </ul>
      ) : (
        <p className="text-sm" data-testid="club-format-in-flight-unknown">
          The card payments already under way could not be counted just now.
          Check the payments screens before saving.
        </p>
      )}
      <p className="text-sm">{CLUB_FORMAT_PROVIDER_CURRENCIES}</p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={acknowledgeId}
          checked={acknowledged}
          onCheckedChange={(checked) => onAcknowledgedChange(checked)}
        />
        <Label htmlFor={acknowledgeId} className="text-sm font-normal">
          {clubFormatCurrencyChangeAcknowledgement(toCurrency)}
        </Label>
      </div>
    </div>
  );
}
