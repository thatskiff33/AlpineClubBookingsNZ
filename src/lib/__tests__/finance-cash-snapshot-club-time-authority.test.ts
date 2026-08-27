import { describe, expect, it, vi } from "vitest";

/**
 * #3123 — the cash-balance KPI dates two DIFFERENT kinds of value, and they take
 * opposite answers.
 *
 * `FinanceSnapshot.asOfDate`, `.periodStart` and `.periodEnd` are `@db.Date`
 * CALENDAR DAYS: UTC-midnight encodings that name the same day in every zone on
 * earth, so they take no zone at all (`INV-DATE-019`). `.sourceUpdatedAt` has no
 * `@db.Date` — it is a real INSTANT, with no civil date until a zone is chosen,
 * and the only right chooser is the club's persisted one (`INV-CONFIG-002`).
 *
 * Before #3123 all six labels went through `formatNZDate`/`formatNZDateTime` and
 * so through `APP_TIME_ZONE`, which for a club west of Greenwich dated the
 * club's bank balance a day early on the screen a finance manager reads a cash
 * figure off. Sweeping all six onto the club's zone would have fixed one and
 * broken five, so this file pins BOTH halves: the instant follows the club's
 * zone, and the five calendar days are byte-identical no matter what that zone
 * is.
 *
 * ## How it discriminates
 *
 * `APP_TIME_ZONE` is pinned to `America/Denver` — behind Greenwich, the side on
 * which the defect is visible — and the club's zone is supplied as a binding,
 * varied per case. Deliberately never `Pacific/Auckland` on both dials at once:
 * that is what `APP_TIME_ZONE` falls back to, so a test agreeing with it could
 * not tell the club's configured zone from the container's (#3123 execution
 * contract). This module formats SUPPLIED values rather than "now", so the
 * frozen clock is not involved and no `vi.setSystemTime` pin is needed.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import {
  parseCashSnapshot,
  type FinanceCashSnapshotRecord,
} from "@/lib/finance-cash-snapshot";

const ENVIRONMENT_ZONE = "America/Denver";
const AUCKLAND = bindClubTime(requireClubTimeZone("Pacific/Auckland"));
const KIRITIMATI = bindClubTime(requireClubTimeZone("Pacific/Kiritimati"));
const PAGO = bindClubTime(requireClubTimeZone("Pacific/Pago_Pago"));

/**
 * A stored `@db.Date`, spelled the way Prisma hands one back: UTC midnight.
 * Read in Denver every one of these is the PREVIOUS day, which is the whole
 * defect.
 */
const AS_OF = new Date("2026-06-30T00:00:00.000Z");
const PERIOD_START = new Date("2026-06-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-06-30T00:00:00.000Z");

/**
 * A real timestamp. 02:00 UTC on 1 July is 1 July 14:00 in Auckland and 30 June
 * 20:00 in Denver, so the two zones never agree about its day.
 */
const SOURCE_UPDATED_AT = new Date("2026-07-01T02:00:00.000Z");

function snapshot(
  overrides: Partial<FinanceCashSnapshotRecord> = {},
): FinanceCashSnapshotRecord {
  return {
    id: "snapshot-1",
    asOfDate: AS_OF,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    payload: {
      reportDate: "2026-06-30",
      reportTitles: ["Bank Balances"],
      fields: [],
      rows: [
        {
          rowType: "Row",
          title: "Cheque account",
          cells: [{ value: "Cheque account" }, { value: "1,234.56" }],
          rows: [],
        },
        {
          rowType: "SummaryRow",
          title: "Total",
          cells: [{ value: "Total" }, { value: "1,234.56" }],
          rows: [],
        },
      ],
    },
    ...overrides,
  };
}

describe("the cash snapshot's dates (#3123)", () => {
  it("PREMISE: the environment and the club disagree about both kinds of value", () => {
    // Without this leg every case below passes just as well when the two zones
    // agree, which is the false green #3123's contract names.
    const day = (zone: string, value: Date) =>
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        dateStyle: "medium",
      }).format(value);
    expect(day(ENVIRONMENT_ZONE, AS_OF)).toBe("29 Jun 2026");
    expect(day("Pacific/Auckland", AS_OF)).toBe("30 Jun 2026");
    expect(day(ENVIRONMENT_ZONE, SOURCE_UPDATED_AT)).toBe("30 Jun 2026");
    expect(day("Pacific/Auckland", SOURCE_UPDATED_AT)).toBe("1 Jul 2026");
  });

  it("dates the stored @db.Date columns with NO zone at all", () => {
    // BEFORE the migration these read "29 Jun 2026" / "31 May 2026 to 29 Jun
    // 2026" — the day before, on a bank balance — because APP_TIME_ZONE is
    // behind Greenwich.
    const parsed = parseCashSnapshot(AUCKLAND, snapshot());
    expect(parsed?.snapshotLabel).toBe("30 Jun 2026");
    expect(parsed?.sourceWindow).toBe("1 Jun 2026 to 30 Jun 2026");
  });

  it("keeps those calendar days IDENTICAL under a different club zone", () => {
    /*
      THE ASSERTION THAT STOPS A FUTURE SWEEP. Exactly half of #3123's
      `nzst-date` sites are calendar days, and putting them on the club's zone
      would be a new defect rather than a fix — the mistake #3113 was filed to
      correct. A money figure's as-of day must not move when the club moves.
    */
    const base = parseCashSnapshot(AUCKLAND, snapshot());
    for (const club of [KIRITIMATI, PAGO]) {
      const other = parseCashSnapshot(club, snapshot());
      expect(other?.snapshotLabel).toBe(base?.snapshotLabel);
      expect(other?.sourceWindow).toBe(base?.sourceWindow);
    }
    expect(base?.snapshotLabel).toBe("30 Jun 2026");
  });

  it("dates the sourceUpdatedAt INSTANT in the club's zone", () => {
    // BEFORE the migration this read "30 Jun 2026, 8:00 pm" (APP_TIME_ZONE).
    const parsed = parseCashSnapshot(AUCKLAND, snapshot());
    expect(parsed?.sourceUpdatedAtLabel).toContain("1 Jul 2026");
    expect(parsed?.sourceUpdatedAtLabel).not.toContain("30 Jun 2026");
  });

  it("moves that instant with the club's zone — kills a hard-coded one", () => {
    // The leg a literal `Pacific/Auckland` cannot pass.
    const ahead = parseCashSnapshot(KIRITIMATI, snapshot());
    const behind = parseCashSnapshot(PAGO, snapshot());
    expect(ahead?.sourceUpdatedAtLabel).toContain("1 Jul 2026");
    expect(behind?.sourceUpdatedAtLabel).toContain("30 Jun 2026");
  });

  it("refuses a real timestamp wired into a calendar-day column", () => {
    /*
      `requireStoredCalendarDay` is what makes a mis-wired value fail loudly.
      Flooring a moment to its UTC day is the `INV-DATE-019` defect and is
      silently RIGHT for a club east of Greenwich — the hardest kind of wrong to
      notice, which is why this throws rather than answering.
    */
    expect(() =>
      parseCashSnapshot(AUCKLAND, snapshot({ asOfDate: SOURCE_UPDATED_AT })),
    ).toThrow(/stored calendar day/);
  });

  it("still says the update time is unavailable when there is none", () => {
    const parsed = parseCashSnapshot(
      AUCKLAND,
      snapshot({ sourceUpdatedAt: null }),
    );
    expect(parsed?.sourceUpdatedAtLabel).toBe("Snapshot update time unavailable");
  });

  it("reports the partial windows the same way, with no zone", () => {
    expect(
      parseCashSnapshot(PAGO, snapshot({ periodStart: null }))?.sourceWindow,
    ).toBe("Through 30 Jun 2026");
    expect(
      parseCashSnapshot(PAGO, snapshot({ periodEnd: null }))?.sourceWindow,
    ).toBe("From 1 Jun 2026");
    expect(
      parseCashSnapshot(
        PAGO,
        snapshot({ periodStart: null, periodEnd: null }),
      )?.sourceWindow,
    ).toBe("Snapshot period not recorded");
  });
});
