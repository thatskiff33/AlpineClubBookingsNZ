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
  "src/lib/stored-night-price-repair-store.ts|bookingGuestNight|create,updateMany|priceCents,priceSource|3",
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
    const spreadRelations = `
      const relation = { create: { priceCents: 1 } };
      await database.booking.update({ data: { guests: { ...relation } } });
    `;
    expect(
      scanBookingMoneyWriterSites("spread-relations.ts", spreadRelations),
    ).toEqual([
      {
        file: "spread-relations.ts",
        delegate: "bookingGuest",
        methods: ["create"],
        fields: ["priceCents"],
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
        "alias-forwarded.ts",
        "const ledger = database.booking; await mutate(ledger);",
      ),
    ).toEqual(["alias-forwarded.ts|booking"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "destructured-alias-forwarded.ts",
        "const { booking: ledger } = database; await mutate(ledger);",
      ),
    ).toEqual(["destructured-alias-forwarded.ts|booking"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "untyped-forwarded.ts",
        "function write(connection) { return mutate(connection.booking); }",
      ),
    ).toEqual(["untyped-forwarded.ts|booking"]);
    expect(
      scanBookingMoneyWriterEscapes(
        "ordinary-data.ts",
        "const model = { booking: bookingDomainObject }; await inspect(model.booking);",
      ),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterSites(
        "ordinary-method.ts",
        "const model = { booking: { update() {} } }; model.booking.update({ data: { finalPriceCents: 1 } });",
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
      import { bookingFinalPriceCents } from "@/lib/booking-final-price";
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
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "shadowed-helper.ts",
        cleanWriter.replace(
          'const final = bookingFinalPriceCents',
          'function run(bookingFinalPriceCents) { const final = bookingFinalPriceCents',
        ).replace(
          'await database.booking.upsert({ where: { id: "booking-1" }, create: payload, update: payload });',
          'await database.booking.upsert({ where: { id: "booking-1" }, create: payload, update: payload }); }',
        ),
      ),
    ).not.toEqual([]);
    // A name can be rebound by a DESTRUCTURING PATTERN as well as by a plain
    // identifier, and every one of these shapes typechecks against the real
    // module. The shadow walk used to look only for an identifier, so each of
    // them hid the canonical import and let any call at all certify the write.
    // A catch clause is the same hole from the other side: it binds its
    // variable on the clause rather than inside the block it guards.
    const shadowedByPattern = (declaration: string, close: string): string =>
      `import { bookingFinalPriceCents } from "@/lib/booking-final-price";
      ${declaration}
      const final = bookingFinalPriceCents({ totalPriceCents: total, promoAdjustmentCents: promo });
      await database.booking.update({ data: { totalPriceCents: total, discountCents: Math.max(0, -promo), promoAdjustmentCents: promo, finalPriceCents: final } });
      ${close}`;
    for (const [declaration, close] of [
      ["function run({ bookingFinalPriceCents }) {", "}"],
      ["const run = ({ bookingFinalPriceCents }) => {", "};"],
      ["function run([bookingFinalPriceCents]) {", "}"],
      ["function run(deps) { const { bookingFinalPriceCents } = deps;", "}"],
      ["function run(deps) { const { helper: bookingFinalPriceCents } = deps;", "}"],
      ["for (const { bookingFinalPriceCents } of list) {", "}"],
      ["try { noop(); } catch (bookingFinalPriceCents) {", "}"],
    ] as const) {
      expect(
        scanBookingMoneyWriterEqualityEscapes(
          "shadowed-by-pattern.ts",
          shadowedByPattern(declaration, close),
        ),
        `a rebinding spelled \`${declaration}\` must not certify the write`,
      ).not.toEqual([]);
    }
    // The control: the same writer with nothing rebinding the helper.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "unshadowed-control.ts",
        shadowedByPattern("", ""),
      ),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "wrong-helper-constant.ts",
        cleanWriter.replace(
          "promoAdjustmentCents: promo });",
          "promoAdjustmentCents: 0 });",
        ),
      ),
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
    const mutablePair = `import { bookingFinalPriceCents } from "@/lib/booking-final-price";
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
      scanBookingMoneyWriterEqualityEscapes(
        "increment-mutable-pair.ts",
        mutablePair.replace(
          "discountCents = resolved.discountCents",
          "discountCents += 1",
        ),
      ),
    ).toEqual(["increment-mutable-pair.ts:10|discountCents"]);
    for (const mutation of [
      "discountCents++",
      "({ discountCents, promoAdjustmentCents } = arbitrary())",
    ]) {
      expect(
        scanBookingMoneyWriterEqualityEscapes(
          "unsupported-mutation.ts",
          mutablePair.replace(
            "discountCents = resolved.discountCents",
            mutation,
          ),
        ),
      ).toEqual(["unsupported-mutation.ts:10|discountCents"]);
    }
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "split-branch-mutable-pair.ts",
        mutablePair
          .replace("if (applyPromo) {", "if (applyDiscount) {")
          .replace(
            "promoAdjustmentCents = resolved.promoAdjustmentCents;",
            "}\nif (applyPromo) {\n        promoAdjustmentCents = resolved.promoAdjustmentCents;",
          ),
      ),
    ).toEqual(["split-branch-mutable-pair.ts:12|discountCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "update-zero-missing-discount.ts",
        "await database.booking.update({ data: { totalPriceCents: total, promoAdjustmentCents: 0, finalPriceCents: total } });",
      ),
    ).toEqual(["update-zero-missing-discount.ts:1|discountCents"]);
    // Every operand the relation is fed must be the payload's own spelling of
    // the column it names. This payload never writes `totalPriceCents`, so the
    // headline it stores is computed from a figure this write does not own —
    // refused, and refused whatever that figure is spelled as. Accepting an
    // unwritten operand "as long as it is not a hard-coded number" was tried
    // and reverted; no writer in this tree needs it, and it admitted a relation
    // fed another row's total.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "update-zero-helper.ts",
        'import { bookingFinalPriceCents } from "@/lib/booking-final-price"; await database.booking.update({ data: { promoAdjustmentCents: 0, finalPriceCents: bookingFinalPriceCents({ totalPriceCents, promoAdjustmentCents: 0 }) } });',
      ),
    ).toEqual([
      "update-zero-helper.ts:1|discountCents",
      "update-zero-helper.ts:1|finalPriceCents",
    ]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "unwritten-total-operand.ts",
        'import { bookingFinalPriceCents } from "@/lib/booking-final-price"; await database.booking.update({ data: { promoAdjustmentCents: promo, discountCents: Math.max(0, -promo), finalPriceCents: bookingFinalPriceCents({ totalPriceCents: someOtherBooking.totalPriceCents, promoAdjustmentCents: promo }) } });',
      ),
    ).toEqual(["unwritten-total-operand.ts:1|finalPriceCents"]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "update-zero-literal-total.ts",
        'import { bookingFinalPriceCents } from "@/lib/booking-final-price"; await database.booking.update({ data: { promoAdjustmentCents: 0, discountCents: 0, finalPriceCents: bookingFinalPriceCents({ totalPriceCents: 0, promoAdjustmentCents: 0 }) } });',
      ),
    ).toEqual(["update-zero-literal-total.ts:1|finalPriceCents"]);
    // The same refusal, spelled as a named constant rather than a bare literal,
    // so the fixture cannot be satisfied by one spelling of a wrong operand.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "update-zero-constant-total.ts",
        'import { bookingFinalPriceCents } from "@/lib/booking-final-price"; const ZERO_TOTAL = 0; await database.booking.update({ data: { promoAdjustmentCents: 0, discountCents: 0, finalPriceCents: bookingFinalPriceCents({ totalPriceCents: ZERO_TOTAL, promoAdjustmentCents: 0 }) } });',
      ),
    ).toEqual(["update-zero-constant-total.ts:1|finalPriceCents"]);
    // The census reads seeds and fixtures outside `src/`, which have no `@/`
    // alias to import the one canonical relation by.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "prisma/relative-import.ts",
        cleanWriter.replace(
          '"@/lib/booking-final-price"',
          '"../src/lib/booking-final-price"',
        ),
      ),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "prisma/relative-import-elsewhere.ts",
        cleanWriter.replace(
          '"@/lib/booking-final-price"',
          '"../src/lib/booking-final-price-copy"',
        ),
      ),
    ).not.toEqual([]);
    // A specifier that climbs above the repository root names no module this
    // repository can spell. Resolving it used to `pop()` an already-empty
    // segment list, which is a no-op, so the path wrapped back onto the
    // canonical one and certified the write.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "src/lib/climbing-import.ts",
        cleanWriter.replace(
          '"@/lib/booking-final-price"',
          '"../../../../src/lib/booking-final-price"',
        ),
      ),
    ).not.toEqual([]);
    // A parked edit writes its total and its final price from parallel
    // ternaries on one condition, and the computed branch may feed the relation
    // either the ternary variable or the expression that branch chooses.
    const parkedWriter = `import { bookingFinalPriceCents } from "@/lib/booking-final-price";
      const newTotalPriceCents = parked ? booking.totalPriceCents : priced.totalPriceCents;
      const newFinalPriceCents = parked
        ? booking.finalPriceCents
        : bookingFinalPriceCents({ totalPriceCents: priced.totalPriceCents, promoAdjustmentCents: promo });
      await database.booking.update({ data: { totalPriceCents: newTotalPriceCents, discountCents: Math.max(0, -promo), promoAdjustmentCents: promo, finalPriceCents: newFinalPriceCents } });
    `;
    expect(
      scanBookingMoneyWriterEqualityEscapes("parked.ts", parkedWriter),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-variable-operand.ts",
        parkedWriter.replace(
          "totalPriceCents: priced.totalPriceCents, promoAdjustmentCents: promo }",
          "totalPriceCents: newTotalPriceCents, promoAdjustmentCents: promo }",
        ),
      ),
    ).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-stored-operand.ts",
        parkedWriter.replace(
          "totalPriceCents: priced.totalPriceCents, promoAdjustmentCents: promo }",
          "totalPriceCents: booking.totalPriceCents, promoAdjustmentCents: promo }",
        ),
      ),
    ).not.toEqual([]);
    // #3544: the parked branch is certified by the RECEIVER it reads, not by
    // the column name. Some other row's headline stored beside this row's
    // total is a pair that satisfies the relation for neither.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-foreign-receiver.ts",
        parkedWriter.replace(
          "? booking.finalPriceCents",
          "? legacyQuote.finalPriceCents",
        ),
      ),
    ).not.toEqual([]);
    // #3544: two ternaries are one parked edit when their conditions resolve to
    // one value. Two evaluations of a call are two conditions however alike
    // they are spelled, and two spellings of one `const` are one condition.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-recalled-condition.ts",
        parkedWriter.replaceAll("parked ?", "isParked() ?").replace(
          "const newFinalPriceCents = parked",
          "const newFinalPriceCents = isParked()",
        ),
      ),
    ).not.toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-aliased-condition.ts",
        `const parked = evidence !== null;
         const alsoParked = parked;
         ${parkedWriter.replace(
           "const newFinalPriceCents = parked",
           "const newFinalPriceCents = alsoParked",
         )}`,
      ),
    ).toEqual([]);
    // #3544: the D3 build-up helper is not a certificate a writer can claim by
    // taking its name. The selection handed to it must derive from the
    // canonical relation over the operands this very payload stores.
    const d3Writer = `import { bookingFinalPriceCents } from "@/lib/booking-final-price";
      import { d3CompatibleBookingMoneyBuildUpCents, selectLoadedBookingMoneyBuildUp } from "@/lib/booking-money-build-up";
      const derived = bookingFinalPriceCents({ totalPriceCents: newTotalPriceCents, promoAdjustmentCents: promo });
      const selection = selectLoadedBookingMoneyBuildUp(loaded, { derivedCents: derived, mismatchClassification: "STORED_SIDE_DEFECT" });
      const verified = d3CompatibleBookingMoneyBuildUpCents(selection);
      await database.booking.updateMany({ data: { totalPriceCents: newTotalPriceCents, discountCents: Math.max(0, -promo), promoAdjustmentCents: promo, finalPriceCents: verified } });
    `;
    expect(scanBookingMoneyWriterEqualityEscapes("d3.ts", d3Writer)).toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "d3-unproven-selection.ts",
        d3Writer.replace(
          "const selection = selectLoadedBookingMoneyBuildUp(loaded, { derivedCents: derived, mismatchClassification: \"STORED_SIDE_DEFECT\" });",
          "const selection = loadWhateverSelection(loaded);",
        ),
      ),
    ).not.toEqual([]);
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "d3-foreign-operand.ts",
        d3Writer.replace(
          "totalPriceCents: newTotalPriceCents, promoAdjustmentCents: promo }",
          "totalPriceCents: someOtherBooking.totalPriceCents, promoAdjustmentCents: promo }",
        ),
      ),
    ).not.toEqual([]);
    // #3544 review round. Each of these is a writer that GOT THROUGH the first
    // attempt at these repairs, reduced to its smallest form. The first is the
    // one that mattered: every certificate resolved through a local name was
    // claimable by writing `let` instead of `const`, because the resolver read
    // the declaration and ignored every later assignment — while the parked
    // condition check ten lines above refused exactly that. The `const`
    // spelling of this same write was correctly refused, which is the tell.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-reassigned-operand.ts",
        parkedWriter.replace(
          "const newTotalPriceCents = parked ? booking.totalPriceCents : priced.totalPriceCents;",
          `let newTotalPriceCents = booking.totalPriceCents;
           newTotalPriceCents = legacyQuote.totalPriceCents;`,
        ),
      ),
    ).not.toEqual([]);

    // But a reassignment the branch being certified PROVABLY EXCLUDES is not
    // evidence of anything, and refusing it would report a correct writer —
    // this is the real shape in `booking-guest-removal-service.ts`, where the
    // reprice happens only when the booking is NOT parked, so on the parked
    // branch the name still holds the booking's own stored total. The whole
    // point of the repair is to resolve rather than to match, and a resolver
    // that ignores the guard is matching again.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-guarded-reassignment.ts",
        parkedWriter.replace(
          "const newTotalPriceCents = parked ? booking.totalPriceCents : priced.totalPriceCents;",
          `let newTotalPriceCents = booking.totalPriceCents;
           if (!parked) { newTotalPriceCents = priced.totalPriceCents; }`,
        ),
      ),
    ).toEqual([]);

    // Two `let` identifiers produced no binding at all, so neither side
    // qualified as a const and the source-text fallback below accepted them as
    // one parked edit — enforcing the const rule only in the case it was not
    // about. An identifier naming a local this census can see never reaches
    // that fallback now.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-let-condition.ts",
        `let parked = evidence !== null;
         ${parkedWriter}
         parked = false;`,
      ),
    ).not.toEqual([]);

    // One extra local between the declaration and the ternary used to flip a
    // CORRECT writer to refused, because the two halves of one conjunction
    // resolved the same expression differently — one hop on one side, four and
    // a branch resolution on the other. There is one resolver now.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-indirect-operand.ts",
        parkedWriter.replace(
          "await database.booking.update({ data: { totalPriceCents: newTotalPriceCents,",
          `const alsoNewTotalPriceCents = newTotalPriceCents;
           await database.booking.update({ data: { totalPriceCents: alsoNewTotalPriceCents,`,
        ),
      ),
    ).toEqual([]);

    // The D3 exemption was claimable by ARGUMENT SHAPE: any call at all whose
    // arguments carried a canonical `derivedCents` was accepted, so a helper
    // returning an arbitrary `selectedCents` — which type-checks, because the
    // selection is a plain structural union — took the exemption with the
    // canonical figure present only to satisfy this scanner. The fixture above
    // misses this because it deletes the argument too, and is therefore
    // refused by the wrong path.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "d3-foreign-selector.ts",
        d3Writer.replace(
          "const selection = selectLoadedBookingMoneyBuildUp(loaded,",
          "const selection = whateverIWant(loaded,",
        ),
      ),
    ).not.toEqual([]);

    // A guard on some OTHER question tells this census nothing, and nesting one
    // inside the parked guard is where that bites: the outer `if` matches the
    // branch, so reading only the outermost guard would call the assignment
    // CERTAIN when `someOtherFlag` may have skipped it. Here the name would
    // then be certified as the booking's own total while it may still hold a
    // foreign one — accepted under that reading, refused under this one.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "parked-nested-unrelated-guard.ts",
        // Built out rather than patched from `parkedWriter`, because the
        // false branch has to be certifiable on its own or the case is
        // refused for a reason that has nothing to do with the guard under
        // test — a fixture passing for the wrong reason, which is the failure
        // this whole file keeps having.
        `import { bookingFinalPriceCents } from "@/lib/booking-final-price";
         let newTotalPriceCents = somethingForeign.totalPriceCents;
         if (parked) { if (someOtherFlag) { newTotalPriceCents = booking.totalPriceCents; } }
         const newFinalPriceCents = parked
           ? booking.finalPriceCents
           : bookingFinalPriceCents({ totalPriceCents: newTotalPriceCents, promoAdjustmentCents: promo });
         await database.booking.update({ data: { totalPriceCents: newTotalPriceCents, discountCents: Math.max(0, -promo), promoAdjustmentCents: promo, finalPriceCents: newFinalPriceCents } });
        `,
      ),
    ).not.toEqual([]);

    // The `let` bypass again, on the D3 path, which resolves its selection
    // through the general binding resolver rather than the parked-branch one.
    // Pinned separately because the two resolvers are different code: proving
    // one closed says nothing about the other.
    expect(
      scanBookingMoneyWriterEqualityEscapes(
        "d3-reassigned-selection.ts",
        d3Writer.replace(
          "const selection = selectLoadedBookingMoneyBuildUp(loaded, { derivedCents: derived, mismatchClassification: \"STORED_SIDE_DEFECT\" });",
          `let selection = selectLoadedBookingMoneyBuildUp(loaded, { derivedCents: derived, mismatchClassification: "STORED_SIDE_DEFECT" });
           selection = loadWhateverSelection(loaded);`,
        ),
      ),
    ).not.toEqual([]);

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
    expect(
      scanBookingMoneyRawSqlEscapes(
        "merge-only.sql",
        'MERGE INTO ONLY "Booking" AS target USING source ON true WHEN MATCHED THEN UPDATE SET "finalPriceCents" = 1;',
      ),
    ).toEqual(["merge-only.sql|rawSql:booking.unsupportedMutation"]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "insert-overriding-select.sql",
        'INSERT INTO ONLY "Booking" ("finalPriceCents") OVERRIDING SYSTEM VALUE SELECT price FROM source;',
      ),
    ).toEqual(["insert-overriding-select.sql|rawSql:booking.finalPriceCents"]);
    expect(
      scanBookingMoneyRawSqlEscapes(
        "insert-with.sql",
        'INSERT INTO "Booking" ("finalPriceCents") WITH source AS (SELECT 1 AS amount) SELECT amount FROM source;',
      ),
    ).toEqual(["insert-with.sql|rawSql:booking.finalPriceCents"]);
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
