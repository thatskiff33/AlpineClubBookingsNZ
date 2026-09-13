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
  MAPPING_DESCRIPTIONS,
  MAPPING_LABELS,
  MAPPING_TYPE_FILTER,
  XERO_ACCOUNT_MAPPING_DEFINITIONS,
  XERO_ITEM_ONLY_MAPPING_DEFINITIONS,
  XERO_MAPPING_WRITABLE_KEYS,
  isAccountMappingKey,
  resolveAccountMappingSource,
  type AccountMappingKey,
} from "@/lib/xero-account-mapping-keys";
import {
  getResolvedAccountMapping,
  getResolvedAccountMappingWithFallback,
  isCodeExplicitlyConfigured,
} from "@/lib/xero-mappings";

const ACCOUNT_TYPES = ["REVENUE", "EXPENSE", "BANK"];

describe("INV-INT-021: every account mapping key carries a type filter", () => {
  it("names exactly one Xero account type per key, with no key left out", () => {
    for (const definition of XERO_ACCOUNT_MAPPING_DEFINITIONS) {
      expect(ACCOUNT_TYPES).toContain(definition.accountType);
      // The picker reads the derived record, so a key missing from it would
      // render an unfiltered account list — every Xero account, of every type.
      expect(MAPPING_TYPE_FILTER[definition.key]).toBe(definition.accountType);
    }
    expect(Object.keys(MAPPING_TYPE_FILTER).sort()).toEqual(
      [...ACCOUNT_MAPPING_KEYS].sort(),
    );
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
    expect(MAPPING_TYPE_FILTER.goodwillWriteOffs).toBe("EXPENSE");
  });

  it("falls back to hutFeeRefunds and ships with no default code of its own", () => {
    expect(ACCOUNT_MAPPING_FALLBACK_KEYS.goodwillWriteOffs).toBe("hutFeeRefunds");
    expect(ACCOUNT_MAPPING_DEFAULTS.goodwillWriteOffs).toBeNull();
  });

  it("is offered in the setup screen, so the unset state is discoverable", () => {
    expect(ACCOUNT_MAPPING_KEYS).toContain("goodwillWriteOffs");
  });

  it("leaves the ordinary refund mapping on REVENUE, untouched", () => {
    expect(MAPPING_TYPE_FILTER.hutFeeRefunds).toBe("REVENUE");
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
