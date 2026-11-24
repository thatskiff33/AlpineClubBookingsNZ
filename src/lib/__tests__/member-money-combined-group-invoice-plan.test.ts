import { describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planner never queries it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { LineAmountTypes, type LineItem } from "xero-node";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoice-lines";
import { changeFeeLineItem } from "@/lib/xero-modification-line-items";
import { stableDigest } from "@/lib/stable-digest";
import { sanitizeForJson } from "@/lib/xero-sync";
import type { PostedRevenueLeg } from "@/lib/member-money/internal/components";
import { buildPrimaryInvoiceLines, type PrimaryInvoiceLineInput } from "@/lib/xero-primary-invoice-lines";
import { BASELINE_XERO_TAX_RENDERING, type XeroTaxRendering } from "@/lib/xero-tax-rendering";
import {
  planCombinedGroupInvoice,
  planReplayedCombinedGroupInvoice,
  type CombinedGroupInvoiceChild,
} from "@/lib/member-money/internal/combined-group-invoice-plan";

/** #4525 (Ledger M13, ALP-437): the organiser's combined group invoice, planned child by child. */

const KEY = "group-settlement:settle-1:invoice:v1";
const TAX = "GST_INCLUSIVE_1500BP";
const mapping = { code: "201", itemCode: "HUT", codeExplicitlyConfigured: true };
const itemCodes = { byKey: new Map([["a", "A-ITEM"]]), fullTypeId: null, nonMemberTypeId: null, legacyItemCode: null, size: 1 };
const checkIn = new Date("2026-07-10T00:00:00.000Z");
const checkOut = new Date("2026-07-12T00:00:00.000Z");
const stay = (bookingId: string) => `booking:${bookingId}:charge`;

const leg = (bookingId: string, account: PostedRevenueLeg["account"], chargeIdentity: string, grossCents: number, extra: Partial<PostedRevenueLeg> = {}): PostedRevenueLeg => ({
  account, chargeIdentity, side: "CREDIT", amountCents: grossCents, grossCents, netCents: grossCents, taxCents: 0,
  taxCode: TAX, bookingId, lodgeId: "lodge-1", ...extra,
});

/** One adult for two nights at `nightCents` a night, and an optional recorded change fee. */
function lineInput(nightCents: number, changeFeeCents: number, taxRendering: XeroTaxRendering): PrimaryInvoiceLineInput {
  return {
    guests: [{ firstName: "Ana", lastName: "One", ageTier: "ADULT", isMember: true, priceCents: nightCents * 2, nights: [
      { stayDate: new Date("2026-07-10T00:00:00.000Z"), priceCents: nightCents },
      { stayDate: new Date("2026-07-11T00:00:00.000Z"), priceCents: nightCents },
    ] }],
    checkIn, checkOut, nights: 2,
    hutFeeMapping: mapping,
    hutFeeItemCodeMap: itemCodes,
    seasonType: "WINTER",
    promo: { aggregateCents: 0, redemptions: [], adjustmentRows: [], firstGuest: null },
    changeFeeCents,
    taxRendering,
  };
}

/** A child as the sender builds it (`buildGroupSettlementInvoiceLines`), with its legs. */
function child(bookingId: string, lodgeId: string, nightCents: number, changeFeeCents: number, postedLegs: readonly PostedRevenueLeg[],
  taxRendering: XeroTaxRendering = BASELINE_XERO_TAX_RENDERING): CombinedGroupInvoiceChild {
  const { stayLines, feeLines } = buildPrimaryInvoiceLines(lineInput(nightCents, changeFeeCents, taxRendering));
  return { bookingId, lodgeId, seasonType: "WINTER", stayLines, feeLines, postedLegs };
}

/** The lines a direct call of the builders gives for the same child. */
function directLines(nightCents: number, changeFeeCents: number, taxRendering: XeroTaxRendering = BASELINE_XERO_TAX_RENDERING): LineItem[] {
  const i = lineInput(nightCents, changeFeeCents, taxRendering);
  const lines = buildInvoiceLineItems(i.guests, i.checkIn, i.checkOut, i.nights, "201", "HUT", true, itemCodes, "WINTER", taxRendering);
  if (changeFeeCents > 0) lines.push(changeFeeLineItem(changeFeeCents, mapping, taxRendering));
  return lines;
}

/** Two children: A stays for 9000, B for 8000 plus a 2500 change fee. */
type LegOverrides = { aLegs?: readonly PostedRevenueLeg[]; bLegs?: readonly PostedRevenueLeg[] };
function twoChildren(overrides: LegOverrides = {}) {
  return [
    child("child-a", "lodge-1", 4500, 0, overrides.aLegs ?? [leg("child-a", "BOOKING_REVENUE", stay("child-a"), 9000)]),
    child("child-b", "lodge-2", 4000, 2500, overrides.bLegs ?? [
      leg("child-b", "BOOKING_REVENUE", stay("child-b"), 8000, { lodgeId: "lodge-2" }),
      leg("child-b", "FEE_REVENUE", "fee:child-b:1", 2500, { lodgeId: "lodge-2" }),
    ]),
  ];
}

const plan = (children: CombinedGroupInvoiceChild[], extra: Partial<Parameters<typeof planCombinedGroupInvoice>[0]> = {}) =>
  planCombinedGroupInvoice({
    legacyKey: KEY, liveCoverage: [], children, taxRendering: BASELINE_XERO_TAX_RENDERING,
    hutFeeMapping: mapping, hutFeeItemCodeMap: itemCodes, ...extra,
  });

describe("planCombinedGroupInvoice (#4525, ALP-437)", () => {
  it("bills two children's lines exactly as the builders do and covers each child's components whole", () => {
    const result = plan(twoChildren());
    expect(result.lines).toEqual([...directLines(4500, 0), ...directLines(4000, 2500)]);
    expect(result).toMatchObject({
      outcome: "COVERED",
      legacyKey: KEY,
      lineTotalCents: 19500,
      coverage: [
        { account: "BOOKING_REVENUE", chargeIdentity: stay("child-a"), coveredCents: 9000, taxCode: TAX },
        { account: "BOOKING_REVENUE", chargeIdentity: stay("child-b"), coveredCents: 8000, taxCode: TAX },
        { account: "FEE_REVENUE", chargeIdentity: "fee:child-b:1", coveredCents: 2500, taxCode: TAX },
      ],
    });
    expect(result.payloadHash).toBe(stableDigest(sanitizeForJson(result.lines)));
  });

  it("freezes a GST-exclusive rendering, each child's lodge and season, and the journal's codes, untranslated", () => {
    const exclusive: XeroTaxRendering = { lineAmountTypes: LineAmountTypes.Exclusive, taxType: "OUTPUT2" };
    const children = twoChildren().map((c) => child(c.bookingId, c.lodgeId, c.bookingId === "child-a" ? 4500 : 4000,
      c.bookingId === "child-a" ? 0 : 2500, c.postedLegs, exclusive));
    const result = plan(children, { taxRendering: exclusive });
    expect(result.lines).toEqual([...directLines(4500, 0, exclusive), ...directLines(4000, 2500, exclusive)]);
    expect(result.frozenMapping).toMatchObject({
      source: "BUILT",
      taxType: "OUTPUT2",
      lineAmountTypes: LineAmountTypes.Exclusive,
      hutFee: { accountCode: "201", itemCode: "HUT", codeExplicitlyConfigured: true },
      children: [
        { bookingId: "child-a", lodgeId: "lodge-1", seasonType: "WINTER" },
        { bookingId: "child-b", lodgeId: "lodge-2", seasonType: "WINTER" },
      ],
      componentTaxCodes: [
        { account: "BOOKING_REVENUE", chargeIdentity: stay("child-a"), taxCode: TAX },
        { account: "BOOKING_REVENUE", chargeIdentity: stay("child-b"), taxCode: TAX },
        { account: "FEE_REVENUE", chargeIdentity: "fee:child-b:1", taxCode: TAX },
      ],
    });
  });

  it.each([
    ["one child's stay charge is a cent short of its stay lines", { aLegs: [leg("child-a", "BOOKING_REVENUE", stay("child-a"), 8999)] }, "STAY_CENTS"],
    ["one child's fee components do not sum to its change-fee line", { bLegs: [
      leg("child-b", "BOOKING_REVENUE", stay("child-b"), 8000), leg("child-b", "FEE_REVENUE", "fee:child-b:1", 2000)] }, "FEE_CENTS"],
    ["one child's stay charge carries money under two tax treatments", { aLegs: [
      leg("child-a", "BOOKING_REVENUE", stay("child-a"), 4500), leg("child-a", "BOOKING_REVENUE", stay("child-a"), 4500, { taxCode: "GST_INCLUSIVE_0BP" })] }, "COMPONENT_UNUSABLE"],
    ["one child has no stay charge in the journal", { aLegs: [] }, "COMPONENT_UNUSABLE"],
    ["one child's component names another booking", { aLegs: [leg("child-z", "BOOKING_REVENUE", stay("child-a"), 9000)] }, "COMPONENT_UNUSABLE"],
  ] as const)("is a conflict covering nothing when %s", (_case, legs, reason) => {
    const result = plan(twoChildren(legs as LegOverrides));
    expect(result).toMatchObject({ outcome: "CONFLICT", reason, frozenMapping: { componentTaxCodes: [] } });
    expect(result).not.toHaveProperty("coverage");
    // The lines are still the sender's: a conflict never changes what was sent.
    expect(result.lines).toEqual([...directLines(4500, 0), ...directLines(4000, 2500)]);
  });

  it("is ALREADY_COVERED when another invoice still covers one of a child's components", () => {
    const result = plan(twoChildren(), { liveCoverage: [{ account: "BOOKING_REVENUE", chargeIdentity: stay("child-b") }] });
    expect(result).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED" });
    expect(result).not.toHaveProperty("coverage");
  });
});

describe("planReplayedCombinedGroupInvoice (#4525, ALP-437)", () => {
  const children = twoChildren().map(({ bookingId, postedLegs }) => ({ bookingId, postedLegs }));
  const stored = sanitizeForJson([...directLines(4500, 0), ...directLines(4000, 2500)]) as unknown as LineItem[];

  it("covers the children's components from the stored lines, rebuilding nothing", () => {
    const result = planReplayedCombinedGroupInvoice({ legacyKey: KEY, liveCoverage: [], storedLines: stored, storedLineAmountTypes: "Inclusive", children });
    expect(result).toMatchObject({ outcome: "COVERED", lineTotalCents: 19500, frozenMapping: { source: "STORED_REQUEST", lineAmountTypes: "Inclusive" } });
    expect(result.outcome === "COVERED" && result.coverage.map((c) => c.chargeIdentity)).toEqual([stay("child-a"), stay("child-b"), "fee:child-b:1"]);
    // The same bytes a built plan hashes, so a replay of a built record is the same row.
    expect(result.payloadHash).toBe(plan(twoChildren()).payloadHash);
  });

  it("is a conflict when the stored lines bill other cents than the children's components", () => {
    const short = [...stored.slice(0, -1)];
    const result = planReplayedCombinedGroupInvoice({ legacyKey: KEY, liveCoverage: [], storedLines: short, storedLineAmountTypes: null, children });
    expect(result).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });
});
