// #4002 — stayWindow() never hands a spec a night a seeded booking already holds.
//
// WHY THIS EXISTS. stayWindow() used to reserve only the Monday-aligned fixtures'
// check-ins (IB, waitlist). Every other seeded booking window is offset by DAYS,
// so it slides one weekday per run date while a stayWindow Monday holds for a
// week. On two run dates in every seven, `rosterEdit` — a PAID booking with
// Alice on it — sat on stayWindow(15)'s nights, and
// e2e/guest-promo-code-chips.spec.ts stalled at the guests step on Alice's
// member-night conflict. It passed on 2026-10-08 and failed on 2026-10-09 with
// the same tree.
//
// The fixture dates are fixed when `prisma/e2e-fixtures.ts` is imported, from
// `E2E_FIXTURE_TODAY_NZ`, so each run date below re-imports both modules
// under a stubbed value.
//
// Lives under src/ because vitest.config.mts excludes `e2e/**` from collection.
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../../prisma/e2e-fixtures";

// The highest stayWindow index any spec reaches (base 28, attempt 2, stride 16 —
// see e2e/locked-out-pickup-and-pay.spec.ts and RETRY_WINDOW_STRIDE).
const HIGHEST_INDEX_IN_USE = 60;
// The pattern repeats weekly; 120 days also crosses month ends and the
// winter/summer season edge for the higher indexes.
const RUN_DATES = 120;
const FIRST_RUN_DATE = "2026-07-01";

type Modules = {
  helpers: typeof import("../../../e2e/helpers/stay-dates");
  fixtures: typeof import("../../../prisma/e2e-fixtures");
};

async function importForRunDate(runDate: string): Promise<Modules> {
  vi.resetModules();
  vi.stubEnv("E2E_FIXTURE_TODAY_NZ", runDate);
  const [helpers, runFixtures] = await Promise.all([
    import("../../../e2e/helpers/stay-dates"),
    import("../../../prisma/e2e-fixtures"),
  ]);
  return { helpers, fixtures: runFixtures };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("#4002 stay windows are clear of every seeded booking night", () => {
  it("SEEDED_BOOKING_WINDOWS lists every exported seeded window", () => {
    const listed = new Set<unknown>(fixtures.SEEDED_BOOKING_WINDOWS);
    const missing = [
      ...Object.entries(fixtures)
        .filter(([name]) => name.endsWith("_WINDOW"))
        .filter(([, window]) => !listed.has(window))
        .map(([name]) => name),
      ...Object.entries(fixtures.DEMO_BOOKING_WINDOWS)
        .filter(([, window]) => !listed.has(window))
        .map(([name]) => `DEMO_BOOKING_WINDOWS.${name}`),
    ];
    expect(
      missing,
      "prisma/e2e-fixtures.ts: add these to SEEDED_BOOKING_WINDOWS so " +
        "stayWindow() reserves their nights",
    ).toEqual([]);
  });

  it(
    `every index up to ${HIGHEST_INDEX_IN_USE} is in season, distinct and ` +
      `clear of seeded nights on ${RUN_DATES} consecutive run dates`,
    async () => {
      const problems: string[] = [];
      for (let day = 0; day < RUN_DATES; day += 1) {
        const runDate = fixtures.shiftDateOnly(FIRST_RUN_DATE, day);
        const { helpers, fixtures: run } = await importForRunDate(runDate);
        expect(run.E2E_TODAY_NZ).toBe(runDate);

        const seededNights = new Set(
          run.SEEDED_BOOKING_WINDOWS.flatMap((window) => window.nights),
        );
        const checkIns = new Set<string>();
        for (let index = 0; index <= HIGHEST_INDEX_IN_USE; index += 1) {
          const window = helpers.stayWindow(index);
          helpers.seasonForWindow(window); // throws if out of season
          if (checkIns.has(window.checkIn)) {
            problems.push(`${runDate} stayWindow(${index}) repeats ${window.checkIn}`);
          }
          checkIns.add(window.checkIn);
          const held = window.nights.filter((night) => seededNights.has(night));
          if (held.length > 0) {
            problems.push(
              `${runDate} stayWindow(${index}) holds seeded night(s) ${held.join(", ")}`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    },
    120_000,
  );

  it("the failing run date: stayWindow(15) no longer lands on rosterEdit", async () => {
    const { helpers, fixtures: run } = await importForRunDate("2026-10-09");
    expect(run.DEMO_BOOKING_WINDOWS.rosterEdit.nights).toEqual(["2027-03-08"]);
    const window = helpers.stayWindow(15);
    expect(window.nights).not.toContain("2027-03-08");
    expect(window.nights).not.toContain("2027-03-09"); // rosterTurnover
  });
});
