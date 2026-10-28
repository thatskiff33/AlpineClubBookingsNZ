/**
 * Real-PostgreSQL proof for #4299 (`INV-PAY-147`, review finding F1): an edit
 * that raises the price of a place the group organiser paid for by Internet
 * Banking bills the ORGANISER, once, and asks the joiner for nothing.
 *
 * Driven through the REAL doors on real rows: the batch edit
 * (`modifyBookingBatch`), the date change (`modifyBookingDates`) and the
 * guest-add route (`POST /api/bookings/[id]/guests`). Each increase must leave
 *  - exactly one queued supplementary invoice for the change, the organiser's
 *    (the edit's own in-transaction queue and its after-commit Xero leg meet on
 *    one anchor);
 *  - no ask of the joiner: no additional amount on the response, the payment
 *    row or a payment recovery; the response names the organiser-billed figure;
 *  - no primary-invoice update, queued or recorded skipped (N-b): the place has
 *    no primary invoice of its own.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/organiser-extra-doors.realdb.test.ts
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4299-doors";
const ORGANISER_ID = `${P}-organiser`;
const JOINER_ID = `${P}-joiner`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const SEASON_ID = `${P}-season`;
const ORGANISER_BOOKING_ID = `${P}-organiser-booking`;
const BOOKING_ID = `${P}-place`;
const GUEST_ID = `${P}-guest`;
const GROUP_ID = `${P}-group`;
const COMBINED_INVOICE_ID = `${P}-combined`;
const RATE = 5_000;
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let dateService: typeof import("@/lib/booking-date-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let guestsRoute: typeof import("@/app/api/bookings/[id]/guests/route");
let syncCash: (typeof import("@/lib/organiser-extra-receipt"))["syncOrganiserExtraInvoiceCash"];
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

async function drainXeroWork(): Promise<void> {
  while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
}

async function clean(): Promise<void> {
  await drainXeroWork();
  const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  const localIds = [BOOKING_ID, ...modifications.map((row) => row.id)];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { memberId: { in: [JOINER_ID, OFFICER_ID] } }, { actorMemberId: { in: [JOINER_ID, OFFICER_ID] } }, { subjectMemberId: JOINER_ID }] } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: { in: [JOINER_ID, ORGANISER_ID] } } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: BOOKING_ID } } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A $100 two-night place in a group its organiser settled by Internet Banking. */
async function seedPlace(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID, memberId: JOINER_ID, lodgeId: LODGE_ID, checkIn: D("2026-08-10"), checkOut: D("2026-08-12"), status: "PAID",
      totalPriceCents: 2 * RATE, finalPriceCents: 2 * RATE, hasNonMembers: true, parentBookingId: ORGANISER_BOOKING_ID, organiserSettled: true,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Guest", lastName: "Joiner", ageTier: "ADULT", isMember: false,
      stayStart: D("2026-08-10"), stayEnd: D("2026-08-12"), priceCents: 2 * RATE,
      nights: { create: ["2026-08-10", "2026-08-11"].map((day) => ({ stayDate: D(day), priceCents: RATE, priceSource: "SOLD" as const })) },
    },
  });
  for (const day of ["2026-08-10", "2026-08-11"]) {
    await prisma.bookingLedgerLine.create({
      data: {
        bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: RATE, amountCents: RATE,
        bookingGuestId: GUEST_ID, nightStart: D(day), nightEndExclusive: new Date(D(day).getTime() + 86_400_000), ageTier: "ADULT",
        guestNames: ["Guest Joiner"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 4299 confirmation", lodgeId: LODGE_ID,
        postingKey: `${P}-confirm-${day}`,
      },
    });
  }
  await prisma.payment.create({ data: { bookingId: BOOKING_ID, amountCents: 2 * RATE, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
}

/** What every increase must leave behind: one organiser invoice, no joiner ask, no primary update. */
async function expectOrganiserBilledOnce(result: { additionalAmountCents: number; billedToOrganiserCents: number; priceDiffCents: number; changeFeeCents?: number }) {
  await drainXeroWork();
  const netCents = result.priceDiffCents + (result.changeFeeCents ?? 0);
  expect(netCents).toBeGreaterThan(0);
  expect(result.additionalAmountCents).toBe(0);
  expect(result.billedToOrganiserCents).toBe(netCents);
  const [modification] = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID } });
  const invoices = await prisma.xeroSyncOperation.findMany({ where: { localModel: "BookingModification", localId: modification!.id, queueType: "SUPPLEMENTARY_INVOICE" } });
  expect(invoices).toHaveLength(1);
  const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: BOOKING_ID } });
  expect(payment.additionalAmountCents).toBe(0);
  expect(payment.additionalPaymentStatus).toBeNull();
  expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
  expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [BOOKING_ID, modification!.id] }, entityType: "INVOICE", operationType: "UPDATE" } })).toBe(0);
}

(RUN ? describe : describe.skip)(
  "#4299 F1: an increase on an organiser-paid bank place bills the organiser once and asks the joiner nothing - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "organiser extra doors");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      batchService = await import("@/lib/booking-batch-modification-service");
      dateService = await import("@/lib/booking-date-modification-service");
      clubTimeServer = await import("@/lib/club-time/server");
      guestsRoute = await import("@/app/api/bookings/[id]/guests/route");
      ({ syncOrganiserExtraInvoiceCash: syncCash } = await import("@/lib/organiser-extra-receipt"));
      const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
      const queue = xeroQueue.queueXeroBookingEditSettlement;
      const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
        const pending = queue(input);
        if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
        return pending;
      });
      restoreXeroQueue = () => spy.mockRestore();

      await clean();
      await prisma.groupBookingSettlement.deleteMany({ where: { groupBookingId: GROUP_ID } });
      await prisma.groupBooking.deleteMany({ where: { id: GROUP_ID } });
      await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING_ID } });
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: SEASON_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [ORGANISER_ID, JOINER_ID, OFFICER_ID] } } });

      for (const [id, role, firstName] of [[ORGANISER_ID, Role.USER, "Organiser"], [JOINER_ID, Role.USER, "Joiner"], [OFFICER_ID, Role.ADMIN, "Officer"]] as const) {
        await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName, lastName: "Proof", ageTier: "ADULT", canLogin: true, role } });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4299 Doors Lodge", slug: P } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 20 } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 } });
      const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
      await prisma.season.create({
        data: {
          id: SEASON_ID, name: "Race 4299 season", type: "WINTER", startDate: D("2026-06-01"), endDate: D("2026-09-30"), active: true, lodgeId: LODGE_ID,
          membershipTypeRates: { create: [
            { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: RATE },
            { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: RATE },
          ] },
        },
      });
      await prisma.booking.create({ data: { id: ORGANISER_BOOKING_ID, memberId: ORGANISER_ID, lodgeId: LODGE_ID, checkIn: D("2026-08-10"), checkOut: D("2026-08-12"), status: "PAID", totalPriceCents: 2 * RATE, finalPriceCents: 2 * RATE } });
      await prisma.groupBooking.create({ data: { id: GROUP_ID, organiserBookingId: ORGANISER_BOOKING_ID, organiserMemberId: ORGANISER_ID, joinCode: P, paymentMode: "ORGANISER_PAYS" } });
      await prisma.groupBookingSettlement.create({ data: { groupBookingId: GROUP_ID, amountCents: 4 * RATE, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: COMBINED_INVOICE_ID } });
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await seedPlace();
    });

    afterAll(async () => {
      try {
        if (!prisma) return;
        await clean();
        await prisma.groupBookingSettlement.deleteMany({ where: { groupBookingId: GROUP_ID } });
        await prisma.groupBooking.deleteMany({ where: { id: GROUP_ID } });
        await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING_ID } });
        await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
        await prisma.season.deleteMany({ where: { id: SEASON_ID } });
        await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
        await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
        await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
        await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
        await prisma.member.deleteMany({ where: { id: { in: [ORGANISER_ID, JOINER_ID, OFFICER_ID] } } });
      } finally {
        restoreXeroQueue?.();
      }
    });

    it("batch edit: an extension bills the organiser once and asks the joiner nothing", async () => {
      const result = await batchService.modifyBookingBatch({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkOut: "2026-08-13" } as never,
        ipAddress: "127.0.0.1",
        todayAtClub: (await clubTimeServer.clubTime()).today(),
        format: CLUB_FORMAT_TEST,
      });
      await expectOrganiserBilledOnce(result);
    });

    it("date change: an extension bills the organiser once and asks the joiner nothing", async () => {
      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-10", checkOut: "2026-08-13" } as never,
        ipAddress: "127.0.0.1",
      });
      await expectOrganiserBilledOnce(result);
    });

    it("a reduction nets the unpaid extra first and binds the paid part's refund to the organiser's hand-back", async () => {
      // An earlier +$50 change with a $10 fee, invoiced to the organiser, $20 of it paid.
      const increase = await prisma.bookingModification.create({ data: { bookingId: BOOKING_ID, memberId: OFFICER_ID, modificationType: "DATE_CHANGE",
        previousData: {}, newData: {}, priceDiffCents: 5_000, changeFeeCents: 1_000 } });
      await prisma.payment.update({ where: { bookingId: BOOKING_ID }, data: { changeFeeCents: 1_000 } });
      await prisma.xeroObjectLink.create({ data: { localModel: "BookingModification", localId: increase.id, xeroObjectType: "INVOICE", xeroObjectId: `${P}-extra`,
        role: "SUPPLEMENTARY_INVOICE", metadata: { organiserBilling: true, priceDiffCents: 5_000, changeFeeCents: 1_000 } } });
      await syncCash({ invoiceID: `${P}-extra`, amountPaid: 20, amountDue: 40, total: 60 });

      // One night ($50) comes off: $40 waives the unpaid extra, the other $10 is paid extra price refunded at 50%.
      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-10", checkOut: "2026-08-11" } as never,
        ipAddress: "127.0.0.1",
      });
      await drainXeroWork();
      expect(result.refundAmountCents).toBe(500);
      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID } });
      expect(task.amountCents).toBe(500);
      const plans = (await prisma.xeroSyncOperation.findMany({ where: { localId: BOOKING_ID, queueType: "ORGANISER_EXTRA_ADJUSTMENT" } }))
        .map((row) => ({ status: row.status, payload: row.requestPayload as { purpose: string; amountCents: number; handBackTaskId?: string } }));
      expect(plans.filter((row) => row.payload.purpose === "waive").map((row) => [row.status, row.payload.amountCents])).toEqual([["PENDING", 4_000]]);
      expect(plans.filter((row) => row.payload.purpose === "refund").map((row) => [row.status, row.payload.amountCents, row.payload.handBackTaskId]))
        .toEqual([["WAITING_PAYMENT", 500, task.id]]);
    });

    it("S2: a reduction sized wholly against the unpaid extra freezes the policy's 50%, not 100%, for cash that races its waiver", async () => {
      // +$50 with a $10 fee invoiced to the organiser, $10 of it paid: $50 unpaid.
      const increase = await prisma.bookingModification.create({ data: { bookingId: BOOKING_ID, memberId: OFFICER_ID, modificationType: "DATE_CHANGE",
        previousData: {}, newData: {}, priceDiffCents: 5_000, changeFeeCents: 1_000 } });
      await prisma.payment.update({ where: { bookingId: BOOKING_ID }, data: { changeFeeCents: 1_000 } });
      await prisma.xeroObjectLink.create({ data: { localModel: "BookingModification", localId: increase.id, xeroObjectType: "INVOICE", xeroObjectId: `${P}-extra`,
        role: "SUPPLEMENTARY_INVOICE", metadata: { organiserBilling: true, priceDiffCents: 5_000, changeFeeCents: 1_000 } } });
      await syncCash({ invoiceID: `${P}-extra`, amountPaid: 10, amountDue: 50, total: 60 });

      // One night ($50) comes off, all of it against the unpaid extra: no cash basis, so no settlement options.
      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-10", checkOut: "2026-08-11" } as never,
        ipAddress: "127.0.0.1",
      });
      await drainXeroWork();
      expect(result.refundAmountCents).toBe(0);
      const plans = (await prisma.xeroSyncOperation.findMany({ where: { localId: BOOKING_ID, queueType: "ORGANISER_EXTRA_ADJUSTMENT" } }))
        .map((row) => row.requestPayload as { purpose: string; amountCents: number; refundPercentage: number });
      // The edit's own tier is frozen on the waiver, so cash racing it is refunded at 50%.
      expect(plans.map((row) => [row.purpose, row.amountCents, row.refundPercentage])).toEqual([["waive", 5_000, 50]]);
    });

    it("guest add: an added guest bills the organiser once and asks the joiner nothing", async () => {
      const { NextRequest } = await import("next/server");
      raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: ["ADMIN"], canLogin: true } };
      try {
        const response = await guestsRoute.POST(
          new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/guests`, {
            method: "POST",
            body: JSON.stringify({ guests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }], notifyMember: false }),
            headers: { "content-type": "application/json" },
          }),
          { params: Promise.resolve({ id: BOOKING_ID }) },
        );
        const json = await response.json();
        expect(response.status, JSON.stringify(json)).toBe(200);
        await expectOrganiserBilledOnce(json);
      } finally {
        raceSession.current = null;
      }
    });
  },
);
