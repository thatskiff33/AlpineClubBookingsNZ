/**
 * #4939 — the derived-filter scan narrows in SQL first, and shows exactly
 * what it showed before.
 *
 * Filtering Admin → Bookings by Xero, bed or change state used to visit every
 * booking the club ever took. Each filter value now ANDs a superset condition
 * into the scan's `where`; the JavaScript derivation still decides. These
 * cases prove the result is unchanged by comparing each filter value against
 * the derivation alone: the unfiltered list's own `operational` state, read
 * row by row. A pre-filter narrower than the derivation drops a scenario from
 * `DERIVED_SCENARIOS` and fails here (the table in that module names which).
 *
 * The booking mock evaluates the WHOLE `where` (`{ where: "full" }`), and the
 * Xero operation and object-link mocks evaluate theirs, so the pre-filter is
 * actually applied. `admin-bookings-derived-prefilter.realdb.test.ts` asks
 * PostgreSQL the same questions.
 *
 * Frozen clock discipline: fixtures sit from July 2026 on, after the frozen
 * 2026-07-01 instant, and nothing here reads a clock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn(), count: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
  },
}));

import {
  ADMIN_BOOKINGS_XERO_PREFILTER_MAX_RECORDS,
  adminBookingsQuerySchema,
  listAdminBookings,
  type AdminBookingsClubDay,
} from "@/lib/admin-bookings-service";
import {
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";
import { addDaysDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { installAdminBookingsDbMock } from "./admin-bookings-db-mock";
import { matchesWhere } from "./support/prisma-where";
import {
  DERIVED_FILTER_CASES,
  DERIVED_SCENARIOS,
  rowMatchesCase,
  type DerivedFilterCase,
  type DerivedScenario,
  type XeroRecord,
} from "./support/admin-bookings-derived-scenarios";

const TEST_CLUB_DAY: AdminBookingsClubDay = {
  zone: requireClubTimeZone("Pacific/Auckland"),
  today: dateOnlyInstantOf(requireCalendarDate("2026-07-01")),
};

type Row = Record<string, unknown>;

interface Store {
  bookings: Row[];
  operations: Row[];
  links: Row[];
}

function bookingIdOf(scenario: DerivedScenario) {
  return `pf-${scenario.key}`;
}

function buildStore(): Store {
  const store: Store = { bookings: [], operations: [], links: [] };
  const created = new Date("2026-06-01T00:00:00.000Z");

  DERIVED_SCENARIOS.forEach((scenario, index) => {
    const id = bookingIdOf(scenario);
    // Distinct check-ins, so a checkIn sort orders the scenarios uniquely.
    const checkIn = addDaysDateOnly(TEST_CLUB_DAY.today, index * 4);
    const nightOf = (offset: number) => addDaysDateOnly(checkIn, offset);
    const guestId = `${id}-guest`;
    const guest = scenario.guest
      ? {
          id: guestId,
          firstName: "Guest",
          lastName: scenario.key,
          ageTier: scenario.guest.ageTier,
          isMember: false,
          priceCents: 0,
          stayStart: nightOf(Math.min(...scenario.guest.nights)),
          stayEnd: nightOf(Math.max(...scenario.guest.nights) + 1),
          nights: scenario.guest.nights.map((offset) => ({
            stayDate: nightOf(offset),
            priceCents: 0,
            priceSource: "NIGHTLY",
          })),
        }
      : null;
    const payment = scenario.payment
      ? {
          id: `${id}-pay`,
          source: "STRIPE",
          status: scenario.payment.status,
          xeroInvoiceId: scenario.payment.storedInvoice ? `inv-${id}` : null,
          xeroInvoiceNumber: scenario.payment.storedInvoice ? `INV-${index}` : null,
          refundedAmountCents: 0,
          additionalAmountCents: null,
          additionalPaymentStatus: null,
        }
      : null;
    const modifications = (scenario.modifications ?? []).map((modification, n) => ({
      id: `${id}-mod-${n}`,
      modificationType: "DATE_CHANGE",
      priceDiffCents: 0,
      createdAt: created,
      creditsFromModification: modification.credit
        ? [{ id: `${id}-mod-${n}-credit`, amountCents: 100, xeroCreditNoteId: null }]
        : [],
    }));

    store.bookings.push({
      id,
      lodgeId: "lodge-1",
      status: scenario.status ?? "PAID",
      checkIn,
      checkOut: nightOf(3),
      updatedAt: created,
      totalPriceCents: 0,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: 0,
      requiresAdminReview: scenario.requiresAdminReview ?? false,
      adminReviewStatus: scenario.adminReviewStatus ?? null,
      adminReviewReason: null,
      deletedAt: null,
      wholeLodgeHold: scenario.wholeLodgeHold ?? false,
      originBookingRequest: null,
      adminCapacityHoldAt: null,
      member: { id: "member-1", firstName: "Aroha", lastName: "Ngata", email: "a@example.test" },
      organisation: null,
      guests: guest ? [guest] : [],
      _count: { guests: guest ? 1 : 0 },
      promoRedemptions: [],
      nightAdjustments: [],
      payment,
      bedAllocations: (scenario.allocatedNights ?? []).map((offset) => ({
        id: `${id}-alloc-${offset}`,
        bookingId: id,
        bookingGuestId: guestId,
        roomId: "room-a",
        bedId: "bed-a",
        stayDate: nightOf(offset),
        approvedAt: created,
        bookingGuest: { id: guestId, firstName: "Guest", lastName: scenario.key, ageTier: guest?.ageTier },
        room: { id: "room-a", name: "Room A" },
        bed: { id: "bed-a", name: "Bed A" },
      })),
      modifications,
      changeRequests: (scenario.changeRequests ?? []).map((status, n) => ({
        id: `${id}-request-${n}`,
        status,
        createdAt: created,
        linkedModificationId: null,
      })),
      creditsFromCancellation: scenario.cancellationCredit
        ? [{ id: `${id}-credit`, amountCents: 100, description: "Cancelled", xeroCreditNoteId: null }]
        : [],
      refundRequests: [],
    });

    const recordId: Record<XeroRecord, string | undefined> = {
      booking: id,
      payment: payment?.id,
      modification: modifications[0]?.id,
    };
    (scenario.xeroOperations ?? []).forEach((operation, n) => {
      store.operations.push({
        id: `${id}-op-${n}`,
        status: operation.status,
        localModel: { booking: "Booking", payment: "Payment", modification: "BookingModification" }[operation.on],
        localId: recordId[operation.on],
        createdAt: new Date(created.getTime() + n * 60_000),
        manuallyResolvedAt: operation.resolved ? created : null,
      });
    });
    if (payment && scenario.payment?.linkedInvoice) {
      store.links.push({
        localModel: "Payment",
        localId: payment.id,
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        active: true,
        xeroObjectNumber: `INV-L-${index}`,
      });
    }
  });

  return store;
}

interface QueryArgs {
  where?: Record<string, unknown>;
  distinct?: string[];
  take?: number;
}

function installStore(store: Store) {
  installAdminBookingsDbMock(store.bookings, { where: "full" });
  vi.mocked(prisma.xeroSyncOperation.findMany).mockImplementation((async (args?: QueryArgs) => {
    let rows = store.operations.filter((row) => matchesWhere(row, args?.where));
    if (args?.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const key = args.distinct!.map((field) => String(row[field])).join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return args?.take == null ? rows : rows.slice(0, args.take);
  }) as never);
  vi.mocked(prisma.xeroObjectLink.findMany).mockImplementation((async (args?: QueryArgs) =>
    store.links.filter((row) => matchesWhere(row, args?.where))) as never);
}

const SORT = { sortBy: "checkIn", sortDir: "asc" } as const;

async function listWith(params: Record<string, string>, bedAllocationEnabled = true) {
  return listAdminBookings(
    adminBookingsQuerySchema.parse({ ...SORT, ...params }),
    { bedAllocationEnabled },
    TEST_CLUB_DAY,
  );
}

/** The derivation's own answer: the unfiltered list, kept row by row. */
async function expectedFor(filterCase: DerivedFilterCase, bedAllocationEnabled = true) {
  const all = await listWith({}, bedAllocationEnabled);
  return all.bookings
    .filter((row) => rowMatchesCase(row.operational, filterCase, bedAllocationEnabled))
    .map((row) => row.id);
}

/** The ids the derived scan's first chunk loaded — what got past the pre-filter. */
async function scannedIds(): Promise<string[]> {
  const scanIndex = vi
    .mocked(prisma.booking.findMany)
    .mock.calls.findIndex(([args]) => (args as { take?: number })?.take !== undefined && "include" in (args ?? {}));
  const rows = (await vi.mocked(prisma.booking.findMany).mock.results[scanIndex]?.value) as Array<{ id: string }>;
  return rows.map((row) => row.id).sort();
}

function caseLabel(filterCase: DerivedFilterCase) {
  return Object.entries(filterCase)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

describe("admin bookings derived-filter SQL pre-filter (#4939)", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = buildStore();
    installStore(store);
  });

  it("seeds every scenario in the state it claims", async () => {
    const all = await listWith({});
    const byId = new Map(all.bookings.map((row) => [row.id, row.operational]));

    for (const scenario of DERIVED_SCENARIOS) {
      const state = byId.get(bookingIdOf(scenario));
      if (scenario.expected === null) {
        expect(state, scenario.key).toBeUndefined();
        continue;
      }
      expect(state, scenario.key).toBeDefined();
      const change = (
        [
          ["requiresReview", state!.requiresReview],
          ["pendingRequest", state!.pendingChangeRequest],
          ["hasModification", state!.hasModification],
          ["creditGenerated", state!.creditGenerated],
        ] as const
      ).flatMap(([flag, on]) => (on ? [flag] : []));
      expect({ xero: state!.xeroState, bed: state!.bedState, change }, scenario.key).toEqual(
        scenario.expected
      );
    }
  });

  it.each(DERIVED_FILTER_CASES.map((filterCase) => [caseLabel(filterCase), filterCase] as const))(
    "%s lists exactly what the derivation alone selects",
    async (_label, filterCase) => {
      const expected = await expectedFor(filterCase);
      // A vacuous case proves nothing: every value has a scenario reaching it.
      expect(expected.length).toBeGreaterThan(0);

      vi.mocked(prisma.booking.findMany).mockClear();
      const result = await listWith(filterCase);

      expect(result.bookings.map((row) => row.id)).toEqual(expected);
      expect(result.total).toBe(expected.length);
      expect(result.totalPages).toBe(1);
    }
  );

  it("loads only bookings holding a failed operation on any of their three records", async () => {
    const result = await listWith({ xeroState: "operationFailed" });

    // The heavy candidate load saw the failed-operation holders, not the
    // other two dozen bookings — and nothing the derivation would show was cut.
    expect(await scannedIds()).toEqual(
      [
        "pf-failed-then-succeeded",
        "pf-failed-on-payment",
        "pf-failed-on-modification",
        "pf-failed-resolved",
        "pf-failed-beats-partial",
      ].sort()
    );
    expect(result.bookings.map((row) => row.id).sort()).toEqual(await scannedIds());
    const scan = vi.mocked(prisma.booking.findMany).mock.calls.find(
      ([args]) => "include" in (args ?? {})
    );
    expect(scan?.[0]?.where).toHaveProperty("AND");
  });

  it("narrows to a payment's and a modification's records, not only the booking's own id", async () => {
    await listWith({ xeroState: "operationPending" });

    expect(await scannedIds()).toEqual(["pf-partial-on-payment", "pf-pending-running", "pf-pending-waiting"]);
  });

  it("matches nothing in SQL when no record holds a counted operation", async () => {
    store.operations = store.operations.filter((operation) => operation.status !== "PARTIAL");

    const result = await listWith({ xeroState: "operationPartial" });

    expect(result.total).toBe(0);
    expect(await scannedIds()).toEqual([]);
  });

  it("steps aside rather than send an oversized id list, and stays exact", async () => {
    for (let n = 0; n < ADMIN_BOOKINGS_XERO_PREFILTER_MAX_RECORDS; n += 1) {
      store.operations.push({
        id: `elsewhere-op-${n}`,
        status: "FAILED",
        localModel: "Booking",
        localId: `elsewhere-${n}`,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        manuallyResolvedAt: null,
      });
    }
    const expected = await expectedFor({ xeroState: "operationFailed" });
    vi.mocked(prisma.booking.findMany).mockClear();

    const result = await listWith({ xeroState: "operationFailed" });

    expect(result.bookings.map((row) => row.id)).toEqual(expected);
    // Every listable booking was a candidate: no Xero narrowing was applied.
    const listable = DERIVED_SCENARIOS.filter((scenario) => scenario.expected !== null);
    expect(await scannedIds()).toHaveLength(listable.length);
  });

  it("applies no bed pre-filter while the bed-allocation module is off", async () => {
    const filterCase = { bedState: "unallocated", changeState: "hasModification" } as const;
    const expected = await expectedFor(filterCase, false);
    expect(expected.length).toBeGreaterThan(0);
    vi.mocked(prisma.booking.findMany).mockClear();

    const result = await listWith(filterCase, false);

    expect(result.bookings.map((row) => row.id)).toEqual(expected);
    // The modification holders without a guest got through: a bed condition
    // would have cut them.
    expect(await scannedIds()).toContain("pf-failed-on-modification");
  });

  it("composes with lodge scoping and deleted visibility", async () => {
    store.bookings.push({
      ...store.bookings.find((row) => row.id === "pf-failed-on-payment")!,
      id: "pf-other-lodge-failed",
      lodgeId: "lodge-2",
    });
    store.operations.push({
      id: "pf-other-lodge-op",
      status: "FAILED",
      localModel: "Booking",
      localId: "pf-other-lodge-failed",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      manuallyResolvedAt: null,
    });

    const lodgeOne = await listWith({ xeroState: "operationFailed", lodgeId: "lodge-1" });
    expect(lodgeOne.bookings.map((row) => row.id)).not.toContain("pf-other-lodge-failed");

    const deletedOnly = await listWith({ xeroState: "operationFailed", deleted: "only" });
    expect(deletedOnly.total).toBe(0);
  });

  it("issues no pre-filter query on the default view", async () => {
    await listWith({});

    const distinctQueries = vi
      .mocked(prisma.xeroSyncOperation.findMany)
      .mock.calls.filter(([args]) => args && "distinct" in args);
    expect(distinctQueries).toHaveLength(0);
  });
});
