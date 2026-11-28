"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  accountsForMappingKey,
  describeMappingAccountFilter,
  mappingCodeClassViolation,
  withIndefiniteArticle,
} from "@/lib/xero-account-mapping-keys";

const NONE = "__none__";

/** A chart-of-accounts row as `/api/admin/xero/chart-of-accounts` returns it. */
export interface SubscriptionAccountOption {
  code: string;
  name: string;
  type: string;
  class?: string | null;
}

/**
 * The Subscription Income account picker on the subscription lockout screen.
 *
 * `INV-INT-021`: it offers what the mapping's registry entry accepts, as the
 * Xero Account Mapping screen does, because the save refuses a newly chosen
 * account of any other kind (#5235). The code already chosen stays listed even
 * when it is not one of those, so the picker shows what is stored, and says so
 * when the chart shows it is the wrong kind: the same question the save asks
 * (`mappingCodeClassViolation`), as the Account Mapping row asks it.
 */
export function SubscriptionAccountSelect({
  id,
  value,
  onChange,
  accounts,
  disabled,
}: {
  id: string;
  value: string | null;
  onChange: (code: string | null) => void;
  accounts: readonly SubscriptionAccountOption[];
  disabled: boolean;
}) {
  const offered = accountsForMappingKey("subscriptionIncome", accounts);
  const chosenIsOffered = offered.some((account) => account.code === value);
  const chosen = accounts.find((account) => account.code === value);
  const wrongKind =
    mappingCodeClassViolation("subscriptionIncome", value, accounts) !== null;
  const wanted = withIndefiniteArticle(
    describeMappingAccountFilter("subscriptionIncome"),
  );
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full sm:w-[360px]">
        <SelectValue placeholder="Not set" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">Not set</span>
        </SelectItem>
        {offered.map((account) => (
          <SelectItem key={account.code} value={account.code}>
            {account.code} - {account.name}
          </SelectItem>
        ))}
        {value && !chosenIsOffered ? (
          <SelectItem value={value}>
            {chosen ? `${value} - ${chosen.name}` : value}
            {wrongKind ? ` (not ${wanted} account)` : ""}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}
