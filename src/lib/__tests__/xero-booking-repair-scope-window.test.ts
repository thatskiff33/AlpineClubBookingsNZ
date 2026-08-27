/**
 * The window an operator asks the Xero booking-repair sweep for, against the
 * window it actually binds (#2868, INV-DATE-013).
 *
 * ## What was wrong
 *
 * `--from 2026-07-01 --to 2026-07-31` used to become a single local-midnight
 * `Date` pair, bound unchanged against all four columns the scope `OR` matches.
 * `Booking.checkIn` is `DateTime @db.Date`, and `@prisma/adapter-pg` narrows a
 * bound value against such a column to its UTC calendar date with the time
 * thrown away — so under the deployment's `TZ=Pacific/Auckland` pin, club
 * midnight on 1 July (`2026-06-30T12:00Z`) arrived as the DATE `2026-06-30`.
 * The sweep covered `[30 Jun, 30 Jul]`. A booking checking in on the last day
 * the operator named was outside the repair unless it happened to have been
 * created or updated inside the window.
 *
 * ## The four consumers are not one comparison
 *
 * | arm                                | column type in `prisma/schema.prisma` | bound value |
 * | ---------------------------------- | ------------------------------------- | ----------- |
 * | `Booking.checkIn`                  | `DateTime @db.Date`                   | date-only (`parseDateOnly`) |
 * | `Booking.createdAt`                | `DateTime @default(now())`            | club-day start (`startOfDateOnlyForTimeZone`) |
 * | `Booking.updatedAt`                | `DateTime @updatedAt`                 | club-day start |
 * | `BookingModification.createdAt`    | `DateTime @default(now())`            | club-day start |
 *
 * The two values differ by the club's UTC offset — twelve hours in NZST — and
 * each is wrong in the other's place. Giving the three instants a date-only
 * value would sit their boundary at club MIDDAY, which is the mistake #2838
 * avoided by deliberately keeping `startOfDateOnlyForTimeZone` for
 * `draftExpiresAt`. So this suite asserts BOTH halves; a fix that moves only
 * the date column is half a fix.
 *
 * ## Verified by binding, not by reasoning
 *
 * The real generated Prisma Client, the real query compiler and the real
 * `PrismaPg` adapter, over a `pg.Pool` whose `query` is a recorder. Nothing
 * connects: the pool's address is a port nothing listens on and no path here
 * asks it for a connection. What is asserted is the `values` array the adapter
 * hands the driver, one hop before the wire — the same technique as
 * `prisma-date-column-binding.test.ts`, and for the same reason. Modelling the
 * narrowing in a local `boundDay()` helper and asserting against the model is
 * exactly what that file exists to stop.
 *
 * ## Why the host time zone is pinned, and what each pin is worth
 *
 * The club's zone is MOCKED to `Pacific/Auckland` below and the HOST's zone is
 * moved around it, which is what makes each pin mean something.
 *
 * That separation is new (CT-5, #2869) and it matters. The window used to be
 * derived from `APP_TIME_ZONE` — `process.env.TZ || NEXT_PUBLIC_TZ ||
 * "Pacific/Auckland"` — so assigning `process.env.TZ` in a test moved the club's
 * zone as well as the host's, and the two could only be told apart because
 * `APP_TIME_ZONE` is frozen at import while `setHours` is not. It is now the
 * PERSISTED club timezone (`INV-CONFIG-002`), read through
 * `readClubTimeZoneOutsideRequest`, and mocking that one function holds the club
 * still while `withTimeZoneAsync` moves everything else.
 *
 * The fixed code has NO host-zone input left — `parseDateOnly` builds an
 * explicit `Z` instant and `startOfDateOnlyForTimeZone` takes the club zone
 * explicitly — so every pin below must produce the identical binding. That
 * invariance is the assertion. MEASURED, by restoring the defect (one shared
 * local-midnight range across all four arms) and re-running this file: 4 of its
 * 7 tests go red, and which ones depends entirely on the pin.
 *
 * | host zone pinned  | red | what it binds for a `[1 Jul, 31 Jul]` request |
 * | ----------------- | --- | --------------------------------------------- |
 * | `Pacific/Auckland` (UTC+12, the production pin) | the `checkIn` test | `checkIn` in `['2026-06-30', '2026-07-31')` — the wrong DAYS. The instants land on `2026-06-30 12:00:00`, which is right, because the host zone IS the club zone. |
 * | `America/New_York` (UTC-4) | the instants test | the instants start at `2026-07-01 04:00:00` where the club day starts at `2026-06-30 12:00:00`. `checkIn` comes out `['2026-07-01', '2026-08-01')` — correct, by accident. |
 * | `UTC` (the CI runner) | the instants test | the instants start at `2026-07-01 00:00:00`. `checkIn` again correct by accident. |
 *
 * The fourth red is the zone-independence test at the bottom, which is the only
 * one no single pin can talk its way past.
 *
 * Read that table carefully, because it is the whole reason there is more than
 * one pin. East of UTC, local midnight is the previous UTC day, so the DATE
 * narrowing is wrong and the instants coincidentally agree with the club's.
 * West of UTC — and at UTC — local midnight is the same UTC day, so the DATE
 * comes out right by accident and only the instants move. **Either pin alone
 * passes a half-fixed implementation**, and the rows above are the measurement
 * that says so rather than an argument that it should be. New York is not a
 * claim about how this is deployed; it is the pin that sees the half Auckland
 * cannot.
 */
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The club's persisted timezone, held constant while the host's moves (CT-5,
 * #2869). Without this the environment seed answers, and pinning `process.env.TZ`
 * would move the club too — which is precisely the coupling this suite exists to
 * prove has been broken.
 */
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));

import type { RepairDependencies } from "@/lib/xero-booking-repair-deps";
import { loadAuditData } from "@/lib/xero-booking-repair-load";
import { parseRepairScopeDay } from "@/lib/xero-booking-repair-utils";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

type CapturedQuery = { text: string; values: unknown[] };

const captured: CapturedQuery[] = [];

/**
 * A real `pg.Pool` — `PrismaPg` treats an argument as an external pool only when
 * it passes `instanceof pg.Pool` — with its `query` swapped for a recorder,
 * pointed at a port nothing listens on.
 */
const pool = new pg.Pool({
  connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
});
pool.query = (async (config: unknown) => {
  captured.push(config as CapturedQuery);
  return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
}) as typeof pool.query;

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** The operator's request, in the two forms this file talks about it. */
const FIRST_REQUESTED_DAY = "2026-07-01";
const LAST_REQUESTED_DAY = "2026-07-31";

/**
 * The eight window parameters of the scope statement, in the order the compiled
 * SQL uses them.
 *
 * `loadAuditData` emits several statements (the selected relations are fetched
 * separately, with an empty id list once the recorder returns no rows). The one
 * that carries the window is picked by name rather than by position, and the
 * SQL text is asserted alongside so "the leading eight" is anchored to the
 * right operands rather than to an ordering that could silently change meaning.
 */
function scopeStatement(): CapturedQuery {
  const scopeQueries = captured.filter((query) =>
    query.text.includes('FROM "public"."Booking" WHERE'),
  );
  expect(
    scopeQueries.length,
    "Expected exactly one statement carrying the scope filter. If the client " +
      "now emits more, select the one carrying the window rather than " +
      "relaxing this.",
  ).toBe(1);
  return scopeQueries[0];
}

/** Run one scope through the client under a pinned host zone and record it. */
async function bindScope(
  scope: Parameters<typeof loadAuditData>[0],
  hostTimeZone = "Pacific/Auckland",
): Promise<CapturedQuery> {
  captured.length = 0;
  await withTimeZoneAsync(hostTimeZone, async () => {
    await loadAuditData(scope, { prisma } as unknown as RepairDependencies);
  });
  return scopeStatement();
}

function windowParameters(): {
  createdAt: [unknown, unknown];
  updatedAt: [unknown, unknown];
  checkIn: [unknown, unknown];
  modificationCreatedAt: [unknown, unknown];
} {
  const { text, values } = scopeStatement();
  // Anchor each parameter index to the operand it belongs to. Without this the
  // tuple assertions below would pass just as happily if the compiler reordered
  // the OR arms and every arm silently swapped windows.
  expect(text).toContain('"public"."Booking"."createdAt" >= $1');
  expect(text).toContain('"public"."Booking"."createdAt" < $2');
  expect(text).toContain('"public"."Booking"."updatedAt" >= $3');
  expect(text).toContain('"public"."Booking"."updatedAt" < $4');
  expect(text).toContain('"public"."Booking"."checkIn" >= $5');
  expect(text).toContain('"public"."Booking"."checkIn" < $6');
  expect(text).toContain('"t0"."createdAt" >= $7');
  expect(text).toContain('"t0"."createdAt" < $8');
  expect(text).toContain('FROM "public"."BookingModification" AS "t0"');

  return {
    createdAt: [values[0], values[1]],
    updatedAt: [values[2], values[3]],
    checkIn: [values[4], values[5]],
    modificationCreatedAt: [values[6], values[7]],
  };
}

async function bindScopeWindow(hostTimeZone: string) {
  await bindScope({ from: FIRST_REQUESTED_DAY, to: LAST_REQUESTED_DAY }, hostTimeZone);
  return windowParameters();
}

/**
 * The DATE bounds the `checkIn` arm binds, as the calendar days they are.
 *
 * Comparing two `yyyy-MM-dd` strings is Postgres's own ordering of two `date`
 * values — fixed width, most significant field first — not a model of the
 * adapter. The adapter's behaviour is the thing being MEASURED here (that a
 * `@db.Date` parameter arrives as a bare day at all), never assumed.
 */
function admitsCheckInDay(bounds: [unknown, unknown], day: string): boolean {
  const [gte, lt] = bounds as [string, string];
  return day >= gte && day < lt;
}

/**
 * Whether an instant falls in an instant arm's window, given as the UTC wall
 * clock the adapter itself formats (`yyyy-MM-dd HH:mm:ss`) — the format the
 * captured bounds below are asserted to be in, so the same fixed-width
 * lexicographic order applies.
 */
function admitsInstant(bounds: [unknown, unknown], utcWallClock: string): boolean {
  const [gte, lt] = bounds as [string, string];
  return utcWallClock >= gte && utcWallClock < lt;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  // No `expectClubTimeZonePremise()` any more: that guard exists for a suite
  // whose club zone comes from `APP_TIME_ZONE`, and this one's comes from the
  // mock above. Keeping it would assert something no assertion below depends on
  // — which is how a premise guard turns into decoration (CT-5, #2869).
  captured.length = 0;
});

describe.each([
  ["Pacific/Auckland", "the production pin, UTC+12 — east of UTC"],
  ["America/New_York", "UTC-4 — west of UTC"],
  ["UTC", "the CI runner"],
])("the repair sweep's [from, to] window, host pinned to %s (%s)", (hostZone) => {
  it("sweeps exactly the club days the operator named", async () => {
    const bound = await bindScopeWindow(hostZone);

    expect(
      bound.checkIn,
      "INV-DATE-013: `Booking.checkIn` is `@db.Date`, so its bounds must be the " +
        "operator's calendar days themselves. The half-open upper bound is the " +
        "day AFTER `--to`, which is what makes `--to` an included day.",
    ).toEqual(["2026-07-01", "2026-08-01"]);

    expect(
      admitsCheckInDay(bound.checkIn, FIRST_REQUESTED_DAY),
      "a booking checking in on the FIRST day of --from/--to must be swept",
    ).toBe(true);
    expect(
      admitsCheckInDay(bound.checkIn, LAST_REQUESTED_DAY),
      "#2868: a booking checking in on the LAST day of --from/--to must be " +
        "swept. This is the assertion the defect failed — the window ended at " +
        "30 July for a sweep asked to run to the 31st.",
    ).toBe(true);
    expect(
      admitsCheckInDay(bound.checkIn, "2026-06-30"),
      "#2868: the day BEFORE --from must not be swept. The defect pulled it " +
        "in, which is the other end of the same one-day shift.",
    ).toBe(false);
    expect(
      admitsCheckInDay(bound.checkIn, "2026-08-01"),
      "the day after --to must not be swept",
    ).toBe(false);
  });

  it("bounds the three instant columns at the START of those club days, not at their UTC midnight", async () => {
    const bound = await bindScopeWindow(hostZone);

    // 1 July 2026 in New Zealand begins at 2026-06-30T12:00Z (NZST, UTC+12),
    // and 1 August begins at 2026-07-31T12:00Z. A date-only value would have
    // put both boundaries twelve hours late — club MIDDAY — and dropped every
    // booking created or edited in the first half of the first requested day.
    const clubDayStarts = ["2026-06-30 12:00:00", "2026-07-31 12:00:00"];

    expect(
      bound.createdAt,
      "INV-DATE-013: `Booking.createdAt` is a bare `DateTime` — a real instant, " +
        "not narrowed by the adapter — so it takes the instant the club day " +
        "starts, never the date-only value the `@db.Date` arm beside it takes.",
    ).toEqual(clubDayStarts);
    expect(bound.updatedAt, "`Booking.updatedAt` is the same kind of column").toEqual(
      clubDayStarts,
    );
    expect(
      bound.modificationCreatedAt,
      "`BookingModification.createdAt` is the same kind of column, and is the " +
        "fourth consumer of this one window — the issue's brief said three",
    ).toEqual(clubDayStarts);

    expect(
      admitsInstant(bound.createdAt, "2026-06-30 12:30:00"),
      "a booking created at 00:30 NZ on the first requested day must be swept",
    ).toBe(true);
    expect(
      admitsInstant(bound.createdAt, "2026-06-30 11:30:00"),
      "a booking created at 23:30 NZ on the day BEFORE must not be swept",
    ).toBe(false);
    expect(
      admitsInstant(bound.createdAt, "2026-07-31 11:30:00"),
      "a booking created at 23:30 NZ on the last requested day must be swept",
    ).toBe(true);
    expect(
      admitsInstant(bound.createdAt, "2026-07-31 12:30:00"),
      "a booking created at 00:30 NZ on the day AFTER must not be swept",
    ).toBe(false);
  });
});

/**
 * The one-sided and single-day windows (#2868).
 *
 * The two-sided case above is the one an operator runs, so it is where the
 * defect lived — but the day-AFTER upper bound is the mechanism this fix
 * introduces, and nothing above holds it when only `--to` is given. An edit
 * that dropped `nextDateOnly` from the `to`-only path would leave every
 * assertion above green while silently making `--to` an excluded day.
 */
describe("a half-open window binds only the end it was given (#2868)", () => {
  it("--from alone binds lower bounds and no upper bound at all", async () => {
    const { text, values } = await bindScope({ from: FIRST_REQUESTED_DAY });

    expect(text).toContain('"public"."Booking"."checkIn" >= $3');
    expect(
      text,
      "a `--from`-only sweep must not acquire an end date from anywhere",
    ).not.toContain('"checkIn" <');
    expect(text).not.toContain('"createdAt" <');
    // createdAt, updatedAt, checkIn, modification.createdAt — one bound each.
    expect(values.slice(0, 4)).toEqual([
      "2026-06-30 12:00:00",
      "2026-06-30 12:00:00",
      "2026-07-01",
      "2026-06-30 12:00:00",
    ]);
  });

  it("--to alone binds the DAY AFTER as an exclusive upper bound, keeping --to itself included", async () => {
    const { text, values } = await bindScope({ to: LAST_REQUESTED_DAY });

    expect(text).toContain('"public"."Booking"."checkIn" < $3');
    expect(text).not.toContain('"checkIn" >=');
    expect(text).not.toContain('"createdAt" >=');
    expect(
      values.slice(0, 4),
      "#2868: the upper bound is the start of the day AFTER `--to`. If this " +
        "reads `2026-07-31` / `2026-07-30 12:00:00`, the exclusive bound has " +
        "been built from `--to` itself and the last requested day is no longer " +
        "swept — which is the defect, re-entering by a path the two-sided " +
        "tests above cannot see.",
    ).toEqual([
      "2026-07-31 12:00:00",
      "2026-07-31 12:00:00",
      "2026-08-01",
      "2026-07-31 12:00:00",
    ]);
  });

  it("--from X --to X sweeps exactly the one club day X", async () => {
    const { values } = await bindScope({ from: "2026-07-15", to: "2026-07-15" });

    expect(values.slice(0, 8)).toEqual([
      "2026-07-14 12:00:00",
      "2026-07-15 12:00:00",
      "2026-07-14 12:00:00",
      "2026-07-15 12:00:00",
      "2026-07-15",
      "2026-07-16",
      "2026-07-14 12:00:00",
      "2026-07-15 12:00:00",
    ]);
  });
});

/**
 * The day validator the CLI's `--from`/`--to` share with the loader (#2868).
 *
 * This is a REAL change to what the CLI accepts, so it is tested directly
 * rather than only through the sweep. The CLI used to validate with the regex
 * plus `Number.isNaN(new Date(`${day}T00:00:00`).getTime())`, and a `Date`
 * built from out-of-range parts ROLLS OVER instead of failing — so three
 * impossible days were accepted and silently became different, later days. The
 * rows below are measured against Node 24, not reasoned from the spec.
 *
 * `parseArgs`'s flag-to-validator wiring in `scripts/xero-booking-repair.ts` is
 * still untested — the script runs `main()` at import, so it cannot be loaded
 * from a test — but that wiring is untouched by this change, and `parseDateInput`
 * is now a one-line delegation to the function tested here.
 */
describe("parseRepairScopeDay rejects days the old CLI check let through (#2868)", () => {
  it.each([
    { day: "2026-02-30", oldResult: "accepted, rolled to 2 March" },
    { day: "2026-04-31", oldResult: "accepted, rolled to 1 May" },
    { day: "2026-02-29", oldResult: "accepted, rolled to 1 March (2026 is not a leap year)" },
  ])("refuses $day, which the old check $oldResult", ({ day }) => {
    expect(() => parseRepairScopeDay(day, "--from")).toThrow(
      /--from must be a real calendar day/,
    );
  });

  it.each(["2026-13-01", "2026-07-32", "2026-7-1", "", "  ", "yesterday"])(
    "refuses %j, as the old check also did",
    (day) => {
      expect(() => parseRepairScopeDay(day, "--to")).toThrow(/--to must be a real calendar day/);
    },
  );

  it.each(["2026-07-01", "2024-02-29", "2026-12-31"])("accepts the real day %j", (day) => {
    expect(parseRepairScopeDay(day, "--from")).toBe(day);
  });

  it("names the flag and the value it refused, so the operator can see the typo", () => {
    expect(() => parseRepairScopeDay("2026-04-31", "--to")).toThrow(
      '--to must be a real calendar day in YYYY-MM-DD format (received "2026-04-31").',
    );
  });

  it("trims surrounding whitespace rather than refusing it", () => {
    expect(parseRepairScopeDay("  2026-07-01  ", "--from")).toBe("2026-07-01");
  });
});

/**
 * A day that is PRESENT but not a real calendar day (#2868).
 *
 * `from`/`to` are strings, so they admit shapes a `Date` could not carry, and
 * the loader used to read them through truthiness — under which `""` means "no
 * lower bound" and an `--apply`-capable sweep silently widens to all of
 * history. Neither shape is reachable from the CLI, which validates first;
 * these pin the LOADER's own behaviour, because the scope type is exported and
 * the CLI is not guaranteed to stay its only constructor.
 */
describe("the loader refuses a malformed scope day rather than widening (#2868)", () => {
  it.each([
    { label: "an empty string", day: "" },
    { label: "a rolled-over impossible day", day: "2026-02-30" },
    { label: "a non-leap 29 February", day: "2026-02-29" },
    { label: "an unpadded day", day: "2026-7-1" },
    { label: "a whole ISO instant", day: "2026-07-01T00:00:00.000Z" },
  ])("refuses $label as the start day instead of sweeping unbounded", async ({ day }) => {
    await expect(
      loadAuditData({ from: day }, { prisma } as unknown as RepairDependencies),
    ).rejects.toThrow(/start day must be a real calendar day/);
  });

  it("accepts a real leap day", async () => {
    const { values } = await bindScope({ from: "2024-02-29", to: "2024-02-29" });
    expect(values.slice(4, 6)).toEqual(["2024-02-29", "2024-03-01"]);
  });

  it("refuses an end day whose next day is not representable", async () => {
    // `9999-12-31` IS a real calendar day, so the day validator accepts it; it
    // is the exclusive upper bound that has nowhere to go. Left unguarded it
    // becomes the expanded-year string "+010000-01" and fails at Prisma with an
    // error naming neither the flag nor the day.
    await expect(
      loadAuditData({ to: "9999-12-31" }, { prisma } as unknown as RepairDependencies),
    ).rejects.toThrow(/has no representable next day/);
  });
});

describe("the bound window does not depend on the host's time zone (#2868)", () => {
  it("binds identically east of UTC, west of UTC, and at UTC", async () => {
    const auckland = await bindScopeWindow("Pacific/Auckland");
    const newYork = await bindScopeWindow("America/New_York");
    const utc = await bindScopeWindow("UTC");

    expect(
      newYork,
      "The operator names club calendar days, so nothing about the window may " +
        "come from wherever the process happens to be pinned. A difference here " +
        "means a host-zone input has come back into the derivation — which is " +
        "what `setHours(0, 0, 0, 0)` was.",
    ).toEqual(auckland);
    expect(utc).toEqual(auckland);
  });
});
