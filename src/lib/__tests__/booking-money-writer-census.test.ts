import { describe, expect, it } from "vitest";

import { reconcileBookingMoney } from "@/lib/booking-money-reconciliation";
import {
  discoveredBookingMoneyRawSqlEscapes,
  discoveredBookingMoneyWriterEscapes,
  discoveredBookingMoneyWriterEqualityEscapes,
  discoveredBookingMoneyWriterSites,
  scanBookingMoneyRawSqlEscapes,
  scanBookingMoneyWriterEscapes,
  scanBookingMoneyWriterEqualityEscapes,
  scanBookingMoneyWriterSites,
} from "@/lib/__tests__/support/booking-money-writer-scan";

const DISCOVERED_WRITERS = discoveredBookingMoneyWriterSites();
const DISCOVERED_ESCAPES = discoveredBookingMoneyWriterEscapes();
const FIXTURE = {
  checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"),
  totalPriceCents: 10_000, promoAdjustmentCents: -1_500, discountCents: 1_500, finalPriceCents: 8_500,
  guests: [{ priceCents: 10_000, stayStart: null, stayEnd: null, nights: [{ stayDate: new Date("2026-08-01T00:00:00.000Z"), priceCents: 10_000, priceSource: "SOLD" as const }] }],
  promoRedemption: { priceAdjustmentCents: -1_500, allocations: [{ memberId: "member-1", priceAdjustmentCents: -1_500 }] },
  nightAdjustments: [{ beneficiaryMemberId: "member-1", amountCents: -1_500 }],
};

function mutationFor(writer: (typeof DISCOVERED_WRITERS)[number]) {
  if (writer.methods.every((method) => method === "delete" || method === "deleteMany")) return null;
  if (writer.delegate === "booking") {
    if (writer.fields.includes("totalPriceCents")) return { totalPriceCents: 9_999 };
    if (writer.fields.includes("promoAdjustmentCents")) return { promoAdjustmentCents: -1_499, discountCents: 1_499, finalPriceCents: 8_501 };
    if (writer.fields.includes("discountCents")) return { discountCents: 1_499 };
    if (writer.fields.includes("finalPriceCents")) return { finalPriceCents: 8_501 };
  }
  if (writer.delegate === "bookingGuest") return { guests: [{ ...FIXTURE.guests[0]!, priceCents: 9_999, nights: [{ ...FIXTURE.guests[0]!.nights[0]!, priceCents: 9_999 }] }] };
  if (writer.delegate === "bookingGuestNight") return { guests: [{ ...FIXTURE.guests[0]!, nights: [{ ...FIXTURE.guests[0]!.nights[0]!, priceCents: null, priceSource: "UNKNOWN" }] }] };
  if (["promoRedemption", "promoRedemptionAllocation", "bookingGuestNightAdjustment"].includes(writer.delegate)) return { promoAdjustmentCents: -1_499, discountCents: 1_499, finalPriceCents: 8_501 };
  return undefined;
}

describe("INV-MONEY-031 booking money writer census", () => {
  it("discovers aliases by capability, not Prisma receiver spelling", () => {
    const code = "const ledger = database.booking; await ledger.update({ data: { finalPriceCents: 1 } });";
    expect(scanBookingMoneyWriterSites("alias.ts", code)).toEqual([{ file: "alias.ts", delegate: "booking", methods: ["update"], fields: ["finalPriceCents"] }]);
    expect(scanBookingMoneyWriterEscapes("alias.ts", code)).toEqual([]);
    expect(scanBookingMoneyWriterEscapes("forward.ts", "mutate(database.booking);")).toEqual(["forward.ts|booking"]);
    expect(scanBookingMoneyWriterEscapes("destructure.ts", "const { booking } = database; mutate(booking);")).toEqual(["destructure.ts|booking"]);
    expect(DISCOVERED_ESCAPES).toEqual([]);
  });

  it("recursively discovers nested relation mutation methods", () => {
    expect(scanBookingMoneyWriterSites("nested.ts", `await tx.booking.update({ data: { guests: { updateMany: { data: { priceCents: 2, nights: { upsert: { create: { priceCents: 3 }, update: { priceCents: 4 } } } } }, createMany: { data: [{ priceCents: 5, nights: { deleteMany: {} } }] } } } });`)).toEqual([
      { file: "nested.ts", delegate: "bookingGuest", methods: ["createMany", "updateMany"], fields: ["priceCents"] },
      { file: "nested.ts", delegate: "bookingGuestNight", methods: ["deleteMany", "upsert"], fields: ["priceCents"] },
    ]);
  });

  it("mutation-proves canonical headline equality", () => {
    const clean = "const final = bookingFinalPriceCents({ totalPriceCents: total, promoAdjustmentCents: promo }); await tx.booking.update({ data: { totalPriceCents: total, discountCents: Math.max(0, -promo), promoAdjustmentCents: promo, finalPriceCents: final } });";
    expect(scanBookingMoneyWriterEqualityEscapes("clean.ts", clean)).toEqual([]);
    expect(scanBookingMoneyWriterEqualityEscapes("broken.ts", clean.replace("finalPriceCents: final", "finalPriceCents: total + 1"))).toEqual(["broken.ts:1|finalPriceCents"]);
    expect(discoveredBookingMoneyWriterEqualityEscapes()).toEqual([]);
  });

  it("reads SQL assignments rather than comments and mutation-proves relations", () => {
    expect(scanBookingMoneyRawSqlEscapes("migration.sql", "-- UPDATE \"Booking\" SET \"finalPriceCents\" = \"finalPriceCents\" + 1;\nUPDATE \"Booking\" SET \"finalPriceCents\" = \"totalPriceCents\" + \"promoAdjustmentCents\"; SELECT 'finalPriceCents';")).toEqual([]);
    expect(scanBookingMoneyRawSqlEscapes("migration.sql", "UPDATE \"Booking\" SET \"finalPriceCents\" = \"finalPriceCents\" + 1;")).toEqual(["migration.sql|rawSqlFinalPriceRelation"]);
    expect(scanBookingMoneyRawSqlEscapes("migration.sql", "UPDATE \"Booking\" SET \"promoAdjustmentCents\" = -500, \"discountCents\" = 500, \"finalPriceCents\" = \"totalPriceCents\" + \"promoAdjustmentCents\";")).toEqual(["migration.sql|rawSqlDiscountRelation"]);
    expect(discoveredBookingMoneyRawSqlEscapes()).toEqual([]);
  });

  it("derives every writer proof from its parsed operations and fields", () => {
    for (const writer of DISCOVERED_WRITERS) {
      const mutation = mutationFor(writer);
      if (mutation === null) continue;
      if (mutation === undefined) {
        expect(writer.methods).toContain("opaquePayload");
      } else {
        expect(reconcileBookingMoney({ ...FIXTURE, ...mutation })).toMatchObject({ state: "UNRECONCILED" });
      }
    }
  });
});
