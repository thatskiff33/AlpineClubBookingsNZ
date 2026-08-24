import { describe, expect, it, vi } from "vitest";
import {
  captureHostTimeZone,
  withTimeZone,
} from "@/lib/__tests__/helpers/timezone";
import {
  calendarDayFromPayload,
  formatPayloadCalendarDay,
} from "../calendar-day";

/**
 * The decoder every admin screen reads a `@db.Date` field through (CT-4, #2870).
 *
 * ## What is actually being asserted, and why it is not "zone independence
 * dressed up"
 *
 * For an INSTANT, the discriminating question is "did you use the club's
 * persisted zone rather than the environment's?" — and a test that shows the
 * answer is the same either way proves nothing.
 *
 * For a CALENDAR DATE the required property is the opposite one, and it is
 * genuinely a property rather than an absence: 1 April 2026 must read as
 * 1 April 2026 no matter what clock the machine is on, because a calendar day
 * has no timezone. The defect this replaced was NOT that a zone was missing —
 * it was that `APP_TIME_ZONE` was applied to a value that has no business
 * being projected, so a club behind UTC saw the day before.
 *
 * ## Two axes, and only one of them is the defect
 *
 * The sweep below varies the HOST clock, and that is worth having: it catches a
 * decoder that starts reading `getMonth()` or builds a local-midnight `Date`.
 * `America/Denver` is six hours behind UTC and `Pacific/Kiritimati` fourteen
 * ahead. Only the BEHIND one can actually move the day, because a `@db.Date`
 * column always arrives as UTC midnight — every zone at or ahead of UTC reads
 * that back as the same day. Kiritimati is swept anyway, as the far edge of the
 * half that must read back unchanged.
 *
 * IT IS NOT, ON ITS OWN, A TEST OF THE DEFECT, and that was measured rather than
 * reasoned: restoring the old `APP_TIME_ZONE` projection left every one of those
 * assertions green. `APP_TIME_ZONE` is read once, when `@/config/operational` is
 * first evaluated, so reassigning `process.env.TZ` afterwards cannot move it —
 * and this deployment's value, `Pacific/Auckland`, is ahead of UTC, where the
 * projection is invisible. The last test in this file is the one that moves the
 * environment instead, and it is the one that kills that mutant.
 */
describe("calendarDayFromPayload / formatPayloadCalendarDay (CT-4, #2870)", () => {
  /** Prisma's serialisation of a `@db.Date` column: the day as UTC midnight. */
  const ISO_ENCODING = "2026-04-01T00:00:00.000Z";
  /** The same day as a route that encoded it itself hands it over. */
  const BARE_DAY = "2026-04-01";

  const HOSTILE_ZONES = [
    "UTC",
    "America/Denver", // −6 — the only direction that moves a UTC-midnight day
    "Pacific/Kiritimati", // +14 — the far edge of the "reads back unchanged" half
    "Pacific/Auckland", // the environment's own zone
  ];

  it("has a premise: the swept zones really would move the day if this decoder projected", () => {
    // Asserted, not assumed — but asserted about the RIGHT AXIS, which took a
    // measurement to get right. This premise used to compare Denver against
    // `APP_TIME_ZONE`, and with `TZ=America/Denver` it went red with a bare
    // `expected '31 Mar 2026' not to be '31 Mar 2026'` that reads exactly like
    // the product bug the file exists to disprove. That comparison belonged to
    // the ENVIRONMENT axis, which is the last test in this file, not to the
    // host sweep below.
    //
    // What the sweep needs is only this: projecting the stored encoding through
    // the swept zones really would give more than one answer, and at least one
    // of them would not be the stored day. Both facts are true on every host on
    // earth, so this guard can no longer be silenced by an environment.
    const projected = HOSTILE_ZONES.map((zone) =>
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        dateStyle: "medium",
      }).format(new Date(ISO_ENCODING)),
    );
    expect(new Set(projected).size).toBeGreaterThan(1);
    expect(projected.some((day) => day !== "1 Apr 2026")).toBe(true);
    // Pinned as a literal so a reader can check it by hand. Note the slip runs
    // in ONE direction only, and that is a property of the encoding rather than
    // of this fixture: a `@db.Date` column always arrives as UTC MIDNIGHT, so
    // every zone at or ahead of UTC reads it back as the same day and only a
    // zone behind UTC names the day before. That one-sidedness is why the
    // defect this file guards against hurts a Denver club and is invisible to
    // an Auckland one — and why the sweep needs a behind-UTC entry to bite.
    expect(
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: "America/Denver",
        dateStyle: "medium",
      }).format(new Date(ISO_ENCODING)),
    ).toBe("31 Mar 2026");
    expect(
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: "Pacific/Kiritimati",
        dateStyle: "medium",
      }).format(new Date(ISO_ENCODING)),
    ).toBe("1 Apr 2026");
  });

  it.each(HOSTILE_ZONES)(
    "decodes the UTC-midnight @db.Date encoding to the stored day on a %s host",
    (zone) => {
      withTimeZone(zone, () => {
        expect(calendarDayFromPayload(ISO_ENCODING)).toBe(BARE_DAY);
        expect(formatPayloadCalendarDay(ISO_ENCODING)).toBe("1 Apr 2026");
      });
    },
  );

  it.each(HOSTILE_ZONES)(
    "decodes the bare yyyy-MM-dd spelling to the same day on a %s host",
    (zone) => {
      withTimeZone(zone, () => {
        expect(calendarDayFromPayload(BARE_DAY)).toBe(BARE_DAY);
        expect(formatPayloadCalendarDay(BARE_DAY)).toBe("1 Apr 2026");
      });
    },
  );

  it("reads both spellings as the same day, so a caller never has to know which it holds", () => {
    // Each spelling against the HAND-WRITTEN day, never against the other. A
    // decoder comparing its own two outputs agrees with itself: one that
    // returned the previous day — or a constant — for both inputs satisfies
    // `A === B` and says nothing at all. The equivalence the test name claims
    // follows from both matching the same literal.
    expect(calendarDayFromPayload(ISO_ENCODING)).toBe(BARE_DAY);
    expect(calendarDayFromPayload(BARE_DAY)).toBe(BARE_DAY);
  });

  it("returns null rather than throwing for anything that names no day", () => {
    // A throw here reaches the nearest error boundary and blanks a whole table,
    // which is why the callers get to decide what an unreadable value shows.
    for (const value of [null, undefined, "", "not-a-date", "2026-02-30", "2026-13-01"]) {
      expect(calendarDayFromPayload(value)).toBeNull();
    }
  });

  it("refuses an offset-less timestamp, which names a wall clock rather than a day", () => {
    // `2026-04-01T13:45:00` is a reading in whichever zone happens to parse it,
    // so it is not a calendar day and not a decodable instant either. Silently
    // taking its first ten characters is the class of shortcut INV-DATE-019 bans.
    expect(calendarDayFromPayload("2026-04-01T13:45:00")).toBeNull();
  });

  /**
   * THE DISCRIMINATING ONE, and it took a surviving mutant to find it.
   *
   * The hostile-zone sweep above varies the HOST clock (`process.env.TZ` at run
   * time), and that is not the same axis as the defect. `APP_TIME_ZONE` — what
   * the old code passed — is read from `process.env.TZ` ONCE, when
   * `@/config/operational` is first evaluated, so a sweep that reassigns `TZ`
   * afterwards cannot move it.
   *
   * MEASURED: replacing this decoder's UTC read with
   * `clubCalendarDateOf(instant, APP_TIME_ZONE)` — the exact defect CT-4 exists
   * to remove — left all thirteen assertions in this file GREEN. Under
   * `Pacific/Auckland` it has to: the zone is twelve hours AHEAD of UTC, so UTC
   * midnight reads back as noon on the same day and the projection is invisible.
   * That is the same "correct by accident" this epic keeps finding, and a suite
   * that only ever runs on this deployment's zone can never see past it.
   *
   * So this test moves the ENVIRONMENT rather than the host: it re-evaluates
   * `@/config/operational` with `TZ` behind UTC, which is what a Denver
   * deployment actually is, and re-imports the decoder against it. Now the
   * projection would name 31 March and only the UTC read still says 1 April.
   */
  it("keeps the stored day when the ENVIRONMENT zone is behind UTC — the Denver deployment", async () => {
    const hostTimeZone = captureHostTimeZone();
    try {
      process.env.TZ = "America/Denver";
      vi.resetModules();

      const { APP_TIME_ZONE: environmentZone } = await import(
        "@/config/operational"
      );
      // Premise, in two parts, because either alone can go quietly vacuous:
      // the re-import really did pick the behind-UTC zone up, AND projecting
      // through it really would move the day.
      expect(environmentZone).toBe("America/Denver");
      expect(
        new Intl.DateTimeFormat("en-NZ", {
          timeZone: environmentZone,
          dateStyle: "medium",
        }).format(new Date(ISO_ENCODING)),
      ).toBe("31 Mar 2026");

      const fresh = await import("../calendar-day");
      expect(fresh.calendarDayFromPayload(ISO_ENCODING)).toBe(BARE_DAY);
      expect(fresh.formatPayloadCalendarDay(ISO_ENCODING)).toBe("1 Apr 2026");
    } finally {
      hostTimeZone.restore();
      // Hand the registry back, or the next file inherits a module graph built
      // against Denver.
      vi.resetModules();
    }
  });

  it("uses the caller's fallback for an unreadable value", () => {
    expect(formatPayloadCalendarDay(null)).toBe("—");
    expect(formatPayloadCalendarDay("rubbish", "rubbish")).toBe("rubbish");
    expect(formatPayloadCalendarDay(null, "-")).toBe("-");
  });
});
