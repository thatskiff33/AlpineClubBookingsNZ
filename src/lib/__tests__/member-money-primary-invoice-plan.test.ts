import { describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planner never queries it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { LineAmountTypes } from "xero-node";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoice-lines";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { changeFeeLineItem, invoiceLineItemsTotalCents } from "@/lib/xero-modification-line-items";
import { planPromoAdjustmentLines, promoAdjustmentLineItems } from "@/lib/xero-promo-adjustment-lines";
import { stableDigest } from "@/lib/stable-digest";
import { sanitizeForJson } from "@/lib/xero-sync";
import type { PostedRevenueLeg } from "@/lib/member-money/internal/components";
import {
  planPrimaryBookingInvoice,
  planReplayedPrimaryBookingInvoice,
  type PrimaryInvoicePlanInput,
} from "@/lib/member-money/internal/primary-invoice-plan";

/** #4525 (Ledger M13): the primary invoice's planner, against the sender's own builders. */

const BOOKING = "booking-m13";
const STAY = `booking:${BOOKING}:charge`;
const TAX = "GST_INCLUSIVE_1500BP";
const mapping = { code: "201", itemCode: "HUT", codeExplicitlyConfigured: true };
const itemCodes = { byKey: new Map([["b", "B-ITEM"], ["a", "A-ITEM"]]), fullTypeId: null, nonMemberTypeId: null, legacyItemCode: null, size: 2 };
const checkIn = new Date("2026-07-10T00:00:00.000Z");
const checkOut = new Date("2026-07-12T00:00:00.000Z");

const leg = (account: PostedRevenueLeg["account"], chargeIdentity: string, grossCents: number, extra: Partial<PostedRevenueLeg> = {}): PostedRevenueLeg => ({
  account, chargeIdentity, side: "CREDIT", amountCents: grossCents, grossCents, netCents: grossCents, taxCents: 0,
  taxCode: TAX, bookingId: BOOKING, lodgeId: "lodge-1", ...extra,
});

function input(overrides: Partial<PrimaryInvoicePlanInput> = {}): PrimaryInvoicePlanInput {
  return {
    bookingId: BOOKING,
    guests: [
      { firstName: "Ana", lastName: "One", ageTier: "ADULT", isMember: true, priceCents: 9000, nights: [
        { stayDate: new Date("2026-07-10T00:00:00.000Z"), priceCents: 4500 },
        { stayDate: new Date("2026-07-11T00:00:00.000Z"), priceCents: 4500 },
      ] },
      { firstName: "Bo", lastName: "Two", ageTier: "CHILD", isMember: false, priceCents: 6000, nights: null },
    ],
    checkIn, checkOut, nights: 2,
    hutFeeMapping: mapping,
    hutFeeItemCodeMap: itemCodes,
    seasonType: "WINTER",
    promo: { aggregateCents: -1000, redemptions: [{ id: "r1", priceAdjustmentCents: -1000, promoCode: { code: "SAVE10" } }], adjustmentRows: [], firstGuest: null },
    changeFeeCents: 0,
    postedLegs: [leg("BOOKING_REVENUE", STAY, 14000)],
    ...overrides,
  };
}

/** The lines the sender builds from the same input, by calling the builders itself. */
function senderLines(i: PrimaryInvoicePlanInput) {
  const lines = buildInvoiceLineItems(i.guests, i.checkIn, i.checkOut, i.nights, i.hutFeeMapping.code ?? "200",
    i.hutFeeMapping.itemCode, i.hutFeeMapping.codeExplicitlyConfigured, i.hutFeeItemCodeMap, i.seasonType);
  const plan = planPromoAdjustmentLines({ aggregateCents: i.promo.aggregateCents, redemptions: i.promo.redemptions, adjustmentRows: i.promo.adjustmentRows });
  lines.push(...promoAdjustmentLineItems(plan, { firstGuest: i.promo.firstGuest, itemCodeResolver: i.hutFeeItemCodeMap, seasonType: i.seasonType, hutFeeMapping: i.hutFeeMapping }));
  if (i.changeFeeCents > 0) lines.push(changeFeeLineItem(i.changeFeeCents, i.hutFeeMapping));
  return lines;
}

describe("planPrimaryBookingInvoice (#4525)", () => {
  it("returns the sender's own lines and covers the stay charge whole", () => {
    const plan = planPrimaryBookingInvoice(input());
    expect(plan.lines).toEqual(senderLines(input()));
    expect(plan).toMatchObject({
      outcome: "COVERED",
      lineTotalCents: 14000,
      coverage: [{ account: "BOOKING_REVENUE", chargeIdentity: STAY, coveredCents: 14000, taxCode: TAX }],
    });
  });

  it("keys the manifest by the invoice's correlation key and hashes the stored bytes", () => {
    const plan = planPrimaryBookingInvoice(input());
    expect(plan.legacyKey).toBe(buildXeroBookingInvoiceCorrelationKey(BOOKING));
    expect(plan.payloadHash).toBe(stableDigest(sanitizeForJson(senderLines(input()))));
    expect(plan.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("freezes both tax namespaces without translating either", () => {
    const plan = planPrimaryBookingInvoice(input());
    expect(plan.frozenMapping).toMatchObject({
      source: "BUILT",
      hutFee: { accountCode: "201", itemCode: "HUT", codeExplicitlyConfigured: true },
      itemCodeMap: { byKey: [["a", "A-ITEM"], ["b", "B-ITEM"]] },
      seasonType: "WINTER",
      taxType: "OUTPUT2",
      lineAmountTypes: LineAmountTypes.Inclusive,
      componentTaxCodes: [{ account: "BOOKING_REVENUE", chargeIdentity: STAY, taxCode: TAX }],
    });
  });

  it("matches the builders on a night of unknown price and on a zero-night stay", () => {
    const unknownNight = input({
      guests: [{ firstName: "Cy", lastName: "Three", ageTier: "ADULT", isMember: true, priceCents: 9000, nights: [
        { stayDate: new Date("2026-07-10T00:00:00.000Z"), priceCents: null },
        { stayDate: new Date("2026-07-11T00:00:00.000Z"), priceCents: 4500 },
      ] }],
      promo: { aggregateCents: 0, redemptions: [], adjustmentRows: [], firstGuest: null },
    });
    const unknownTotal = invoiceLineItemsTotalCents(senderLines(unknownNight));
    const unknownPlan = planPrimaryBookingInvoice({ ...unknownNight, postedLegs: [leg("BOOKING_REVENUE", STAY, unknownTotal)] });
    expect(unknownPlan.lines).toEqual(senderLines(unknownNight));
    expect(unknownPlan.outcome).toBe("COVERED");

    const zeroNight = input({ checkOut: checkIn, nights: 0, guests: [{ firstName: "Di", lastName: "Four", ageTier: "ADULT", isMember: true, priceCents: 3000 }],
      promo: { aggregateCents: 0, redemptions: [], adjustmentRows: [], firstGuest: null }, postedLegs: [leg("BOOKING_REVENUE", STAY, 3000)] });
    expect(planPrimaryBookingInvoice(zeroNight).lines).toEqual(senderLines(zeroNight));
    // The builder's degenerate line has quantity 0, so it bills nothing: a 3000-cent
    // stay charge beside it is a real mismatch, and a zero one is covered by nothing.
    expect(planPrimaryBookingInvoice(zeroNight)).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS", lineTotalCents: 0 });
    expect(planPrimaryBookingInvoice({ ...zeroNight, postedLegs: [leg("BOOKING_REVENUE", STAY, 0)] })).toMatchObject({ outcome: "COVERED", coverage: [] });
  });

  it("covers each live change-fee component beside the stay", () => {
    const plan = planPrimaryBookingInvoice(input({ changeFeeCents: 2500, postedLegs: [
      leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 1000), leg("FEE_REVENUE", "fee:b", 1500),
    ] }));
    expect(plan.lines).toEqual(senderLines(input({ changeFeeCents: 2500 })));
    expect(plan).toMatchObject({ outcome: "COVERED", lineTotalCents: 16500 });
    expect(plan.outcome === "COVERED" && plan.coverage.map((c) => [c.chargeIdentity, c.coveredCents])).toEqual([[STAY, 14000], ["fee:a", 1000], ["fee:b", 1500]]);
  });

  it("is STAY_CENTS, covering nothing, when the stay charge is a cent short", () => {
    const plan = planPrimaryBookingInvoice(input({ postedLegs: [leg("BOOKING_REVENUE", STAY, 13999)] }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
    expect("coverage" in plan).toBe(false);
    expect(plan.frozenMapping.componentTaxCodes).toEqual([]);
  });

  it("is STAY_CENTS when an extra folded into the stay charge leaves it unlike the lines", () => {
    // A group discount, agreed adjustment or cancellation keep folds into the one stay component.
    const plan = planPrimaryBookingInvoice(input({ postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("BOOKING_REVENUE", STAY, 500, { side: "DEBIT" })] }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
  });

  it("is FEE_CENTS, with no partial fee coverage, when the fee components do not sum to the fee line", () => {
    const plan = planPrimaryBookingInvoice(input({ changeFeeCents: 2500, postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 1000)] }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
    expect("coverage" in plan).toBe(false);
    expect(planPrimaryBookingInvoice(input({ postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 1000)] })))
      .toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });

  it("is COMPONENT_UNUSABLE for a missing stay charge, a mixed tax split, a scope disagreement or a close-out", () => {
    const reason = (postedLegs: PostedRevenueLeg[]) => {
      const plan = planPrimaryBookingInvoice(input({ postedLegs }));
      return plan.outcome === "CONFLICT" ? plan.reason : plan.outcome;
    };
    expect(reason([])).toBe("COMPONENT_UNUSABLE");
    expect(reason([leg("BOOKING_REVENUE", STAY, 7000), leg("BOOKING_REVENUE", STAY, 7000, { taxCode: "GST_INCLUSIVE_0BP" })])).toBe("COMPONENT_UNUSABLE");
    expect(reason([leg("BOOKING_REVENUE", STAY, 7000), leg("BOOKING_REVENUE", STAY, 7000, { lodgeId: "lodge-2" })])).toBe("COMPONENT_UNUSABLE");
    expect(reason([leg("BOOKING_REVENUE", `booking:${BOOKING}:refund-close-out:rec-1`, 14000)])).toBe("COMPONENT_UNUSABLE");
  });

  it("covers nothing, and conflicts with nothing, for a zero invoice with no positive component", () => {
    const zero = input({ guests: [{ firstName: "Ed", lastName: "Five", ageTier: "ADULT", isMember: true, priceCents: 0 }],
      promo: { aggregateCents: 0, redemptions: [], adjustmentRows: [], firstGuest: null }, postedLegs: [] });
    expect(planPrimaryBookingInvoice(zero)).toMatchObject({ outcome: "COVERED", lineTotalCents: 0, coverage: [] });
  });
});

describe("planReplayedPrimaryBookingInvoice (#4525)", () => {
  it("hashes the stored lines as the first run did and splits the fee line by its words", () => {
    const built = planPrimaryBookingInvoice(input({ changeFeeCents: 2500, postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 2500)] }));
    const stored = sanitizeForJson({ invoices: [{ lineItems: built.lines }] }) as { invoices: [{ lineItems: never[] }] };
    const replayed = planReplayedPrimaryBookingInvoice({ bookingId: BOOKING, storedLines: stored.invoices[0].lineItems,
      postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 2500)] });
    expect(replayed.payloadHash).toBe(built.payloadHash);
    expect(replayed).toMatchObject({ outcome: "COVERED", lineTotalCents: 16500, frozenMapping: { source: "STORED_REQUEST" } });
  });
});
