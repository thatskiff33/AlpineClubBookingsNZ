/**
 * `INV-INT-021` — the house rule for Xero account mapping keys (#2717).
 *
 * A new mapping key names the Xero account TYPE its picker may offer, says what
 * it does while unset, and is surfaced in the Xero setup screen until a club
 * configures it. This file pins all three, plus the one-hop fallback resolution
 * both the runtime resolver and the setup screen share.
 *
 * It deliberately tests the REGISTRY rather than any one key: the point of
 * #2717 was to stop the key set being spelled out in four places that could
 * drift apart, so the guard is that every consumer's view of a key is total.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const rows = new Map<string, { code: string | null; itemCode: string | null }>();
  return {
    rows,
    prismaStub: {
      xeroAccountMapping: {
        findUnique: async ({ where }: { where: { key: string } }) =>
          rows.get(where.key) ?? null,
      },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prismaStub }));

import {
  ACCOUNT_MAPPING_DEFAULTS,
  ACCOUNT_MAPPING_FALLBACK_KEYS,
  ACCOUNT_MAPPING_KEYS,
  accountsForMappingKey,
  MAPPING_DESCRIPTIONS,
  MAPPING_LABELS,
  describeMappingAccountFilter,
  MAPPING_ACCOUNT_FILTERS,
  XERO_ACCOUNT_MAPPING_DEFINITIONS,
  XERO_ITEM_ONLY_MAPPING_DEFINITIONS,
  XERO_MAPPING_WRITABLE_KEYS,
  isAccountMappingKey,
  mappingWriteViolation,
  normalizeMappingCode,
  resolveAccountMappingSource,
  type AccountMappingKey,
} from "@/lib/xero-account-mapping-keys";
import {
  XERO_ACCOUNT_CLASSES,
  normalizeXeroAccountClass,
} from "@/lib/xero-account-class";
import {
  getResolvedAccountMapping,
  getResolvedAccountMappingWithFallback,
  isCodeExplicitlyConfigured,
} from "@/lib/xero-mappings";

/**
 * Xero's `Type` values that belong to each `Class`, for the narrowings this
 * product declares. Deliberately NOT a full provider taxonomy: the registry
 * filters on class and narrows only where a key asks for less, so this table
 * only has to cover the types the definitions actually name.
 */
const TYPES_BY_CLASS: Record<string, readonly string[]> = {
  REVENUE: ["REVENUE", "SALES", "OTHERINCOME"],
  EXPENSE: ["EXPENSE", "OVERHEADS", "DIRECTCOSTS", "DEPRECIATN"],
  ASSET: ["BANK", "CURRENT", "FIXED", "INVENTORY", "NONCURRENT", "PREPAYMENT"],
};

describe("INV-INT-021: every account mapping key carries an account filter", () => {
  it("names exactly one Xero account CLASS per key, with no key left out", () => {
    for (const definition of XERO_ACCOUNT_MAPPING_DEFINITIONS) {
      expect(XERO_ACCOUNT_CLASSES).toContain(definition.accountClass);
      // The picker reads the derived record, so a key missing from it would
      // render an unfiltered account list — every Xero account, of every kind.
      expect(MAPPING_ACCOUNT_FILTERS[definition.key].accountClass).toBe(
        definition.accountClass,
      );
    }
    expect(Object.keys(MAPPING_ACCOUNT_FILTERS).sort()).toEqual(
      [...ACCOUNT_MAPPING_KEYS].sort(),
    );
  });

  it("keeps every declared type narrowing INSIDE its declared class", () => {
    // A narrowing that stepped outside its class would silently offer the wrong
    // kind of account while the registry still claimed the right class.
    for (const definition of XERO_ACCOUNT_MAPPING_DEFINITIONS) {
      const narrowing: readonly string[] =
        "accountTypes" in definition ? definition.accountTypes : [];
      for (const type of narrowing) {
        expect(TYPES_BY_CLASS[definition.accountClass] ?? []).toContain(type);
      }
    }
  });

  it("describes each filter in a word the setup screen can put in a sentence", () => {
    expect(describeMappingAccountFilter("goodwillWriteOffs")).toBe("expense");
    expect(describeMappingAccountFilter("stripeBankAccount")).toBe("bank");
    expect(describeMappingAccountFilter("hutFeeRefunds")).toBe("revenue");
  });

  it("gives every key a label and a description the setup screen can render", () => {
    for (const key of XERO_MAPPING_WRITABLE_KEYS) {
      expect(MAPPING_LABELS[key]?.length ?? 0).toBeGreaterThan(0);
      expect(MAPPING_DESCRIPTIONS[key]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gives every key a default-code entry — null meaning optional, never absent", () => {
    for (const definition of XERO_ACCOUNT_MAPPING_DEFINITIONS) {
      expect(Object.keys(ACCOUNT_MAPPING_DEFAULTS)).toContain(definition.key);
      expect(ACCOUNT_MAPPING_DEFAULTS[definition.key]).toBe(definition.defaultCode);
    }
  });

  it("keeps every key unique across the account and item-only registries", () => {
    const keys = XERO_MAPPING_WRITABLE_KEYS;
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(
      XERO_ACCOUNT_MAPPING_DEFINITIONS.length +
        XERO_ITEM_ONLY_MAPPING_DEFINITIONS.length,
    );
  });

  it("resolves a fallback in ONE hop, to a real account key that has none itself", () => {
    for (const [key, fallbackKey] of Object.entries(ACCOUNT_MAPPING_FALLBACK_KEYS)) {
      expect(isAccountMappingKey(fallbackKey as string)).toBe(true);
      expect(fallbackKey).not.toBe(key);
      // A chain would make "where do my goodwill entries go?" unanswerable from
      // one row of the setup screen, and the resolver deliberately does not walk
      // one — so a definition that needed a chain must fail here instead.
      expect(
        ACCOUNT_MAPPING_FALLBACK_KEYS[fallbackKey as AccountMappingKey],
      ).toBeUndefined();
    }
  });
});

describe("goodwillWriteOffs — the owner's 10 Aug 2026 decision, pinned", () => {
  it("is filtered to EXPENSE accounts, because goodwill is a cost not a discount", () => {
    // Revenue stays at what was billed and goodwill shows as its own cost line.
    // A REVENUE filter here would put it back to contra-revenue silently.
    expect(MAPPING_ACCOUNT_FILTERS.goodwillWriteOffs.accountClass).toBe("EXPENSE");
  });

  it("offers the WHOLE expense class, not just accounts typed EXPENSE", () => {
    // The bug this pins: Xero's type enumeration has four expense-class values,
    // and on the standard New Zealand chart the range a treasurer puts
    // write-offs in is typed OVERHEADS. Narrowed to type EXPENSE the picker
    // renders only its empty-state message, with no explanation and no
    // override, and the club stays on the fallback for ever — which arrives at
    // "you may not configure this", the neighbour of the option the owner
    // explicitly rejected.
    expect(MAPPING_ACCOUNT_FILTERS.goodwillWriteOffs.accountTypes).toBeUndefined();
    const nzStandardChart = [
      { code: "200", name: "Sales", type: "REVENUE", class: "REVENUE" },
      { code: "404", name: "Bank Fees", type: "OVERHEADS", class: "EXPENSE" },
      { code: "429", name: "General Expenses", type: "OVERHEADS", class: "EXPENSE" },
      { code: "310", name: "Cost of Goods Sold", type: "DIRECTCOSTS", class: "EXPENSE" },
      { code: "620", name: "Prepayments", type: "PREPAYMENT", class: "ASSET" },
    ];
    expect(
      accountsForMappingKey("goodwillWriteOffs", nzStandardChart).map((a) => a.code),
    ).toEqual(["404", "429", "310"]);
  });

  it("still offers a class-less chart row to a key that declares its types", () => {
    // A snapshot Xero returned without a Class must not empty a picker that has
    // worked since before #2717; the narrower type question still answers it.
    const noClass = [{ code: "200", name: "Hut Fees", type: "REVENUE", class: "" }];
    expect(accountsForMappingKey("hutFeeRefunds", noClass).map((a) => a.code)).toEqual([
      "200",
    ]);
    expect(accountsForMappingKey("goodwillWriteOffs", noClass)).toEqual([]);
    expect(normalizeXeroAccountClass("")).toBeNull();
  });

  it("falls back to hutFeeRefunds and ships with no default code of its own", () => {
    expect(ACCOUNT_MAPPING_FALLBACK_KEYS.goodwillWriteOffs).toBe("hutFeeRefunds");
    expect(ACCOUNT_MAPPING_DEFAULTS.goodwillWriteOffs).toBeNull();
  });

  it("offers the picker EXPENSE accounts only, and never a revenue or bank one", () => {
    const chartOfAccounts = [
      { code: "200", name: "Hut Fees", type: "REVENUE", class: "REVENUE" },
      { code: "404", name: "Goodwill", type: "EXPENSE", class: "EXPENSE" },
      { code: "477", name: "Donations Made", type: "OVERHEADS", class: "EXPENSE" },
      { code: "606", name: "Business Bank Account", type: "BANK", class: "ASSET" },
    ];
    expect(
      accountsForMappingKey("goodwillWriteOffs", chartOfAccounts).map((a) => a.code),
    ).toEqual(["404", "477"]);
    // The refund mapping is unchanged and still offers revenue accounts.
    expect(
      accountsForMappingKey("hutFeeRefunds", chartOfAccounts).map((a) => a.code),
    ).toEqual(["200"]);
  });

  it("is offered in the setup screen, so the unset state is discoverable", () => {
    expect(ACCOUNT_MAPPING_KEYS).toContain("goodwillWriteOffs");
  });

  it("leaves the ordinary refund mapping on REVENUE, untouched", () => {
    expect(MAPPING_ACCOUNT_FILTERS.hutFeeRefunds.accountClass).toBe("REVENUE");
    expect(MAPPING_ACCOUNT_FILTERS.hutFeeRefunds.accountTypes).toEqual(["REVENUE"]);
    expect(ACCOUNT_MAPPING_FALLBACK_KEYS.hutFeeRefunds).toBeUndefined();
  });
});

describe("resolveAccountMappingSource — one rule, shared by runtime and setup", () => {
  it("uses the key's own mapping once the club has configured it", () => {
    expect(resolveAccountMappingSource("goodwillWriteOffs", true)).toEqual({
      sourceKey: "goodwillWriteOffs",
      usingFallback: false,
    });
  });

  it("uses the registered fallback while the key is unset", () => {
    expect(resolveAccountMappingSource("goodwillWriteOffs", false)).toEqual({
      sourceKey: "hutFeeRefunds",
      usingFallback: true,
    });
  });

  it("never reports a fallback for a key that registers none", () => {
    expect(resolveAccountMappingSource("stripeFees", false)).toEqual({
      sourceKey: "stripeFees",
      usingFallback: false,
    });
  });
});

describe("isCodeExplicitlyConfigured — the one definition of a club's own choice", () => {
  it("is true only for a row carrying a code", () => {
    expect(isCodeExplicitlyConfigured({ code: "404" })).toBe(true);
    expect(isCodeExplicitlyConfigured({ code: null })).toBe(false);
    expect(isCodeExplicitlyConfigured(null)).toBe(false);
    expect(isCodeExplicitlyConfigured(undefined)).toBe(false);
  });

  it("treats a BLANK code as unset, not as a choice", () => {
    // Stored blank it used to read as configured, which disengaged the key's
    // fallback and sent an empty accountCode to Xero — rejected, so the outbox
    // retried for ever. True of every key, so the one normalisation fixes all.
    expect(isCodeExplicitlyConfigured({ code: "" })).toBe(false);
    expect(isCodeExplicitlyConfigured({ code: "   " })).toBe(false);
    expect(normalizeMappingCode(" 404 ")).toBe("404");
    expect(normalizeMappingCode("")).toBeNull();
  });
});

describe("getResolvedAccountMappingWithFallback (INV-INT-021)", () => {
  beforeEach(() => {
    h.rows.clear();
  });

  it("returns the club's chosen expense account once goodwill is configured", async () => {
    h.rows.set("hutFeeRefunds", { code: "200", itemCode: "REFUND-ITEM" });
    h.rows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    const resolved = await getResolvedAccountMappingWithFallback("goodwillWriteOffs");
    expect(resolved).toEqual({
      code: "404",
      itemCode: null,
      codeExplicitlyConfigured: true,
      sourceKey: "goodwillWriteOffs",
      usingFallback: false,
    });
  });

  it("returns the hutFeeRefunds mapping VERBATIM while goodwill is unset", async () => {
    // Upgrade safety: the item code and the configured-ness flag come across
    // too, because the call site's line-coding decision reads both. Anything
    // less than verbatim changes where an existing club's entries land.
    h.rows.set("hutFeeRefunds", { code: "202", itemCode: "REFUND-ITEM" });
    const resolved = await getResolvedAccountMappingWithFallback("goodwillWriteOffs");
    expect(resolved).toEqual({
      code: "202",
      itemCode: "REFUND-ITEM",
      codeExplicitlyConfigured: true,
      sourceKey: "hutFeeRefunds",
      usingFallback: true,
    });
    expect(resolved).toMatchObject(
      await getResolvedAccountMapping("hutFeeRefunds"),
    );
  });

  it("falls through to the fallback's application default when neither is set", async () => {
    const resolved = await getResolvedAccountMappingWithFallback("goodwillWriteOffs");
    expect(resolved).toEqual({
      code: "200",
      itemCode: null,
      codeExplicitlyConfigured: false,
      sourceKey: "hutFeeRefunds",
      usingFallback: true,
    });
  });

  it("treats a row whose code is null as unset, not as a choice", async () => {
    h.rows.set("goodwillWriteOffs", { code: null, itemCode: null });
    h.rows.set("hutFeeRefunds", { code: "202", itemCode: null });
    const resolved = await getResolvedAccountMappingWithFallback("goodwillWriteOffs");
    expect(resolved.usingFallback).toBe(true);
    expect(resolved.code).toBe("202");
  });

  it("behaves exactly like the plain resolver for a key with no fallback", async () => {
    h.rows.set("hutFeesIncome", { code: "201", itemCode: null });
    await expect(
      getResolvedAccountMappingWithFallback("hutFeesIncome"),
    ).resolves.toEqual({
      ...(await getResolvedAccountMapping("hutFeesIncome")),
      sourceKey: "hutFeesIncome",
      usingFallback: false,
    });
  });
});

/**
 * The picker and the finance reports must not hold two answers to "is this an
 * expense account?" (#2717, `INV-SSOT-001`).
 *
 * Before #2717 they did: the picker compared the account TYPE to "EXPENSE"
 * while the profit-and-loss view and the ratio explorer classified by the
 * account CLASS — and the two disagree on the very range a treasurer puts
 * write-offs in. Read from disk because the rule is about which helper each
 * module NAMES; no behavioural test states it as plainly.
 */
describe("INV-SSOT-001: one reading of a Xero account's class", () => {
  const CLASS_READERS = [
    "src/lib/finance-monthly-pnl.ts",
    "src/lib/finance-ratio-insights.ts",
    "src/lib/xero-account-mapping-keys.ts",
  ];

  it.each(CLASS_READERS)("%s reads the class through the one module", async (file) => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(file), "utf-8");
    expect(
      source.includes("normalizeXeroAccountClass"),
      `${file} classifies a Xero account without the one helper (INV-SSOT-001)`,
    ).toBe(true);
    expect(
      /accountClass\?\.toUpperCase\(\)\s*===/.test(source),
      `${file} compares a raw account class string; route it through ` +
        "normalizeXeroAccountClass so the admin pickers and these reports " +
        "cannot drift apart (INV-SSOT-001, #2717)",
    ).toBe(false);
  });
});

/**
 * What the write path refuses, and what `INV-INT-021` does NOT claim.
 *
 * The registry knows which keys hold an account code and which hold an item
 * code, so the mix-up is refused rather than stored as an edit that does
 * nothing. It does NOT know a club's chart of accounts, so it cannot say
 * whether a code names an expense account — the invariant states that limit
 * plainly rather than claiming a guarantee the mechanism does not hold.
 */
describe("mappingWriteViolation (#2717)", () => {
  it("refuses an account code on an item-only key", () => {
    expect(mappingWriteViolation("hutFeeItem", { code: "200" })).toMatch(
      /never read/,
    );
  });

  it("refuses an item code on a key that does not carry one", () => {
    expect(
      mappingWriteViolation("goodwillWriteOffs", { itemCode: "REFUND-ITEM" }),
    ).toMatch(/never read/);
    expect(mappingWriteViolation("stripeFees", { itemCode: "X" })).not.toBeNull();
  });

  it("refuses a key the registry does not know", () => {
    expect(mappingWriteViolation("entranceFeeAmountCents", { code: "5000" }))
      .toMatch(/not a Xero mapping key/);
  });

  it("allows the writes each key really supports", () => {
    expect(mappingWriteViolation("goodwillWriteOffs", { code: "429" })).toBeNull();
    expect(
      mappingWriteViolation("membershipCancellationCredit", {
        code: "203",
        itemCode: "CANCEL-CREDIT",
      }),
    ).toBeNull();
    expect(mappingWriteViolation("hutFeeItem", { itemCode: "HUT" })).toBeNull();
  });

  it("always allows clearing a column, on every key", () => {
    for (const key of XERO_MAPPING_WRITABLE_KEYS) {
      expect(mappingWriteViolation(key, { code: null, itemCode: null })).toBeNull();
    }
  });

  it("does NOT judge whether a code names the right kind of account", () => {
    // Stated, not hidden: a revenue code on the goodwill key is accepted here,
    // because answering needs the connected org's chart. INV-INT-021 says so,
    // and the setup screen flags a stored code that is outside the filter.
    expect(mappingWriteViolation("goodwillWriteOffs", { code: "200" })).toBeNull();
  });
});

describe("the picker's credit-item rows stay anchored to the registry (#2717)", () => {
  it("lists only writable keys that really carry an item code", async () => {
    const { CREDIT_ITEM_MAPPING_KEYS } = await import(
      "@/app/(admin)/admin/xero/_components/shared"
    );
    for (const key of CREDIT_ITEM_MAPPING_KEYS) {
      expect(XERO_MAPPING_WRITABLE_KEYS).toContain(key);
      expect(mappingWriteViolation(key, { itemCode: "SOME-ITEM" })).toBeNull();
    }
  });
});
