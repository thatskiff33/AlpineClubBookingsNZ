import { beforeEach, describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planners never query it. The
// recorder's wiring test drives the journal read, the shares, the posted legs
// and the manifest write through these mocks.
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  loadShares: vi.fn(),
  readBookingChargeLegs: vi.fn(),
  writeExportManifest: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: { info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError, debug: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberMoneyJournal: { findMany: mocks.findMany },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}));
vi.mock("@/lib/xero-modification-line-items", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-modification-line-items")),
  loadEditReviewSettledShares: mocks.loadShares,
}));
vi.mock("@/lib/member-money/internal/booking-journal-read", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/internal/booking-journal-read")),
  readBookingChargeLegs: mocks.readBookingChargeLegs,
}));
vi.mock("@/lib/member-money/internal/store", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/internal/store")),
  writeExportManifest: mocks.writeExportManifest,
}));
import { Prisma } from "@prisma/client";
import {
  readItemisedShareSliceEvents,
  readSupplementarySliceEvent,
  recordSupplementaryInvoiceManifest,
} from "@/lib/member-money/internal/supplementary-invoice-manifest";
import { LineAmountTypes, type LineItem } from "xero-node";
import { modificationChangeFeeKey } from "@/lib/booking-ledger-posting-keys";
import { changeFeeLineItem } from "@/lib/xero-modification-line-items";
import { BASELINE_XERO_TAX_RENDERING as BASELINE, xeroLineTax, type XeroTaxRendering } from "@/lib/xero-tax-rendering";
import type { PostedRevenueLeg } from "@/lib/member-money/internal/components";
import { planPrimaryInvoiceUpdate, primaryInvoicePayloadHash } from "@/lib/member-money/internal/primary-invoice-plan";
import {
  planSupplementaryBookingInvoice,
  type SupplementaryInvoicePlanInput,
} from "@/lib/member-money/internal/supplementary-invoice-plan";

/** ALP-436 (#4525, Ledger M13): the supplementary invoice's planner and the primary invoice update's. */

const BOOKING = "booking-m13";
const MOD = "mod-1";
const STAY = `booking:${BOOKING}:charge`;
const FEE = modificationChangeFeeKey(MOD);
const EVENT = `modification:${MOD}`;
const TAX = "GST_INCLUSIVE_1500BP";
const mapping = { code: "201", itemCode: "HUT", codeExplicitlyConfigured: true };

const leg = (account: PostedRevenueLeg["account"], chargeIdentity: string, grossCents: number, extra: Partial<PostedRevenueLeg> = {}): PostedRevenueLeg => ({
  account, chargeIdentity, side: grossCents >= 0 ? "CREDIT" : "DEBIT", amountCents: Math.abs(grossCents),
  grossCents: Math.abs(grossCents), netCents: Math.abs(grossCents), taxCents: 0,
  taxCode: TAX, bookingId: BOOKING, lodgeId: "lodge-1", ...extra,
});
const stayLine = (cents: number): LineItem => ({ description: "Extra night", quantity: 1, unitAmount: cents / 100, accountCode: "201" });

function input(overrides: Partial<SupplementaryInvoicePlanInput> = {}): SupplementaryInvoicePlanInput {
  return {
    bookingId: BOOKING,
    anchor: { kind: "MODIFICATION", modificationId: MOD },
    legacyKey: `xero-supplementary:${MOD}`,
    lines: [stayLine(4500), changeFeeLineItem(2000, mapping, BASELINE)],
    taxRendering: BASELINE,
    priceLines: [{ kind: "night" }],
    sliceEvent: { eventKey: EVENT, reversed: false, legs: [leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", FEE, 2000)] },
    postedLegs: [leg("BOOKING_REVENUE", STAY, 14000), leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", FEE, 2000)],
    ...overrides,
  };
}

describe("planSupplementaryBookingInvoice (ALP-436)", () => {
  it("covers the edit's slice of the stay charge and its own fee whole", () => {
    const plan = planSupplementaryBookingInvoice(input());
    expect(plan).toMatchObject({
      outcome: "COVERED",
      lineTotalCents: 6500,
      coverage: [
        { account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: EVENT, coveredCents: 4500, taxCode: TAX },
        { account: "FEE_REVENUE", chargeIdentity: FEE, coveredCents: 2000, taxCode: TAX },
      ],
    });
    expect(plan.payloadHash).toBe(primaryInvoicePayloadHash(input().lines));
    expect(plan.frozenMapping).toMatchObject({
      source: "BUILT", anchor: { kind: "MODIFICATION", modificationId: MOD }, lineAmountTypes: LineAmountTypes.Inclusive,
      componentTaxCodes: [
        { account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: EVENT, taxCode: TAX },
        { account: "FEE_REVENUE", chargeIdentity: FEE, sliceKey: null, taxCode: TAX },
      ],
    });
  });

  it("covers a fee-only invoice when the edit moved no stay money", () => {
    const plan = planSupplementaryBookingInvoice(input({
      lines: [changeFeeLineItem(2000, mapping, BASELINE)],
      sliceEvent: { eventKey: EVENT, reversed: false, legs: [leg("FEE_REVENUE", FEE, 2000)] },
    }));
    expect(plan).toMatchObject({ outcome: "COVERED", coverage: [{ account: "FEE_REVENUE", chargeIdentity: FEE, coveredCents: 2000 }] });
  });

  // #4632: the three treatments a tax period can hold. The sender renders the
  // invoice under the booking's own (its tax anchor: when it was made); the
  // manifest freezes exactly that rendering, and each line's own tax type.
  const TREATMENTS: ReadonlyArray<[string, XeroTaxRendering]> = [
    ["the baseline (registered, OUTPUT2)", BASELINE],
    ["a registered period with another code", { lineAmountTypes: LineAmountTypes.Inclusive, taxType: "OUTPUT3" }],
    ["an unregistered period", { lineAmountTypes: LineAmountTypes.NoTax }],
  ];

  it.each(TREATMENTS)("freezes the treatment the invoice was sent with under %s", (_label, taxRendering) => {
    const lines = [{ ...stayLine(4500), ...xeroLineTax(taxRendering) }, changeFeeLineItem(2000, mapping, taxRendering)];
    const plan = planSupplementaryBookingInvoice(input({ lines, taxRendering }));
    expect(plan.outcome).toBe("COVERED");
    expect(plan.frozenMapping).toMatchObject({
      source: "BUILT",
      taxType: taxRendering.taxType ?? null,
      lineAmountTypes: taxRendering.lineAmountTypes,
      lineCodes: [
        { accountCode: "201", itemCode: null, taxType: taxRendering.taxType ?? null },
        { accountCode: "201", itemCode: "HUT", taxType: taxRendering.taxType ?? null },
      ],
    });
  });

  it("never freezes another treatment than the one it was handed, whatever today's is", () => {
    // A booking made before a change to unregistered keeps registered OUTPUT2
    // for its whole life (#4632, decision A): the sender hands the planner the
    // booking's rendering, and the planner records that, not a default.
    const unregistered: XeroTaxRendering = { lineAmountTypes: LineAmountTypes.NoTax };
    const plan = planSupplementaryBookingInvoice(input({
      lines: [stayLine(4500), changeFeeLineItem(2000, mapping, unregistered)],
      taxRendering: unregistered,
    }));
    expect(plan.frozenMapping).toMatchObject({ taxType: null, lineAmountTypes: LineAmountTypes.NoTax });
    expect(plan.frozenMapping).not.toMatchObject({ lineAmountTypes: LineAmountTypes.Inclusive });
  });

  it("bills a second ask's review closure as a slice, with no fee", () => {
    const closure = `review-close:task-9:line-1`;
    const plan = planSupplementaryBookingInvoice(input({
      anchor: { kind: "SECOND_ASK", modificationId: MOD, taskId: "task-9" },
      lines: [stayLine(3000)],
      sliceEvent: { eventKey: closure, reversed: false, legs: [leg("BOOKING_REVENUE", STAY, 3000)] },
    }));
    expect(plan).toMatchObject({ outcome: "COVERED", coverage: [{ chargeIdentity: STAY, sliceKey: closure, coveredCents: 3000 }] });
  });

  it("refuses a fee on a second ask", () => {
    const plan = planSupplementaryBookingInvoice(input({ anchor: { kind: "SECOND_ASK", modificationId: MOD, taskId: "task-9" } }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });

  it("records a reduction netted against a fee as a conflict", () => {
    const plan = planSupplementaryBookingInvoice(input({ lines: [stayLine(-1000), changeFeeLineItem(2000, mapping, BASELINE)] }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "REDUCTION_NETTED", lineTotalCents: 1000 });
  });

  it.each([
    ["no event", null],
    ["an ambiguous second ask", "AMBIGUOUS" as const],
    ["a reversed event", { eventKey: EVENT, reversed: true, legs: [leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", FEE, 2000)] }],
    ["an event moving another booking's revenue", { eventKey: EVENT, reversed: false, legs: [leg("BOOKING_REVENUE", STAY, 4500), leg("BOOKING_REVENUE", "booking:other:charge", 100), leg("FEE_REVENUE", FEE, 2000)] }],
  ])("refuses %s as COMPONENT_UNUSABLE", (_label, sliceEvent) => {
    expect(planSupplementaryBookingInvoice(input({ sliceEvent }))).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
  });

  it("refuses stay lines that do not bill the event's movement", () => {
    expect(planSupplementaryBookingInvoice(input({ lines: [stayLine(4400), changeFeeLineItem(2000, mapping, BASELINE)] })))
      .toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
  });

  it("refuses a fee line that differs from the fee the edit posted", () => {
    expect(planSupplementaryBookingInvoice(input({ lines: [stayLine(4500), changeFeeLineItem(2500, mapping, BASELINE)] })))
      .toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });

  it("refuses an event that moves a fee other than the edit's own", () => {
    const other = modificationChangeFeeKey("mod-0");
    const plan = planSupplementaryBookingInvoice(input({
      sliceEvent: { eventKey: EVENT, reversed: false, legs: [leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", other, 2000)] },
    }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });

  describe("an edit whose financial review settled shares before it was sent", () => {
    const CLOSE_A = "review-close:task-a:line-1";
    const CLOSE_B = "review-close:task-b:line-1";
    const shareLine = (cents: number): LineItem => ({ description: "Agreed adjustment", quantity: 1, unitAmount: cents / 100, accountCode: "201" });
    const closure = (eventKey: string, ...legs: PostedRevenueLeg[]) => ({ eventKey, reversed: false, legs });
    const withShares = (overrides: Partial<SupplementaryInvoicePlanInput> = {}) => input({
      lines: [stayLine(4500), shareLine(1500), shareLine(500), changeFeeLineItem(2000, mapping, BASELINE)],
      shareEvents: [closure(CLOSE_A, leg("BOOKING_REVENUE", STAY, 1500)), closure(CLOSE_B, leg("BOOKING_REVENUE", STAY, 500))],
      ...overrides,
    });

    it("covers the edit's slice, each share's closure as a slice of its own, and the fee", () => {
      expect(planSupplementaryBookingInvoice(withShares())).toMatchObject({
        outcome: "COVERED",
        lineTotalCents: 8500,
        coverage: [
          { account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: EVENT, coveredCents: 4500 },
          { account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: CLOSE_A, coveredCents: 1500 },
          { account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: CLOSE_B, coveredCents: 500 },
          { account: "FEE_REVENUE", chargeIdentity: FEE, coveredCents: 2000 },
        ],
      });
    });

    it("covers a parked edit whose shares alone explain the stay lines", () => {
      expect(planSupplementaryBookingInvoice(withShares({
        lines: [shareLine(1500), changeFeeLineItem(2000, mapping, BASELINE)],
        sliceEvent: { eventKey: EVENT, reversed: false, legs: [leg("FEE_REVENUE", FEE, 2000)] },
        shareEvents: [closure(CLOSE_A, leg("BOOKING_REVENUE", STAY, 1500))],
      }))).toMatchObject({ outcome: "COVERED", coverage: [{ sliceKey: CLOSE_A, coveredCents: 1500 }, { account: "FEE_REVENUE" }] });
    });

    it("records the share's slice as STAY_CENTS when the closure is not read", () => {
      expect(planSupplementaryBookingInvoice(withShares({ shareEvents: [] }))).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
    });

    it.each([
      ["a share with no closure", [null]],
      ["a share whose task closed twice", ["AMBIGUOUS" as const]],
      ["a closure moving another booking's revenue", [closure(CLOSE_A, leg("BOOKING_REVENUE", STAY, 2000), leg("BOOKING_REVENUE", "booking:other:charge", 100))]],
    ])("refuses %s as COMPONENT_UNUSABLE", (_label, shareEvents) => {
      expect(planSupplementaryBookingInvoice(withShares({ shareEvents }))).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
    });

    it("refuses a closure that moves a fee", () => {
      expect(planSupplementaryBookingInvoice(withShares({
        shareEvents: [closure(CLOSE_A, leg("BOOKING_REVENUE", STAY, 2000), leg("FEE_REVENUE", FEE, 100))],
      }))).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
    });

    it("refuses a give-back share netted against the edit's charge", () => {
      expect(planSupplementaryBookingInvoice(withShares({
        lines: [stayLine(4500), shareLine(-1500), changeFeeLineItem(2000, mapping, BASELINE)],
        shareEvents: [closure(CLOSE_A, leg("BOOKING_REVENUE", STAY, -1500))],
      }))).toMatchObject({ outcome: "CONFLICT", reason: "REDUCTION_NETTED" });
    });

    it("never reads shares into a second ask", () => {
      const plan = planSupplementaryBookingInvoice(input({
        anchor: { kind: "SECOND_ASK", modificationId: MOD, taskId: "task-9" },
        lines: [stayLine(3000)],
        sliceEvent: closure("review-close:task-9:line-1", leg("BOOKING_REVENUE", STAY, 3000)),
        shareEvents: [closure(CLOSE_A, leg("BOOKING_REVENUE", STAY, 1500))],
      }));
      expect(plan).toMatchObject({ outcome: "COVERED", coverage: [{ sliceKey: "review-close:task-9:line-1", coveredCents: 3000 }] });
    });
  });

  it("refuses a fee a later event has since moved", () => {
    const plan = planSupplementaryBookingInvoice(input({
      postedLegs: [leg("BOOKING_REVENUE", STAY, 18500), leg("FEE_REVENUE", FEE, 2000), leg("FEE_REVENUE", FEE, -500)],
    }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });
});

describe("planPrimaryInvoiceUpdate (ALP-436)", () => {
  const lines = [stayLine(14000)];
  const primary = { id: "manifest-1", outcome: "COVERED" as const, lineTotalCents: 14000, providerInvoiceId: "inv-1" };
  const update = (overrides: Partial<Parameters<typeof planPrimaryInvoiceUpdate>[0]> = {}) => planPrimaryInvoiceUpdate({
    legacyKey: "update-key", providerInvoiceId: "inv-1", lines, lineAmountTypes: LineAmountTypes.Inclusive, providerTotalCents: 14000, primary, ...overrides,
  });

  it("plans nothing without a primary manifest", () => {
    expect(update({ primary: null })).toBeNull();
  });

  it("matches a same-total update of the primary invoice, freezing the provider's line amount types", () => {
    expect(update()).toMatchObject({
      outcome: "COVERED", legacyKey: "update-key", lineTotalCents: 14000, payloadHash: primaryInvoicePayloadHash(lines),
      frozenMapping: { source: "UPDATED_FROM_PROVIDER", primaryManifestId: "manifest-1", lineAmountTypes: LineAmountTypes.Inclusive },
    });
  });

  // #4632: the update copies every line of the issued invoice, tax type and
  // all, and keeps the basis it was issued under; the manifest freezes those.
  it.each([
    ["the baseline (registered, OUTPUT2)", LineAmountTypes.Inclusive, "OUTPUT2"],
    ["a registered period with another code", LineAmountTypes.Inclusive, "OUTPUT3"],
    ["an unregistered period", LineAmountTypes.NoTax, undefined],
  ] as const)("freezes the basis and each line's tax type the update was sent with under %s", (_label, lineAmountTypes, taxType) => {
    const sent = [{ ...stayLine(14000), ...(taxType === undefined ? {} : { taxType }) }];
    expect(update({ lines: sent, lineAmountTypes })).toMatchObject({
      outcome: "COVERED",
      frozenMapping: { lineAmountTypes, lineCodes: [{ accountCode: "201", itemCode: null, taxType: taxType ?? null }] },
    });
  });

  it.each([
    ["discounted", { ...stayLine(14000), discountRate: 10, lineAmount: 126 }, LineAmountTypes.Inclusive, 12600],
    ["exclusive tax", { ...stayLine(14000), lineAmount: 140, taxAmount: 21 }, LineAmountTypes.Exclusive, 16100],
  ])("uses the provider total for %s lines", (_label, line, lineAmountTypes, providerTotalCents) => {
    expect(update({ lines: [line], lineAmountTypes, providerTotalCents }))
      .toMatchObject({ outcome: "CONFLICT", reason: "PRIMARY_UNMATCHED", lineTotalCents: providerTotalCents });
  });

  it.each([
    ["another invoice", { providerInvoiceId: "inv-2" }, {}],
    ["a conflicted primary", {}, { outcome: "CONFLICT" as const }],
    ["a changed total", { lines: [stayLine(15000)], providerTotalCents: 15000 }, {}],
  ])("records %s as PRIMARY_UNMATCHED", (_label, overrides, primaryOverrides) => {
    expect(update({ ...overrides, primary: { ...primary, ...primaryOverrides } }))
      .toMatchObject({ outcome: "CONFLICT", reason: "PRIMARY_UNMATCHED" });
  });
});

describe("readSupplementarySliceEvent (ALP-436)", () => {
  const anchor = { kind: "SECOND_ASK" as const, modificationId: MOD, taskId: "task_%\\1" };
  const journal = (eventKey: string, reversed = false) => ({ event: { eventKey }, reversedBy: reversed ? { id: "reversal" } : null, lines: [] });
  const read = (journals: ReturnType<typeof journal>[]) => {
    const findMany = vi.fn().mockResolvedValue(journals);
    const db = { memberMoneyJournal: { findMany } } as unknown as Pick<Prisma.TransactionClient, "memberMoneyJournal">;
    return { findMany, db };
  };

  it("matches task IDs literally, escaping SQL wildcard and escape characters", async () => {
    const { db, findMany } = read([]);
    await readSupplementarySliceEvent(db, BOOKING, anchor);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { event: { eventKey: { startsWith: String.raw`review-close:task\_\%\\1:` } }, reversesJournalId: null },
    }));
  });

  it("selects the one live closure after an earlier closure was reversed", async () => {
    const { db } = read([journal("review-close:task:old", true), journal("review-close:task:live")]);
    await expect(readSupplementarySliceEvent(db, BOOKING, anchor)).resolves.toMatchObject({ eventKey: "review-close:task:live", reversed: false });
  });

  it("refuses multiple live closures and ignores fully reversed closures", async () => {
    await expect(readSupplementarySliceEvent(read([journal("one"), journal("two")]).db, BOOKING, anchor)).resolves.toBe("AMBIGUOUS");
    await expect(readSupplementarySliceEvent(read([journal("old", true)]).db, BOOKING, anchor)).resolves.toBeNull();
  });

  it("reads the one live closure of each itemised share's task for an edit, and none for a second ask", async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([journal("review-close:a:old", true), journal("review-close:a:live")])
      .mockResolvedValueOnce([]);
    const db = { memberMoneyJournal: { findMany } } as unknown as Pick<Prisma.TransactionClient, "memberMoneyJournal">;
    await expect(readItemisedShareSliceEvents(db, BOOKING, { kind: "MODIFICATION", modificationId: MOD }, ["a", "b"]))
      .resolves.toEqual([expect.objectContaining({ eventKey: "review-close:a:live" }), null]);
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { event: { eventKey: { startsWith: "review-close:b:" } }, reversesJournalId: null },
    }));
    await expect(readItemisedShareSliceEvents(db, BOOKING, anchor, ["a"])).resolves.toEqual([]);
    await expect(readItemisedShareSliceEvents(db, BOOKING, { kind: "MODIFICATION", modificationId: MOD }, [])).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("keeps a reversed modification visible so its planner can refuse it", async () => {
    await expect(readSupplementarySliceEvent(read([journal(EVENT, true)]).db, BOOKING, { kind: "MODIFICATION", modificationId: MOD }))
      .resolves.toMatchObject({ eventKey: EVENT, reversed: true });
  });
});

describe("recordSupplementaryInvoiceManifest (ALP-436)", () => {
  // Review task T settled a 1500 charge against edit E: its closure moved the
  // stay charge by 1500. The journal and the settled-share table both hold it
  // in every case below; only what the sent lines itemise differs.
  const CLOSE_T = "review-close:task-t:line-1";
  const journals: Record<string, { event: { eventKey: string }; reversedBy: null; lines: PostedRevenueLeg[] }> = {
    [EVENT]: { event: { eventKey: EVENT }, reversedBy: null, lines: [leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", FEE, 2000)] },
    [CLOSE_T]: { event: { eventKey: CLOSE_T }, reversedBy: null, lines: [leg("BOOKING_REVENUE", STAY, 1500)] },
  };
  const singleLine = (cents: number): LineItem => ({ description: "Booking modification - price adjustment (Booking booking-)", quantity: 1, unitAmount: cents / 100, taxType: "OUTPUT2", accountCode: "201" });
  const shareLine = (cents: number): LineItem => ({ description: "Agreed adjustment", quantity: 1, unitAmount: cents / 100, accountCode: "201" });
  const record = (overrides: Partial<Parameters<typeof recordSupplementaryInvoiceManifest>[0]>) => recordSupplementaryInvoiceManifest({
    bookingId: BOOKING,
    anchor: { kind: "MODIFICATION", modificationId: MOD },
    legacyKey: `xero-supplementary:${MOD}`,
    lines: [stayLine(4500), changeFeeLineItem(2000, mapping, BASELINE)],
    taxRendering: BASELINE,
    priceLines: { source: "STORED", shareCount: 0 },
    itemisedShareTaskIds: [],
    providerInvoiceId: "inv-1",
    ...overrides,
  });
  const written = () => mocks.writeExportManifest.mock.calls.at(-1)?.[1];

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.findMany.mockImplementation(async ({ where }: { where: { event: { eventKey: string | { startsWith: string } } } }) => {
      const key = where.event.eventKey;
      return Object.values(journals).filter(({ event }) =>
        typeof key === "string" ? event.eventKey === key : event.eventKey.startsWith(key.startsWith));
    });
    mocks.loadShares.mockResolvedValue([{ taskId: "task-t", sign: 1, amountCents: 1500, note: null }]);
    mocks.readBookingChargeLegs.mockResolvedValue([
      leg("BOOKING_REVENUE", STAY, 14000), leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", FEE, 2000), leg("BOOKING_REVENUE", STAY, 1500),
    ]);
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
  });

  it("covers an itemised settled share as its own slice", async () => {
    await record({ lines: [stayLine(4500), shareLine(1500), changeFeeLineItem(2000, mapping, BASELINE)], priceLines: { source: "STORED", shareCount: 1 }, itemisedShareTaskIds: ["task-t"] });
    expect(written()).toMatchObject({
      documentRole: "SUPPLEMENTARY_BOOKING_INVOICE",
      outcome: "COVERED",
      coverage: [
        { account: "BOOKING_REVENUE", sliceKey: EVENT, coveredCents: 4500 },
        { account: "BOOKING_REVENUE", sliceKey: CLOSE_T, coveredCents: 1500 },
        { account: "FEE_REVENUE", chargeIdentity: FEE, coveredCents: 2000 },
      ],
    });
  });

  it("covers the single fallback line as the edit's own slice and fee, never the share it did not bill", async () => {
    // E's lines total 4500; T settled after the operation was claimed and the
    // figures were withheld, so 4500 + 1500 != 4500 and the sender fell back.
    await record({
      lines: [singleLine(4500), changeFeeLineItem(2000, mapping, BASELINE)],
      priceLines: { source: "FALLBACK_SINGLE_LINE", reason: "STORED_LINES_DO_NOT_SUM", shareCount: 0 },
      itemisedShareTaskIds: [],
    });
    expect(written()).toMatchObject({ outcome: "COVERED", reason: null });
    expect(written()?.coverage).toEqual([
      expect.objectContaining({ account: "BOOKING_REVENUE", sliceKey: EVENT, coveredCents: 4500 }),
      expect.objectContaining({ account: "FEE_REVENUE", chargeIdentity: FEE, coveredCents: 2000 }),
    ]);
  });

  it("covers an invoice whose lines were built before a share settled, and leaves the share to its own document", async () => {
    await record({ priceLines: { source: "STORED", shareCount: 0 }, itemisedShareTaskIds: [] });
    expect(written()).toMatchObject({ outcome: "COVERED" });
    expect(written()?.coverage.map((row: { sliceKey?: string }) => row.sliceKey)).not.toContain(CLOSE_T);
  });

  it("lets the later second ask for that share cover its closure, a slice no edit manifest claimed", async () => {
    await record({ itemisedShareTaskIds: [] });
    const editSlices = written()?.coverage.map((row: { sliceKey?: string }) => row.sliceKey);
    await record({
      anchor: { kind: "SECOND_ASK", modificationId: MOD, taskId: "task-t" },
      legacyKey: "review-task:task-t:supplementary-shortfall-invoice:1500:0:v1",
      lines: [singleLine(1500)],
      priceLines: { source: "FALLBACK_SINGLE_LINE", reason: "SECOND_ASK", shareCount: 0 },
      providerInvoiceId: "inv-2",
    });
    expect(written()).toMatchObject({ outcome: "COVERED", coverage: [{ account: "BOOKING_REVENUE", sliceKey: CLOSE_T, coveredCents: 1500 }] });
    expect(editSlices).not.toContain(CLOSE_T);
  });

  it("records the treatment the sender handed it, for each treatment a period can hold (#4632)", async () => {
    for (const taxRendering of [BASELINE, { lineAmountTypes: LineAmountTypes.Inclusive, taxType: "OUTPUT3" }, { lineAmountTypes: LineAmountTypes.NoTax }] as XeroTaxRendering[]) {
      await record({ lines: [{ ...stayLine(4500), ...xeroLineTax(taxRendering) }, changeFeeLineItem(2000, mapping, taxRendering)], taxRendering });
      expect(written()).toMatchObject({
        outcome: "COVERED",
        frozenMapping: { taxType: taxRendering.taxType ?? null, lineAmountTypes: taxRendering.lineAmountTypes },
      });
    }
  });

  it("warns when a slice is already covered by another manifest, and notes a manifest-key race at info", async () => {
    // adapter-pg names the index, as the realdb suite shows for the coverage key.
    const p2002 = (index: string) => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index } } } },
    });
    mocks.writeExportManifest.mockRejectedValueOnce(p2002("MemberMoneyExportCoverage_documentRole_account_chargeIdenti_key"));
    await record({});
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING }), expect.stringContaining("already covered by another manifest"));
    expect(mocks.logInfo).not.toHaveBeenCalled();

    mocks.writeExportManifest.mockRejectedValueOnce(p2002("MemberMoneyExportManifest_documentRole_legacyKey_key"));
    await record({});
    expect(mocks.logInfo).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING }), expect.stringContaining("recorded the supplementary invoice's manifest first"));
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
