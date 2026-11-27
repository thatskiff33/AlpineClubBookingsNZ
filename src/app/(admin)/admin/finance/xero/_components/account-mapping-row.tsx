"use client"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ACCOUNT_MAPPING_DEFAULTS,
  describeMappingAccountFilter,
  describeMappingOwnWhileUnset,
  describeMappingUnsetEntries,
  groupAccountsForMappingKey,
  isCodeExplicitlyConfigured,
  MAPPING_DESCRIPTIONS,
  MAPPING_LABELS,
  resolveAccountMappingSource,
  withIndefiniteArticle,
  type AccountMappingKey,
} from "@/lib/xero-account-mapping-keys"
import type { AccountMappings, XeroAccount } from "./types"

/** One account mapping on the Account Mapping screen: its label, its picker and its notices. */
export function AccountMappingRow({
  mappingKey,
  mappings,
  setMappings,
  accounts,
  isEditingMappings,
}: {
  mappingKey: AccountMappingKey
  mappings: AccountMappings
  setMappings: (value: AccountMappings | null | ((prev: AccountMappings | null) => AccountMappings | null)) => void
  accounts: XeroAccount[]
  isEditingMappings: boolean
}) {
  const accountNoun = describeMappingAccountFilter(mappingKey)
  // INV-INT-021: the offered accounts come from the registry's filter, so this
  // picker cannot offer a kind of account the key did not declare. A key that
  // accepts two classes (Hut Fee Refunds, #5235) gets a heading per class.
  const groups = groupAccountsForMappingKey(mappingKey, accounts)
  const offered = groups.flatMap((group) => group.accounts)
  const currentCode = mappings[mappingKey]?.code
  // Looked up in the WHOLE chart, not in the offered list. A code stored before
  // the save checked the kind of account (#5235), or while no chart was cached,
  // can still be the wrong kind, and a code shown as a bare number with no
  // name, in a picker whose current value is not among its options, is how such
  // a row goes unnoticed.
  const matchedAccount = accounts.find((account) => account.code === currentCode)
  const currentIsOutsideFilter =
    currentCode != null &&
    currentCode !== "" &&
    !offered.some((account) => account.code === currentCode)
  // INV-INT-021: while a mapping with a registered fallback is unset, say so
  // here and name where its entries are going. Both halves come from the server's
  // own rules — `isCodeExplicitlyConfigured` is the one definition of a club
  // having CHOSEN a code, and `resolveAccountMappingSource` is the resolver the
  // runtime path uses — so the notice cannot claim a destination the server
  // would not pick. It is applied to the STAGED code rather than to a flag the
  // server sent, which is what makes the notice appear the moment an officer
  // clears a previously-configured mapping: a server flag would still say
  // "configured" and they would never be told that saving sends goodwill back
  // to the revenue account.
  const { sourceKey, usingFallback } = resolveAccountMappingSource(
    mappingKey,
    isCodeExplicitlyConfigured({ code: currentCode ?? null }),
  )
  // The RESOLVED fallback code, not the raw row. Where the fallback key has no
  // code of its own the entries go to the application default, and showing the
  // empty row would tell a treasurer that two mappings are unconfigured while
  // naming no account at all.
  const fallbackCode = usingFallback
    ? mappings[sourceKey]?.code ?? ACCOUNT_MAPPING_DEFAULTS[sourceKey] ?? null
    : null
  const fallbackAccount = accounts.find((account) => account.code === fallbackCode)
  const accountOption = (account: XeroAccount) => (
    <SelectItem key={account.code} value={account.code}>{account.code} - {account.name}</SelectItem>
  )
  return (
    <div className="grid grid-cols-3 items-start gap-4">
      <div>
        <p className="text-sm font-medium">{MAPPING_LABELS[mappingKey]}</p>
        <p className="text-xs text-muted-foreground">{MAPPING_DESCRIPTIONS[mappingKey]}</p>
      </div>
      <div className="col-span-2">
        {isEditingMappings ? (
          <Select value={currentCode ?? "__none__"} onValueChange={(value) => setMappings((prev) => prev ? { ...prev, [mappingKey]: { ...prev[mappingKey], code: value === "__none__" ? null : value } } : prev)}>
            <SelectTrigger aria-label={`${MAPPING_LABELS[mappingKey]} account`}><SelectValue placeholder="Select account..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__"><span className="text-muted-foreground">Not configured (use default)</span></SelectItem>
              {groups.map((group) =>
                group.heading ? (
                  <SelectGroup key={group.accountClass}>
                    <SelectLabel>{group.heading}</SelectLabel>
                    {group.accounts.map(accountOption)}
                  </SelectGroup>
                ) : (
                  group.accounts.map(accountOption)
                ),
              )}
              {currentIsOutsideFilter ? (
                <SelectItem value={currentCode!}>
                  {matchedAccount ? `${matchedAccount.code} - ${matchedAccount.name}` : currentCode} (not {withIndefiniteArticle(accountNoun)} account)
                </SelectItem>
              ) : null}
              {offered.length === 0 ? <SelectItem value="__empty__" disabled>No {accountNoun} accounts found &mdash; check the chart of accounts is up to date</SelectItem> : null}
            </SelectContent>
          </Select>
        ) : (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{matchedAccount ? `${matchedAccount.code} - ${matchedAccount.name}` : currentCode || <span className="text-muted-foreground">{ACCOUNT_MAPPING_DEFAULTS[mappingKey] ? "Not configured (using default)" : "Not configured"}</span>}</p>
        )}
        {currentIsOutsideFilter ? (
          <p className="mt-1 text-xs text-warning-11">
            This code is not {withIndefiniteArticle(accountNoun)} account in the connected Xero
            organisation. Entries keep posting to it until you choose another account here, so
            choose {withIndefiniteArticle(accountNoun)} account, or refresh the chart of
            accounts if it is simply out of date.
          </p>
        ) : null}
        {!usingFallback &&
        !isCodeExplicitlyConfigured({ code: currentCode ?? null }) &&
        describeMappingOwnWhileUnset(mappingKey) ? (
          // `INV-INT-021`'s row prompt for a key with NO fallback (#3529): the
          // treasurer is told what happens without it, in the same place the
          // fallback notice would sit.
          <p className="mt-1 text-xs text-warning-11">
            Not set, so {describeMappingOwnWhileUnset(mappingKey)}. Choosing{" "}
            {withIndefiniteArticle(accountNoun)} account here records those payments from it; notes
            already in Xero are never changed.
          </p>
        ) : null}
        {usingFallback ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Not set, so {describeMappingUnsetEntries(mappingKey)} keep posting to the{" "}
            <span className="font-medium">{MAPPING_LABELS[sourceKey]}</span> mapping
            {fallbackAccount ? ` (${fallbackAccount.code} - ${fallbackAccount.name})` : fallbackCode ? ` (${fallbackCode})` : ""}
            , exactly as they did before this setting existed. Choosing{" "}
            {withIndefiniteArticle(accountNoun)} account here changes where new entries post; entries
            already in Xero are never reclassified.
          </p>
        ) : null}
      </div>
    </div>
  )
}
