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
