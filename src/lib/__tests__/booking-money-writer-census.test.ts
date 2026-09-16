import { describe, expect, it } from "vitest";

import { reconcileBookingMoney } from "@/lib/booking-money-reconciliation";
import {
  discoveredBookingMoneyWriterEscapes,
  discoveredBookingMoneyWriterEqualityEscapes,
  discoveredBookingMoneyWriterSites,
  scanBookingMoneyWriterEqualityEscapes,
  scanBookingMoneyWriterEscapes,
  scanBookingMoneyWriterSites,
} from "@/lib/__tests__/support/booking-money-writer-scan";

const REVIEWED_WRITERS = [
  "e2e/setup/seed-second-lodge.ts|booking|create,deleteMany,update|finalPriceCents,totalPriceCents",
  "e2e/setup/seed-second-lodge.ts|bookingGuest|create|priceCents",
  "e2e/setup/seed-second-lodge.ts|bookingGuestNight|create|priceCents,priceSource",
  "prisma/demo-seed.ts|booking|create,deleteMany|finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "prisma/demo-seed.ts|bookingGuest|create,deleteMany|priceCents",
  "prisma/demo-seed.ts|bookingGuestNight|create,deleteMany|priceCents,priceSource",
  "prisma/demo-seed.ts|promoRedemption|create,deleteMany|discountCents",
  "prisma/demo-seed.ts|promoRedemptionAllocation|deleteMany|",
  "prisma/migrations/20260928020000_booking_owner_optional_member/migration.sql|promoRedemptionAllocation|rawSql|discountCents",
  "prisma/migrations/20260928030000_backfill_school_bookings_to_organisations/migration.sql|booking|rawSql|discountCents",
  "prisma/migrations/20260928030000_backfill_school_bookings_to_organisations/migration.sql|promoRedemption|rawSql|discountCents,priceAdjustmentCents",
  "prisma/migrations/20260928030000_backfill_school_bookings_to_organisations/migration.sql|promoRedemptionAllocation|rawSql|discountCents,priceAdjustmentCents",
  "src/app/api/admin/bookings/[id]/capacity-hold/route.ts|booking|opaquePayload|",
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts|booking|opaquePayload|",
  "src/app/api/admin/bookings/[id]/force-confirm/route.ts|booking|opaquePayload|",
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts|booking|opaquePayload|",
  "src/app/api/admin/bookings/[id]/review/route.ts|booking|opaquePayload|",
  "src/app/api/bookings/[id]/guests/route.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/app/api/bookings/[id]/guests/route.ts|bookingGuest|create|priceCents",
  "src/app/api/bookings/[id]/guests/route.ts|bookingGuestNight|create|",
  "src/app/api/lodge/guests/[date]/arrive/route.ts|bookingGuest|opaquePayload|",
  "src/instrumentation.node.ts|booking|deleteMany|",
  "src/lib/booking-batch-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-create.ts|booking|create,opaquePayload|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-cancel.ts|booking|opaquePayload|",
  "src/lib/booking-create.ts|booking|create,opaquePayload|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-create.ts|bookingGuest|create|",
  "src/lib/booking-create.ts|bookingGuestNight|opaquePayload|",
  "src/lib/booking-date-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-date-modification-service.ts|bookingGuest|update|priceCents",
  "src/lib/booking-date-modification-service.ts|bookingGuestNight|deleteMany,opaquePayload|",
  "src/lib/booking-delete.ts|booking|delete|",
  "src/lib/booking-guest-removal-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-guest-removal-service.ts|bookingGuest|delete,update|priceCents",
  "src/lib/booking-modify-plan.ts|bookingGuest|create,delete,update|priceCents",
  "src/lib/booking-modify-plan.ts|bookingGuestNight|deleteMany,opaquePayload|",
  "src/lib/booking-no-emails-service.ts|booking|opaquePayload|",
  "src/lib/booking-request-quotes.ts|booking|create|finalPriceCents,totalPriceCents",
  "src/lib/booking-request-quotes.ts|bookingGuest|create|",
  "src/lib/booking-request-quotes.ts|bookingGuestNight|opaquePayload|",
  "src/lib/booking-request.ts|booking|create,updateMany|finalPriceCents,totalPriceCents",
  "src/lib/booking-request.ts|bookingGuest|create,deleteMany,update|priceCents",
  "src/lib/booking-request.ts|bookingGuestNight|deleteMany,opaquePayload|",
  "src/lib/booking-review-price-rebase.ts|booking|updateMany|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/cron-group-settlement-reaper.ts|booking|opaquePayload|",
  "src/lib/group-booking.ts|booking|create|finalPriceCents,totalPriceCents",
  "src/lib/group-booking.ts|bookingGuest|create|",
  "src/lib/group-booking.ts|bookingGuestNight|opaquePayload|",
  "src/lib/group-cancel.ts|booking|opaquePayload|",
  "src/lib/internet-banking-payment-cron.ts|booking|opaquePayload|",
  "src/lib/member-guest-consent-service.ts|bookingGuest|opaquePayload|",
  "src/lib/night-adjustment-write.ts|bookingGuestNightAdjustment|createMany,deleteMany,opaquePayload|amountCents",
  "src/lib/payment-reconciliation.ts|booking|opaquePayload|",
  "src/lib/promo.ts|promoRedemption|create,delete,update|discountCents,priceAdjustmentCents",
  "src/lib/promo.ts|promoRedemptionAllocation|deleteMany,opaquePayload|",
  "src/lib/school-booking-request.ts|booking|create,update|finalPriceCents,totalPriceCents",
  "src/lib/school-booking-request.ts|bookingGuest|create|",
  "src/lib/school-booking-request.ts|bookingGuestNight|opaquePayload|",
  "src/lib/stored-night-price-repair-store.ts|bookingGuest|updateMany|priceCents",
  "src/lib/stored-night-price-repair-store.ts|bookingGuestNight|create,updateMany|priceCents,priceSource",
  "src/lib/waitlist.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/waitlist.ts|bookingGuest|update|priceCents",
  "src/lib/waitlist.ts|bookingGuestNight|deleteMany,opaquePayload|",
] as const;

function writerKey(
  site: ReturnType<typeof discoveredBookingMoneyWriterSites>[number],
): string {
  return `${site.file}|${site.delegate}|${site.methods.join(",")}|${site.fields.join(",")}`;
}

// The tree walk is intentionally outside each five-second assertion budget,
// matching the Stage 1/2 censuses that use the same source inventory.
const DISCOVERED_WRITERS = discoveredBookingMoneyWriterSites();
const DISCOVERED_ESCAPES = discoveredBookingMoneyWriterEscapes();
const DISCOVERED_EQUALITY_ESCAPES = discoveredBookingMoneyWriterEqualityEscapes();

const RECONCILIATION_WRITER_KEYS = [
  "src/app/api/bookings/[id]/guests/route.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-batch-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-date-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-guest-removal-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-review-price-rebase.ts|booking|updateMany|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/waitlist.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
] as const;

const RECONCILED_FIXTURE = {
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-02T00:00:00.000Z"),
  totalPriceCents: 10_000,
  promoAdjustmentCents: -1_500,
  discountCents: 1_500,
  finalPriceCents: 8_500,
  guests: [{
    priceCents: 10_000,
    stayStart: null,
    stayEnd: null,
    nights: [{
      stayDate: new Date("2026-08-01T00:00:00.000Z"),
      priceCents: 10_000,
      priceSource: "SOLD" as const,
    }],
  }],
  promoRedemption: {
    priceAdjustmentCents: -1_500,
    allocations: [{ memberId: "member-1", priceAdjustmentCents: -1_500 }],
  },
  nightAdjustments: [{ beneficiaryMemberId: "member-1", amountCents: -1_500 }],
};

describe("INV-MONEY-031 booking money writer census", () => {
  it("discovers direct and raw-SQL mutations, including a newly added writer", () => {
    expect(
      scanBookingMoneyWriterSites(
        "src/lib/mutant.ts",
        `async function mutant(tx) {
          await tx.booking.update({ data: { finalPriceCents: 1 } });
          await tx.bookingGuest.update({ data: { priceCents: 1 } });
          await tx.$executeRawUnsafe(
            'UPDATE "BookingGuestNightAdjustment" SET "amountCents" = 1',
          );
        }`,
      ),
    ).toEqual([
      {
        file: "src/lib/mutant.ts",
        delegate: "booking",
        methods: ["update"],
        fields: ["finalPriceCents"],
      },
      {
        file: "src/lib/mutant.ts",
        delegate: "bookingGuest",
        methods: ["update"],
        fields: ["priceCents"],
      },
      {
        file: "src/lib/mutant.ts",
        delegate: "bookingGuestNightAdjustment",
        methods: ["rawSql"],
        fields: ["amountCents"],
      },
    ]);
  });

  it("discovers variable-backed booking and adjustment mutation payloads", () => {
    expect(
      scanBookingMoneyWriterSites(
        "src/lib/variable-backed-mutant.ts",
        `async function mutant(tx) {
          const data = { finalPriceCents: 1 };
          await tx.booking.update({ data });
          const rows = [{ amountCents: 1 }];
          await tx.bookingGuestNightAdjustment.createMany({ data: rows });
        }`,
      ),
    ).toEqual([
      {
        file: "src/lib/variable-backed-mutant.ts",
        delegate: "booking",
        methods: ["update"],
        fields: ["finalPriceCents"],
      },
      {
        file: "src/lib/variable-backed-mutant.ts",
        delegate: "bookingGuestNightAdjustment",
        methods: ["createMany"],
        fields: ["amountCents"],
      },
    ]);
  });

  it("discovers aliased options, mutable array rows, opaque options builders, and both upsert branches", () => {
    expect(
      scanBookingMoneyWriterSites(
        "src/lib/options-and-rows.ts",
        `async function mutant(tx) {
          const options = { data: { finalPriceCents: 1 } };
          await tx.booking.update(options);
          const rows = [];
          rows.push({ amountCents: 2 });
          rows.unshift({ amountCents: 3 });
          await tx.bookingGuestNightAdjustment.createMany({ data: rows });
          await tx.booking.update(buildOptions());
          await tx.booking.upsert({ where: { id: "x" }, create: { finalPriceCents: 4 }, update: { discountCents: 5 } });
        }`,
      ),
    ).toEqual([
      { file: "src/lib/options-and-rows.ts", delegate: "booking", methods: ["opaquePayload", "update", "upsert"], fields: ["discountCents", "finalPriceCents"] },
      { file: "src/lib/options-and-rows.ts", delegate: "bookingGuestNightAdjustment", methods: ["createMany"], fields: ["amountCents"] },
    ]);
  });

  it("mutation-proves bracket delegates, nested relation writes, lexical bindings, opaque builders, and schema-qualified SQL", () => {
    expect(
      scanBookingMoneyWriterSites(
        "src/lib/mutation-forms.ts",
        `async function mutant(tx) {
          const base = { finalPriceCents: 1 };
          const data = { ...base };
          await tx["booking"].update({ data });
          await tx.booking.create({ data: { guests: { create: [{ priceCents: 2, nights: { create: [{ priceCents: 3, priceSource: "SOLD" }] } }] } } });
          await tx.booking.create({ data: { guests: { create: buildGuests() } } });
          await tx.bookingGuest.create({ data: buildGuest() });
          await tx.$executeRawUnsafe('UPDATE public."Booking" SET "finalPriceCents" = 4');
        }`,
      ),
    ).toEqual([
      { file: "src/lib/mutation-forms.ts", delegate: "booking", methods: ["rawSql", "update"], fields: ["finalPriceCents"] },
      { file: "src/lib/mutation-forms.ts", delegate: "bookingGuest", methods: ["create", "opaquePayload"], fields: ["priceCents"] },
      { file: "src/lib/mutation-forms.ts", delegate: "bookingGuestNight", methods: ["create", "opaquePayload"], fields: ["priceCents", "priceSource"] },
    ]);
    expect(
      scanBookingMoneyWriterSites(
        "src/lib/lexical-scope.ts",
        `async function mutant(tx) {
          const data = { status: "PENDING" };
          { const data = { finalPriceCents: 99 }; void data; }
          await tx.booking.update({ data });
        }`,
      ),
    ).toEqual([]);
  });

  it("rejects delegate forwarding and mutation-proves the alias escape routes", () => {
    expect(
      DISCOVERED_ESCAPES,
      "INV-MONEY-031: booking-money Prisma delegates must remain direct calls so the writer census cannot be bypassed.",
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEscapes(
        "src/lib/alias-mutant.ts",
        "const bookings = tx.booking; await bookings.update({ data: { finalPriceCents: 1 } });",
      ),
    ).toEqual(["src/lib/alias-mutant.ts|booking"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "src/lib/forwarded-mutant.ts",
        'await mutate(tx["bookingGuestNight"]);',
      ),
    ).toEqual(["src/lib/forwarded-mutant.ts|bookingGuestNight"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "src/lib/destructured-mutant.ts",
        "const { promoRedemption: redemption } = tx; await mutate(redemption);",
      ),
    ).toEqual(["src/lib/destructured-mutant.ts|promoRedemption"]);
  });

  it("mutation-proves complete headline equality through direct, aliased, spread, bracket, and upsert writer forms", () => {
    const cleanWriter = `
      const final = bookingFinalPriceCents({ totalPriceCents: total, promoAdjustmentCents: promo });
      await tx.booking.update({ data: {
        totalPriceCents: total,
        discountCents: Math.max(0, -promo),
        promoAdjustmentCents: promo,
        finalPriceCents: final,
      } });
    `;
    const brokenEquality = cleanWriter.replace("finalPriceCents: final", "finalPriceCents: total + 1");
    const zeroPromoMutation = cleanWriter
      .replace("promoAdjustmentCents: promo", "promoAdjustmentCents: 0")
      .replace("finalPriceCents: final", "finalPriceCents: total + 1");
    const aliasesAndSpreads = `
      const base = { totalPriceCents: total, discountCents: 0, promoAdjustmentCents: 0 };
      const payload = { ...base, finalPriceCents: total + 1 };
      const options = { data: payload };
      await tx["booking"].update(options);
      await tx["booking"].upsert({ where: { id: "b" }, create: payload, update: payload });
    `;
    const staleProperty = cleanWriter.replace("finalPriceCents: final", "finalPriceCents: staleBooking.finalPriceCents");
    const opaqueCompleteHeadline = `
      const payload = { ...buildHeadline(), totalPriceCents: total, discountCents: 0, promoAdjustmentCents: 0 };
      const options = { data: payload };
      await tx["booking"].update(options);
    `;
    expect(scanBookingMoneyWriterSites("src/lib/headline-mutant.ts", cleanWriter)).toEqual(
      scanBookingMoneyWriterSites("src/lib/headline-mutant.ts", brokenEquality),
    );
    expect(
      scanBookingMoneyWriterEqualityEscapes("src/lib/headline-mutant.ts", cleanWriter),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("src/lib/headline-mutant.ts", brokenEquality),
    ).toEqual(["src/lib/headline-mutant.ts:7|finalPriceCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("src/lib/zero-promo-mutant.ts", zeroPromoMutation),
    ).toEqual(["src/lib/zero-promo-mutant.ts:7|finalPriceCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("src/lib/alias-mutant.ts", aliasesAndSpreads),
    ).toEqual(["src/lib/alias-mutant.ts:3|finalPriceCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("src/lib/stale-property-mutant.ts", staleProperty),
    ).toEqual(["src/lib/stale-property-mutant.ts:7|finalPriceCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("src/lib/opaque-headline-mutant.ts", opaqueCompleteHeadline),
    ).toEqual(["src/lib/opaque-headline-mutant.ts:3|opaqueCompleteHeadlinePayload"]);
    expect(
      DISCOVERED_EQUALITY_ESCAPES,
      "INV-MONEY-031: a complete Booking headline write must derive finalPriceCents through bookingFinalPriceCents (or preserve it only on the documented parked branch).",
    ).toEqual([]);
  });

  it("binds every complete headline writer to real-shaped typed reconciliation mutations", () => {
    expect(RECONCILIATION_WRITER_KEYS.every((key) => REVIEWED_WRITERS.includes(key))).toBe(true);
    const mutations = [
      ["HEADLINE_TOTAL_MISMATCH", { totalPriceCents: 9_999 }],
      ["PROMO_BUILD_UP_MISMATCH", { promoAdjustmentCents: -1_499, finalPriceCents: 8_501 }],
      ["DISCOUNT_COMPONENT_MISMATCH", { discountCents: 1_499 }],
      ["FINAL_PRICE_RELATION_MISMATCH", { finalPriceCents: 8_501 }],
    ] as const;
    for (const [reason, headlineMutation] of mutations) {
      expect(
        reconcileBookingMoney({ ...RECONCILED_FIXTURE, ...headlineMutation }),
        `${reason}: every reviewed complete-headline writer must leave a mismatch typed and visible, never silently trusted.`,
      ).toMatchObject({ state: "UNRECONCILED", reasons: expect.arrayContaining([reason]) });
    }
  });

  it("matches the reviewed production writer manifest exactly", () => {
    expect(
      DISCOVERED_WRITERS.map(writerKey),
      "INV-MONEY-031: a booking headline or component writer changed. Classify the writer against the canonical derived projection, add a real-shaped fixture, and update this reviewed manifest; never default missing evidence to zero.",
    ).toEqual(REVIEWED_WRITERS);
  });
});
