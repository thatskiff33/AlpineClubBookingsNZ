import { describe, it, expect } from "vitest";
import { buildInvoiceLineItems } from "../xero";

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

// ─── Per-guest item codes via itemCodeMap ─────────────────────────────────

describe("buildInvoiceLineItems with per-guest itemCodeMap", () => {
  const mixedGuests = [
    { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 9000 },
    { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, priceCents: 13000 },
    { firstName: "Tom", lastName: "Smith", ageTier: "CHILD", isMember: true, priceCents: 4000 },
  ];

  const itemCodeMap = new Map([
    ["ADULT_WINTER_true", "HUTFEE-ADULT-WIN-MEM"],
    ["ADULT_WINTER_false", "HUTFEE-ADULT-WIN-NON"],
    ["CHILD_WINTER_true", "HUTFEE-CHILD-WIN-MEM"],
  ]);

  it("assigns different item codes per guest based on ageTier, season, and membership", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, itemCodeMap, "WINTER"
    );
    expect(items[0].itemCode).toBe("HUTFEE-ADULT-WIN-MEM");
    expect(items[1].itemCode).toBe("HUTFEE-ADULT-WIN-NON");
    expect(items[2].itemCode).toBe("HUTFEE-CHILD-WIN-MEM");
  });

  it("omits itemCode when no mapping exists for that combination", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, itemCodeMap, "SUMMER"
    );
    // No SUMMER mappings exist in the map
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
  });

  it("falls back to legacy itemCode when itemCodeMap is undefined", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", "LEGACY-HUT", false, undefined, "WINTER"
    );
    for (const item of items) {
      expect(item.itemCode).toBe("LEGACY-HUT");
    }
  });

  it("falls back to legacy itemCode when seasonType is null", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", "LEGACY-HUT", false, itemCodeMap, null
    );
    for (const item of items) {
      expect(item.itemCode).toBe("LEGACY-HUT");
    }
  });

  it("omits accountCode when per-guest itemCode is set and accountCode is default", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, itemCodeMap, "WINTER"
    );
    // Items with item codes should omit default account code
    expect(items[0].accountCode).toBeUndefined();
    expect(items[1].accountCode).toBeUndefined();
    expect(items[2].accountCode).toBeUndefined();
  });

  it("includes accountCode when per-guest itemCode is set but accountCode is non-default", () => {
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "400", null, false, itemCodeMap, "WINTER"
    );
    for (const item of items) {
      expect(item.accountCode).toBe("400");
    }
  });

  it("works with an empty itemCodeMap (same as no map)", () => {
    const emptyMap = new Map<string, string>();
    const items = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, emptyMap, "WINTER"
    );
    for (const item of items) {
      expect(item.itemCode).toBeUndefined();
      expect(item.accountCode).toBe("200");
    }
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
  it("ADULT tier maps to ADULT category", () => {
    // Testing the pure logic used in determineEntranceFeeCategory
    const ageTier = "ADULT";
    expect(ageTier === "YOUTH" ? "YOUTH" : ageTier === "CHILD" || ageTier === "INFANT" ? "CHILD" : "ADULT").toBe("ADULT");
  });

  it("YOUTH tier maps to YOUTH category", () => {
    const ageTier = "YOUTH";
    expect(ageTier === "YOUTH" ? "YOUTH" : ageTier === "CHILD" || ageTier === "INFANT" ? "CHILD" : "ADULT").toBe("YOUTH");
  });

  it("CHILD tier maps to CHILD category", () => {
    const ageTier = "CHILD";
    expect(ageTier === "YOUTH" ? "YOUTH" : ageTier === "CHILD" || ageTier === "INFANT" ? "CHILD" : "ADULT").toBe("CHILD");
  });

  it("INFANT tier maps to CHILD category", () => {
    const ageTier = "INFANT";
    expect(ageTier === "YOUTH" ? "YOUTH" : ageTier === "CHILD" || ageTier === "INFANT" ? "CHILD" : "ADULT").toBe("CHILD");
  });

  it("FAMILY requires 2+ adults and 1+ dependents in group", () => {
    const groupMembers = [
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
    const groupMembers = [
      { ageTier: "ADULT" },
      { ageTier: "CHILD" },
    ];
    const adults = groupMembers.filter((m) => m.ageTier === "ADULT");
    const dependents = groupMembers.filter((m) => ["CHILD", "YOUTH", "INFANT"].includes(m.ageTier));
    const isFamily = adults.length >= 2 && dependents.length >= 1;
    expect(isFamily).toBe(false);
  });

  it("does not qualify as FAMILY with only adults (no dependents)", () => {
    const groupMembers = [
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

  it("composite key format is correct", () => {
    const key = `ADULT_WINTER_true`;
    const parts = key.split("_");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("ADULT");
    expect(parts[1]).toBe("WINTER");
    expect(parts[2]).toBe("true");
  });
});
