/**
 * Real-PostgreSQL proof of `bookingsWithFinancialHistory` (#4514, Ledger M2; D1
 * on #4482, `INV-MONEY-043`).
 *
 * The unit test pins each reader's `where`; what a mock cannot show is that the
 * Prisma query really finds the booking a row names in PostgreSQL — through a
 * relation filter for a credit row's modification and a group settlement — and
 * nothing else. One booking per relation, each carrying ONE kind of history
 * (a recovery operation needs its payment too), beside a booking carrying none. And the readers agree with the
 * database: each such booking's delete is refused (23503), while the clean one
 * deletes.
 *
 * Ordinary Vitest runs skip the whole file; CI's real-PostgreSQL job runs it
 * against the guarded loopback race database. It cleans its own namespaced rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import type { BookingFinancialHistoryRelation } from "@/lib/booking-financial-history";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4514";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const CLEAN_ID = `${P}-clean`;
const CHECK_IN = new Date("2026-09-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-11T00:00:00.000Z");

let prisma: PrismaClient;
let financialHistory: typeof import("@/lib/booking-financial-history");

const bookingFor = (relation: string) => `${P}-${relation.replace(".", "-")}`;

/** Gives `bookingId` exactly one row of `relation`'s kind. */
async function name(relation: BookingFinancialHistoryRelation, bookingId: string): Promise<void> {
  const paymentFor = async () => (await prisma.payment.create({ data: { bookingId, amountCents: 100 } })).id;
  switch (relation) {
    case "BookingLedgerLine.bookingId":
      await prisma.bookingLedgerLine.create({
        data: {
          bookingId, lodgeId: LODGE_ID, side: "ADJUSTMENT", kind: "AGREED_ADJUSTMENT", sign: 1, quantity: 1,
          unitCents: 100, amountCents: 100, guestNames: [], anchorKind: "REVIEW_TASK", anchorId: bookingId,
          narration: "Adjustment agreed with member: race 4514",
        },
      });
      return;
    case "MemberMoneyLine.bookingId":
      // The journal is inert until M3 and its rows are immutable, so no fixture
      // can post one and remove it; the census and the catalog proof in
      // database-roles.realdb.test.ts hold this key. The reader still runs below.
      return;
    case "MemberCredit.sourceBookingId":
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: 100, type: "CANCELLATION_REFUND", description: "race 4514", sourceBookingId: bookingId },
      });
      return;
    case "MemberCredit.appliedToBookingId":
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: -100, type: "BOOKING_APPLIED", description: "race 4514", appliedToBookingId: bookingId },
      });
      return;
    case "MemberCredit.sourceBookingModificationId": {
      const modification = await prisma.bookingModification.create({
        data: { bookingId, memberId: MEMBER_ID, modificationType: "DATES", previousData: {}, newData: {} },
      });
      await prisma.memberCredit.create({
        data: {
          memberId: MEMBER_ID, amountCents: 100, type: "BOOKING_MODIFICATION_REFUND", description: "race 4514",
          sourceBookingModificationId: modification.id,
        },
      });
      return;
    }
    case "Payment.bookingId":
      await paymentFor();
      return;
    case "RefundRequest.bookingId":
      await prisma.refundRequest.create({ data: { bookingId, memberId: MEMBER_ID, reason: "race 4514" } });
      return;
    case "ManualRefundTask.bookingId":
      await prisma.manualRefundTask.create({ data: { bookingId, reason: "race 4514" } });
      return;
    case "PaymentRecoveryOperation.bookingId":
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "CANCEL_PAYMENT_INTENT", bookingId, paymentId: await paymentFor(), paymentIntentId: `pi_${bookingId}`,
          amountCents: 100, idempotencyKey: bookingId,
        },
      });
      return;
    case "GroupBookingSettlement.groupBookingId": {
      const group = await prisma.groupBooking.create({
        data: { organiserBookingId: bookingId, organiserMemberId: MEMBER_ID, joinCode: `R4514${bookingId.length}`, paymentMode: "ORGANISER_PAYS" },
      });
      await prisma.groupBookingSettlement.create({ data: { groupBookingId: group.id, amountCents: 100 } });
      return;
    }
  }
}

async function clean(bookingIds: string[]): Promise<void> {
  await releaseBookingFinancialHistoryForTeardown(prisma, bookingIds);
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.refundRequest.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.groupBooking.deleteMany({ where: { organiserBookingId: { in: bookingIds } } });
  await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
}

(RUN ? describe : describe.skip)("bookingsWithFinancialHistory against real PostgreSQL (#4514)", () => {
  let bookingIds: string[] = [];

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Booking financial history");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    financialHistory = await import("@/lib/booking-financial-history");
    bookingIds = [CLEAN_ID, ...financialHistory.BOOKING_FINANCIAL_HISTORY_RELATIONS.map(bookingFor)];

    await clean(bookingIds);
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "History", lastName: "Proof" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4514 Lodge", slug: P } });
    for (const id of bookingIds) {
      await prisma.booking.create({
        data: { id, lodgeId: LODGE_ID, memberId: MEMBER_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, totalPriceCents: 100, finalPriceCents: 100 },
      });
    }
    for (const relation of financialHistory.BOOKING_FINANCIAL_HISTORY_RELATIONS) {
      await name(relation, bookingFor(relation));
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean(bookingIds);
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("finds exactly the bookings their one kind of history names, through every relation", async () => {
    const found = await financialHistory.bookingsWithFinancialHistory(prisma, bookingIds);
    const expected = financialHistory.BOOKING_FINANCIAL_HISTORY_RELATIONS
      .filter((relation) => relation !== "MemberMoneyLine.bookingId")
      .map(bookingFor);
    expect([...found].sort()).toEqual(expected.sort());
  });

  it("agrees with the database: each named booking's delete is refused, the clean one's is not", async () => {
    for (const id of await financialHistory.bookingsWithFinancialHistory(prisma, bookingIds)) {
      await expect(prisma.booking.delete({ where: { id } }), id).rejects.toMatchObject({ code: "P2003" });
    }
    await prisma.booking.delete({ where: { id: CLEAN_ID } });
    await prisma.booking.create({
      data: { id: CLEAN_ID, lodgeId: LODGE_ID, memberId: MEMBER_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, totalPriceCents: 100, finalPriceCents: 100 },
    });
  });

  it("releases every kind for teardown, so a suite's cleanup deletes its bookings as before M2", async () => {
    await releaseBookingFinancialHistoryForTeardown(prisma, [
      bookingFor("BookingLedgerLine.bookingId"),
      bookingFor("MemberCredit.sourceBookingId"),
      bookingFor("MemberCredit.appliedToBookingId"),
      bookingFor("MemberCredit.sourceBookingModificationId"),
      bookingFor("GroupBookingSettlement.groupBookingId"),
    ]);
    const found = await financialHistory.bookingsWithFinancialHistory(prisma, bookingIds);
    expect([...found].sort()).toEqual(
      ["Payment.bookingId", "RefundRequest.bookingId", "ManualRefundTask.bookingId", "PaymentRecoveryOperation.bookingId"]
        .map(bookingFor)
        .sort(),
    );
  });
});
