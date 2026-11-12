/**
 * Real-PostgreSQL proof that the admin bookings derived-filter pre-filter
 * (#4939) changes no result. Ordinary Vitest runs skip this; the `realdb-all`
 * job runs it against a disposable, loopback-only database.
 *
 * The unit suite (`admin-bookings-derived-prefilter.test.ts`) evaluates the
 * pre-filter's `where` with a test evaluator. This one lets PostgreSQL do it:
 * the relation filters (`payment: { is }`, `modifications: { some }`, the
 * nested modification credit), the `distinct` Xero record query and the empty
 * `in` list are properties of Prisma's SQL, which a mock cannot establish.
 *
 * It seeds `DERIVED_SCENARIOS` in its own lodge, reads the unfiltered list
 * for that lodge as the derivation's answer, and requires every filter value
 * to list exactly those rows, in the same order, with the same totals.
 */
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DERIVED_FILTER_CASES,
  DERIVED_SCENARIOS,
  rowMatchesCase,
  type DerivedFilterCase,
  type XeroRecord,
} from "./support/admin-bookings-derived-scenarios";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "dp-4939";
const MEMBER_ID = `${PREFIX}-member`;
const LODGE_ID = `${PREFIX}-lodge`;
const ROOM_ID = `${PREFIX}-room`;
const BED_ID = `${PREFIX}-bed`;
const BOOKING_IDS = DERIVED_SCENARIOS.map((scenario) => `${PREFIX}-${scenario.key}`);
const FIRST_CHECK_IN = Date.UTC(2099, 0, 1);
const DAY_MS = 86_400_000;

let prisma: typeof import("@/lib/prisma")["prisma"];
let service: typeof import("@/lib/admin-bookings-service");
let clubDay: import("@/lib/admin-bookings-service").AdminBookingsClubDay;

function dayOf(index: number, offset: number): Date {
  return new Date(FIRST_CHECK_IN + (index * 4 + offset) * DAY_MS);
}

async function ownedRecordIds(): Promise<string[]> {
  const [payments, modifications] = await Promise.all([
    prisma.payment.findMany({ where: { bookingId: { in: BOOKING_IDS } }, select: { id: true } }),
    prisma.bookingModification.findMany({
      where: { bookingId: { in: BOOKING_IDS } },
      select: { id: true },
    }),
  ]);
  return [...BOOKING_IDS, ...payments.map((row) => row.id), ...modifications.map((row) => row.id)];
}

async function clearFixtures(): Promise<void> {
  // Xero rows first, by the records this suite owns: the race harness
  // refuses to leave PENDING operations behind.
  const recordIds = await ownedRecordIds();
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: recordIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: recordIds } } });
  // Credits restrict their source booking and modification.
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingGuestNight.deleteMany({
    where: { bookingGuest: { bookingId: { in: BOOKING_IDS } } },
  });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingChangeRequest.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
  await prisma.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
  await prisma.lodgeBed.deleteMany({ where: { id: BED_ID } });
  await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
}

async function seed(): Promise<void> {
  await prisma.member.create({
    data: {
      id: MEMBER_ID,
      email: `${PREFIX}@example.invalid`,
      passwordHash: "not-a-real-password",
      firstName: "Derived",
      lastName: "Prefilter",
      ageTier: "ADULT",
    },
  });
  await prisma.lodge.create({ data: { id: LODGE_ID, name: "Prefilter Lodge", slug: PREFIX } });
  await prisma.lodgeRoom.create({ data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Prefilter Room" } });
  await prisma.lodgeBed.create({
    data: { id: BED_ID, roomId: ROOM_ID, name: "Bunk", bedType: "SINGLE", sortOrder: 0 },
  });

  for (const [index, scenario] of DERIVED_SCENARIOS.entries()) {
    const bookingId = BOOKING_IDS[index]!;
    await prisma.booking.create({
      data: {
        id: bookingId,
        memberId: MEMBER_ID,
        lodgeId: LODGE_ID,
        checkIn: dayOf(index, 0),
        checkOut: dayOf(index, 3),
        status: scenario.status ?? "PAID",
        wholeLodgeHold: scenario.wholeLodgeHold ?? false,
        requiresAdminReview: scenario.requiresAdminReview ?? false,
        adminReviewStatus: scenario.adminReviewStatus ?? null,
        totalPriceCents: 0,
        finalPriceCents: 0,
      },
    });

    let guestId: string | null = null;
    if (scenario.guest) {
      const nights = scenario.guest.nights;
      guestId = `${bookingId}-guest`;
      await prisma.bookingGuest.create({
        data: {
          id: guestId,
          bookingId,
          firstName: "Guest",
          lastName: scenario.key,
          ageTier: scenario.guest.ageTier,
          stayStart: dayOf(index, Math.min(...nights)),
          stayEnd: dayOf(index, Math.max(...nights) + 1),
          priceCents: 0,
        },
      });
      await prisma.bookingGuestNight.createMany({
        data: nights.map((offset) => ({
          bookingGuestId: guestId!,
          stayDate: dayOf(index, offset),
          priceCents: 0,
        })),
      });
    }
    for (const offset of scenario.allocatedNights ?? []) {
      await prisma.bedAllocation.create({
        data: {
          bookingId,
          bookingGuestId: guestId!,
          roomId: ROOM_ID,
          bedId: BED_ID,
          stayDate: dayOf(index, offset),
          approvedAt: new Date(FIRST_CHECK_IN),
        },
      });
    }

    const payment = scenario.payment
      ? await prisma.payment.create({
          data: {
            bookingId,
            amountCents: 0,
            status: scenario.payment.status,
            xeroInvoiceId: scenario.payment.storedInvoice ? `${bookingId}-inv` : null,
          },
          select: { id: true },
        })
      : null;
    if (payment && scenario.payment?.linkedInvoice) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment",
          localId: payment.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: `${bookingId}-linked-inv`,
          xeroObjectNumber: `${PREFIX}-${index}`,
          role: "PRIMARY_INVOICE",
        },
      });
    }

    const modificationIds: string[] = [];
    for (const modification of scenario.modifications ?? []) {
      const row = await prisma.bookingModification.create({
        data: {
          bookingId,
          memberId: MEMBER_ID,
          modificationType: "DATE_CHANGE",
          previousData: {},
          newData: {},
        },
        select: { id: true },
      });
      modificationIds.push(row.id);
      if (modification.credit) {
        await prisma.memberCredit.create({
          data: {
            memberId: MEMBER_ID,
            amountCents: 100,
            type: "BOOKING_MODIFICATION_REFUND",
            description: "Modification refund",
            sourceBookingModificationId: row.id,
          },
        });
      }
    }
    for (const status of scenario.changeRequests ?? []) {
      await prisma.bookingChangeRequest.create({
        data: { bookingId, requestedByMemberId: MEMBER_ID, status, requestedChanges: {} },
      });
    }
    if (scenario.cancellationCredit) {
      await prisma.memberCredit.create({
        data: {
          memberId: MEMBER_ID,
          amountCents: 100,
          type: "CANCELLATION_REFUND",
          description: "Cancellation refund",
          sourceBookingId: bookingId,
        },
      });
    }

    const recordId: Record<XeroRecord, { model: string; id: string | undefined }> = {
      booking: { model: "Booking", id: bookingId },
      payment: { model: "Payment", id: payment?.id },
      modification: { model: "BookingModification", id: modificationIds[0] },
    };
    for (const [n, operation] of (scenario.xeroOperations ?? []).entries()) {
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: recordId[operation.on].model,
          localId: recordId[operation.on].id!,
          status: operation.status,
          createdAt: new Date(FIRST_CHECK_IN + n * 60_000),
          manuallyResolvedAt: operation.resolved ? new Date(FIRST_CHECK_IN) : null,
        },
      });
    }
  }
}

const SORT = { sortBy: "checkIn", sortDir: "asc" } as const;

async function listWith(params: Record<string, string>, bedAllocationEnabled = true) {
  return service.listAdminBookings(
    service.adminBookingsQuerySchema.parse({ ...SORT, lodgeId: LODGE_ID, ...params }),
    { bedAllocationEnabled },
    clubDay,
  );
}

function caseLabel(filterCase: DerivedFilterCase) {
  return Object.entries(filterCase)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

if (RUN) {
  describe("admin bookings derived-filter pre-filter against PostgreSQL (#4939)", () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "admin bookings derived pre-filter"); // #4142: the one shared guard
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      service = await import("@/lib/admin-bookings-service");
      const { dateOnlyInstantOf, requireCalendarDate, requireClubTimeZone } = await import(
        "@/lib/club-time"
      );
      clubDay = {
        zone: requireClubTimeZone("Pacific/Auckland"),
        today: dateOnlyInstantOf(requireCalendarDate("2026-07-01")),
      };
      await clearFixtures();
      await seed();
    }, 120_000);

    afterAll(async () => {
      await clearFixtures();
    });

    it("seeds every listable scenario in the state it claims", async () => {
      const all = await listWith({});
      const byId = new Map(all.bookings.map((row) => [row.id, row.operational]));

      for (const [index, scenario] of DERIVED_SCENARIOS.entries()) {
        const state = byId.get(BOOKING_IDS[index]!);
        if (scenario.expected === null) {
          expect(state, scenario.key).toBeUndefined();
          continue;
        }
        expect(
          { xero: state?.xeroState, bed: state?.bedState },
          scenario.key
        ).toEqual({ xero: scenario.expected.xero, bed: scenario.expected.bed });
      }
    });

    it.each(DERIVED_FILTER_CASES.map((filterCase) => [caseLabel(filterCase), filterCase] as const))(
      "%s lists exactly what the derivation alone selects",
      async (_label, filterCase) => {
        for (const bedAllocationEnabled of [true, false]) {
          const all = await listWith({}, bedAllocationEnabled);
          const expected = all.bookings
            .filter((row) => rowMatchesCase(row.operational, filterCase, bedAllocationEnabled))
            .map((row) => row.id);
          if (bedAllocationEnabled) expect(expected.length).toBeGreaterThan(0);

          const result = await listWith(filterCase, bedAllocationEnabled);

          expect(result.bookings.map((row) => row.id)).toEqual(expected);
          expect(result.total).toBe(expected.length);
          expect(result.totalPages).toBe(1);
        }
      },
      60_000
    );
  });
} else {
  describe.skip("admin bookings derived-filter pre-filter against PostgreSQL (#4939)", () => {
    it("needs RUN_CONCURRENCY_RACE_TESTS=1 and a disposable database", () => {});
  });
}
