import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoveredBookingMoneyRawSqlEscapes,
  discoveredBookingMoneyWriterEqualityEscapes,
  discoveredBookingMoneyWriterEscapes,
  discoveredBookingMoneyWriterSites,
  scanBookingMoneyRawSqlEscapes,
  scanBookingMoneyWriterEqualityEscapes,
  scanBookingMoneyWriterEscapes,
  scanBookingMoneyWriterSites,
  type BookingMoneyWriterSite,
} from "@/lib/__tests__/support/booking-money-writer-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  reconcileBookingMoney,
  type BookingMoneyReconciliationProjection,
  type BookingMoneyReconciliationReason,
} from "@/lib/booking-money-reconciliation";

const REVIEWED_WRITERS = [
  "e2e/setup/seed-second-lodge.ts|booking|create,deleteMany,update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|3",
  "e2e/setup/seed-second-lodge.ts|bookingGuest|create|priceCents|1",
  "e2e/setup/seed-second-lodge.ts|bookingGuestNight|create|priceCents,priceSource|1",
  "prisma/demo-seed.ts|booking|create,deleteMany|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|11",
  "prisma/demo-seed.ts|bookingGuest|create,deleteMany|priceCents|2",
  "prisma/demo-seed.ts|bookingGuestNight|create,deleteMany|priceCents,priceSource|2",
  "prisma/demo-seed.ts|promoRedemption|deleteMany||1",
  "prisma/demo-seed.ts|promoRedemptionAllocation|deleteMany||1",
  "prisma/migrations/20260928020000_booking_owner_optional_member/migration.sql|promoRedemptionAllocation|rawSql|discountCents|1",
  "src/app/api/admin/bookings/[id]/capacity-hold/route.ts|booking|opaquePayload||1",
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts|booking|opaquePayload||2",
  "src/app/api/admin/bookings/[id]/force-confirm/route.ts|booking|opaquePayload||1",
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts|booking|opaquePayload||1",
  "src/app/api/admin/bookings/[id]/review/route.ts|booking|opaquePayload||2",
  "src/app/api/bookings/[id]/guests/route.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|1",
  "src/app/api/bookings/[id]/guests/route.ts|bookingGuest|create|priceCents|1",
  "src/app/api/bookings/[id]/guests/route.ts|bookingGuestNight|create||1",
  "src/app/api/lodge/guests/[date]/arrive/route.ts|bookingGuest|opaquePayload||1",
  "src/instrumentation.node.ts|booking|deleteMany||1",
  "src/lib/booking-batch-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|1",
  "src/lib/booking-cancel.ts|booking|opaquePayload||5",
  "src/lib/booking-create.ts|booking|create,opaquePayload|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|5",
  "src/lib/booking-create.ts|bookingGuest|create||4",
  "src/lib/booking-create.ts|bookingGuestNight|opaquePayload||4",
  "src/lib/booking-date-modification-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|1",
  "src/lib/booking-date-modification-service.ts|bookingGuest|update|priceCents|1",
  "src/lib/booking-date-modification-service.ts|bookingGuestNight|deleteMany,opaquePayload||4",
  "src/lib/booking-delete.ts|booking|delete||1",
  "src/lib/booking-guest-removal-service.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|1",
  "src/lib/booking-guest-removal-service.ts|bookingGuest|delete,update|priceCents|2",
  "src/lib/booking-modify-plan.ts|bookingGuest|create,delete,update|priceCents|5",
  "src/lib/booking-modify-plan.ts|bookingGuestNight|deleteMany,opaquePayload||2",
  "src/lib/booking-no-emails-service.ts|booking|opaquePayload||1",
  "src/lib/booking-request-quotes.ts|booking|create|finalPriceCents,totalPriceCents|1",
  "src/lib/booking-request-quotes.ts|bookingGuest|create||1",
  "src/lib/booking-request-quotes.ts|bookingGuestNight|opaquePayload||1",
  "src/lib/booking-request.ts|booking|create,updateMany|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|2",
  "src/lib/booking-request.ts|bookingGuest|create,deleteMany,update|priceCents|4",
  "src/lib/booking-request.ts|bookingGuestNight|deleteMany,opaquePayload||4",
  "src/lib/booking-review-price-rebase.ts|booking|updateMany|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|1",
  "src/lib/cron-group-settlement-reaper.ts|booking|opaquePayload||1",
  "src/lib/group-booking.ts|booking|create|finalPriceCents,totalPriceCents|1",
  "src/lib/group-booking.ts|bookingGuest|create||1",
  "src/lib/group-booking.ts|bookingGuestNight|opaquePayload||1",
  "src/lib/group-cancel.ts|booking|opaquePayload||1",
  "src/lib/internet-banking-payment-cron.ts|booking|opaquePayload||1",
  "src/lib/member-guest-consent-service.ts|bookingGuest|opaquePayload||1",
  "src/lib/night-adjustment-write.ts|bookingGuestNightAdjustment|createMany,deleteMany,opaquePayload|amountCents|4",
  "src/lib/payment-reconciliation.ts|booking|opaquePayload||1",
  "src/lib/promo.ts|promoRedemption|create,delete,update|discountCents,priceAdjustmentCents|3",
  "src/lib/promo.ts|promoRedemptionAllocation|deleteMany,opaquePayload||4",
  "src/lib/school-booking-request.ts|booking|create,update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|3",
  "src/lib/school-booking-request.ts|bookingGuest|create||2",
  "src/lib/school-booking-request.ts|bookingGuestNight|opaquePayload||2",
  "src/lib/stored-night-price-repair-store.ts|bookingGuest|updateMany|priceCents|1",
  "src/lib/stored-night-price-repair-store.ts|bookingGuestNight|create,updateMany|priceCents,priceSource|2",
  "src/lib/waitlist.ts|booking|update|discountCents,finalPriceCents,promoAdjustmentCents,totalPriceCents|1",
  "src/lib/waitlist.ts|bookingGuest|update|priceCents|1",
  "src/lib/waitlist.ts|bookingGuestNight|deleteMany,opaquePayload||2",
] as const;

function writerKey(writer: BookingMoneyWriterSite): string {
  return `${writer.file}|${writer.delegate}|${writer.methods.join(",")}|${writer.fields.join(",")}|${writer.siteCount}`;
}

const REVIEWED_NON_MONEY_OPAQUE_WRITERS = new Map<
  string,
  {
    reason: string;
    sourceShape: RegExp;
  }
>([
  [
    "src/app/api/admin/bookings/[id]/capacity-hold/route.ts|booking|opaquePayload||1",
    {
      reason: "capacity-hold metadata only",
      sourceShape: /data:\s*\{[\s\S]*?adminCapacityHoldAt:/,
    },
  ],
  [
    "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts|booking|opaquePayload||2",
    {
      reason: "status/capacity claim only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*BookingStatus\./,
    },
  ],
  [
    "src/app/api/admin/bookings/[id]/force-confirm/route.ts|booking|opaquePayload||1",
    {
      reason: "status/review claim only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*nextStatus/,
    },
  ],
  [
    "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts|booking|opaquePayload||1",
    {
      reason: "status/waitlist claim only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*BookingStatus\.WAITLISTED/,
    },
  ],
  [
    "src/app/api/admin/bookings/[id]/review/route.ts|booking|opaquePayload||2",
    {
      reason: "review closure only",
      sourceShape: /data:\s*\{[\s\S]*?adminReviewStatus:/,
    },
  ],
  [
    "src/app/api/lodge/guests/[date]/arrive/route.ts|bookingGuest|opaquePayload||1",
    {
      reason: "arrival state only",
      sourceShape: /data:\s*isReturn\s*\?[\s\S]*?arrivedAt/,
    },
  ],
  [
    "src/lib/booking-cancel.ts|booking|opaquePayload||5",
    {
      reason: "cancellation lifecycle only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*BookingStatus\.CANCELLED/,
    },
  ],
  [
    "src/lib/booking-no-emails-service.ts|booking|opaquePayload||1",
    {
      reason: "notification preference only",
      sourceShape: /data:\s*params\.noEmails[\s\S]*?noEmails:/,
    },
  ],
  [
    "src/lib/cron-group-settlement-reaper.ts|booking|opaquePayload||1",
    {
      reason: "settlement lifecycle claim only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*BookingStatus\./,
    },
  ],
  [
    "src/lib/group-cancel.ts|booking|opaquePayload||1",
    {
      reason: "group cancellation lifecycle only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*BookingStatus\.CANCELLED/,
    },
  ],
  [
    "src/lib/internet-banking-payment-cron.ts|booking|opaquePayload||1",
    {
      reason: "internet-banking expiry lifecycle only",
      sourceShape: /data:\s*\{[\s\S]*?status:\s*BookingStatus\.CANCELLED/,
    },
  ],
  [
    "src/lib/member-guest-consent-service.ts|bookingGuest|opaquePayload||1",
    {
      reason: "consent lifecycle only",
      sourceShape: /data:[\s\S]*?consentStatus:/,
    },
  ],
  [
    "src/lib/payment-reconciliation.ts|booking|opaquePayload||1",
    {
      reason: "payment lifecycle/credit-election state only",
      sourceShape:
        /data:\s*\{[\s\S]*?status:\s*(?:BookingStatus\.|restoredStatus)/,
    },
  ],
]);

const DISCOVERED_WRITERS = discoveredBookingMoneyWriterSites();
const DISCOVERED_ESCAPES = discoveredBookingMoneyWriterEscapes();
const DISCOVERED_EQUALITY_ESCAPES =
  discoveredBookingMoneyWriterEqualityEscapes();
const DISCOVERED_RAW_SQL_ESCAPES = discoveredBookingMoneyRawSqlEscapes();

const RECONCILED_FIXTURE: BookingMoneyReconciliationProjection = {
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-02T00:00:00.000Z"),
  totalPriceCents: 10_000,
  promoAdjustmentCents: -1_500,
  discountCents: 1_500,
  finalPriceCents: 8_500,
  guests: [
    {
      priceCents: 10_000,
      stayStart: null,
      stayEnd: null,
      nights: [
        {
          stayDate: new Date("2026-08-01T00:00:00.000Z"),
          priceCents: 10_000,
          priceSource: "SOLD",
        },
      ],
    },
  ],
  promoRedemption: {
    priceAdjustmentCents: -1_500,
    allocations: [{ memberId: "member-1", priceAdjustmentCents: -1_500 }],
  },
  nightAdjustments: [{ beneficiaryMemberId: "member-1", amountCents: -1_500 }],
};

type WriterProof = {
  reason: BookingMoneyReconciliationReason;
  projection: BookingMoneyReconciliationProjection;
};

function mechanicallyDerivedWriterProofs(
  writer: BookingMoneyWriterSite,
): WriterProof[] {
  if (writer.delegate === "booking") {
    const proofs: WriterProof[] = [];
    if (writer.fields.includes("totalPriceCents"))
      proofs.push({
        reason: "HEADLINE_TOTAL_MISMATCH",
        projection: { ...RECONCILED_FIXTURE, totalPriceCents: 9_999 },
      });
    if (writer.fields.includes("promoAdjustmentCents"))
      proofs.push({
        reason: "PROMO_BUILD_UP_MISMATCH",
        projection: {
          ...RECONCILED_FIXTURE,
          promoAdjustmentCents: -1_499,
          discountCents: 1_499,
          finalPriceCents: 8_501,
        },
      });
    if (writer.fields.includes("discountCents"))
      proofs.push({
        reason: "DISCOUNT_COMPONENT_MISMATCH",
        projection: { ...RECONCILED_FIXTURE, discountCents: 1_499 },
      });
    if (writer.fields.includes("finalPriceCents"))
      proofs.push({
        reason: "FINAL_PRICE_RELATION_MISMATCH",
        projection: { ...RECONCILED_FIXTURE, finalPriceCents: 8_501 },
      });
    return proofs;
  }
  if (writer.delegate === "bookingGuest") {
    return [
      {
        reason: "HEADLINE_TOTAL_MISMATCH",
        projection: {
          ...RECONCILED_FIXTURE,
          guests: [
            {
              ...RECONCILED_FIXTURE.guests[0]!,
              priceCents: 9_999,
              nights: [
                {
                  ...RECONCILED_FIXTURE.guests[0]!.nights[0]!,
                  priceCents: 9_999,
                },
              ],
            },
          ],
        },
      },
    ];
  }
  if (writer.delegate === "bookingGuestNight") {
    return [
      {
        reason: "STRAND_EVIDENCE_UNREADABLE",
        projection: {
          ...RECONCILED_FIXTURE,
          guests: [
            {
              ...RECONCILED_FIXTURE.guests[0]!,
              nights: [
                {
                  ...RECONCILED_FIXTURE.guests[0]!.nights[0]!,
                  priceCents: null,
                  priceSource: "UNKNOWN",
                },
              ],
            },
          ],
        },
      },
    ];
  }
  if (writer.delegate === "bookingGuestNightAdjustment") {
    return [
      {
        reason: "PROMO_BUILD_UP_NOT_KNOWN",
        projection: {
          ...RECONCILED_FIXTURE,
          nightAdjustments: [
            { beneficiaryMemberId: "member-1", amountCents: -1_499 },
          ],
        },
      },
    ];
  }
  return [
    {
      reason: "PROMO_BUILD_UP_NOT_KNOWN",
      projection: {
        ...RECONCILED_FIXTURE,
        promoRedemption: {
          priceAdjustmentCents: -1_499,
          allocations: [{ memberId: "member-1", priceAdjustmentCents: -1_499 }],
        },
      },
    },
  ];
}

describe("INV-MONEY-031 booking money writer census", () => {
  it("discovers direct, variable-backed, mutable-array, bracket and raw-SQL writers", () => {
    expect(
      scanBookingMoneyWriterSites(
        "src/lib/mutant.ts",
        `
      async function mutant(database) {
        const bookingData = { finalPriceCents: 1 };
        await database["booking"].update({ data: bookingData });
        const rows = [];
        rows.push({ amountCents: 2 });
        await database.bookingGuestNightAdjustment.createMany({ data: rows });
        await database.$executeRawUnsafe('UPDATE public."BookingGuest" SET "priceCents" = 1');
      }
    `,
      ),
    ).toEqual([
      {
        file: "src/lib/mutant.ts",
        delegate: "booking",
        methods: ["update"],
        fields: ["finalPriceCents"],
        siteCount: 1,
      },
      {
        file: "src/lib/mutant.ts",
        delegate: "bookingGuest",
        methods: ["rawSql"],
        fields: ["priceCents"],
        siteCount: 1,
      },
      {
        file: "src/lib/mutant.ts",
        delegate: "bookingGuestNightAdjustment",
        methods: ["createMany"],
        fields: ["amountCents"],
        siteCount: 1,
      },
    ]);

    const duplicateShape = scanBookingMoneyWriterSites(
      "src/lib/count-mutant.ts",
      `
        await database.booking.update({ data: { finalPriceCents: 1 } });
        await database.booking.update({ data: { finalPriceCents: 2 } });
      `,
    );
    expect(duplicateShape).toEqual([
      {
        file: "src/lib/count-mutant.ts",
        delegate: "booking",
        methods: ["update"],
        fields: ["finalPriceCents"],
        siteCount: 2,
      },
    ]);
  });

  it("discovers every nested relation mutation method and grandchildren", () => {
    const nested = `
      await database.booking.update({ data: { guests: {
        create: { priceCents: 1, nights: { create: { priceCents: 1 } } },
        createMany: { data: [{ priceCents: 2 }] },
        update: { data: { priceCents: 3, nights: { update: { data: { priceCents: 3 } } } } },
        updateMany: { data: { priceCents: 4, nights: { updateMany: { data: { priceCents: 4 } } } } },
        upsert: { create: { priceCents: 5, nights: { upsert: { create: { priceCents: 5 }, update: { priceCents: 6 } } } }, update: { priceCents: 6, nights: { createMany: { data: [{ priceCents: 6 }] } } } },
        delete: { id: "guest-1" },
        deleteMany: { id: "guest-2" },
      } } });
      await database.bookingGuest.update({ data: { nights: { delete: { id: "night-1" }, deleteMany: { id: "night-2" } } } });
    `;
    expect(scanBookingMoneyWriterSites("src/lib/nested.ts", nested)).toEqual([
      {
        file: "src/lib/nested.ts",
        delegate: "bookingGuest",
        methods: [
          "create",
          "createMany",
          "delete",
          "deleteMany",
          "update",
          "updateMany",
          "upsert",
        ],
        fields: ["priceCents"],
        siteCount: 7,
      },
      {
        file: "src/lib/nested.ts",
        delegate: "bookingGuestNight",
        methods: [
          "create",
          "createMany",
          "delete",
          "deleteMany",
          "update",
          "updateMany",
          "upsert",
        ],
        fields: ["priceCents"],
        siteCount: 7,
      },
    ]);
  });

  it("resolves local nested relation payloads and fails closed when one cannot be read", () => {
    const localRelations = `
      const nights = { create: { priceCents: 1, priceSource: "SOLD" } };
      const guests = { create: { priceCents: 1, nights } };
      await database.booking.update({ data: { guests } });
    `;
    expect(
      scanBookingMoneyWriterSites("local-relations.ts", localRelations),
    ).toEqual([
      {
        file: "local-relations.ts",
        delegate: "bookingGuest",
        methods: ["create"],
        fields: ["priceCents"],
        siteCount: 1,
      },
      {
        file: "local-relations.ts",
        delegate: "bookingGuestNight",
        methods: ["create"],
        fields: ["priceCents", "priceSource"],
        siteCount: 1,
      },
    ]);
    expect(
      scanBookingMoneyWriterSites(
        "unknown-relations.ts",
        "await database.booking.update({ data: { guests: buildGuests() } });",
      ),
    ).toEqual([
      {
        file: "unknown-relations.ts",
        delegate: "bookingGuest",
        methods: ["opaquePayload"],
        fields: [],
        siteCount: 1,
      },
    ]);
  });

  it("rejects forwarded delegates without relying on the receiver variable name", () => {
    const directAlias = `const ledger = anything.booking; await ledger.update({ data: { finalPriceCents: 1 } });`;
    expect(scanBookingMoneyWriterSites("direct-alias.ts", directAlias)).toEqual(
      [
        {
          file: "direct-alias.ts",
          delegate: "booking",
          methods: ["update"],
          fields: ["finalPriceCents"],
          siteCount: 1,
        },
      ],
    );
    expect(
      scanBookingMoneyWriterEscapes("direct-alias.ts", directAlias),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEscapes(
        "forwarded.ts",
        "await mutate(database.bookingGuestNight);",
      ),
    ).toEqual(["forwarded.ts|bookingGuestNight"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "renamed-forwarded.ts",
        "await mutate(connection.bookingGuestNight);",
      ),
    ).toEqual(["renamed-forwarded.ts|bookingGuestNight"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "typed-forwarded.ts",
        "async function write(connection: PrismaClient) { await mutate(connection.bookingGuestNight); }",
      ),
    ).toEqual(["typed-forwarded.ts|bookingGuestNight"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "ordinary-data.ts",
        "const model = { booking: bookingDomainObject }; await inspect(model.booking);",
      ),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEscapes(
        "destructured.ts",
        "const { promoRedemption: redemption } = database; redemption.update({ data: {} });",
      ),
    ).toEqual(["destructured.ts|promoRedemption"]);
    expect(
      DISCOVERED_ESCAPES,
      "INV-MONEY-031: a booking-money Prisma delegate escaped the direct, source-censused call shape.",
    ).toEqual([]);
  });

  it("mutation-proves headline equality through aliases, spreads, upserts and parked branches", () => {
    const cleanWriter = `
      const final = bookingFinalPriceCents({ totalPriceCents: total, promoAdjustmentCents: promo });
      const base = { totalPriceCents: total, discountCents: Math.max(0, -promo), promoAdjustmentCents: promo };
      const payload = { ...base, finalPriceCents: final };
      const options = { data: payload };
      await database["booking"].update(options);
      await database.booking.upsert({ where: { id: "booking-1" }, create: payload, update: payload });
    `;
    const broken = cleanWriter.replace(
      "finalPriceCents: final",
      "finalPriceCents: total + 1",
    );
    const zeroPromo = cleanWriter
      .replace("promoAdjustmentCents: promo", "promoAdjustmentCents: 0")
      .replace("finalPriceCents: final", "finalPriceCents: total + 1");
    const stale = cleanWriter.replace(
      "finalPriceCents: final",
      "finalPriceCents: staleBooking.finalPriceCents",
    );
    const opaque = `const payload = { ...buildHeadline(), totalPriceCents: total, discountCents: 0, promoAdjustmentCents: 0 }; await database.booking.update({ data: payload });`;
    expect(
      scanBookingMoneyWriterEqualityEscapes("clean.ts", cleanWriter),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("broken.ts", broken),
    ).not.toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("zero.ts", zeroPromo),
    ).not.toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes("stale.ts", stale),
    ).not.toEqual([]);
    expect(scanBookingMoneyWriterEqualityEscapes("opaque.ts", opaque)).toEqual([
      "opaque.ts:1|opaqueCompleteHeadlinePayload",
    ]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "partial-final.ts",
        "await database.booking.update({ data: { finalPriceCents: total + 1 } });",
      ),
    ).toEqual(["partial-final.ts:1|finalPriceCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "bad-discount.ts",
        "await database.booking.update({ data: { promoAdjustmentCents: promo, discountCents: Math.max(0, -promo) + 1 } });",
      ),
    ).toEqual(["bad-discount.ts:1|discountCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "partial-discount.ts",
        "await database.booking.update({ data: { discountCents: 999 } });",
      ),
    ).toEqual(["partial-discount.ts:1|discountCents"]);
    const mutablePair = `
      let discountCents = 0;
      let promoAdjustmentCents = 0;
      if (applyPromo) {
        const resolved = resolvePromo();
        discountCents = resolved.discountCents;
        promoAdjustmentCents = resolved.promoAdjustmentCents;
      }
      const finalPriceCents = bookingFinalPriceCents({ totalPriceCents, promoAdjustmentCents });
      await database.booking.update({ data: { totalPriceCents, discountCents, promoAdjustmentCents, finalPriceCents } });
    `;
    expect(
      scanBookingMoneyWriterEqualityEscapes("mutable-pair.ts", mutablePair),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "broken-mutable-pair.ts",
        mutablePair.replace(
          "discountCents = resolved.discountCents",
          "discountCents = 999",
        ),
      ),
    ).toEqual(["broken-mutable-pair.ts:10|discountCents"]);
    expect(
      DISCOVERED_EQUALITY_ESCAPES,
      "INV-MONEY-031: a complete Booking headline write bypasses the canonical final-price relation.",
    ).toEqual([]);
  });

  it("reads actual SQL assignments and rejects arithmetic hidden behind unchanged tokens", () => {
    const cleanBookingSql = `-- UPDATE "Booking" SET "finalPriceCents" = "finalPriceCents" + 1;\nUPDATE "Booking" SET "discountCents" = GREATEST(0, -"promoAdjustmentCents"), "finalPriceCents" = "totalPriceCents" + "promoAdjustmentCents";`;
    expect(scanBookingMoneyRawSqlEscapes("clean.sql", cleanBookingSql)).toEqual(
      [],
    );
    expect(
      scanBookingMoneyRawSqlEscapes(
        "broken-final.sql",
        cleanBookingSql.replace(
          '"totalPriceCents" + "promoAdjustmentCents"',
          '"totalPriceCents" + "promoAdjustmentCents" + 1',
        ),
      ),
    ).toEqual(["broken-final.sql|rawSql:booking.finalPriceCents"]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "broken-discount.sql",
        cleanBookingSql.replace(
          'GREATEST(0, -"promoAdjustmentCents")',
          'GREATEST(0, -"promoAdjustmentCents") + 1',
        ),
      ),
    ).toEqual(["broken-discount.sql|rawSql:booking.discountCents"]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "update-only.sql",
        'UPDATE ONLY "Booking" SET "finalPriceCents" = "totalPriceCents" + "promoAdjustmentCents";',
      ),
    ).toEqual([]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "insert-select.sql",
        'INSERT INTO "Booking" ("finalPriceCents") SELECT price FROM source;',
      ),
    ).toEqual(["insert-select.sql|rawSql:booking.finalPriceCents"]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "merge.sql",
        'MERGE INTO "Booking" AS target USING source ON true WHEN MATCHED THEN UPDATE SET "finalPriceCents" = 1;',
      ),
    ).toEqual(["merge.sql|rawSql:booking.unsupportedMutation"]);
    const cleanCopy = `CREATE FUNCTION copy_discount() RETURNS trigger AS $function$ BEGIN INSERT INTO "PromoRedemptionAllocation" ("discountCents") VALUES (NEW."discountCents") ON CONFLICT ("promoRedemptionId", "memberId") DO UPDATE SET "discountCents" = EXCLUDED."discountCents"; RETURN NEW; END; $function$ LANGUAGE plpgsql;`;
    expect(scanBookingMoneyRawSqlEscapes("copy.sql", cleanCopy)).toEqual([]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "broken-copy.sql",
        cleanCopy.replace('NEW."discountCents"', 'NEW."discountCents" + 1'),
      ),
    ).toEqual([
      "broken-copy.sql|rawSql:promoRedemptionAllocation.discountCents",
    ]);
    expect(
      scanBookingMoneyWriterSites(
        "comment-only.sql",
        '-- UPDATE "Booking" SET "discountCents" = 1;\nUPDATE "Booking" SET "memberId" = NULL WHERE "discountCents" = 1;',
      ),
    ).toEqual([]);
    expect(
      DISCOVERED_RAW_SQL_ESCAPES,
      "INV-MONEY-031: a post-boundary migration changes money through unreviewed SQL arithmetic.",
    ).toEqual([]);
  });

  it("binds every opaque non-money call to its reviewed source shape", () => {
    const discovered = DISCOVERED_WRITERS.filter(
      (writer) =>
        writer.fields.length === 0 &&
        writer.methods.includes("opaquePayload") &&
        (writer.delegate === "booking" || writer.delegate === "bookingGuest"),
    )
      .map(writerKey)
      .sort();
    expect([...REVIEWED_NON_MONEY_OPAQUE_WRITERS.keys()].sort()).toEqual(
      discovered,
    );
    for (const [key, contract] of REVIEWED_NON_MONEY_OPAQUE_WRITERS) {
      const file = key.split("|")[0]!;
      const source = stripComments(
        readFileSync(join(process.cwd(), file), "utf8"),
      );
      expect(source, `${key}: ${contract.reason}`).toMatch(
        contract.sourceShape,
      );
    }
  });

  it("mechanically derives typed classifier mutations from every money writer", () => {
    expect(reconcileBookingMoney(RECONCILED_FIXTURE)).toEqual({
      state: "RECONCILED",
      reasons: [],
    });
    const deliberatelyBadFixture: BookingMoneyReconciliationProjection = {
      ...RECONCILED_FIXTURE,
      promoAdjustmentCents: -1_499,
      discountCents: 1_499,
      finalPriceCents: 8_501,
    };
    expect(reconcileBookingMoney(deliberatelyBadFixture)).toMatchObject({
      state: "UNRECONCILED",
      reasons: ["PROMO_BUILD_UP_MISMATCH"],
    });

    for (const writer of DISCOVERED_WRITERS) {
      const key = writerKey(writer);
      const nonMoney = REVIEWED_NON_MONEY_OPAQUE_WRITERS.has(key);
      const deletesBooking =
        writer.delegate === "booking" &&
        writer.methods.every(
          (method) => method === "delete" || method === "deleteMany",
        );
      if (nonMoney) {
        continue;
      }
      if (deletesBooking) {
        expect(
          writer.fields,
          `${key}: booking deletion has money fields`,
        ).toEqual([]);
        continue;
      }
      const proofs = mechanicallyDerivedWriterProofs(writer);
      expect(
        proofs.length,
        `${key}: writer has no source-derived proof`,
      ).toBeGreaterThan(0);
      for (const proof of proofs) {
        expect(
          reconcileBookingMoney(proof.projection),
          `${key}: ${proof.reason}`,
        ).toMatchObject({
          state: "UNRECONCILED",
          reasons: expect.arrayContaining([proof.reason]),
        });
      }
    }
  });

  it("matches the reviewed production writer manifest exactly", () => {
    expect(
      DISCOVERED_WRITERS.map(writerKey),
      "INV-MONEY-031: a booking headline/component writer changed; review its actual source shape and add source-derived mutation proof.",
    ).toEqual(REVIEWED_WRITERS);
  });
});
