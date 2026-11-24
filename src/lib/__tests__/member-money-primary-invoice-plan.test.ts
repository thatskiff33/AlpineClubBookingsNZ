import { describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planner never queries it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { LineAmountTypes } from "xero-node";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoice-lines";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { changeFeeLineItem, invoiceLineItemsTotalCents } from "@/lib/xero-modification-line-items";
import { planPromoAdjustmentLines, promoAdjustmentLineItems } from "@/lib/xero-promo-adjustment-lines";
import { stableDigest } from "@/lib/stable-digest";
import { clubTaxCode } from "@/lib/club-tax-settings";
import { splitTaxInclusiveGross } from "@/lib/member-money";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { sanitizeForJson } from "@/lib/xero-sync";
import type { PostedRevenueLeg } from "@/lib/member-money/internal/components";
import { buildPrimaryInvoiceLines } from "@/lib/xero-primary-invoice-lines";
import { BASELINE_XERO_TAX_RENDERING, type XeroTaxRendering } from "@/lib/xero-tax-rendering";
import {
  confirmBilledPrimaryInvoice,
  coverBookingInvoiceLines,
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
    taxRendering: BASELINE_XERO_TAX_RENDERING,
    postedLegs: [leg("BOOKING_REVENUE", STAY, 14000)],
    // The suites before #5208 hold the builders' own lines; the overrides have their own below.
    taxOverrides: "PAUSED",
    ...overrides,
  };
}

/** The lines the sender builds from the same input, by calling the builders itself. */
function senderLines(i: PrimaryInvoicePlanInput) {
  const lines = buildInvoiceLineItems(i.guests, i.checkIn, i.checkOut, i.nights, i.hutFeeMapping.code ?? "200",
    i.hutFeeMapping.itemCode, i.hutFeeMapping.codeExplicitlyConfigured, i.hutFeeItemCodeMap, i.seasonType, i.taxRendering);
  const plan = planPromoAdjustmentLines({ aggregateCents: i.promo.aggregateCents, redemptions: i.promo.redemptions, adjustmentRows: i.promo.adjustmentRows });
  lines.push(...promoAdjustmentLineItems(plan, { firstGuest: i.promo.firstGuest, itemCodeResolver: i.hutFeeItemCodeMap, seasonType: i.seasonType, hutFeeMapping: i.hutFeeMapping }, i.taxRendering));
  if (i.changeFeeCents > 0) lines.push(changeFeeLineItem(i.changeFeeCents, i.hutFeeMapping, i.taxRendering));
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

  it("freezes the booking's own tax treatment, not a hard-coded one (#4632)", () => {
    const notRegistered: XeroTaxRendering = { lineAmountTypes: LineAmountTypes.NoTax };
    const plan = planPrimaryBookingInvoice(input({ changeFeeCents: 2500, taxRendering: notRegistered,
      postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 2500)] }));
    expect(plan.lines).toEqual(senderLines(input({ changeFeeCents: 2500, taxRendering: notRegistered })));
    expect(plan.lines.every((line) => line.taxType === undefined)).toBe(true);
    expect(plan.frozenMapping).toMatchObject({ source: "BUILT", taxType: null, lineAmountTypes: LineAmountTypes.NoTax });

    const otherCode = planPrimaryBookingInvoice(input({ taxRendering: { lineAmountTypes: LineAmountTypes.Inclusive, taxType: "OUTPUT3" } }));
    expect(otherCode.lines.every((line) => line.taxType === "OUTPUT3")).toBe(true);
    expect(otherCode.frozenMapping).toMatchObject({ taxType: "OUTPUT3", lineAmountTypes: LineAmountTypes.Inclusive });
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
      storedLineAmountTypes: "Inclusive",
      postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 2500)] });
    expect(replayed.payloadHash).toBe(built.payloadHash);
    expect(replayed).toMatchObject({ outcome: "COVERED", lineTotalCents: 16500, frozenMapping: { source: "STORED_REQUEST" } });
  });

  it("freezes the basis and line tax types the stored request carries (#4632)", () => {
    const built = planPrimaryBookingInvoice(input({ taxRendering: { lineAmountTypes: LineAmountTypes.NoTax } }));
    const stored = sanitizeForJson({ invoices: [{ lineItems: built.lines }] }) as { invoices: [{ lineItems: never[] }] };
    const replayed = planReplayedPrimaryBookingInvoice({ bookingId: BOOKING, storedLines: stored.invoices[0].lineItems,
      storedLineAmountTypes: "NoTax", postedLegs: [leg("BOOKING_REVENUE", STAY, 14000)] });
    expect(replayed.frozenMapping).toMatchObject({ source: "STORED_REQUEST", lineAmountTypes: "NoTax" });
    expect((replayed.frozenMapping.lineCodes as Array<{ taxType: string | null }>).map((line) => line.taxType))
      .toEqual(built.lines.map(() => null));
    expect(replayed.frozenMapping).not.toHaveProperty("taxType");
  });
});

describe("confirmBilledPrimaryInvoice (#4525 review)", () => {
  const covered = () => planPrimaryBookingInvoice(input({ changeFeeCents: 2500, postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 2500)] }));

  it("plans exactly the lines the sender's one composition builds", () => {
    const i = input({ changeFeeCents: 2500 });
    expect(planPrimaryBookingInvoice(i).lines).toEqual(buildPrimaryInvoiceLines(i).lines);
  });

  it("keeps a COVERED plan when Xero's invoice bills the lines planned", () => {
    const plan = covered();
    expect(plan.outcome).toBe("COVERED");
    expect(confirmBilledPrimaryInvoice(plan, sanitizeForJson(plan.lines) as never)).toBe(plan);
  });

  it("turns a replayed create's ORIGINAL invoice, billing other stay lines, into a conflict that covers nothing", () => {
    const plan = covered();
    const original = [{ description: "Ana One - earlier stay", quantity: 1, unitAmount: 120 }, changeFeeLineItem(2500, mapping, BASELINE_XERO_TAX_RENDERING)];
    const confirmed = confirmBilledPrimaryInvoice(plan, original);
    expect(confirmed).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS", payloadHash: plan.payloadHash, lineTotalCents: 16500 });
    expect(confirmed).not.toHaveProperty("coverage");
    expect(confirmed.frozenMapping).toMatchObject({ componentTaxCodes: [] });
  });

  it("names the fee when only the change-fee line differs", () => {
    const plan = covered();
    const stay = plan.lines.filter((line) => line.description !== changeFeeLineItem(2500, mapping, BASELINE_XERO_TAX_RENDERING).description);
    expect(confirmBilledPrimaryInvoice(plan, [...stay, changeFeeLineItem(2000, mapping, BASELINE_XERO_TAX_RENDERING)])).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });

  it("leaves a conflict as it was", () => {
    const plan = planPrimaryBookingInvoice(input({ postedLegs: [leg("BOOKING_REVENUE", STAY, 13999)] }));
    expect(confirmBilledPrimaryInvoice(plan, [])).toBe(plan);
  });
});

/** ALP-437: the per-booking match the combined group invoice runs for each child. */
describe("coverBookingInvoiceLines (#4525, ALP-437)", () => {
  it("covers nothing, and is no conflict, for a booking with no charge and no lines", () => {
    expect(coverBookingInvoiceLines({ bookingId: BOOKING, stayCents: 0, feeCents: 0, postedLegs: [] })).toEqual({ coverage: [], stay: null, fees: [] });
  });

  it("refuses lines for a booking the journal holds no stay charge for, even when its fees match", () => {
    expect(coverBookingInvoiceLines({ bookingId: BOOKING, stayCents: 0, feeCents: 2500, postedLegs: [leg("FEE_REVENUE", "fee:a", 2500)] }))
      .toMatchObject({ reason: "COMPONENT_UNUSABLE" });
  });

  it("leaves a fully reversed fee component out of the coverage", () => {
    const covered = coverBookingInvoiceLines({ bookingId: BOOKING, stayCents: 14000, feeCents: 0, postedLegs: [
      leg("BOOKING_REVENUE", STAY, 14000), leg("FEE_REVENUE", "fee:a", 2500), leg("FEE_REVENUE", "fee:a", 2500, { side: "DEBIT" }),
    ] });
    expect(covered).toMatchObject({ coverage: [{ account: "BOOKING_REVENUE", chargeIdentity: STAY, coveredCents: 14000, taxCode: TAX }] });
    // #5208: the live tax is for line rendering only; coverage never carries it.
    expect("coverage" in covered && covered.coverage[0]).not.toHaveProperty("taxCents");
  });
});

describe("the journal's GST on each line (#5208, Option A)", () => {
  const treatment = { registered: true as const, rateBasisPoints: 1500, taxCode: clubTaxCode(1500), xeroTaxType: "OUTPUT2" };
  /** A leg as the journal posts it: its gross split at 15% (`splitTaxInclusiveGross`). */
  const taxedLeg = (account: PostedRevenueLeg["account"], chargeIdentity: string, grossCents: number): PostedRevenueLeg => {
    const split = splitTaxInclusiveGross(grossCents, treatment)!;
    return leg(account, chargeIdentity, grossCents, { amountCents: split.netCents, netCents: split.netCents, taxCents: split.taxCents, taxCode: split.taxCode });
  };
  const night = (day: number, priceCents: number) => ({ stayDate: new Date(`2026-07-${day}T00:00:00.000Z`), priceCents });
  /** Two adults and a child over four nights, a price change on the third night, a promo and a change fee. */
  const party = (over: Partial<PrimaryInvoicePlanInput> = {}) => input({
    checkIn: new Date("2026-07-10T00:00:00.000Z"), checkOut: new Date("2026-07-14T00:00:00.000Z"), nights: 4,
    guests: [
      { firstName: "Ana", lastName: "One", ageTier: "ADULT", isMember: true, priceCents: 17_336, nights: [night(10, 4112), night(11, 4112), night(12, 4556), night(13, 4556)] },
      { firstName: "Bo", lastName: "Two", ageTier: "ADULT", isMember: false, priceCents: 26_002, nights: [night(10, 6167), night(11, 6167), night(12, 6834), night(13, 6834)] },
      { firstName: "Cy", lastName: "Three", ageTier: "CHILD", isMember: true, priceCents: 8_667, nights: [night(10, 2056), night(11, 2056), night(12, 2278), night(13, 2277)] },
    ],
    promo: { aggregateCents: -1_333, redemptions: [{ id: "r1", priceAdjustmentCents: -1_333, promoCode: { code: "SAVE" } }], adjustmentRows: [], firstGuest: null },
    changeFeeCents: 2_501,
    taxOverrides: "ON",
    postedLegs: [taxedLeg("BOOKING_REVENUE", STAY, 50_672), taxedLeg("FEE_REVENUE", "fee:a", 2_501)],
    ...over,
  });
  const lineTax = (lines: { taxAmount?: number }[]) => lines.map((line) => providerAmountToCents(line.taxAmount));
  /** What Xero would work out on its own: round-half-up(line × rate / (10000 + rate)), line by line. */
  const xeroOwnTax = (lines: Parameters<typeof invoiceLineItemsTotalCents>[0]) =>
    lines.reduce((sum, line) => sum + splitTaxInclusiveGross(Math.abs(invoiceLineItemsTotalCents([line])), treatment)!.taxCents * Math.sign(invoiceLineItemsTotalCents([line])), 0);

  it("makes the invoice's tax the journal's to the cent on a multi-night, multi-line booking", () => {
    const i = party();
    const plan = planPrimaryBookingInvoice(i);
    expect(plan.outcome).toBe("COVERED");
    const stayLines = plan.lines.filter((line) => line.description !== CHANGE_FEE_DESCRIPTION);
    expect(stayLines.length).toBeGreaterThanOrEqual(7); // price runs per guest, plus the promo line
    const stayTax = stayLines.reduce((sum, line) => sum + providerAmountToCents(line.taxAmount)!, 0);
    expect(stayTax).toBe(splitTaxInclusiveGross(50_672, treatment)!.taxCents);
    expect(providerAmountToCents(plan.lines.at(-1)!.taxAmount)).toBe(splitTaxInclusiveGross(2_501, treatment)!.taxCents);
    // Without the overrides Xero's own per-line sum is off the journal's, which is why the decision was needed.
    expect(xeroOwnTax(buildPrimaryInvoiceLines(i).stayLines)).not.toBe(stayTax);
    // Amounts and codes are the builders'; only the tax is added.
    expect(plan.lines.map((line) => ({ ...line, taxAmount: undefined }))).toEqual(buildPrimaryInvoiceLines(i).lines.map((line) => ({ ...line, taxAmount: undefined })));
    expect(plan.payloadHash).toBe(stableDigest(sanitizeForJson(plan.lines)));
    expect(plan.frozenMapping.taxAllocation).toEqual({ method: "JOURNAL_LARGEST_REMAINDER", lineTaxCents: lineTax(plan.lines) });
  });

  it("adds no tax to the lines when paused, unregistered or replayed", () => {
    const paused = planPrimaryBookingInvoice(party({ taxOverrides: "PAUSED" }));
    expect(paused.lines).toEqual(buildPrimaryInvoiceLines(party()).lines);
    expect(paused).toMatchObject({ outcome: "COVERED", frozenMapping: { taxAllocation: "PAUSED" } });

    const notRegistered = party({ taxRendering: { lineAmountTypes: LineAmountTypes.NoTax },
      postedLegs: [leg("BOOKING_REVENUE", STAY, 50_672, { taxCode: null }), leg("FEE_REVENUE", "fee:a", 2_501, { taxCode: null })] });
    const unregistered = planPrimaryBookingInvoice(notRegistered);
    expect(unregistered.lines).toEqual(buildPrimaryInvoiceLines(notRegistered).lines);
    expect(unregistered.outcome).toBe("COVERED");
    expect(unregistered.frozenMapping).not.toHaveProperty("taxAllocation");

    const stored = sanitizeForJson(buildPrimaryInvoiceLines(party()).lines) as never;
    const replayed = planReplayedPrimaryBookingInvoice({ bookingId: BOOKING, storedLines: stored, storedLineAmountTypes: "Inclusive", postedLegs: party().postedLegs });
    expect(replayed.lines).toBe(stored);
    expect(replayed.frozenMapping).not.toHaveProperty("taxAllocation");
  });

  it("leaves a conflict's lines as built", () => {
    const plan = planPrimaryBookingInvoice(party({ postedLegs: [taxedLeg("BOOKING_REVENUE", STAY, 50_671), taxedLeg("FEE_REVENUE", "fee:a", 2_501)] }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
    expect(plan.lines.every((line) => line.taxAmount === undefined)).toBe(true);
  });

  it("is TAX_CENTS, with the lines untouched, when the journal's tax cannot be shared", () => {
    const tooMuch = { ...taxedLeg("BOOKING_REVENUE", STAY, 50_672), taxCents: 50_673, netCents: -1 };
    const plan = planPrimaryBookingInvoice(party({ postedLegs: [tooMuch, taxedLeg("FEE_REVENUE", "fee:a", 2_501)] }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "TAX_CENTS" });
    expect(plan.lines).toEqual(buildPrimaryInvoiceLines(party()).lines);

    const untaxed = planPrimaryBookingInvoice(party({ postedLegs: [leg("BOOKING_REVENUE", STAY, 50_672, { taxCode: null }), taxedLeg("FEE_REVENUE", "fee:a", 2_501)] }));
    expect(untaxed).toMatchObject({ outcome: "CONFLICT", reason: "TAX_CENTS" });
  });

  it("is TAX_CENTS when the invoice Xero returned holds other tax on a line than was sent", () => {
    const plan = planPrimaryBookingInvoice(party());
    const billed = sanitizeForJson(plan.lines) as { taxAmount: number }[];
    expect(confirmBilledPrimaryInvoice(plan, billed as never)).toBe(plan);
    billed[0]!.taxAmount = Math.round(billed[0]!.taxAmount * 100 - 1) / 100;
    expect(confirmBilledPrimaryInvoice(plan, billed as never)).toMatchObject({ outcome: "CONFLICT", reason: "TAX_CENTS", frozenMapping: { componentTaxCodes: [] } });
  });
});

const CHANGE_FEE_DESCRIPTION = changeFeeLineItem(1, mapping, BASELINE_XERO_TAX_RENDERING).description;
