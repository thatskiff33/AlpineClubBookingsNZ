import { beforeEach, describe, expect, it, vi } from "vitest";

// The planner never queries; the recorder's wiring test drives the journal
// read, the live-coverage read and the manifest write through these mocks.
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  coverageFindFirst: vi.fn(),
  writeExportManifest: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: { info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError, debug: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberMoneyJournal: { findMany: mocks.findMany },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ memberMoneyExportCoverage: { findFirst: mocks.coverageFindFirst } }),
  },
}));
vi.mock("@/lib/member-money/internal/store", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/internal/store")),
  writeExportManifest: mocks.writeExportManifest,
}));
import { Prisma } from "@prisma/client";
import { LineAmountTypes, type LineItem } from "xero-node";
import { modificationChangeFeeKey } from "@/lib/booking-ledger-posting-keys";
import { changeFeeLineItem } from "@/lib/xero-modification-line-items";
import { BASELINE_XERO_TAX_RENDERING as BASELINE, xeroLineTax, type XeroTaxRendering } from "@/lib/xero-tax-rendering";
import { giveBackNoteScope, UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } from "@/lib/xero-review-task-key";
import type { PostedRevenueLeg } from "@/lib/member-money/internal/components";
import { primaryInvoicePayloadHash } from "@/lib/member-money/internal/primary-invoice-plan";
import {
  planModificationCreditNote,
  type ModificationCreditNotePlanInput,
} from "@/lib/member-money/internal/modification-credit-note-plan";
import {
  modificationCreditNoteAnchor,
  recordModificationCreditNoteManifest,
} from "@/lib/member-money/internal/modification-credit-note-manifest";

/** ALP-753 (#4525, Ledger M13): an edit's credit note's planner and recorder. */

const BOOKING = "booking-m13-note";
const MOD = "mod-note-1";
const STAY = `booking:${BOOKING}:charge`;
const FEE = modificationChangeFeeKey(MOD);
const EVENT = `modification:${MOD}`;
const CLOSE_T = "review-close:task-t:line-1";
const TAX = "GST_INCLUSIVE_1500BP";
const mapping = { code: "201", itemCode: "HUT", codeExplicitlyConfigured: true };

const leg = (account: PostedRevenueLeg["account"], chargeIdentity: string, grossCents: number, extra: Partial<PostedRevenueLeg> = {}): PostedRevenueLeg => ({
  account, chargeIdentity, side: grossCents >= 0 ? "CREDIT" : "DEBIT", amountCents: Math.abs(grossCents),
  grossCents: Math.abs(grossCents), netCents: Math.abs(grossCents), taxCents: 0,
  taxCode: TAX, bookingId: BOOKING, lodgeId: "lodge-1", ...extra,
});
/** A reduction as an edit posts it: the whole stay component corrected to zero, the remainder charged again. */
const reduction = (eventKey: string, fromCents: number, toCents: number) =>
  ({ eventKey, reversed: false, legs: [leg("BOOKING_REVENUE", STAY, -fromCents), leg("BOOKING_REVENUE", STAY, toCents)] });
const noteLine = (cents: number): LineItem => ({ description: "Night removed", quantity: 1, unitAmount: cents / 100, accountCode: "202" });

function input(overrides: Partial<ModificationCreditNotePlanInput> = {}): ModificationCreditNotePlanInput {
  return {
    bookingId: BOOKING,
    anchor: { kind: "MODIFICATION", modificationId: MOD },
    legacyKey: `booking-mod:${MOD}:mod-credit-note:4500:v1`,
    lines: [noteLine(4500)],
    taxRendering: BASELINE,
    priceLines: { source: "STORED", shareCount: 0 },
    sliceEvent: reduction(EVENT, 14000, 9500),
    ...overrides,
  };
}

describe("planModificationCreditNote (ALP-753)", () => {
  it("covers the reduction the edit's event posted as a positive slice of the stay charge", () => {
    const plan = planModificationCreditNote(input());
    expect(plan).toMatchObject({
      outcome: "COVERED",
      lineTotalCents: 4500,
      coverage: [{ account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: EVENT, coveredCents: 4500, taxCode: TAX }],
    });
    expect(plan.payloadHash).toBe(primaryInvoicePayloadHash(input().lines));
    expect(plan.frozenMapping).toMatchObject({
      source: "BUILT", anchor: { kind: "MODIFICATION", modificationId: MOD },
      componentTaxCodes: [{ account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: EVENT, taxCode: TAX }],
    });
  });

  it("covers each itemised settled review share as its own slice", () => {
    const plan = planModificationCreditNote(input({
      lines: [noteLine(3000), noteLine(1500)],
      sliceEvent: reduction(EVENT, 14000, 11000),
      shareEvents: [reduction(CLOSE_T, 11000, 9500)],
    }));
    expect(plan).toMatchObject({
      outcome: "COVERED",
      lineTotalCents: 4500,
      coverage: [
        { sliceKey: EVENT, coveredCents: 3000 },
        { sliceKey: CLOSE_T, coveredCents: 1500 },
      ],
    });
  });

  it("covers a review task's note as its closure's slice, and reads no shares for it", () => {
    const plan = planModificationCreditNote(input({
      anchor: { kind: "REVIEW_SHARE", modificationId: MOD, taskId: "task-t" },
      lines: [noteLine(1500)],
      sliceEvent: reduction(CLOSE_T, 11000, 9500),
      shareEvents: [null],
    }));
    expect(plan).toMatchObject({ outcome: "COVERED", coverage: [{ sliceKey: CLOSE_T, coveredCents: 1500 }] });
  });

  it("refuses a note that nets the edit's change fee, by its fee line or by a fee its event moved", () => {
    const netted = planModificationCreditNote(input({
      lines: [noteLine(6500), { ...changeFeeLineItem(2000, mapping, BASELINE), unitAmount: -20 }],
      sliceEvent: { ...reduction(EVENT, 14000, 7500), legs: [...reduction(EVENT, 14000, 7500).legs, leg("FEE_REVENUE", FEE, 2000)] },
    }));
    expect(netted).toMatchObject({ outcome: "CONFLICT", reason: "REDUCTION_NETTED", lineTotalCents: 4500 });
    expect(netted).not.toHaveProperty("coverage");
    // The single fallback line carries the net; the fee shows only on the event.
    const single = planModificationCreditNote(input({
      lines: [noteLine(4500)],
      sliceEvent: { ...reduction(EVENT, 14000, 7500), legs: [...reduction(EVENT, 14000, 7500).legs, leg("FEE_REVENUE", FEE, 2000)] },
    }));
    expect(single).toMatchObject({ outcome: "CONFLICT", reason: "REDUCTION_NETTED" });
  });

  it("refuses an edit that raised the price: a note returns no increase", () => {
    expect(planModificationCreditNote(input({ sliceEvent: reduction(EVENT, 14000, 18500) })))
      .toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
  });

  it("refuses a share that moved the stay the other way rather than netting it", () => {
    expect(planModificationCreditNote(input({
      lines: [noteLine(4500)],
      sliceEvent: reduction(EVENT, 14000, 8000),
      shareEvents: [reduction(CLOSE_T, 8000, 9500)],
    }))).toMatchObject({ outcome: "CONFLICT", reason: "REDUCTION_NETTED" });
  });

  it("refuses lines that do not carry exactly what the slices returned", () => {
    expect(planModificationCreditNote(input({ lines: [noteLine(4000)] }))).toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
  });

  it("refuses a reversed, missing or ambiguous event, and a share whose closure is any of those", () => {
    expect(planModificationCreditNote(input({ sliceEvent: { ...reduction(EVENT, 14000, 9500), reversed: true } })))
      .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", problem: `the journal reversed ${EVENT}` });
    expect(planModificationCreditNote(input({ sliceEvent: null })))
      .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", problem: "the journal holds no event for what this note returns" });
    expect(planModificationCreditNote(input({ anchor: { kind: "REVIEW_SHARE", modificationId: MOD, taskId: "task-t" }, sliceEvent: "AMBIGUOUS" })))
      .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
    for (const share of [null, "AMBIGUOUS"] as const) {
      expect(planModificationCreditNote(input({ lines: [noteLine(3000), noteLine(1500)], sliceEvent: reduction(EVENT, 14000, 11000), shareEvents: [share] })))
        .toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
    }
  });

  it("refuses a give-back or billed-offset note, naming its scope", () => {
    for (const scope of [giveBackNoteScope(undefined), UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE]) {
      const plan = planModificationCreditNote(input({ anchor: modificationCreditNoteAnchor(MOD, scope) }));
      expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE" });
      expect(plan.outcome === "CONFLICT" && plan.problem).toContain(scope);
    }
    expect(modificationCreditNoteAnchor(MOD, giveBackNoteScope("task-t"))).toMatchObject({ kind: "OTHER_SCOPE" });
    expect(modificationCreditNoteAnchor(MOD, "task-t")).toEqual({ kind: "REVIEW_SHARE", modificationId: MOD, taskId: "task-t" });
    expect(modificationCreditNoteAnchor(MOD, undefined)).toEqual({ kind: "MODIFICATION", modificationId: MOD });
  });

  it.each([
    ["the baseline (registered, OUTPUT2)", BASELINE],
    ["a registered period with another code", { lineAmountTypes: LineAmountTypes.Inclusive, taxType: "OUTPUT3" }],
    ["an unregistered period", { lineAmountTypes: LineAmountTypes.NoTax }],
  ] as ReadonlyArray<[string, XeroTaxRendering]>)("freezes the treatment the note was sent with under %s", (_label, taxRendering) => {
    const plan = planModificationCreditNote(input({ lines: [{ ...noteLine(4500), ...xeroLineTax(taxRendering) }], taxRendering }));
    expect(plan.outcome).toBe("COVERED");
    expect(plan.frozenMapping).toMatchObject({
      taxType: taxRendering.taxType ?? null,
      lineAmountTypes: taxRendering.lineAmountTypes,
      lineCodes: [{ accountCode: "202", itemCode: null, taxType: taxRendering.taxType ?? null }],
    });
  });
});

describe("recordModificationCreditNoteManifest (ALP-753)", () => {
  const journals = [
    { event: { eventKey: EVENT }, reversedBy: null, lines: reduction(EVENT, 14000, 9500).legs },
  ];
  const record = (overrides: Partial<Parameters<typeof recordModificationCreditNoteManifest>[0]> = {}) => recordModificationCreditNoteManifest({
    bookingId: BOOKING,
    modificationId: MOD,
    legacyKey: `booking-mod:${MOD}:mod-credit-note:4500:v1`,
    lines: [noteLine(4500)],
    taxRendering: BASELINE,
    priceLines: { source: "STORED", shareCount: 0 },
    itemisedShareTaskIds: [],
    providerCreditNoteId: "credit-1",
    ...overrides,
  });
  const written = () => mocks.writeExportManifest.mock.calls.at(-1)?.[1];

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.findMany.mockImplementation(async ({ where }: { where: { event: { eventKey: string | { startsWith: string } } } }) => {
      const key = where.event.eventKey;
      return journals.filter(({ event }) => (typeof key === "string" ? event.eventKey === key : event.eventKey.startsWith(key.startsWith)));
    });
    mocks.coverageFindFirst.mockResolvedValue(null);
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
  });

  it("writes the covered slice under the note's own role and key", async () => {
    await record();
    expect(written()).toMatchObject({
      documentRole: "MODIFICATION_CREDIT_NOTE",
      legacyKey: `booking-mod:${MOD}:mod-credit-note:4500:v1`,
      bookingId: BOOKING,
      outcome: "COVERED",
      reason: null,
      providerInvoiceId: "credit-1",
      lineTotalCents: 4500,
      coverage: [{ account: "BOOKING_REVENUE", chargeIdentity: STAY, sliceKey: EVENT, coveredCents: 4500 }],
    });
    // Only live cover under another key counts as taken: a replay of this key is the store's SAME.
    expect(mocks.coverageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        documentRole: "MODIFICATION_CREDIT_NOTE",
        manifest: { release: { is: null }, NOT: { legacyKey: `booking-mod:${MOD}:mod-credit-note:4500:v1` } },
      }),
    }));
  });

  it("records a second note on a slice another note still covers as ALREADY_COVERED, with no coverage", async () => {
    mocks.coverageFindFirst.mockResolvedValue({ sliceKey: EVENT, manifest: { providerInvoiceId: "credit-1" } });
    await record({ legacyKey: `booking-mod:${MOD}:mod-credit-note:4500:v2`, providerCreditNoteId: "credit-2" });
    expect(written()).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED", coverage: [], providerInvoiceId: "credit-2" });
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.objectContaining({ reason: "ALREADY_COVERED" }), expect.any(String));
  });

  it("never throws: a lost unique-key race is noted, any other failure logged", async () => {
    mocks.writeExportManifest.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }));
    await expect(record()).resolves.toBeUndefined();
    expect(mocks.logInfo).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING }), expect.stringContaining("first row stands"));
    mocks.findMany.mockRejectedValueOnce(new Error("database gone"));
    await expect(record()).resolves.toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING }), expect.stringContaining("the note is unchanged"));
  });
});
