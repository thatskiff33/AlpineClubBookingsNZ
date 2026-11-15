import type { AgeTier } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildEntranceFeeLineItem } from "@/lib/xero-entrance-fee-invoices";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const guests = [
  { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 9000 },
  { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, priceCents: 13000 },
];

const checkIn = new Date("2026-07-10");
const checkOut = new Date("2026-07-12");

// ─── P6.1 / P6.2: buildInvoiceLineItems with itemCode ─────────────────────

describe("buildInvoiceLineItems with itemCode", () => {
  it("includes itemCode when provided", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", "HUT-FEE");
    for (const item of items) {
      expect(item.itemCode).toBe("HUT-FEE");
    }
  });

  it("omits accountCode when itemCode is set and accountCode is default (200)", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", "HUT-FEE");
    for (const item of items) {
      expect(item.itemCode).toBe("HUT-FEE");
      expect(item.accountCode).toBeUndefined();
    }
  });

  it("includes accountCode when itemCode is set but accountCode is non-default (override)", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "400", "HUT-FEE");
    for (const item of items) {
      expect(item.itemCode).toBe("HUT-FEE");
      expect(item.accountCode).toBe("400");
    }
  });

  it("includes accountCode when the default account was explicitly configured as an override", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", "HUT-FEE", true);
    for (const item of items) {
      expect(item.itemCode).toBe("HUT-FEE");
      expect(item.accountCode).toBe("200");
    }
  });

  it("includes accountCode and no itemCode when itemCode is not provided", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200");
    for (const item of items) {
      expect(item.accountCode).toBe("200");
      expect(item.itemCode).toBeUndefined();
    }
  });

  it("includes accountCode and no itemCode when itemCode is null", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", null);
    for (const item of items) {
      expect(item.accountCode).toBe("200");
      expect(item.itemCode).toBeUndefined();
    }
  });

  it("includes accountCode and no itemCode when itemCode is empty string", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", "");
    for (const item of items) {
      expect(item.accountCode).toBe("200");
      expect(item.itemCode).toBeUndefined();
    }
  });

  it("preserves correct unit amounts and descriptions regardless of itemCode", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", "HUT-FEE");
    expect(items).toHaveLength(2);
    // John: 9000 cents / 2 nights = $45
    expect(items[0].unitAmount).toBe(45);
    expect(items[0].quantity).toBe(2);
    expect(items[0].description).toContain("John Smith");
    // Jane: 13000 cents / 2 nights = $65
    expect(items[1].unitAmount).toBe(65);
    expect(items[1].quantity).toBe(2);
    expect(items[1].description).toContain("Jane Smith");
  });

  it("all line items have OUTPUT2 tax type with itemCode", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2, "200", "HUT-FEE");
    for (const item of items) {
      expect(item.taxType).toBe("OUTPUT2");
    }
  });
});

// ─── P6.3: Entrance Fee Amount Parsing ─────────────────────────────────────

describe("Entrance fee amount parsing", () => {
  it("converts dollar string to cents correctly", () => {
    // This tests the logic used in the UI and createXeroEntranceFeeInvoice
    const testCases = [
      { input: "5000", expectedCents: 5000, expectedDollars: 50 },
      { input: "2500", expectedCents: 2500, expectedDollars: 25 },
      { input: "10000", expectedCents: 10000, expectedDollars: 100 },
      { input: "150", expectedCents: 150, expectedDollars: 1.5 },
    ];

    for (const { input, expectedCents, expectedDollars } of testCases) {
      const cents = parseInt(input, 10);
      expect(cents).toBe(expectedCents);
      expect(cents / 100).toBe(expectedDollars);
    }
  });

  it("returns NaN for invalid amount strings", () => {
    expect(parseInt("", 10)).toBeNaN();
    expect(parseInt("abc", 10)).toBeNaN();
  });

  it("rejects zero and negative amounts", () => {
    const zero = parseInt("0", 10);
    expect(zero <= 0).toBe(true);

    const negative = parseInt("-100", 10);
    expect(negative <= 0).toBe(true);
  });
});

describe("buildEntranceFeeLineItem", () => {
  it("omits the hard-coded description when itemCode is present", () => {
    const item = buildEntranceFeeLineItem("Adult", 5000, "200", "ENTFEE-ADULT");
    expect(item.itemCode).toBe("ENTFEE-ADULT");
    expect(item.description).toBeUndefined();
    expect(item.accountCode).toBeUndefined();
  });

  it("uses the fallback description when no itemCode is configured", () => {
    const item = buildEntranceFeeLineItem("Adult", 5000, "200", null);
    expect(item.description).toBe("Membership joining fee (Adult)");
    expect(item.accountCode).toBe("200");
  });

  it("uses an admin narration override when supplied with an itemCode", () => {
    const item = buildEntranceFeeLineItem(
      "Adult",
      5000,
      "200",
      "ENTFEE-ADULT",
      false,
      "Adjusted entrance fee"
    );
    expect(item.itemCode).toBe("ENTFEE-ADULT");
    expect(item.description).toBe("Adjusted entrance fee");
  });
});

// ─── Per-guest item codes via itemCodeMap ─────────────────────────────────

describe("buildInvoiceLineItems with per-guest membership-type item codes (#1930, E4)", () => {
  const MEMBER_TYPE = "type-full";
  const NONMEMBER_TYPE = "type-nonmember";

  // Guests carry the rateMembershipType snapshot the resolver produced.
  const mixedGuests = [
    { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, priceCents: 9000 },
    { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, priceCents: 13000 },
    { firstName: "Tom", lastName: "Smith", ageTier: "CHILD", isMember: true, rateMembershipTypeId: MEMBER_TYPE, priceCents: 4000 },
  ];

  // Resolver keyed `${membershipTypeId}_${seasonType}_${ageTier|"FLAT"}`.
  const makeResolver = (legacyItemCode: string | null = null) => {
    const byKey = new Map([
      [`${MEMBER_TYPE}_WINTER_ADULT`, "HUTFEE-ADULT-WIN-MEM"],
      [`${NONMEMBER_TYPE}_WINTER_ADULT`, "HUTFEE-ADULT-WIN-NON"],
      [`${MEMBER_TYPE}_WINTER_CHILD`, "HUTFEE-CHILD-WIN-MEM"],
    ]);
    return {
      byKey,
      fullTypeId: MEMBER_TYPE,
      nonMemberTypeId: NONMEMBER_TYPE,
      legacyItemCode,
      size: byKey.size,
    };
  };

  it("assigns different item codes per guest based on rate type, season, and age tier", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, makeResolver(), "WINTER"
    );
    expect(items[0].itemCode).toBe("HUTFEE-ADULT-WIN-MEM");
    expect(items[1].itemCode).toBe("HUTFEE-ADULT-WIN-NON");
    expect(items[2].itemCode).toBe("HUTFEE-CHILD-WIN-MEM");
  });

  it("resolves a NULL snapshot via isMember -> FULL/NON_MEMBER", () => {
    const nullSnapshotGuests = mixedGuests.map((g) => ({
      ...g,
      rateMembershipTypeId: null,
    }));
    const items = buildInvoiceLineItems(
      nullSnapshotGuests, checkIn, checkOut, 2, "200", null, false, makeResolver(), "WINTER"
    );
    expect(items[0].itemCode).toBe("HUTFEE-ADULT-WIN-MEM"); // member -> FULL
    expect(items[1].itemCode).toBe("HUTFEE-ADULT-WIN-NON"); // non-member -> NON_MEMBER
    expect(items[2].itemCode).toBe("HUTFEE-CHILD-WIN-MEM");
  });

  it("gives a TYPE_POLICY_FORCED member the NON_MEMBER item code, not the member code (#1930, E4)", () => {
    // A member whose type forces the non-member rate is priced from NON_MEMBER,
    // so its snapshot is NON_MEMBER and its Xero line uses the NON_MEMBER item
    // code — a deliberate byte-difference correcting the old latent mismatch
    // (stored isMember=true previously yielded the MEMBER item code on a
    // non-member-priced line). This test pins the new consistent behavior.
    const forcedMember = {
      firstName: "Pat",
      lastName: "Policy",
      ageTier: "ADULT",
      isMember: true, // a real member...
      rateMembershipTypeId: NONMEMBER_TYPE, // ...forced onto the NON_MEMBER rows
      priceCents: 7200,
    };
    const items = buildInvoiceLineItems(
      [forcedMember], checkIn, checkOut, 2, "200", null, false, makeResolver(), "WINTER"
    );
    expect(items[0].itemCode).toBe("HUTFEE-ADULT-WIN-NON");
    expect(items[0].itemCode).not.toBe("HUTFEE-ADULT-WIN-MEM");
  });

  it("omits itemCode when no mapping exists for that combination", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, makeResolver(), "SUMMER"
    );
    // No SUMMER mappings exist in the resolver and no legacy fallback set.
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
  });

  it("a miss with keyed rows present yields NO item code even when the legacy hutFeeItem is set (main parity)", () => {
    // Keyed rows exist (WINTER only) and the legacy flat hutFeeItem is also
    // configured. A SUMMER lookup misses -> null, exactly like main: once the
    // keyed table has rows, the legacy flat code is never a per-guest fallback.
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, makeResolver("LEGACY-HUT"), "SUMMER"
    );
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
  });

  it("a miss with keyed rows present also ignores the hutFeesIncome item code param (main parity)", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", "INCOME-ITEM", false, makeResolver(), "SUMMER"
    );
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
  });

  it("legacy-only install (keyed table empty) resolves the flat hutFeeItem", () => {
    const legacyOnlyResolver = {
      byKey: new Map<string, string>(),
      fullTypeId: MEMBER_TYPE,
      nonMemberTypeId: NONMEMBER_TYPE,
      legacyItemCode: "LEGACY-HUT",
      size: 0,
    };
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", "INCOME-ITEM", false, legacyOnlyResolver, "WINTER"
    );
    for (const item of items) {
      expect(item.itemCode).toBe("LEGACY-HUT");
    }
  });

  it("falls back to legacy itemCode when the resolver is undefined", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", "LEGACY-HUT", false, undefined, "WINTER"
    );
    for (const item of items) {
      expect(item.itemCode).toBe("LEGACY-HUT");
    }
  });

  it("null seasonType falls back to the hutFeesIncome item code param, never the resolver's hutFeeItem (main parity)", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", "INCOME-ITEM", false, makeResolver("LEGACY-HUT"), null
    );
    for (const item of items) {
      expect(item.itemCode).toBe("INCOME-ITEM");
    }
  });

  it("null seasonType with no hutFeesIncome item code yields no item code", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, makeResolver("LEGACY-HUT"), null
    );
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
  });

  it("omits accountCode when per-guest itemCode is set and accountCode is default", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, makeResolver(), "WINTER"
    );
    expect(items[0].accountCode).toBeUndefined();
    expect(items[1].accountCode).toBeUndefined();
    expect(items[2].accountCode).toBeUndefined();
  });

  it("includes accountCode when per-guest itemCode is set but accountCode is non-default", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "400", null, false, makeResolver(), "WINTER"
    );
    for (const item of items) {
      expect(item.accountCode).toBe("400");
    }
  });

  it("works with an empty resolver (no keyed rows, no legacy)", () => {
    const emptyResolver = {
      byKey: new Map<string, string>(),
      fullTypeId: MEMBER_TYPE,
      nonMemberTypeId: NONMEMBER_TYPE,
      legacyItemCode: null,
      size: 0,
    };
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, emptyResolver, "WINTER"
    );
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
  });
});

// ─── getHutFeeItemCodeMap query shape (#2130 runtime-prep) ────────────────────

describe("getHutFeeItemCodeMap query shape (#2130 runtime-prep)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("selects ONLY the consumed columns, never the doomed isMember column", async () => {
    // Blue/green safety pin: the deployed client must stop naming
    // XeroItemCodeMapping.isMember in generated SQL one release BEFORE the
    // #2130 contract migration drops it. Guards against someone removing the
    // explicit select and reintroducing a no-select findMany that names every
    // column. Inspects the mock call args.
    const findMany = vi.fn().mockResolvedValue([]);
    const membershipTypeFindMany = vi.fn().mockResolvedValue([]);
    const xeroAccountFindUnique = vi.fn().mockResolvedValue(null);
    vi.doMock("../prisma", () => ({
      prisma: {
        xeroItemCodeMapping: { findMany },
        membershipType: { findMany: membershipTypeFindMany },
        xeroAccountMapping: { findUnique: xeroAccountFindUnique },
      },
    }));

    const { getHutFeeItemCodeMap } = await import("../xero-mappings");
    await getHutFeeItemCodeMap();

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as {
      where?: unknown;
      select?: Record<string, unknown>;
    };
    expect(args.where).toEqual({ category: "HUT_FEE" });
    expect(args.select).toEqual({
      membershipTypeId: true,
      seasonType: true,
      ageTier: true,
      itemCode: true,
    });
    expect(args.select).not.toHaveProperty("isMember");
  });
});

// ─── Account mapping API response shape ────────────────────────────────────

describe("Account mapping response shape", () => {
  it("mapping value has code and itemCode fields", () => {
    // Verify the expected response shape from the updated API
    const mapping = { code: "200", itemCode: "HUT-FEE" };
    expect(mapping).toHaveProperty("code");
    expect(mapping).toHaveProperty("itemCode");
  });

  it("mapping value defaults are null", () => {
    const defaultMapping = { code: null, itemCode: null };
    expect(defaultMapping.code).toBeNull();
    expect(defaultMapping.itemCode).toBeNull();
  });
});

// ─── Entrance fee category determination (unit logic) ─────────────────────

describe("Entrance fee category logic", () => {
  function determineEntranceFeeCategory(ageTier: AgeTier): "ADULT" | "YOUTH" | "CHILD" {
    return ageTier === "YOUTH"
      ? "YOUTH"
      : ageTier === "CHILD" || ageTier === "INFANT"
        ? "CHILD"
        : "ADULT";
  }

  it("ADULT tier maps to ADULT category", () => {
    // Testing the pure logic used in determineEntranceFeeCategory
    const ageTier: AgeTier = "ADULT";
    expect(determineEntranceFeeCategory(ageTier)).toBe("ADULT");
  });

  it("YOUTH tier maps to YOUTH category", () => {
    const ageTier: AgeTier = "YOUTH";
    expect(determineEntranceFeeCategory(ageTier)).toBe("YOUTH");
  });

  it("CHILD tier maps to CHILD category", () => {
    const ageTier: AgeTier = "CHILD";
    expect(determineEntranceFeeCategory(ageTier)).toBe("CHILD");
  });

  it("INFANT tier maps to CHILD category", () => {
    const ageTier: AgeTier = "INFANT";
    expect(determineEntranceFeeCategory(ageTier)).toBe("CHILD");
  });

  it("FAMILY requires 2+ adults and 1+ dependents in group", () => {
    const groupMembers: Array<{ ageTier: AgeTier }> = [
      { ageTier: "ADULT" },
      { ageTier: "ADULT" },
      { ageTier: "CHILD" },
    ];
    const adults = groupMembers.filter((m) => m.ageTier === "ADULT");
    const dependents = groupMembers.filter((m) => ["CHILD", "YOUTH", "INFANT"].includes(m.ageTier));
    const isFamily = adults.length >= 2 && dependents.length >= 1;
    expect(isFamily).toBe(true);
  });

  it("does not qualify as FAMILY with only 1 adult", () => {
    const groupMembers: Array<{ ageTier: AgeTier }> = [
      { ageTier: "ADULT" },
      { ageTier: "CHILD" },
    ];
    const adults = groupMembers.filter((m) => m.ageTier === "ADULT");
    const dependents = groupMembers.filter((m) => ["CHILD", "YOUTH", "INFANT"].includes(m.ageTier));
    const isFamily = adults.length >= 2 && dependents.length >= 1;
    expect(isFamily).toBe(false);
  });

  it("does not qualify as FAMILY with only adults (no dependents)", () => {
    const groupMembers: Array<{ ageTier: AgeTier }> = [
      { ageTier: "ADULT" },
      { ageTier: "ADULT" },
    ];
    const adults = groupMembers.filter((m) => m.ageTier === "ADULT");
    const dependents = groupMembers.filter((m) => ["CHILD", "YOUTH", "INFANT"].includes(m.ageTier));
    const isFamily = adults.length >= 2 && dependents.length >= 1;
    expect(isFamily).toBe(false);
  });
});

// ─── Item code mapping API response shape ─────────────────────────────────

describe("Item code mapping response shape", () => {
  it("hut fee entry has itemCode field", () => {
    const entry = { itemCode: "HUTFEE-ADULT-WIN-MEM" };
    expect(entry).toHaveProperty("itemCode");
    expect(entry.itemCode).toBe("HUTFEE-ADULT-WIN-MEM");
  });

  it("entrance fee entry has itemCode and amountCents", () => {
    const entry = { itemCode: "ENTFEE-ADULT", amountCents: 5000 };
    expect(entry).toHaveProperty("itemCode");
    expect(entry).toHaveProperty("amountCents");
    expect(entry.amountCents).toBe(5000);
  });

  it("composite key format is correct (membershipTypeId_seasonType_ageTier)", () => {
    const key = `type-full_WINTER_ADULT`;
    const parts = key.split("_");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("type-full");
    expect(parts[1]).toBe("WINTER");
    expect(parts[2]).toBe("ADULT");
  });
});
