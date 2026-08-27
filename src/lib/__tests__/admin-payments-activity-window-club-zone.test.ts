/**
 * Whose civil day closes the payments activity window (CT-4, #2870;
 * `INV-CONFIG-002`).
 *
 * ## What was wrong, and why it was invisible
 *
 * `admin/payments/page.tsx` seeds its default "last updated" range from
 * `clubTime.today()` — the club's PERSISTED timezone. The two functions that
 * turn those two `yyyy-MM-dd` box values into instants closed the window at
 * midnight and 23:59:59.999 in `APP_TIME_ZONE`, which is the deployment's `TZ`
 * seed and NOT the club's setting.
 *
 * For a club six hours behind an Auckland-defaulted build, every payment updated
 * after about 06:00 club time fell out of the officer's DEFAULT view while the
 * date box still read the correct date — an invisible truncation of roughly
 * eighteen hours, with nothing on the screen to suggest rows were missing. Both
 * bounds were affected, so a `from` bound admitted rows from the previous club
 * day in the other direction.
 *
 * ## How this suite can see it, on every host
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`,
 * so a contributor or CI image running with `TZ=America/Denver` would make the
 * "wrong" zone and the "right" zone the same zone and every assertion below
 * would pass whether or not the fix were present. The config module is therefore
 * MOCKED to a literal `Pacific/Auckland`: the rival is then pinned rather than
 * inherited, and the club's persisted `America/Denver` diverges from it on any
 * machine.
 *
 * That is the trade the club-zone chooser's docblock describes — pinning the
 * rival cannot notice that a genuine behind-UTC *deployment* breaks, but the
 * graph here is a service rather than a rendered component, so the mock touches
 * nothing else. `chooseDivergentClubZone` is the right tool where a component
 * renders; this is the right tool here.
 *
 * ## The observable
 *
 * `total` — the count of rows that survived the in-memory activity filter. Each
 * fixture payment is placed so that the two candidate zones disagree about
 * whether it is inside the window, and the assertions name which payment is
 * being kept or dropped and why.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  xeroSyncOperationFindMany: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.paymentFindMany },
    xeroSyncOperation: { findMany: mocks.xeroSyncOperationFindMany },
    xeroObjectLink: { findMany: mocks.xeroObjectLinkFindMany },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  adminPaymentsQuerySchema,
  listAdminPayments,
} from "@/lib/admin-payments-service";

/** The club's own setting, six hours behind the pinned environment. */
const CLUB_ZONE = "America/Denver";
/** What `APP_TIME_ZONE` is pinned to above — the wrong answer, made a literal. */
const ENVIRONMENT_ZONE = "Pacific/Auckland";

/**
 * 20:00 UTC on 15 April 2026.
 *
 * - In the CLUB's zone that is 14:00 on the 15th, so a `lastUpdatedTo=2026-04-15`
 *   window must KEEP it.
 * - In the pinned environment's zone it is 08:00 on the 16th, so an
 *   environment-closed window DROPS it. That row is the eighteen hours an
 *   officer could not see.
 */
const AFTERNOON_CLUB_TIME = new Date("2026-04-15T20:00:00.000Z");

/**
 * 02:00 UTC on 16 April 2026.
 *
 * - In the CLUB's zone that is still 20:00 on the 15th, so a
 *   `lastUpdatedFrom=2026-04-16` window must DROP it.
 * - In the environment's zone it is 14:00 on the 16th, so an
 *   environment-opened window KEEPS it — a row from the wrong club day.
 */
const PREVIOUS_CLUB_EVENING = new Date("2026-04-16T02:00:00.000Z");

function buildCandidate(id: string, updatedAt: Date) {
  return {
    id,
    bookingId: `booking-${id}`,
    amountCents: 1_000,
    source: "STRIPE",
    reference: null,
    status: "SUCCEEDED",
    stripePaymentIntentId: null,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    refundedAmountCents: 0,
    updatedAt,
    transactions: [],
    refunds: [],
    booking: {
      id: `booking-${id}`,
      status: "CONFIRMED",
      checkIn: new Date("2026-04-10T00:00:00.000Z"),
      checkOut: new Date("2026-04-12T00:00:00.000Z"),
      creditsFromCancellation: [],
      member: {
        id: "member-1",
        firstName: "Ada",
        lastName: "Member",
        email: "ada@example.com",
      },
    },
  };
}

/** The civil day an instant falls on in a zone — an independent `Intl` oracle. */
function civilDayIn(zone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

type Candidate = ReturnType<typeof buildCandidate>;

/**
 * The rows the database holds, answered CONTENT-ADDRESSABLY rather than in call
 * order.
 *
 * `listAdminPayments` queries `payment.findMany` twice — once for the candidate
 * set and once for the page's full rows, keyed by id — and the second call only
 * happens when the first survived the activity filter. A pair of
 * `mockResolvedValueOnce`s therefore leaves an unconsumed value queued whenever
 * a test expects the window to drop everything, and that value is handed to the
 * NEXT test as its candidate set. Measured while writing this file: it made the
 * lower-bound test pass against an empty list, proving nothing, and failed the
 * one after it. One implementation that reads the `where` cannot drift that way.
 */
function givenPayments(rows: Candidate[]) {
  mocks.paymentFindMany.mockImplementation(
    async (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      return ids === undefined ? rows : rows.filter((row) => ids.includes(row.id));
    },
  );
}

async function runQuery(params: Record<string, string>) {
  const query = adminPaymentsQuerySchema.parse(params);
  const result = await listAdminPayments(query);
  return result.body as { total: number; data: Array<{ id: string }> };
}

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: the latter keeps queued implementations
  // and so leaks them between tests — see `givenPayments` above.
  vi.resetAllMocks();
  givenPayments([]);
  mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);
  // The club HAS chosen a zone, so `readClubTimeZoneOutsideRequest` resolves the
  // persisted value rather than any fallback. The real reader runs; only the row
  // is a fake.
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({ timeZone: CLUB_ZONE });
});

describe("the fixtures really do split the two zones", () => {
  it("places each payment on a different civil day in each zone", () => {
    // Without this the assertions below could pass against a tree that ignored
    // both zones. Stated as its own test so a change in ICU or in a fixture
    // instant fails here with a legible message rather than as a count mismatch.
    expect(civilDayIn(CLUB_ZONE, AFTERNOON_CLUB_TIME)).toBe("2026-04-15");
    expect(civilDayIn(ENVIRONMENT_ZONE, AFTERNOON_CLUB_TIME)).toBe("2026-04-16");
    expect(civilDayIn(CLUB_ZONE, PREVIOUS_CLUB_EVENING)).toBe("2026-04-15");
    expect(civilDayIn(ENVIRONMENT_ZONE, PREVIOUS_CLUB_EVENING)).toBe(
      "2026-04-16",
    );
  });
});

describe("the activity window closes on the club's PERSISTED day", () => {
  it("keeps a payment updated late on the club's day, which the environment's day had already dropped", async () => {
    givenPayments([buildCandidate("late-club-afternoon", AFTERNOON_CLUB_TIME)]);

    const body = await runQuery({ lastUpdatedTo: "2026-04-15" });

    expect(
      body.total,
      "INV-CONFIG-002: 20:00 UTC is 14:00 on 15 April in the club's zone and " +
        "08:00 on the 16th in the environment's. Closing the window with " +
        "APP_TIME_ZONE drops this row from the officer's default view while the " +
        "date box still reads 15 April.",
    ).toBe(1);
    expect(body.data.map((payment) => payment.id)).toEqual([
      "late-club-afternoon",
    ]);
  });

  it("still drops a payment genuinely past the club's end of day", async () => {
    // The bound is a real bound, not an absence of filtering: 08:00 UTC on the
    // 17th is 02:00 on the 17th in the club's zone, past the inclusive end of
    // the 15th under either zone.
    givenPayments([
      buildCandidate("two-club-days-later", new Date("2026-04-17T08:00:00.000Z")),
    ]);

    const body = await runQuery({ lastUpdatedTo: "2026-04-15" });

    expect(body.total).toBe(0);
  });

  it("opens the window on the club's day too, not a club evening early", async () => {
    // The LOWER bound, which fails in the opposite direction: an
    // environment-opened window would admit a row that is still the previous
    // day for the club.
    givenPayments([
      buildCandidate("still-previous-club-evening", PREVIOUS_CLUB_EVENING),
    ]);

    const body = await runQuery({ lastUpdatedFrom: "2026-04-16" });

    expect(
      body.total,
      "INV-CONFIG-002: 02:00 UTC on 16 April is still 20:00 on the 15th in the " +
        "club's zone, so a window opening on 16 April must not contain it. " +
        "Opening on APP_TIME_ZONE's day admits it.",
    ).toBe(0);
  });

  it("reads the zone once per request, not once per row", async () => {
    // Three rows, one settings read. The reader is a database query, so a
    // per-row read would put one inside a filter callback.
    givenPayments([
      buildCandidate("a", AFTERNOON_CLUB_TIME),
      buildCandidate("b", AFTERNOON_CLUB_TIME),
      buildCandidate("c", AFTERNOON_CLUB_TIME),
    ]);

    await runQuery({ lastUpdatedTo: "2026-04-15" });

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledTimes(1);
  });

  it("does not read the zone at all when no activity bound is in play", async () => {
    await runQuery({ status: "SUCCEEDED" });

    expect(mocks.clubTimeSettingsFindUnique).not.toHaveBeenCalled();
  });

  it("uses the same club day for the legacy from/to spelling", async () => {
    // `from`/`to` are the older query parameters the activity window falls back
    // to, and they reach the same two bounds. A fix applied only to
    // `lastUpdated*` would leave a live caller on the environment's day.
    givenPayments([buildCandidate("legacy-spelling", AFTERNOON_CLUB_TIME)]);

    const body = await runQuery({ to: "2026-04-15" });

    expect(body.total).toBe(1);
  });
});
