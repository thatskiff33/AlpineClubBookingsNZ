import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";
import {
  DATE_ONLY_COLUMN_FIELDS,
  DATE_ONLY_IN_DATETIME_COLUMN,
} from "@/lib/__tests__/support/date-only-reviewed-fields";
import {
  formatMergeFieldValue,
  mergeFieldValueKind,
  MERGE_FIELD_VALUE_KINDS,
  type MergeFieldValueKind,
} from "@/lib/member-merge-field-kinds";
import {
  mergeMemberFields,
  UNCONDITIONALLY_MERGED_FIELDS,
} from "@/lib/member-merge";

/**
 * The member-merge comparison screen dates each value by what the field MEANS,
 * not by what its runtime type is (#2860, INV-DATE-019 / INV-DATE-010).
 *
 * The screen is the last thing a Full Admin reads before an IRREVERSIBLE merge,
 * and it exists so a human can judge which of two records should survive. It
 * used to truncate every date-shaped value to its UTC day, so `photoUpdatedAt`
 * and `hutLeaderEligibleAt` — real instants — read as the PREVIOUS day for
 * roughly the first half of every New Zealand day. `photoUpdatedAt` is a recency
 * signal by construction, so the wrong day landed exactly where the decision is
 * made.
 *
 * The fix is not "swap the helper". The two kinds need OPPOSITE operations:
 *
 * - an instant must be read on the club's calendar (`formatDateOnlyForTimeZone`);
 * - a calendar day is already pinned at UTC midnight and must be TRUNCATED
 *   (`formatDateOnly`) — routing it through the club-zone formatter agrees in
 *   New Zealand, which is why an NZ-only assertion cannot catch it, and is a day
 *   wrong for a club sitting behind UTC.
 *
 * Both halves are proved below, and the discrimination is verified by calling
 * the formatters with EXPLICIT zones rather than by setting `TZ`: `TZ` also
 * moves `APP_TIME_ZONE` (docs/TESTING.md rule 6), so a suite that sets it goes
 * red on the premise guard and proves nothing about the instants themselves.
 *
 * The instants are chosen so a wrong zone FAILS them. A comfortable mid-morning
 * instant passes under any zone from roughly UTC+10 up and pins nothing, so each
 * case is either the first instant of a club day or 00:30 NZDT, and each carries
 * a companion one millisecond EARLIER whose club day is the previous one. The
 * pair brackets the offset from both sides: a shallower zone gets the first
 * instant wrong, a deeper zone gets the companion wrong.
 */

const CLUB_DAY_CASES = [
  {
    label: "NZST (UTC+12), the first instant of a club day",
    instant: new Date("2026-06-14T12:00:00.000Z"),
    utcDay: "2026-06-14",
    clubDay: "2026-06-15",
    // One millisecond before the club day starts.
    justBefore: new Date("2026-06-14T11:59:59.999Z"),
    justBeforeClubDay: "2026-06-14",
    // Shallower than UTC+12, no daylight saving: reads the boundary instant as
    // the UTC day.
    shallowZone: "Australia/Brisbane",
    // Deeper than UTC+13, no daylight saving: has already rolled over at the
    // companion instant.
    deeperZone: "Pacific/Kiritimati",
  },
  {
    label: "NZDT (UTC+13), 00:30 on a club day",
    instant: new Date("2026-01-14T11:30:00.000Z"),
    utcDay: "2026-01-14",
    clubDay: "2026-01-15",
    justBefore: new Date("2026-01-14T10:59:59.999Z"),
    justBeforeClubDay: "2026-01-14",
    // A FIXED UTC+12 with no daylight saving is 30 minutes short of the club
    // day here, which is what makes this case catch a zone that ignores NZDT.
    // (POSIX sign convention: `Etc/GMT-12` is UTC+12.)
    shallowZone: "Etc/GMT-12",
    deeperZone: "Pacific/Kiritimati",
  },
] as const;

// A calendar day as its writers store it: `yyyy-MM-dd` pinned to UTC midnight
// (`parseDateOnly` / `new Date("yyyy-MM-dd")`).
const CALENDAR_DAY = new Date("1985-06-15T00:00:00.000Z");
const CALENDAR_DAY_STRING = "1985-06-15";
// A zone BEHIND UTC. Nothing about the club is American; this is simply where
// the two operations stop agreeing, and the only place the calendar-day
// assertions become decidable.
const ZONE_BEHIND_UTC = "America/New_York";
/**
 * The club's own zone, named rather than left to a default: `date-only.ts` lost
 * its `= APP_TIME_ZONE` defaults in #3123 and `formatMergeFieldValue` lost its
 * own in #3126 (`INV-SSOT-003`), so every call in this file names a zone and
 * nothing here can be answered by the environment. It is New Zealand because
 * that is this file's premise, and `expectClubTimeZonePremise()` below asserts
 * the environment still agrees — so this constant cannot drift out of step and
 * leave the divergence cases measuring nothing.
 */
const CLUB_ZONE = "Pacific/Auckland";

describe("#2860 the premise: the club zone is New Zealand and each instant really is divergent", () => {
  it("runs with the club time zone actually set to New Zealand", () => {
    expectClubTimeZonePremise();
  });

  it.each(CLUB_DAY_CASES)(
    "$label: the UTC day is the day before the club day",
    ({ instant, utcDay, clubDay }) => {
      // The first reading IS the pre-#2860 renderer's operation, spelled out:
      // `value.toISOString().slice(0, 10)`. Both readings are executed rather
      // than asserted against each other as literals, so a fixture that drifted
      // out of the divergence window fails here instead of quietly passing.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      expect(formatDateOnlyForTimeZone(instant, CLUB_ZONE)).toBe(clubDay);
    },
  );

  it.each(CLUB_DAY_CASES)(
    "$label: a SHALLOWER zone reads the same instant as the UTC day, so a wrong zone fails these tests",
    ({ instant, utcDay, shallowZone }) => {
      expect(formatDateOnlyForTimeZone(instant, shallowZone)).toBe(utcDay);
    },
  );

  it.each(CLUB_DAY_CASES)(
    "$label: one millisecond earlier is still the previous club day, and a DEEPER zone gets that wrong",
    ({ justBefore, justBeforeClubDay, clubDay, deeperZone }) => {
      expect(formatDateOnlyForTimeZone(justBefore, CLUB_ZONE)).toBe(
        justBeforeClubDay,
      );
      // UTC+14 has already rolled over, so the pair brackets the club offset
      // from both sides rather than only proving "deep enough".
      expect(formatDateOnlyForTimeZone(justBefore, deeperZone)).toBe(clubDay);
    },
  );
});

describe("#2860 the other half of the premise: a calendar day is read by TRUNCATION, which is a DIFFERENT operation", () => {
  it("agrees with the club-zone formatter in New Zealand, which is exactly why an NZ-only assertion cannot decide it", () => {
    expect(formatDateOnly(CALENDAR_DAY)).toBe(CALENDAR_DAY_STRING);
    expect(formatDateOnlyForTimeZone(CALENDAR_DAY, CLUB_ZONE)).toBe(
      CALENDAR_DAY_STRING,
    );
  });

  it("disagrees in a zone BEHIND UTC — the club-zone formatter would move a stored calendar day a day early", () => {
    // Verified by passing the zone explicitly, not by setting `TZ`. This is the
    // reason `dateOfBirth`, `lifeMemberDate` and `joinedDate` are deliberately
    // NOT routed through `formatDateOnlyForTimeZone` (INV-DATE-010).
    expect(formatDateOnly(CALENDAR_DAY)).toBe(CALENDAR_DAY_STRING);
    expect(formatDateOnlyForTimeZone(CALENDAR_DAY, ZONE_BEHIND_UTC)).toBe(
      "1985-06-14",
    );
  });
});

describe("#2860 every merged field is classified, and only merged fields are", () => {
  // The classification is only as good as its coverage: a merged field with no
  // declared kind would fall back to the raw value, and a stray declaration
  // would be classification nobody reads. Both directions are pinned against
  // what `mergeMemberFields` actually emits.
  const emittedFields = () => {
    // Populate BOTH sides of every merged field so no conditional row is
    // skipped: the photo group needs the master blank and the loser populated,
    // `hutLeaderEligibleAt` needs eligibility, and `joinedDate` is always
    // emitted.
    const master: Record<string, unknown> = {
      hutLeaderEligible: true,
      hutLeaderEligibleAt: new Date("2026-06-14T12:00:00.000Z"),
      joinedDate: new Date("2020-01-01T00:00:00.000Z"),
    };
    const loser: Record<string, unknown> = {
      photoImageId: "img_loser",
      photoUpdatedAt: new Date("2026-01-14T11:30:00.000Z"),
      photoUpdatedByMemberId: "member_loser",
      hutLeaderEligible: true,
      hutLeaderEligibleAt: new Date("2019-06-14T12:00:00.000Z"),
      joinedDate: new Date("2019-01-01T00:00:00.000Z"),
    };
    return mergeMemberFields(master, loser).diff.map((row) => row.field);
  };

  it("declares a kind for every field the merge emits", () => {
    const undeclared = emittedFields().filter(
      (field) => !(field in MERGE_FIELD_VALUE_KINDS),
    );
    expect(undeclared).toEqual([]);
  });

  it("declares no kind for a field the merge no longer emits", () => {
    const emitted = new Set(emittedFields());
    const strays = Object.keys(MERGE_FIELD_VALUE_KINDS).filter(
      (field) => !emitted.has(field),
    );
    expect(strays).toEqual([]);
  });

  /*
    THE TWO ASSERTIONS ABOVE ARE ONLY AS EXHAUSTIVE AS THE FIXTURE.

    `emittedFields()` is a hand-built pair of member records. It is honest about
    the rows it triggers, but a NEW conditional row — another
    `hutLeaderEligibleAt`, pushed only when some flag is set — would simply not
    be emitted by it. "Declares a kind for every field the merge emits" would
    then pass over a field it never saw, and that field would reach
    `mergeFieldValueKind`'s `plain` fallback in production.

    So the two tests below take the field names from the merge module itself
    rather than from the fixture, and between them they cover every way a row
    can be built: the loops (via the exported list) and the hand-written pushes
    (via the single constructor's literal arguments).
  */

  it("declares a kind for every field the merge's own lists loop over", () => {
    const undeclared = UNCONDITIONALLY_MERGED_FIELDS.filter(
      (field) => !(field in MERGE_FIELD_VALUE_KINDS),
    );
    expect(
      undeclared,
      "A field was added to FILL_IF_BLANK_FIELDS, a GROUP_FILL_SPECS group or " +
        "the OR booleans without a declared value kind (#2860). It would render " +
        "through the `plain` fallback — raw, and for a date, wrong.",
    ).toEqual([]);

    // Vacuity guard: an export that became empty would pass the filter above
    // perfectly while asserting nothing.
    expect(UNCONDITIONALLY_MERGED_FIELDS.length).toBeGreaterThan(20);
  });

  it("declares a kind for every field pushed as a one-off derived row", () => {
    // `fieldMergeRow` is the SINGLE constructor for a diff row (#2860), so every
    // hand-written push names its field as a string literal in a call to it.
    // Reading them out of the source is what makes this exhaustive for rows no
    // fixture is guaranteed to trigger — the same "read the tree, not a
    // remembered list" method as #2684's encoding guard.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/member-merge.ts"),
      "utf8",
    );
    const derived = [
      ...source.matchAll(/fieldMergeRow\(\s*"([A-Za-z0-9_]+)"/g),
    ].map((match) => match[1]!);

    expect(
      derived.length,
      "Found NO literal fieldMergeRow(\"...\") call. Either the derived rows are " +
        "gone, or they are built some other way and this test now asserts nothing.",
    ).toBeGreaterThan(0);

    const undeclared = derived.filter(
      (field) => !(field in MERGE_FIELD_VALUE_KINDS),
    );
    expect(
      undeclared,
      "A derived diff row is emitted for a field with no declared value kind " +
        "(#2860). Conditional rows are exactly the ones a fixture can miss.",
    ).toEqual([]);
  });

  it("classifies the two instants and the three calendar days as such", () => {
    // The classification is proved from the schema and the write paths in
    // `member-merge-field-kinds.ts`; this pins the conclusions so a later edit
    // cannot flip one silently. `lifeMemberDate` is a calendar day: every writer
    // validates `^\d{4}-\d{2}-\d{2}$` or calls `parseDateOnly`, and none stamps
    // a clock.
    expect(mergeFieldValueKind("photoUpdatedAt")).toBe("instant");
    expect(mergeFieldValueKind("hutLeaderEligibleAt")).toBe("instant");
    expect(mergeFieldValueKind("dateOfBirth")).toBe("calendarDay");
    expect(mergeFieldValueKind("lifeMemberDate")).toBe("calendarDay");
    expect(mergeFieldValueKind("joinedDate")).toBe("calendarDay");
    expect(mergeFieldValueKind("occupation")).toBe("plain");
  });

  it("falls back to the raw value for an unknown field, which can be odd but never a day wrong", () => {
    expect(mergeFieldValueKind("someFutureField")).toBe("plain");
  });
});

describe("#2860 the classification agrees with #2684's reviewed record of the same columns", () => {
  /*
    TWO DECLARATIONS, ONE SUBJECT. #2684's guard keeps
    `DATE_ONLY_IN_DATETIME_COLUMN`: the reviewed record of which bare-`DateTime`
    columns actually hold a calendar day. `MERGE_FIELD_VALUE_KINDS` decides the
    same question for the merge screen.

    They are not redundant — the guard classifies a call site by the field name
    written in the ARGUMENT, and the merge screen renders `unknown` values whose
    field is a runtime string, so the guard passes over it in silence (it does
    today: the whole suite is green against this branch). But two records of the
    same fact drift, and a drift here is a date silently a day wrong on the
    screen before an irreversible merge. So they are bound: a calendar day here
    must be a reviewed calendar day there, and an instant here must NOT be.
  */

  const dateKinds = Object.entries(MERGE_FIELD_VALUE_KINDS).filter(
    ([, kind]) => kind !== "plain",
  );

  /*
    #2872 WIDENED WHAT COUNTS AS "REVIEWED", AND IT IS NOW USUALLY THE SCHEMA.
    A column holds a calendar day either because the database says so
    (`@db.Date`) or because a reviewed exception says so despite the column type.
    Since CT-3 migrated all ten of #2684's entries, the reviewed record is empty
    and every calendar day on this screen is settled by the schema — so the
    binding has to consult BOTH, or it would fail on exactly the fields the
    migration made structurally correct.
  */
  /*
    `Object.hasOwn`, NOT `in`. Now that the reviewed record is empty, `in` would
    make that disjunct a pure PROTOTYPE CHANNEL: `constructor`, `toString`,
    `valueOf`, `hasOwnProperty` and `__proto__` are all `in` an ordinary object
    literal, so a merged field with one of those names would be classified as a
    reviewed calendar day by a list that reviewed nothing. The record itself also
    carries a null prototype now, which closes the same hole for #2684's guard,
    which asks the question its own way and lives in a file this lane may not
    edit. Two independent defences, and the test below pins both.
  */
  const reviewedOrStructural = (field: string) =>
    Object.hasOwn(DATE_ONLY_IN_DATETIME_COLUMN, field) ||
    DATE_ONLY_COLUMN_FIELDS.has(field);

  it("has some date-kinded fields to check", () => {
    // Vacuity guard: if every field became `plain`, both assertions below would
    // pass over an empty list.
    expect(dateKinds.length).toBeGreaterThan(0);
  });

  it("can still see the schema's own date-only columns", () => {
    // The second vacuity guard, and the one #2872 made necessary:
    // DATE_ONLY_COLUMN_FIELDS is PARSED from prisma/schema.prisma, so a change
    // to the schema's formatting could return an empty set and turn the
    // calendar-day assertion below into a permanent failure — or, worse, turn
    // the instant assertion into one that passes over nothing. Pin the
    // archetype: `Booking.checkIn` is the lodge night this whole contract is
    // named after.
    expect(
      DATE_ONLY_COLUMN_FIELDS.has("checkIn"),
      "The @db.Date scan found no `checkIn`, so prisma/schema.prisma has " +
        "stopped parsing and every classification below is meaningless.",
    ).toBe(true);
    /*
      A FLOOR AT THE MEASURED COUNT, not at a token one. This was 15 against 31
      real names, which tolerated losing half the set to a schema-format change
      and still passing. A floor cannot be tripped by ADDING a `@db.Date` column
      — the count only goes up — so pinning it at today's figure costs a future
      lane nothing. Removing one does trip it, deliberately: a calendar-day
      column leaving this set is exactly the change somebody should look at. If
      that removal is right, move this number and say why in the pull request.
    */
    expect(
      DATE_ONLY_COLUMN_FIELDS.size,
      "Fewer `@db.Date` field names than the 31 measured when this floor was " +
        "set. Either the schema scan has partially broken (which makes every " +
        "classification below weaker without failing it), or a calendar-day " +
        "column was narrowed back to a bare `DateTime` — say which, in the PR.",
    ).toBeGreaterThanOrEqual(31);
  });

  it("does not read a reviewed exception off Object.prototype", () => {
    /*
      #2872 review. The reviewed record is EMPTY, so `field in record` had become
      a pure prototype channel: every name below is `in` an ordinary object
      literal, and a merged field carrying one would have been reported as a
      reviewed calendar day — silently, by a list that reviews nothing. Both
      defences are asserted here, because either alone would close it and the
      point is that neither can be dropped unnoticed: this binding asks with
      `Object.hasOwn`, and the record has a null prototype, which is what also
      protects #2684's guard in a file this lane may not edit.
    */
    for (const inherited of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
    ]) {
      expect(inherited in {}, `${inherited} is not an inherited key`).toBe(true);
      expect(
        reviewedOrStructural(inherited),
        `${inherited} was treated as a reviewed calendar day`,
      ).toBe(false);
    }

    expect(
      Object.getPrototypeOf(DATE_ONLY_IN_DATETIME_COLUMN),
      "DATE_ONLY_IN_DATETIME_COLUMN must have a null prototype: #2684's guard " +
        "asks `field in` it and cannot use Object.hasOwn from here.",
    ).toBeNull();
  });

  it("records every calendar day it declares as a date-only column, or on #2684's reviewed list", () => {
    const missing = dateKinds
      .filter(([, kind]) => kind === "calendarDay")
      .map(([field]) => field)
      .filter((field) => !reviewedOrStructural(field));

    expect(
      missing,
      "This field is rendered by TRUNCATION on the merge screen, which is only " +
        "correct for a column that holds a calendar day — but the schema does " +
        "not declare it `@db.Date` and it is not on #2684's reviewed list in " +
        "src/lib/__tests__/support/date-only-reviewed-fields.ts. Narrow the " +
        "column (that is what #2872 did to the other ten), add it to the " +
        "reviewed list WITH THE WRITE THAT PROVES IT, or classify it as an " +
        "instant here (INV-DATE-019).",
    ).toEqual([]);
  });

  it("declares no instant that the schema or #2684 treats as a calendar day", () => {
    const contradictory = dateKinds
      .filter(([, kind]) => kind === "instant")
      .map(([field]) => field)
      .filter(reviewedOrStructural);

    expect(
      contradictory,
      "Two records now disagree about what this column means: it is an instant " +
        "here and a calendar day in prisma/schema.prisma or on #2684's list. " +
        "One of them is wrong, and whichever it is, some surface is showing a " +
        "date a day early.",
    ).toEqual([]);
  });
});

describe.each(CLUB_DAY_CASES)(
  "#2860 the merge comparison table — $label",
  ({ instant, utcDay, clubDay }) => {
    // Every case in this block pins a DIVERGENT instant — its club day is not
    // its UTC day — so each one is only meaningful while the club zone really is
    // New Zealand. `expectClubTimeZonePremise`'s own docblock asks to be called
    // from the `beforeEach` of exactly such a block: without it a mis-set zone
    // reports as a bare date mismatch here, and the reader debugs the renderer
    // instead of the environment.
    beforeEach(() => {
      expectClubTimeZonePremise();
    });

    // One table, both receiver kinds: the photo group's `photoUpdatedAt` and the
    // hut-leader `hutLeaderEligibleAt` are instants; `dateOfBirth`,
    // `lifeMemberDate` and `joinedDate` are calendar days. They are asserted
    // together because the defect was a single generic formatter applied to all
    // of them, and the fix has to move one set without moving the other.
    const master: Record<string, unknown> = {
      photoImageId: null,
      photoUpdatedAt: null,
      photoUpdatedByMemberId: null,
      dateOfBirth: null,
      lifeMemberDate: null,
      hutLeaderEligible: false,
      hutLeaderEligibleAt: null,
      joinedDate: new Date("2021-03-08T00:00:00.000Z"),
    };
    const loser: Record<string, unknown> = {
      photoImageId: "img_loser",
      photoUpdatedAt: instant,
      photoUpdatedByMemberId: "member_loser",
      dateOfBirth: CALENDAR_DAY,
      lifeMemberDate: new Date("2018-11-02T00:00:00.000Z"),
      hutLeaderEligible: true,
      hutLeaderEligibleAt: instant,
      joinedDate: new Date("2019-07-01T00:00:00.000Z"),
    };

    const rowsByField = () => {
      const byField = new Map<
        string,
        { result: unknown; kind: MergeFieldValueKind }
      >();
      for (const row of mergeMemberFields(master, loser).diff) {
        byField.set(row.field, { result: row.result, kind: row.kind });
      }
      return byField;
    };

    const rendered = (field: string) => {
      const row = rowsByField().get(field);
      if (!row) throw new Error(`the merge emitted no ${field} row`);
      return formatMergeFieldValue(row.result, row.kind, CLUB_ZONE);
    };

    it("dates the duplicate's photo on the club's calendar day, not the UTC day", () => {
      expect(rendered("photoUpdatedAt")).toBe(clubDay);
      expect(rendered("photoUpdatedAt")).not.toBe(utcDay);
    });

    it("dates hut-leader eligibility on the club's calendar day, not the UTC day", () => {
      expect(rendered("hutLeaderEligibleAt")).toBe(clubDay);
      expect(rendered("hutLeaderEligibleAt")).not.toBe(utcDay);
    });

    it("leaves the stored calendar days exactly as stored", () => {
      expect(rendered("dateOfBirth")).toBe(CALENDAR_DAY_STRING);
      expect(rendered("lifeMemberDate")).toBe("2018-11-02");
      expect(rendered("joinedDate")).toBe("2019-07-01");
    });

    it("renders the same days from the ISO strings the browser actually receives", () => {
      // The page is a client component fed by `/merge/preview`, so every value
      // arrives as a JSON string, never a `Date`. That was the live arm of the
      // old formatter, so it is the arm that most needs pinning.
      const overTheWire = JSON.parse(
        JSON.stringify(mergeMemberFields(master, loser).diff),
      ) as { field: string; result: unknown; kind: MergeFieldValueKind }[];
      const display = (field: string) => {
        const row = overTheWire.find((r) => r.field === field);
        if (!row) throw new Error(`the merge emitted no ${field} row`);
        expect(typeof row.result).toBe("string");
        return formatMergeFieldValue(row.result, row.kind, CLUB_ZONE);
      };

      expect(display("photoUpdatedAt")).toBe(clubDay);
      expect(display("hutLeaderEligibleAt")).toBe(clubDay);
      expect(display("dateOfBirth")).toBe(CALENDAR_DAY_STRING);
      expect(display("lifeMemberDate")).toBe("2018-11-02");
      expect(display("joinedDate")).toBe("2019-07-01");
    });

    it("would move the calendar days too if they were routed through the club-zone formatter — proved from a club BEHIND UTC", () => {
      // The load-bearing test for the OTHER half of the fix, and the only one
      // that can fail the mutation "render calendar days with
      // formatDateOnlyForTimeZone as well". In New Zealand that mutation is
      // invisible: UTC midnight is midday NZ, the same calendar day. Rendering
      // the same table for a club sitting behind UTC separates them — the
      // instants follow that club's day, and the stored calendar days do not
      // move at all.
      const byField = rowsByField();
      const behind = (field: string) => {
        const row = byField.get(field);
        if (!row) throw new Error(`the merge emitted no ${field} row`);
        return formatMergeFieldValue(row.result, row.kind, ZONE_BEHIND_UTC);
      };

      expect(behind("dateOfBirth")).toBe(CALENDAR_DAY_STRING);
      expect(behind("lifeMemberDate")).toBe("2018-11-02");
      expect(behind("joinedDate")).toBe("2019-07-01");
      // And the instants DO follow the club they are read in, which is what
      // makes the line above a real distinction rather than a no-op.
      expect(behind("photoUpdatedAt")).toBe(
        formatDateOnlyForTimeZone(instant, ZONE_BEHIND_UTC),
      );
      expect(behind("photoUpdatedAt")).not.toBe(clubDay);
    });

    it("carries the kind on the row, so the browser cannot classify a value differently from the server", () => {
      const byField = rowsByField();
      expect(byField.get("photoUpdatedAt")?.kind).toBe("instant");
      expect(byField.get("hutLeaderEligibleAt")?.kind).toBe("instant");
      expect(byField.get("dateOfBirth")?.kind).toBe("calendarDay");
      expect(byField.get("lifeMemberDate")?.kind).toBe("calendarDay");
      expect(byField.get("joinedDate")?.kind).toBe("calendarDay");
      expect(byField.get("occupation")?.kind).toBe("plain");
    });
  },
);

describe("#2860 the non-date cells are untouched", () => {
  it("renders blanks, booleans and plain values as before", () => {
    // The zone is REQUIRED since #3126 and unused on every branch below, so a
    // zone BEHIND UTC is passed deliberately: if one of these branches ever
    // starts consulting it, the value moves and the assertion fails. Passing
    // the club's own zone here would hide that.
    expect(formatMergeFieldValue(null, "plain", ZONE_BEHIND_UTC)).toBe("—");
    expect(formatMergeFieldValue(undefined, "calendarDay", ZONE_BEHIND_UTC)).toBe(
      "—",
    );
    expect(formatMergeFieldValue("", "instant", ZONE_BEHIND_UTC)).toBe("—");
    expect(formatMergeFieldValue(true, "plain", ZONE_BEHIND_UTC)).toBe("Yes");
    expect(formatMergeFieldValue(false, "plain", ZONE_BEHIND_UTC)).toBe("No");
    expect(formatMergeFieldValue("Engineer", "plain", ZONE_BEHIND_UTC)).toBe(
      "Engineer",
    );
    expect(formatMergeFieldValue("MR", "plain", ZONE_BEHIND_UTC)).toBe("MR");
  });

  it("shows an unparsable date-kinded value rather than a made-up day", () => {
    expect(
      formatMergeFieldValue("not a date", "instant", ZONE_BEHIND_UTC),
    ).toBe("not a date");
    expect(
      formatMergeFieldValue(new Date(NaN), "calendarDay", ZONE_BEHIND_UTC),
    ).toBe("Invalid Date");
  });

  it("shows the raw value for a kind it does not recognise, rather than truncating it", () => {
    // The rolling-deploy case, and the reason the renderer has no trailing
    // `else`. A NEW server can stamp a kind an OLD bundle has never heard of;
    // the browser must not guess, because the only guess available is exactly
    // the truncation #2860 removed. TypeScript cannot express this call — `kind`
    // is a closed union at compile time and an arbitrary string at runtime — so
    // the cast is the point of the test, not a shortcut around it.
    const futureKind = "zonedDay" as unknown as MergeFieldValueKind;
    const value = new Date("2026-06-14T12:00:00.000Z");

    // The CLUB's zone, not a zone behind UTC: the third assertion below is that
    // the value is not the club-zone READING of the instant, and it only says
    // anything while the zone passed in is the one that reading would use.
    const rendered = formatMergeFieldValue(value, futureKind, CLUB_ZONE);
    expect(rendered).toBe(String(value));
    // Specifically NOT the UTC truncation, which is the silent-day-early defect.
    expect(rendered).not.toBe("2026-06-14");
    // And not the club-zone reading either — an unknown kind is not a date at
    // all as far as this renderer is concerned.
    expect(rendered).not.toBe("2026-06-15");
  });
});
