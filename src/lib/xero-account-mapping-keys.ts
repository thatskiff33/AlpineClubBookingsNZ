/**
 * Xero account-mapping keys — the ONE registry (#2717, `INV-SSOT-001`).
 *
 * A `XeroAccountMapping` row is keyed by name, and until #2717 the set of names
 * was spelled out in FOUR places that had to be edited together: the admin
 * picker's key list, its label/description/type-filter records, the
 * `/api/admin/xero/account-mappings` allowlist and zod schema, and the runtime
 * default codes in `xero-mappings.ts`. Adding one key meant four edits and
 * nothing failed if you made three, which is exactly the defect `AGENTS.md` →
 * "Single source of truth" describes: the fix is the move, not a lint rule.
 * Every one of those consumers now derives from the definitions below.
 *
 * `INV-INT-021` is the house rule this file makes structural rather than
 * policed: a new account mapping key names the Xero account TYPE its picker may
 * offer (`accountType` is REQUIRED — a key with no filter cannot be written),
 * declares what it does while unset (`defaultCode`, or a `fallbackKey` naming
 * the mapping that keeps working until a club configures this one), and is
 * surfaced in the Xero setup screen while it is unset. Never a hard failure on
 * upgrade, never a silent default.
 *
 * This module is deliberately pure data — no Prisma, no React — so the server
 * resolver, the API route, the seed and the admin client component can all
 * import it.
 */

/** The Xero account types this product's pickers filter on. */
export type XeroAccountType = "REVENUE" | "EXPENSE" | "BANK";

export type XeroAccountMappingDefinition = {
  /** The `XeroAccountMapping.key` column value. Permanent: rows are keyed by it. */
  readonly key: string;
  /** Admin picker heading. */
  readonly label: string;
  /** Admin picker help text. */
  readonly description: string;
  /**
   * REQUIRED (`INV-INT-021`): the only Xero account type the picker offers for
   * this key. Goodwill is typed `EXPENSE` because goodwill is a cost the club
   * chose to bear, not a reduction of what it billed (owner, 10 Aug 2026).
   */
  readonly accountType: XeroAccountType;
  /** Application default when no row exists or the row's code is null. */
  readonly defaultCode: string | null;
  /**
   * The key whose mapping stays in force while THIS key is unset
   * (`INV-INT-021`). Resolution is one hop only — a fallback key may not itself
   * declare one — and the setup screen says so while the fallback is active.
   */
  readonly fallbackKey?: string;
};

export const XERO_ACCOUNT_MAPPING_DEFINITIONS = [
  {
    key: "hutFeesIncome",
    label: "Hut Fees Income",
    description: "Sales account for booking income line items",
    accountType: "REVENUE",
    defaultCode: "200",
  },
  {
    key: "hutFeeRefunds",
    label: "Hut Fee Refunds",
    description: "Account for refund credit notes",
    accountType: "REVENUE",
    defaultCode: "200",
  },
  {
    key: "goodwillWriteOffs",
    label: "Goodwill & Write-Offs",
    description:
      "Expense account for discretionary goodwill — admin-granted account credit applied to an Internet Banking booking. Keeping it separate from refunds lets the accounts show what the club billed and what it chose not to collect, instead of netting the two together.",
    accountType: "EXPENSE",
    defaultCode: null,
    fallbackKey: "hutFeeRefunds",
  },
  {
    key: "stripeBankAccount",
    label: "Stripe Bank Account",
    description: "Bank account used to record Stripe payments",
    accountType: "BANK",
    defaultCode: "606",
  },
  {
    key: "stripeFees",
    label: "Stripe Fees",
    description: "Expense account for Stripe transaction fees (optional)",
    accountType: "EXPENSE",
    defaultCode: null,
  },
  {
    key: "subscriptionIncome",
    label: "Subscription Income",
    description: "Account code used to detect Annual Membership Fee invoices",
    accountType: "REVENUE",
    defaultCode: "203",
  },
  {
    key: "membershipCancellationCredit",
    label: "Membership Cancellation Credits",
    description:
      "Credit note account and item used to reverse unpaid Annual Membership Fee invoices when membership cancellation is approved",
    accountType: "REVENUE",
    defaultCode: "203",
  },
] as const satisfies readonly XeroAccountMappingDefinition[];

export type AccountMappingKey =
  (typeof XERO_ACCOUNT_MAPPING_DEFINITIONS)[number]["key"];

/**
 * Keys on the same table that carry ONLY an item code — they select a Xero
 * Item, never an account, so `INV-INT-021`'s account-type filter does not
 * apply to them. `entranceFeeAmountCents` is deliberately absent (#1931, E5):
 * the legacy flat joining-fee amount is not read at runtime, so exposing it as
 * writable would accept edits that silently do nothing.
 */
export const XERO_ITEM_ONLY_MAPPING_DEFINITIONS = [
  {
    key: "hutFeeItem",
    label: "Hut Fee Item",
    description: "Xero Item for hut fee invoice line items",
  },
  {
    key: "hutFeeRefundItem",
    label: "Hut Fee Refund Item",
    description: "Xero Item for refund credit note line items",
  },
  {
    key: "entranceFeeItem",
    label: "Joining Fee Item",
    description: "Xero Item for joining fee invoice line items",
  },
] as const;

export type ItemOnlyMappingKey =
  (typeof XERO_ITEM_ONLY_MAPPING_DEFINITIONS)[number]["key"];

/** Every key the admin may write through `/api/admin/xero/account-mappings`. */
export type XeroMappingWritableKey = AccountMappingKey | ItemOnlyMappingKey;

export const ACCOUNT_MAPPING_KEYS: readonly AccountMappingKey[] =
  XERO_ACCOUNT_MAPPING_DEFINITIONS.map((definition) => definition.key);

export const XERO_MAPPING_WRITABLE_KEYS: readonly XeroMappingWritableKey[] = [
  ...ACCOUNT_MAPPING_KEYS,
  ...XERO_ITEM_ONLY_MAPPING_DEFINITIONS.map((definition) => definition.key),
];

function byKey<Definition extends { key: string }, Value>(
  definitions: readonly Definition[],
  read: (definition: Definition) => Value,
): Record<string, Value> {
  return Object.fromEntries(
    definitions.map((definition) => [definition.key, read(definition)]),
  );
}

/** Picker headings, account and item-only keys alike. */
export const MAPPING_LABELS: Record<string, string> = {
  ...byKey(XERO_ACCOUNT_MAPPING_DEFINITIONS, (d) => d.label),
  ...byKey(XERO_ITEM_ONLY_MAPPING_DEFINITIONS, (d) => d.label),
};

export const MAPPING_DESCRIPTIONS: Record<string, string> = {
  ...byKey(XERO_ACCOUNT_MAPPING_DEFINITIONS, (d) => d.description),
  ...byKey(XERO_ITEM_ONLY_MAPPING_DEFINITIONS, (d) => d.description),
};

/** `INV-INT-021`: the Xero account type each key's picker may offer. */
export const MAPPING_TYPE_FILTER: Record<AccountMappingKey, XeroAccountType> =
  byKey(XERO_ACCOUNT_MAPPING_DEFINITIONS, (d) => d.accountType) as Record<
    AccountMappingKey,
    XeroAccountType
  >;

/** Application default code per key — `null` for an optional mapping. */
export const ACCOUNT_MAPPING_DEFAULTS: Record<string, string | null> = byKey(
  XERO_ACCOUNT_MAPPING_DEFINITIONS,
  (d) => d.defaultCode,
);

/** `INV-INT-021`: the mapping that stays in force while a key is unset. */
export const ACCOUNT_MAPPING_FALLBACK_KEYS: Readonly<
  Partial<Record<AccountMappingKey, AccountMappingKey>>
> = Object.fromEntries(
  XERO_ACCOUNT_MAPPING_DEFINITIONS.filter(
    (definition): definition is (typeof definition) & { fallbackKey: string } =>
      "fallbackKey" in definition,
  ).map((definition) => [definition.key, definition.fallbackKey]),
);

/**
 * The accounts a key's picker may offer (`INV-INT-021`).
 *
 * The filter lives here rather than inline in the picker so "goodwill offers
 * expense accounts only" is a fact one unit test can hold, and so a picker
 * cannot come to filter on anything other than the key's declared type.
 */
export function accountsForMappingKey<Account extends { type: string }>(
  key: AccountMappingKey,
  accounts: readonly Account[],
): Account[] {
  const accountType = MAPPING_TYPE_FILTER[key];
  return accounts.filter((account) => account.type === accountType);
}

export function isAccountMappingKey(key: string): key is AccountMappingKey {
  return (ACCOUNT_MAPPING_KEYS as readonly string[]).includes(key);
}

/**
 * Which mapping's code is actually in force for `key` — the ONE place that
 * decides it (`INV-INT-021`). The runtime resolver and the Xero setup screen
 * both call this, so neither re-derives "are we falling back?" from a null
 * code: the answer is driven by `codeExplicitlyConfigured`, the canonical flag
 * that says this club CHOSE a code rather than inheriting one.
 *
 * One hop, never a chain: a fallback key's own fallback is not consulted, and
 * `xero-account-mapping-registry.test.ts` fails a definition that would need it.
 */
export function resolveAccountMappingSource(
  key: AccountMappingKey,
  codeExplicitlyConfigured: boolean,
): { sourceKey: AccountMappingKey; usingFallback: boolean } {
  if (codeExplicitlyConfigured) return { sourceKey: key, usingFallback: false };
  const fallbackKey = ACCOUNT_MAPPING_FALLBACK_KEYS[key];
  if (!fallbackKey) return { sourceKey: key, usingFallback: false };
  return { sourceKey: fallbackKey, usingFallback: true };
}
