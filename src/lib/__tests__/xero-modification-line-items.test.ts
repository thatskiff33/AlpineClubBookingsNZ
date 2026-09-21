/**
 * The itemised lines on a booking-edit Xero document (#3530 stage 2b,
 * `INV-MOD-058`): one Xero line per stored line, coded like the original
 * invoice, summing to the cent to what the document bills. The last case
 * prints the rendered `LineItem[]` for the owner's eye.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUniqueOrThrow: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  loggerError: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getHutFeeItemCodeMap: vi.fn(),
  getHutFeeSeasonType: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUniqueOrThrow: mocks.bookingFindUniqueOrThrow },
    bookingModification: { findUnique: mocks.bookingModificationFindUnique },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getHutFeeItemCodeMap: mocks.getHutFeeItemCodeMap,
  getHutFeeSeasonType: mocks.getHutFeeSeasonType,
}));

import {
  buildModificationDocumentLineItems,
  resolveModificationDocumentLineItems,
  type ModificationDocumentCodingContext,
} from "@/lib/xero-modification-line-items";
import {
  diffBookingPricing,
  type ModificationLine,
  type ModificationPricingSide,
} from "@/lib/booking-modification-lines";
import type { HutFeeItemCodeResolver } from "@/lib/xero-mappings";
import { lineTotalCents } from "@/lib/__tests__/helpers/xero-lines";

const FULL = "type-full";
const NON_MEMBER = "type-non-member";

function resolver(): HutFeeItemCodeResolver {
  return {
    byKey: new Map([
      [`${FULL}_WINTER_ADULT`, "HUT-MEMBER-ADULT"],
      [`${FULL}_WINTER_YOUTH`, "HUT-MEMBER-YOUTH"],
      [`${NON_MEMBER}_WINTER_ADULT`, "HUT-NONMEMBER-ADULT"],
    ]),
    fullTypeId: FULL,
    nonMemberTypeId: NON_MEMBER,
    legacyItemCode: null,
    size: 3,
  };
}

function context(overrides: Partial<ModificationDocumentCodingContext> = {}): ModificationDocumentCodingContext {
  return {
    incomeMapping: { code: "200", itemCode: "HUT", codeExplicitlyConfigured: false },
    refundMapping: { code: "201", itemCode: null, codeExplicitlyConfigured: true },
    itemCodeResolver: resolver(),
    seasonType: "WINTER",
    promo: null,
    firstGuest: { ageTier: "ADULT", isMember: false, rateMembershipTypeId: NON_MEMBER },
    ...overrides,
  };
}

function day(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}
function nights(from: string, prices: number[], sold = true) {
  return prices.map((priceCents, i) => ({
    stayDate: new Date(day(from).getTime() + i * 86_400_000),
    priceCents,
    ...(sold ? { priceSource: "SOLD" as const } : {}),
  }));
}
function guest(
  guestKey: string,
  overrides: Partial<ModificationPricingSide["guests"][number]> = {},
): ModificationPricingSide["guests"][number] {
  return {
    guestKey,
    ageTier: "ADULT",
    isMember: false,
    rateMembershipTypeId: NON_MEMBER,
    name: `Guest ${guestKey}`,
    nights: nights("2026-08-14", [8000, 8000]),
    ...overrides,
  };
}
function linesOf(before: ModificationPricingSide, after: ModificationPricingSide, delta: number): ModificationLine[] {
  const result = diffBookingPricing(before, after, delta);
  expect(result.kind).toBe("lines");
  return result.kind === "lines" ? result.lines : [];
}

describe("buildModificationDocumentLineItems", () => {
  it("bills an added non-member adult night on hutFeesIncome with that guest's own item code", () => {
    const lines = linesOf(
      { guests: [guest("a")], promoAdjustmentCents: 0 },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000], false) }, { ...guest("b"), nights: nights("2026-08-14", [8000], false) }], promoAdjustmentCents: 0 },
      8000,
    );
    const items = buildModificationDocumentLineItems({ lines, changeFeeCents: 0, document: "SUPPLEMENTARY_INVOICE", context: context() });
    expect(items).toEqual([
      {
        description: "1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026",
        quantity: 1,
        unitAmount: 80,
        taxType: "OUTPUT2",
        itemCode: "HUT-NONMEMBER-ADULT",
      },
    ]);
    expect(lineTotalCents(items)).toBe(8000);
  });

  it("a removed run on the supplementary invoice is a negative line on hutFeeRefunds; the fee stays on income", () => {
    const lines = linesOf(
      { guests: [guest("a"), guest("b")], promoAdjustmentCents: 0 },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000], false) }], promoAdjustmentCents: 0 },
      -16000,
    );
    const items = buildModificationDocumentLineItems({ lines, changeFeeCents: 20000, document: "SUPPLEMENTARY_INVOICE", context: context() });
    expect(items).toEqual([
      {
        description: "1 x Non-member Adult removed - 2 nights - 14 Aug 2026 - 16 Aug 2026",
        quantity: 2,
        unitAmount: -80,
        taxType: "OUTPUT2",
        accountCode: "201",
      },
      { description: "Late notice booking change fee", quantity: 1, unitAmount: 200, taxType: "OUTPUT2", itemCode: "HUT" },
    ]);
    expect(lineTotalCents(items)).toBe(4000);
  });

  it("inverts every sign on a credit note: the removed nights are the credit, an added night and the fee reduce it", () => {
    const lines = linesOf(
      { guests: [guest("a"), guest("b")], promoAdjustmentCents: 0 },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000, 8000], false) }], promoAdjustmentCents: 0 },
      -8000,
    );
    const items = buildModificationDocumentLineItems({ lines, changeFeeCents: 2500, document: "MODIFICATION_CREDIT_NOTE", context: context() });
    console.info(
      ["", "Modification credit note lines (two guests 14-16 Aug; one guest removed, the other extended a night, late-change fee $25):", ...items.map((i) => `  ${i.quantity} x $${i.unitAmount?.toFixed(2)}  ${i.description}  [${i.itemCode ?? i.accountCode}]`)].join("\n"),
    );
    expect(items.map((i) => [i.description, i.quantity, i.unitAmount, i.accountCode ?? i.itemCode])).toEqual([
      ["1 x Non-member Adult removed - 2 nights - 14 Aug 2026 - 16 Aug 2026", 2, 80, "201"],
      ["1 x Non-member Adult added - 1 night - 16 Aug 2026 - 17 Aug 2026", 1, -80, "HUT-NONMEMBER-ADULT"],
      ["Late notice booking change fee", 1, -25, "HUT"],
    ]);
    // What the note returns: 160 - 80 - 25.
    expect(lineTotalCents(items)).toBe(5500);
  });

  it("a member priced at the non-member rate reads Non-member and codes to the non-member item (#2543)", () => {
    const lockedOut = guest("m", { isMember: true, rateMembershipTypeId: NON_MEMBER });
    const lines = linesOf(
      { guests: [], promoAdjustmentCents: 0 },
      { guests: [{ ...lockedOut, nights: nights("2026-08-14", [8000], false) }], promoAdjustmentCents: 0 },
      8000,
    );
    const [item] = buildModificationDocumentLineItems({ lines, changeFeeCents: 0, document: "SUPPLEMENTARY_INVOICE", context: context() });
    expect(item.description).toBe("1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026");
    expect(item.itemCode).toBe("HUT-NONMEMBER-ADULT");
  });

  it("the promotion delta takes the promo's own codes, else the original invoice's fallback", () => {
    const lines = linesOf(
      { guests: [guest("a")], promoAdjustmentCents: -2000, promoCode: "SUMMER25" },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000], false) }], promoAdjustmentCents: -1000, promoCode: "SUMMER25" },
      1000,
    );
    const own = buildModificationDocumentLineItems({
      lines, changeFeeCents: 0, document: "SUPPLEMENTARY_INVOICE",
      context: context({ promo: { xeroItemCode: "PROMO", xeroAccountCode: "260" } }),
    });
    expect(own).toEqual([
      { description: "Promotion SUMMER25 reduced by $10.00", quantity: 1, unitAmount: 10, taxType: "OUTPUT2", itemCode: "PROMO", accountCode: "260" },
    ]);
    const fallback = buildModificationDocumentLineItems({ lines, changeFeeCents: 0, document: "SUPPLEMENTARY_INVOICE", context: context() });
    expect(fallback[0]).toMatchObject({ itemCode: "HUT-NONMEMBER-ADULT" });
    expect(fallback[0].accountCode).toBeUndefined();
    const credited = buildModificationDocumentLineItems({ lines, changeFeeCents: 0, document: "MODIFICATION_CREDIT_NOTE", context: context() });
    expect(credited[0].unitAmount).toBe(-10);
  });

  it("with no season known, an added night takes the single hutFeesIncome item code, as the original invoice does", () => {
    const lines = linesOf(
      { guests: [], promoAdjustmentCents: 0 },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000], false) }], promoAdjustmentCents: 0 },
      8000,
    );
    const [item] = buildModificationDocumentLineItems({ lines, changeFeeCents: 0, document: "SUPPLEMENTARY_INVOICE", context: context({ seasonType: null }) });
    expect(item.itemCode).toBe("HUT");
  });

  it("prints a date move and a reprice for the owner's eye, summing to the cent", () => {
    // Two guests, 14-16 Aug at $80, moved to 15-17 Aug where the 16th is $95.
    const before: ModificationPricingSide = { guests: [guest("a"), guest("b")], promoAdjustmentCents: 0 };
    const after: ModificationPricingSide = {
      guests: [
        { ...guest("a"), nights: nights("2026-08-15", [8000, 9500], false) },
        { ...guest("b"), nights: nights("2026-08-15", [8000, 9500], false) },
      ],
      promoAdjustmentCents: 0,
    };
    const lines = linesOf(before, after, 3000);
    const items = buildModificationDocumentLineItems({ lines, changeFeeCents: 0, document: "SUPPLEMENTARY_INVOICE", context: context() });
    console.info(
      ["", "Supplementary invoice lines (date move 14-16 Aug -> 15-17 Aug, 16th repriced):", ...items.map((i) => `  ${i.quantity} x $${i.unitAmount?.toFixed(2)}  ${i.description}  [${i.itemCode ?? i.accountCode}]`)].join("\n"),
    );
    expect(items.map((i) => i.description)).toEqual([
      "2 x Non-member Adult removed - 1 night - 14 Aug 2026 - 15 Aug 2026",
      "2 x Non-member Adult added - 1 night - 16 Aug 2026 - 17 Aug 2026",
    ]);
    expect(lineTotalCents(items)).toBe(3000);
  });
});

describe("resolveModificationDocumentLineItems", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bookingFindUniqueOrThrow.mockResolvedValue({
      checkIn: day("2026-08-14"),
      lodgeId: "lodge-1",
      promoRedemption: null,
      guests: [{ ageTier: "ADULT", isMember: false, rateMembershipTypeId: NON_MEMBER }],
    });
    mocks.getResolvedAccountMapping.mockImplementation(async (key: string) =>
      key === "hutFeeRefunds"
        ? { code: "201", itemCode: null, codeExplicitlyConfigured: true }
        : { code: "200", itemCode: "HUT", codeExplicitlyConfigured: false },
    );
    mocks.getHutFeeItemCodeMap.mockResolvedValue(resolver());
    mocks.getHutFeeSeasonType.mockResolvedValue("WINTER");
  });

  const stored = linesOf(
    { guests: [guest("a")], promoAdjustmentCents: 0 },
    { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000], false) }, { ...guest("b"), nights: nights("2026-08-14", [8000], false) }], promoAdjustmentCents: 0 },
    8000,
  );

  it("renders the stored lines and records STORED with the figures compared", async () => {
    const result = await resolveModificationDocumentLineItems({
      bookingId: "bk1",
      row: { priceLines: stored, priceDiffCents: 8000, changeFeeCents: 0 },
      document: "SUPPLEMENTARY_INVOICE",
      billedCents: 8000,
      billedFigures: { priceDiffCents: 8000, changeFeeCents: 0 },
    });
    expect(result.lineItems).toHaveLength(1);
    expect(result.record).toEqual({ source: "STORED", reason: null, storedSumCents: 8000, billedCents: 8000, lineCount: 1 });
    expect(mocks.getHutFeeSeasonType).toHaveBeenCalledWith(day("2026-08-14"), "lodge-1");
  });

  it("falls back with the reason and reads nothing else when the lines do not explain the document", async () => {
    const result = await resolveModificationDocumentLineItems({
      bookingId: "bk1",
      row: { priceLines: stored, priceDiffCents: 8000, changeFeeCents: 0 },
      document: "SUPPLEMENTARY_INVOICE",
      billedCents: 9000,
      billedFigures: { priceDiffCents: 9000, changeFeeCents: 0 },
    });
    expect(result.lineItems).toBeNull();
    expect(result.record).toEqual({ source: "FALLBACK_SINGLE_LINE", reason: "STORED_LINES_DO_NOT_SUM", storedSumCents: 8000, billedCents: 9000, lineCount: 0 });
    expect(mocks.bookingFindUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.getHutFeeItemCodeMap).not.toHaveBeenCalled();
  });

  it("reads the row itself for a credit note, inside the guard", async () => {
    const removedLines = linesOf(
      { guests: [guest("a"), guest("b")], promoAdjustmentCents: 0 },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000], false) }], promoAdjustmentCents: 0 },
      -16000,
    );
    mocks.bookingModificationFindUnique.mockResolvedValue({ priceLines: removedLines, priceDiffCents: -16000, changeFeeCents: 0 });
    const result = await resolveModificationDocumentLineItems({
      bookingId: "bk1",
      bookingModificationId: "mod_1",
      document: "MODIFICATION_CREDIT_NOTE",
      billedCents: 16000,
    });
    expect(mocks.bookingModificationFindUnique).toHaveBeenCalledWith({
      where: { id: "mod_1" },
      select: { priceLines: true, priceDiffCents: true, changeFeeCents: true },
    });
    expect(result.record.source).toBe("STORED");
    expect(lineTotalCents(result.lineItems ?? [])).toBe(16000);
  });

  it("narration never fails a document: a failed read sends the single line, logged and recorded", async () => {
    mocks.getHutFeeItemCodeMap.mockRejectedValueOnce(new Error("connection reset"));
    const result = await resolveModificationDocumentLineItems({
      bookingId: "bk1",
      row: { priceLines: stored, priceDiffCents: 8000, changeFeeCents: 0 },
      document: "SUPPLEMENTARY_INVOICE",
      billedCents: 8000,
      billedFigures: { priceDiffCents: 8000, changeFeeCents: 0 },
    });
    expect(result).toEqual({
      lineItems: null,
      record: { source: "FALLBACK_SINGLE_LINE", reason: "NARRATION_UNAVAILABLE", storedSumCents: null, billedCents: 8000, lineCount: 0 },
    });
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);

    mocks.bookingModificationFindUnique.mockRejectedValueOnce(new Error("connection reset"));
    const rowRead = await resolveModificationDocumentLineItems({
      bookingId: "bk1",
      bookingModificationId: "mod_1",
      document: "MODIFICATION_CREDIT_NOTE",
      billedCents: 16000,
    });
    expect(rowRead.record.reason).toBe("NARRATION_UNAVAILABLE");
  });

  it("a credit note bills from the row itself", async () => {
    const removedLines = linesOf(
      { guests: [guest("a"), guest("b")], promoAdjustmentCents: 0 },
      { guests: [{ ...guest("a"), nights: nights("2026-08-14", [8000, 8000], false) }], promoAdjustmentCents: 0 },
      -16000,
    );
    const result = await resolveModificationDocumentLineItems({
      bookingId: "bk1",
      row: { priceLines: removedLines, priceDiffCents: -16000, changeFeeCents: 0 },
      document: "MODIFICATION_CREDIT_NOTE",
      billedCents: 16000,
    });
    expect(result.record.source).toBe("STORED");
    expect(lineTotalCents(result.lineItems ?? [])).toBe(16000);
  });
});
