import { describe, expect, it } from "vitest";

import {
  discoveredBookingMoneyWriterEscapes,
  discoveredBookingMoneyWriterSites,
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
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts|booking|updateMany|finalPriceCents",
  "src/app/api/bookings/[id]/guests/route.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/app/api/bookings/[id]/guests/route.ts|bookingGuest|create|priceCents",
  "src/instrumentation.node.ts|booking|deleteMany|",
  "src/lib/booking-batch-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-create.ts|booking|create|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-date-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-date-modification-service.ts|bookingGuest|update|priceCents",
  "src/lib/booking-date-modification-service.ts|bookingGuestNight|createMany,deleteMany|priceCents,priceSource",
  "src/lib/booking-delete.ts|booking|delete|",
  "src/lib/booking-guest-removal-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/booking-guest-removal-service.ts|bookingGuest|delete,update|priceCents",
  "src/lib/booking-modify-plan.ts|bookingGuest|create,delete,update|priceCents",
  "src/lib/booking-modify-plan.ts|bookingGuestNight|createMany,deleteMany|priceCents,priceSource",
  "src/lib/booking-request-quotes.ts|booking|create|finalPriceCents,totalPriceCents",
  "src/lib/booking-request.ts|booking|create,updateMany|finalPriceCents,totalPriceCents",
  "src/lib/booking-request.ts|bookingGuest|create,deleteMany,update|priceCents",
  "src/lib/booking-request.ts|bookingGuestNight|createMany,deleteMany|priceCents,priceSource",
  "src/lib/booking-review-price-rebase.ts|booking|updateMany|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/group-booking.ts|booking|create|finalPriceCents,totalPriceCents",
  "src/lib/night-adjustment-write.ts|bookingGuestNightAdjustment|createMany,deleteMany|amountCents",
  "src/lib/promo.ts|promoRedemption|create,delete,update|discountCents,priceAdjustmentCents",
  "src/lib/promo.ts|promoRedemptionAllocation|createMany,deleteMany|discountCents,priceAdjustmentCents",
  "src/lib/school-booking-request.ts|booking|create,update|finalPriceCents,totalPriceCents",
  "src/lib/stored-night-price-repair-store.ts|bookingGuest|updateMany|priceCents",
  "src/lib/stored-night-price-repair-store.ts|bookingGuestNight|create,updateMany|priceCents,priceSource",
  "src/lib/waitlist-cross-lodge.ts|booking|update,updateMany|finalPriceCents",
  "src/lib/waitlist.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents",
  "src/lib/waitlist.ts|bookingGuest|update|priceCents",
  "src/lib/waitlist.ts|bookingGuestNight|createMany,deleteMany|priceCents,priceSource",
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

  it("matches the reviewed production writer manifest exactly", () => {
    expect(
      DISCOVERED_WRITERS.map(writerKey),
      "INV-MONEY-031: a booking headline or component writer changed. Classify the writer against the canonical derived projection, add a real-shaped fixture, and update this reviewed manifest; never default missing evidence to zero.",
    ).toEqual(REVIEWED_WRITERS);
  });
});
