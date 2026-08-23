import { describe, expect, it } from "vitest";
import {
  getFinanceMonthKeyForDate,
  getFinanceReportWindow,
  parseOptionalDateOnly,
  toOptionalDate,
  toOptionalDateOnlyText,
  toOptionalReportDateText,
} from "@/lib/finance-sync-xero-datasets/date-format";
import { requireClubTimeZone } from "@/lib/club-time";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// #2105 (from #2110 review): parseOptionalDateOnly must be Date-aware like its
// siblings. xero-node coerces `/Date(...)/` invoice date fields to JS Dates at
// runtime; before the fix a Date silently parsed to null, dropping the due date
// from the aging-bucket / days-overdue computation.
describe("parseOptionalDateOnly Date-awareness (#2105)", () => {
  it("returns null for empty inputs", () => {
    expect(parseOptionalDateOnly(null)).toBeNull();
    expect(parseOptionalDateOnly(undefined)).toBeNull();
    expect(parseOptionalDateOnly("")).toBeNull();
  });

  it("parses a date-only string", () => {
    expect(iso(parseOptionalDateOnly("2026-04-10"))).toBe("2026-04-10");
  });

  it("returns null for an unparseable string", () => {
    expect(parseOptionalDateOnly("not-a-date")).toBeNull();
  });

  it("normalizes a Date object to a date-only Date (was previously null)", () => {
    const result = parseOptionalDateOnly(new Date("2026-04-10T00:00:00.000Z"));
    expect(result).not.toBeNull();
    expect(iso(result)).toBe("2026-04-10");
  });

  it("treats an invalid Date object as unset rather than crashing", () => {
    expect(parseOptionalDateOnly(new Date(Number.NaN))).toBeNull();
  });
});

/** One zone behind UTC, one ahead, and UTC itself. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

/**
 * The four shapes Xero can send for one date-only field, all naming 10 April
 * 2026. `/Date(1775779200000+0000)/` is that day's UTC midnight in epoch
 * milliseconds — the classic Accounting API's encoding of a date-only value.
 */
const TENTH_OF_APRIL: ReadonlyArray<readonly [string, unknown]> = [
  ["a plain calendar date", "2026-04-10"],
  ["an offset-less date-time", "2026-04-10T00:00:00"],
  ["an offset-bearing instant", "2026-04-10T00:00:00Z"],
  ["a Microsoft-JSON string", "/Date(1775779200000+0000)/"],
  ["a Date the SDK already built", new Date("2026-04-10T00:00:00.000Z")],
];

/**
 * CT-5 (#2869). These datasets are read by other tools long after the sync ran,
 * so a serialised value has to SAY which kind it is: a date-only column is
 * exactly ten characters and an instant column is a full ISO instant. The old
 * text helper passed a provider string through verbatim, so the same column read
 * `"2026-04-10"` on one deployment and `"2026-04-10T00:00:00"` on another purely
 * by which Xero response shape had answered.
 */
describe("a date-only dataset column (#2869)", () => {
  it.each(TENTH_OF_APRIL)(
    "is exactly ten characters from %s, on every host zone",
    (label, value) => {
      for (const hostZone of HOST_ZONES) {
        withTimeZone(hostZone, () => {
          expect(toOptionalDateOnlyText(value), `${label} on ${hostZone}`).toBe(
            "2026-04-10",
          );
        });
      }
    },
  );

  it.each(TENTH_OF_APRIL)(
    "reaches the aging arithmetic as the same day from %s, on every host zone",
    (label, value) => {
      for (const hostZone of HOST_ZONES) {
        withTimeZone(hostZone, () => {
          expect(
            parseOptionalDateOnly(value as never)?.toISOString(),
            `${label} on ${hostZone}`,
          ).toBe("2026-04-10T00:00:00.000Z");
        });
      }
    },
  );

  // The hole #2105 closed for the `Date` shape and #2869 closed for this one:
  // an offset-less date-time is not `YYYY-MM-DD`, so the strict parser returned
  // null and the due date silently dropped out of the aging buckets.
  it("no longer drops an offset-less due date out of the aging buckets", () => {
    expect(parseOptionalDateOnly("2026-04-10T00:00:00")).not.toBeNull();
  });

  it("refuses a value it cannot read as a real day rather than passing prose through", () => {
    expect(toOptionalDateOnlyText("not-a-date")).toBeNull();
    expect(toOptionalDateOnlyText("2026-02-30")).toBeNull();
    expect(toOptionalDateOnlyText(null)).toBeNull();
  });
});

describe("an instant dataset column (#2869)", () => {
  it("reads an offset-less UTC-named timestamp as UTC, not as the host's clock", () => {
    for (const hostZone of HOST_ZONES) {
      withTimeZone(hostZone, () => {
        expect(
          toOptionalDate("2026-04-10T20:12:34")?.toISOString(),
          hostZone,
        ).toBe("2026-04-10T20:12:34.000Z");
      });
    }
  });

  it("keeps an exact instant exactly", () => {
    expect(toOptionalDate("2026-04-10T20:12:34.567Z")?.toISOString()).toBe(
      "2026-04-10T20:12:34.567Z",
    );
  });
});

describe("the finance report window (#2869)", () => {
  const CLUB = requireClubTimeZone("Pacific/Auckland");
  const CLUB_BEHIND_UTC = requireClubTimeZone("America/Denver");

  // A sync that starts at 00:30 UTC is already the 16th in Auckland and still
  // the 15th in Denver, so the club's zone decides — never the container's.
  const startedAt = new Date("2026-04-16T00:30:00.000Z");

  it("dates the snapshot by the club's calendar, on every host zone", () => {
    for (const hostZone of HOST_ZONES) {
      withTimeZone(hostZone, () => {
        expect(getFinanceReportWindow(startedAt, CLUB).asOfDateString, hostZone).toBe(
          "2026-04-16",
        );
        expect(
          getFinanceReportWindow(startedAt, CLUB_BEHIND_UTC).asOfDateString,
          hostZone,
        ).toBe("2026-04-15");
      });
    }
  });

  it("keys the monthly facts by the club's month", () => {
    expect(getFinanceMonthKeyForDate(startedAt, CLUB)).toBe("2026-04");
    expect(
      getFinanceMonthKeyForDate(new Date("2026-05-01T00:30:00.000Z"), CLUB_BEHIND_UTC),
    ).toBe("2026-04");
  });
});

describe("a report's own date field (#2869)", () => {
  /*
    `Report.reportDate` is a LABEL as often as it is a date — Xero renders
    "30 September 2020" on a balance sheet, and `readPnlPeriodLabel` uses it as
    the last-resort period caption. So it cannot simply go through the date-only
    reader, which would answer `null` and delete the caption.

    But it was passed through VERBATIM, which broke this module's other rule for
    the case where Xero DOES send a temporal shape: an offset-less
    "2019-03-11T00:00:00" was persisted as a timestamp-looking string in a field
    a consumer has to guess about.
  */
  it("canonicalises a temporal value to ten characters", () => {
    expect(toOptionalReportDateText("2019-03-11")).toBe("2019-03-11");
    expect(toOptionalReportDateText("2019-03-11T00:00:00")).toBe("2019-03-11");
    expect(toOptionalReportDateText("2019-03-11T13:45:00Z")).toBe("2019-03-11");
    expect(toOptionalReportDateText(new Date("2019-03-11T00:00:00.000Z"))).toBe(
      "2019-03-11",
    );
  });

  it("keeps a human label exactly as Xero wrote it", () => {
    expect(toOptionalReportDateText("30 September 2020")).toBe("30 September 2020");
    expect(toOptionalReportDateText("")).toBeNull();
    expect(toOptionalReportDateText(null)).toBeNull();
  });

  it("reads the same on every host zone", () => {
    for (const hostZone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
      withTimeZone(hostZone, () => {
        expect(toOptionalReportDateText("2019-03-11T00:00:00"), hostZone).toBe(
          "2019-03-11",
        );
      });
    }
  });
});
