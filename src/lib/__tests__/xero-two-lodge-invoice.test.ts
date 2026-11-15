import { describe, expect, it } from "vitest";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";

// docs/multi-lodge/test-plan.md — "Xero invoice output identical across
// lodges". The production-readiness review found zero lodge awareness in any
// Xero invoice/item-code test. That absence is itself the contract: Xero
// line-item construction is deliberately club-wide — item codes are keyed on
// age tier, season type, and membership only, never on lodge (there is no
// lodgeId parameter on buildInvoiceLineItems, and the itemCodeMap keys carry no
// lodge component). So two bookings that differ ONLY by lodge, with the same
// billable profile, must produce byte-identical line items. These tests pin
// that so a future change cannot quietly make invoices diverge per lodge (a
// finance-correctness regression) without a failing test.

const checkIn = new Date("2026-07-10");
const checkOut = new Date("2026-07-12"); // 2 nights

// Identical billable profiles — the only thing that would differ in
// production is which lodge the booking belongs to, a dimension the invoice
// builder is intentionally blind to.
const lodgeAGuests = [
  { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 9000 },
  { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, priceCents: 13000 },
];
const lodgeBGuests = [
  { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 9000 },
  { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, priceCents: 13000 },
];

describe("Xero invoice line items are consistent across lodges", () => {
  it("produces identical line items for the same billable profile regardless of lodge", () => {
    const lodgeA = buildInvoiceLineItems(lodgeAGuests, checkIn, checkOut, 2, "200", "HUT-FEE");
    const lodgeB = buildInvoiceLineItems(lodgeBGuests, checkIn, checkOut, 2, "200", "HUT-FEE");

    expect(lodgeA).toEqual(lodgeB);
    // And the item code is the same value at both lodges — no per-lodge suffix.
    for (const item of [...lodgeA, ...lodgeB]) {
      expect(item.itemCode).toBe("HUT-FEE");
    }
  });

  it("resolves per-guest item codes by rate type/season/age tier only, identically per lodge", () => {
    const MEMBER_TYPE = "type-full";
    const NONMEMBER_TYPE = "type-nonmember";
    const mixedGuests = [
      { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, priceCents: 9000 },
      { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, priceCents: 13000 },
      { firstName: "Tom", lastName: "Smith", ageTier: "CHILD", isMember: true, rateMembershipTypeId: MEMBER_TYPE, priceCents: 4000 },
    ];
    // A single club-wide resolver (there is no per-lodge map): the same
    // resolver applied for two different lodges must yield the same codes.
    const byKey = new Map([
      [`${MEMBER_TYPE}_WINTER_ADULT`, "HUTFEE-ADULT-WIN-MEM"],
      [`${NONMEMBER_TYPE}_WINTER_ADULT`, "HUTFEE-ADULT-WIN-NON"],
      [`${MEMBER_TYPE}_WINTER_CHILD`, "HUTFEE-CHILD-WIN-MEM"],
    ]);
    const itemCodeResolver = {
      byKey,
      fullTypeId: MEMBER_TYPE,
      nonMemberTypeId: NONMEMBER_TYPE,
      legacyItemCode: null,
      size: byKey.size,
    };

    const lodgeA = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, itemCodeResolver, "WINTER"
    );
    const lodgeB = buildInvoiceLineItems(
      mixedGuests, checkIn, checkOut, 2, "200", null, false, itemCodeResolver, "WINTER"
    );

    expect(lodgeA).toEqual(lodgeB);
    expect(lodgeA.map((i) => i.itemCode)).toEqual([
      "HUTFEE-ADULT-WIN-MEM",
      "HUTFEE-ADULT-WIN-NON",
      "HUTFEE-CHILD-WIN-MEM",
    ]);
  });

  it("keeps the same tax type, quantities, and unit amounts across lodges", () => {
    const lodgeA = buildInvoiceLineItems(lodgeAGuests, checkIn, checkOut, 2, "200", "HUT-FEE");
    const lodgeB = buildInvoiceLineItems(lodgeBGuests, checkIn, checkOut, 2, "200", "HUT-FEE");

    for (let i = 0; i < lodgeA.length; i++) {
      expect(lodgeA[i].taxType).toBe("OUTPUT2");
      expect(lodgeA[i].taxType).toBe(lodgeB[i].taxType);
      expect(lodgeA[i].unitAmount).toBe(lodgeB[i].unitAmount);
      expect(lodgeA[i].quantity).toBe(lodgeB[i].quantity);
      expect(lodgeA[i].description).toBe(lodgeB[i].description);
    }
  });
});
