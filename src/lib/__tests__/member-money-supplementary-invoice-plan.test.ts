import { describe, expect, it, vi } from "vitest";

// The builders' modules load the client; the planners never query it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { LineAmountTypes, type LineItem } from "xero-node";
import { modificationChangeFeeKey } from "@/lib/booking-ledger-posting-keys";
import { changeFeeLineItem } from "@/lib/xero-modification-line-items";
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
    lines: [stayLine(4500), changeFeeLineItem(2000, mapping)],
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
      lines: [changeFeeLineItem(2000, mapping)],
      sliceEvent: { eventKey: EVENT, reversed: false, legs: [leg("FEE_REVENUE", FEE, 2000)] },
    }));
    expect(plan).toMatchObject({ outcome: "COVERED", coverage: [{ account: "FEE_REVENUE", chargeIdentity: FEE, coveredCents: 2000 }] });
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
    const plan = planSupplementaryBookingInvoice(input({ lines: [stayLine(-1000), changeFeeLineItem(2000, mapping)] }));
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
    expect(planSupplementaryBookingInvoice(input({ lines: [stayLine(4400), changeFeeLineItem(2000, mapping)] })))
      .toMatchObject({ outcome: "CONFLICT", reason: "STAY_CENTS" });
  });

  it("refuses a fee line that differs from the fee the edit posted", () => {
    expect(planSupplementaryBookingInvoice(input({ lines: [stayLine(4500), changeFeeLineItem(2500, mapping)] })))
      .toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
  });

  it("refuses an event that moves a fee other than the edit's own", () => {
    const other = modificationChangeFeeKey("mod-0");
    const plan = planSupplementaryBookingInvoice(input({
      sliceEvent: { eventKey: EVENT, reversed: false, legs: [leg("BOOKING_REVENUE", STAY, 4500), leg("FEE_REVENUE", other, 2000)] },
    }));
    expect(plan).toMatchObject({ outcome: "CONFLICT", reason: "FEE_CENTS" });
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
    legacyKey: "update-key", providerInvoiceId: "inv-1", lines, lineAmountTypes: LineAmountTypes.Exclusive, primary, ...overrides,
  });

  it("plans nothing without a primary manifest", () => {
    expect(update({ primary: null })).toBeNull();
  });

  it("matches a same-total update of the primary invoice, freezing the provider's line amount types", () => {
    expect(update()).toMatchObject({
      outcome: "COVERED", legacyKey: "update-key", lineTotalCents: 14000, payloadHash: primaryInvoicePayloadHash(lines),
      frozenMapping: { source: "UPDATED_FROM_PROVIDER", primaryManifestId: "manifest-1", lineAmountTypes: LineAmountTypes.Exclusive },
    });
  });

  it.each([
    ["another invoice", { providerInvoiceId: "inv-2" }, {}],
    ["a conflicted primary", {}, { outcome: "CONFLICT" as const }],
    ["a changed total", { lines: [stayLine(15000)] }, {}],
  ])("records %s as PRIMARY_UNMATCHED", (_label, overrides, primaryOverrides) => {
    expect(update({ ...overrides, primary: { ...primary, ...primaryOverrides } }))
      .toMatchObject({ outcome: "CONFLICT", reason: "PRIMARY_UNMATCHED" });
  });
});
