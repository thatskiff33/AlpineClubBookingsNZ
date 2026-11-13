import { beforeEach, describe, expect, it, vi } from "vitest";

// #2109 fee-schedule look-through resolver + shared match-options builder.
// Mocks only @/lib/prisma so the REAL resolver, settings loader, and
// buildSubscriptionInvoiceMatchOptions run against controllable data.
const mocks = vi.hoisted(() => ({
  feeComponentFindMany: vi.fn(),
  categoryFeeComponentFindMany: vi.fn(),
  accountMappingFindUnique: vi.fn(),
  accountMappingFindMany: vi.fn(),
  itemCodeMappingFindMany: vi.fn(),
  promoCodeFindMany: vi.fn(),
  lockoutFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipAnnualFeeComponent: { findMany: mocks.feeComponentFindMany },
    subscriptionCategoryFeeComponent: { findMany: mocks.categoryFeeComponentFindMany },
    xeroAccountMapping: {
      findUnique: mocks.accountMappingFindUnique,
      findMany: mocks.accountMappingFindMany,
    },
    xeroItemCodeMapping: { findMany: mocks.itemCodeMappingFindMany },
    promoCode: { findMany: mocks.promoCodeFindMany },
    membershipLockoutSettings: { findUnique: mocks.lockoutFindUnique },
  },
}));

import {
  getNonSubscriptionFeeItemCodes,
  getSubscriptionItemCodes,
} from "@/lib/xero-mappings";
import { buildSubscriptionInvoiceMatchOptions } from "@/lib/xero-membership-sync";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.feeComponentFindMany.mockResolvedValue([]);
  mocks.categoryFeeComponentFindMany.mockResolvedValue([]);
  mocks.accountMappingFindUnique.mockResolvedValue(null);
  mocks.accountMappingFindMany.mockResolvedValue([]);
  mocks.itemCodeMappingFindMany.mockResolvedValue([]);
  mocks.promoCodeFindMany.mockResolvedValue([]);
  mocks.lockoutFindUnique.mockResolvedValue(null);
});

describe("getSubscriptionItemCodes (#2109)", () => {
  it("returns distinct fee-schedule component codes ∪ the flat item code, sorted", async () => {
    mocks.feeComponentFindMany.mockResolvedValue([
      { xeroItemCode: "FULL-YOUTH" },
      { xeroItemCode: "FULL-ADULT" },
    ]);
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });

    const codes = await getSubscriptionItemCodes();
    expect(codes).toEqual(["FULL-ADULT", "FULL-YOUTH", "SUBS"]);
  });

  it("always includes the flat item code even with no fee rows", async () => {
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    expect(await getSubscriptionItemCodes()).toEqual(["SUBS"]);
  });

  it("de-duplicates when the flat code equals a component code", async () => {
    mocks.feeComponentFindMany.mockResolvedValue([{ xeroItemCode: "SUBS" }]);
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    expect(await getSubscriptionItemCodes()).toEqual(["SUBS"]);
  });

  it("degrades to the mapping code when the fee-schedule read fails", async () => {
    mocks.feeComponentFindMany.mockRejectedValue(new Error("db down"));
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    expect(await getSubscriptionItemCodes()).toEqual(["SUBS"]);
  });

  // Subscription-category decoupling: the independent category-axis fee
  // schedule's own item codes must be recognized too, since a category
  // charge stamps them on its invoice lines exactly as a type charge stamps
  // the membership-annual-fee ones.
  it("unions subscription-category fee-component codes in too", async () => {
    mocks.feeComponentFindMany.mockResolvedValue([{ xeroItemCode: "FULL-ADULT" }]);
    mocks.categoryFeeComponentFindMany.mockResolvedValue([
      { xeroItemCode: "COUPLE" },
    ]);
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    expect(await getSubscriptionItemCodes()).toEqual(["COUPLE", "FULL-ADULT", "SUBS"]);
  });

  it("degrades to the other sources when the category fee-component read fails", async () => {
    mocks.feeComponentFindMany.mockResolvedValue([{ xeroItemCode: "FULL-ADULT" }]);
    mocks.categoryFeeComponentFindMany.mockRejectedValue(new Error("db down"));
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    expect(await getSubscriptionItemCodes()).toEqual(["FULL-ADULT", "SUBS"]);
  });

  // Closed-loop invariant: every code billing can stamp on a subscription line
  // is in the detection set. The authoritative closed-loop test drives the REAL
  // billing line-builder (not a hardcoded array) and lives in
  // membership-subscription-billing.test.ts (#2109 FIX-4d).
});

describe("getNonSubscriptionFeeItemCodes (#2109)", () => {
  it("unions hut/joining item-code, account-mapping, and promo codes", async () => {
    mocks.itemCodeMappingFindMany.mockResolvedValue([
      { itemCode: "HUT-001" },
      { itemCode: "JOIN-001" },
    ]);
    mocks.accountMappingFindMany.mockResolvedValue([{ itemCode: "HUTFLAT" }]);
    mocks.promoCodeFindMany.mockResolvedValue([{ xeroItemCode: "PROMO-X" }]);

    expect(await getNonSubscriptionFeeItemCodes()).toEqual([
      "HUT-001",
      "HUTFLAT",
      "JOIN-001",
      "PROMO-X",
    ]);
    // #2109 FIX-4a: the hut-fee INCOME account's item code is a non-subscription
    // code too, so an overlap with it is warned.
    expect(mocks.accountMappingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          key: {
            in: expect.arrayContaining(["hutFeesIncome"]),
          },
        }),
      }),
    );
  });

  it("returns [] on a read failure (best-effort overlap only)", async () => {
    mocks.itemCodeMappingFindMany.mockRejectedValue(new Error("db down"));
    expect(await getNonSubscriptionFeeItemCodes()).toEqual([]);
  });
});

describe("buildSubscriptionInvoiceMatchOptions (#2109)", () => {
  it("off: uses only the flat item code, single-code behaviour", async () => {
    mocks.lockoutFindUnique.mockResolvedValue({
      mode: "HARD_BLOCK",
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    mocks.feeComponentFindMany.mockResolvedValue([
      { xeroItemCode: "FULL-ADULT" },
    ]);

    const options = await buildSubscriptionInvoiceMatchOptions();
    expect(options.accountCode).toBe("203");
    expect(options.primaryItemCode).toBe("SUBS");
    // Fee-schedule codes are NOT consulted when off.
    expect(options.itemCodes).toEqual(["SUBS"]);
    expect(options.textFallbackEnabled).toBe(true);
  });

  it("on: unions fee-schedule codes with the flat code, flat still primary", async () => {
    mocks.lockoutFindUnique.mockResolvedValue({
      mode: "HARD_BLOCK",
      financialYearEndMonthOverride: null,
      textFallbackEnabled: false,
      useFeeScheduleItemCodes: true,
    });
    mocks.accountMappingFindUnique.mockResolvedValue({
      code: "203",
      itemCode: "SUBS",
    });
    mocks.feeComponentFindMany.mockResolvedValue([
      { xeroItemCode: "FULL-ADULT" },
      { xeroItemCode: "FULL-YOUTH" },
    ]);

    const options = await buildSubscriptionInvoiceMatchOptions();
    expect(options.primaryItemCode).toBe("SUBS");
    expect(options.itemCodes).toEqual(["FULL-ADULT", "FULL-YOUTH", "SUBS"]);
    expect(options.textFallbackEnabled).toBe(false);
  });

  it("defaults the account code to 203 when unconfigured", async () => {
    mocks.lockoutFindUnique.mockResolvedValue(null);
    mocks.accountMappingFindUnique.mockResolvedValue(null);
    const options = await buildSubscriptionInvoiceMatchOptions();
    expect(options.accountCode).toBe("203");
    expect(options.itemCodes).toEqual([]);
    expect(options.primaryItemCode).toBeNull();
  });
});
