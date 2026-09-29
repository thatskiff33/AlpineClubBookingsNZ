import { afterEach, describe, expect, it } from "vitest";
import {
  INDUCTION_KIND_LABELS,
  INDUCTION_STATUS_LABELS,
  formatInductionDate,
} from "@/lib/induction-display";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  CLUB_FORMAT_TEST,
  CLUB_FORMAT_TEST_OTHER,
} from "@/lib/__tests__/support/club-format-fixture";

// #2256: formatInductionDate passed "en-NZ" but no `timeZone`, so an induction
// sign-off rendered in the *runtime's* zone — the viewer's browser on
// /induction and /admin/induction/[id], the server's on the print page. The
// sign-off date is the human-readable part of a competency record, so it must
// read the same for the hut leader who signed it and the admin who prints it.
//
// #3566: the formatter was frozen at import to `APP_LOCALE` and `APP_TIME_ZONE`
// — the build's locale and the container's zone, never the club's. It now takes
// the caller's `BoundClubTime` (both callers pass `useClubTime()`), so the zone
// AND the locale are the club's persisted ones. The zone below is deliberately
// the club's, handed in; nothing reads the environment's any more.
const AUCKLAND = bindClubTime(
  requireClubTimeZone("Pacific/Auckland"),
  CLUB_FORMAT_TEST,
);

describe("formatInductionDate (#2256)", () => {
  // 2026-04-15T23:30:00Z is 2026-04-16 11:30 in Pacific/Auckland: the NZ
  // calendar date and the UTC one disagree at this instant.
  const INSTANT = "2026-04-15T23:30:00.000Z";
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    // A bare `delete process.env.TZ` does not invalidate Node's cached zone
    // (#2485); `hostTimeZone.restore()` assigns the real host zone back
    // first, so it can't leak into a later test in this worker.
    hostTimeZone.restore();
  });

  it("renders the NZ calendar date in the induction record's long format", () => {
    expect(formatInductionDate(INSTANT, AUCKLAND)).toBe("16 April 2026");
  });

  it("ignores the runtime's own time zone on both sides of the NZ date", () => {
    // UTC is still on 15 April at this instant and Kiritimati is already two
    // hours into 16 April — no ambient-zone formatter answers "16 April 2026"
    // to all three.
    process.env.TZ = "UTC";
    expect(formatInductionDate(INSTANT, AUCKLAND)).toBe("16 April 2026");
    process.env.TZ = "America/New_York";
    expect(formatInductionDate(INSTANT, AUCKLAND)).toBe("16 April 2026");
    process.env.TZ = "Pacific/Kiritimati";
    expect(formatInductionDate(INSTANT, AUCKLAND)).toBe("16 April 2026");
  });

  it("renders a date-only induction date as that same calendar day", () => {
    expect(formatInductionDate("2026-04-16", AUCKLAND)).toBe("16 April 2026");
  });

  it("returns null for a missing date and never throws on a bad one", () => {
    expect(formatInductionDate(null, AUCKLAND)).toBeNull();
    expect(formatInductionDate("", AUCKLAND)).toBeNull();
    // Intl.DateTimeFormat throws RangeError on an invalid Date; the callers
    // render this straight into JSX, so degrade instead of crashing the page.
    expect(formatInductionDate("not-a-date", AUCKLAND)).toBeNull();
  });

  it("follows the club's zone and locale, which the environment no longer supplies (#3566)", () => {
    // A club west of Greenwich reads the same sign-off on the PREVIOUS day...
    const denver = bindClubTime(
      requireClubTimeZone("America/Denver"),
      CLUB_FORMAT_TEST,
    );
    expect(formatInductionDate(INSTANT, denver)).toBe("15 April 2026");
    // ...and a de-CH club reads it in German, the same long shape.
    const zurichWords = bindClubTime(
      requireClubTimeZone("Pacific/Auckland"),
      CLUB_FORMAT_TEST_OTHER,
    );
    expect(formatInductionDate(INSTANT, zurichWords)).toBe("16. April 2026");
  });
});

describe("induction label maps", () => {
  it("keeps the labels the induction screens render", () => {
    expect(INDUCTION_STATUS_LABELS.IN_PROGRESS).toBe("In progress");
    expect(INDUCTION_KIND_LABELS.HUT_LEADER).toBe("Hut Leader Induction");
  });
});
