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
import {
  normalizeXeroAccountClass,
  type XeroAccountClass,
} from "@/lib/xero-account-class";


export type XeroAccountMappingDefinition = {
  /** The `XeroAccountMapping.key` column value. Permanent: rows are keyed by it. */
  readonly key: string;
  /** Admin picker heading. */
  readonly label: string;
  /** Admin picker help text. */
  readonly description: string;
  /**
   * REQUIRED (`INV-INT-021`): the Xero account CLASS this key's picker offers.
   * Class, not type — type has four separate expense-class values and the
   * single field meaning "this is an expense account" is the class. Goodwill is
   * `EXPENSE` because goodwill is a cost the club chose to bear, not a
   * reduction of what it billed (owner, 10 Aug 2026).
   */
  readonly accountClass: XeroAccountClass;
  /**
   * OPTIONAL narrowing WITHIN that class, for a key that wants less than the
   * whole of it — `stripeBankAccount` wants a bank account, which is one type
   * inside class `ASSET`. Every listed type must belong to the declared class;
   * `xero-account-mapping-registry.test.ts` holds that. Omitted, the key offers
   * the whole class, which is what a broad question like "an expense account"
   * needs.
   */
  readonly accountTypes?: readonly string[];
  /** Application default when no row exists or the row's code is null. */
  readonly defaultCode: string | null;
  /**
   * The key whose mapping stays in force while THIS key is unset
   * (`INV-INT-021`). Resolution is one hop only — a fallback key may not itself
   * declare one — and the setup screen says so while the fallback is active.
   */
  readonly fallbackKey?: string;
  /**
   * What the setup screen calls the entries this key routes, for the sentence
   * it writes while the fallback is active ("so goodwill entries keep posting
   * to …"). Defaults to a bare "entries", which is true but tells an admin
   * less than it could at no cost.
   */
  readonly unsetEntriesLabel?: string;
  /**
   * Whether this key's `itemCode` column is READ at runtime. A Xero Item
   * carries its own account and wins over a line's account code, so an item
   * code set on a key nothing reads it from is not merely inert — on a key that
   * DID read it, it would silently re-route the line. The write path refuses
   * one on a key that does not declare this.
   */
  readonly carriesItemCode?: true;
};

export const XERO_ACCOUNT_MAPPING_DEFINITIONS = [
  {
    key: "hutFeesIncome",
    label: "Hut Fees Income",
    description: "Sales account for booking income line items",
    accountClass: "REVENUE",
    accountTypes: ["REVENUE"],
    defaultCode: "200",
    carriesItemCode: true,
  },
  {
    key: "hutFeeRefunds",
    label: "Hut Fee Refunds",
    description: "Account for refund credit notes",
    accountClass: "REVENUE",
    accountTypes: ["REVENUE"],
    defaultCode: "200",
    carriesItemCode: true,
  },
  {
    key: "goodwillWriteOffs",
    label: "Goodwill & Write-Offs",
    description:
      "Expense account for discretionary goodwill — account credit an admin granted, spent on a booking. Keeping it separate from refunds lets the accounts show what the club billed and what it chose not to collect, instead of netting the two together. Credit a member had already paid for is not goodwill and still posts to the refund account.",
    // The WHOLE expense class, with no type narrowing. On the standard New
    // Zealand chart the range a treasurer puts write-offs in is typed
    // OVERHEADS, so narrowing to type EXPENSE would render an empty picker and
    // leave the club on the fallback for ever.
    accountClass: "EXPENSE",
    defaultCode: null,
    fallbackKey: "hutFeeRefunds",
    unsetEntriesLabel: "goodwill entries",
  },
  {
    key: "stripeBankAccount",
    label: "Stripe Bank Account",
    description: "Bank account used to record Stripe payments",
    // A bank account is one type inside class ASSET; this key wants that type
    // and nothing else, so the narrowing is the whole filter here.
    accountClass: "ASSET",
    accountTypes: ["BANK"],
    defaultCode: "606",
  },
  {
    key: "stripeFees",
    label: "Stripe Fees",
    description: "Expense account for Stripe transaction fees (optional)",
    accountClass: "EXPENSE",
    accountTypes: ["EXPENSE"],
    defaultCode: null,
  },
  {
    key: "subscriptionIncome",
    label: "Subscription Income",
    description: "Account code used to detect Annual Membership Fee invoices",
    accountClass: "REVENUE",
    accountTypes: ["REVENUE"],
    defaultCode: "203",
    carriesItemCode: true,
  },
  {
    key: "membershipCancellationCredit",
    label: "Membership Cancellation Credits",
    description:
      "Credit note account and item used to reverse unpaid Annual Membership Fee invoices when membership cancellation is approved",
    accountClass: "REVENUE",
    accountTypes: ["REVENUE"],
    defaultCode: "203",
    carriesItemCode: true,
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

/** The accounts one key's picker may offer (`INV-INT-021`). */
export type MappingAccountFilter = {
  readonly accountClass: XeroAccountClass;
  readonly accountTypes?: readonly string[];
};

/** `INV-INT-021`: the account filter each key's picker applies. */
export const MAPPING_ACCOUNT_FILTERS: Record<
  AccountMappingKey,
  MappingAccountFilter
> = byKey(XERO_ACCOUNT_MAPPING_DEFINITIONS, (d) => ({
  accountClass: d.accountClass,
  ...("accountTypes" in d ? { accountTypes: d.accountTypes } : {}),
})) as Record<AccountMappingKey, MappingAccountFilter>;

/**
 * The word the setup screen uses for the kind of account a key wants — "bank",
 * "revenue", "expense". A key narrowed to one type is named by that type,
 * because that is what an admin is being asked to pick; a key that offers a
 * whole class is named by the class.
 */
/** What the setup screen calls this key's entries while its fallback is live. */
export function describeMappingUnsetEntries(key: AccountMappingKey): string {
  return MAPPING_UNSET_ENTRY_LABELS[key] ?? "entries";
}

export function describeMappingAccountFilter(key: AccountMappingKey): string {
  const filter = MAPPING_ACCOUNT_FILTERS[key];
  const narrowed =
    filter.accountTypes?.length === 1 ? filter.accountTypes[0] : null;
  return (narrowed ?? filter.accountClass).toLowerCase();
}

const MAPPING_UNSET_ENTRY_LABELS: Record<string, string | undefined> = byKey(
  XERO_ACCOUNT_MAPPING_DEFINITIONS,
  (d) => ("unsetEntriesLabel" in d ? d.unsetEntriesLabel : undefined),
);

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
 * cannot come to filter on anything other than the key's declared filter.
 *
 * It matches on the account's CLASS — the one field that means "this is an
 * expense account", and the same field the finance reports classify by (see
 * `xero-account-class.ts`). A chart row whose class the snapshot does not carry
 * still answers the narrower TYPE question, so a key that declares its types
 * keeps offering exactly the accounts it offered before #2717 even then; a key
 * that asks the broad class question drops such a row rather than guess.
 */
export function accountsForMappingKey<
  Account extends { type: string; class?: string | null },
>(key: AccountMappingKey, accounts: readonly Account[]): Account[] {
  const filter = MAPPING_ACCOUNT_FILTERS[key];
  const typeMatches = (account: Account) =>
    filter.accountTypes == null || filter.accountTypes.includes(account.type);
  return accounts.filter((account) => {
    const accountClass = normalizeXeroAccountClass(account.class);
    if (accountClass) return accountClass === filter.accountClass && typeMatches(account);
    return filter.accountTypes != null && typeMatches(account);
  });
}

/**
 * A stored mapping code, or `null` when there is not one (#2717).
 *
 * BLANK IS NOT A CHOICE. A row whose code is an empty string used to read as
 * explicitly configured, which disengaged the fallback and sent an empty
 * `accountCode` to Xero — which rejects it, so the outbox retried for ever.
 * That was true of every key; normalising here fixes all of them at once, and
 * repairs rows already stored that way rather than only new writes.
 */
export function normalizeMappingCode(
  code: string | null | undefined,
): string | null {
  const trimmed = code?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The ONE definition of "this club chose this code" (#2717, `INV-INT-021`).
 *
 * A row with no usable code is a row the club has not decided — the mapping
 * then resolves from the application default, or from the key's registered
 * fallback. The runtime resolver, the account-mappings API and the Xero setup
 * screen all call this, so nobody re-derives configuredness from a null check
 * of their own. It lives in this pure module rather than beside the resolver so
 * the admin picker, which cannot import the database client, can call it on the
 * code an officer has STAGED — a server-sent flag would describe the saved code
 * instead, and go stale the moment the officer typed.
 */
export function isCodeExplicitlyConfigured(
  row: { code: string | null } | null | undefined,
): boolean {
  return normalizeMappingCode(row?.code) != null;
}

/** Every writable key whose `itemCode` column is read at runtime. */
const ITEM_BEARING_KEYS: ReadonlySet<string> = new Set<string>([
  ...XERO_ACCOUNT_MAPPING_DEFINITIONS.filter(
    (definition) => "carriesItemCode" in definition,
  ).map((definition) => definition.key),
  ...XERO_ITEM_ONLY_MAPPING_DEFINITIONS.map((definition) => definition.key),
]);

const ITEM_ONLY_KEYS: ReadonlySet<string> = new Set<string>(
  XERO_ITEM_ONLY_MAPPING_DEFINITIONS.map((definition) => definition.key),
);

/**
 * Why a write to one mapping key is not allowed, or `null` when it is (#2717).
 *
 * The registry says which keys hold an ACCOUNT code and which hold an ITEM
 * code, so the write path can refuse the mix-up instead of storing an edit that
 * silently does nothing — the same reason `entranceFeeAmountCents` is not
 * writable at all (#1931, E5). The goodwill key is the case that forced it: an
 * item code set there while its account code was unset was discarded whole,
 * because the resolver returns the FALLBACK key's resolution verbatim.
 *
 * It judges VALUES, never the account behind them: nothing here can say whether
 * a code names an expense account in the connected Xero organisation, because
 * that needs the chart. `INV-INT-021` states that limit plainly.
 */
export function mappingWriteViolation(
  key: string,
  write: { code?: string | null; itemCode?: string | null },
): string | null {
  if (!(XERO_MAPPING_WRITABLE_KEYS as readonly string[]).includes(key)) {
    return `${key} is not a Xero mapping key`;
  }
  if (normalizeMappingCode(write.code) != null && ITEM_ONLY_KEYS.has(key)) {
    return `${key} selects a Xero Item, not an account: an account code set here is never read`;
  }
  if (normalizeMappingCode(write.itemCode) != null && !ITEM_BEARING_KEYS.has(key)) {
    return `${key} does not carry a Xero Item code: one set here is never read`;
  }
  return null;
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
