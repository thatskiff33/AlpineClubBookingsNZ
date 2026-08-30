/**
 * #2622 source contract for the two stay models.
 *
 * The night model and the operational-day model must stay separate and must
 * each have exactly one definition. These are source-text assertions on
 * purpose: the behaviour they protect is "nobody quietly grew a third model",
 * which no runtime assertion can see.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return allSourceFiles(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

// Byte-for-byte copies of the frozen night-model helpers. `capacity.test.ts`
// pins back-to-back handover behaviour through these, and the pricing,
// whole-lodge and multi-date-range suites are built on them, so #2622 added the
// operational-day rule ALONGSIDE them rather than editing them.
const FROZEN_IS_GUEST_ACTIVE_ON_NIGHT = `export function isGuestActiveOnNight(
  guest: GuestStayRange,
  night: Date,
  booking: BookingStayRange
): boolean {
  const nightKey = dateOnlyKey(night);

  // Explicit night set wins: a guest is active on a night iff that night is in
  // their set. This correctly handles non-contiguous stays (gaps are absences).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }

  // Fallback: contiguous envelope, half-open [stayStart, stayEnd).
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return stayStartKey <= nightKey && nightKey < stayEndKey;
}`;

const FROZEN_GET_ACTIVE_GUESTS_FOR_NIGHT = `export function getActiveGuestsForNight<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestActiveOnNight(guest, night, booking)
  );
}`;

describe("stay-range model contract (#2622)", () => {
  const stayRanges = source("src/lib/booking-guest-stay-ranges.ts");

  it("keeps the night-model helpers byte-identical", () => {
    expect(stayRanges).toContain(FROZEN_IS_GUEST_ACTIVE_ON_NIGHT);
    expect(stayRanges).toContain(FROZEN_GET_ACTIVE_GUESTS_FOR_NIGHT);
  });

  it("defines the operational-day rule exactly once", () => {
    for (const named of [
      "export function getGuestOperationalDayPresence(",
      "export function isGuestOperationallyPresentOnDay(",
      "export function isGuestArrivingOnDay(",
      "export function isGuestDepartingOnDay(",
      "export function getOperationallyPresentGuestsForDay<",
    ]) {
      expect(stayRanges.split(named)).toHaveLength(2);
    }
  });

  it("carries no time-of-day input: the boundary is midday NZ by definition", () => {
    // Epic D-M3. If a threshold, setting or arrival-time input ever reaches
    // this rule it stops being derivable from the night set alone.
    expect(stayRanges).not.toMatch(/arrivalTime|departureTime|getHours|setHours/);
  });

  it("keeps the lobby-wall wrapper a pure delegation, defining nothing of its own", () => {
    // #2735. The wrapper used to hold the LEGACY lodge-date rule as its own
    // third definition — night-set membership plus the single morning after the
    // FINAL listed night — which is how a sparse stay's intermediate departure
    // mornings went missing from the wall. Both branches now delegate to a named
    // model, so there is still exactly one operational-day rule and one night
    // rule in this file and the wall cannot drift out of step with either.
    //
    // A THIRD BRANCH IS THE REGRESSION. If a date comparison ever reappears
    // between these two markers, somebody has started defining lodge-date
    // visibility here again.
    const predicate = stayRanges.slice(
      stayRanges.indexOf("function isGuestVisibleOnLodgeDate("),
      stayRanges.indexOf("export function getLodgeVisibleGuestsForDate<"),
    );
    expect(predicate).toContain(
      "return isGuestActiveOnNight(guest, date, booking);",
    );
    expect(predicate).toContain(
      "return isGuestOperationallyPresentOnDay(guest, date, booking);",
    );
    const predicateCode = stripComments(predicate);
    expect(predicateCode).not.toMatch(/dateKey|stayStartKey|stayEndKey|maxKey/);

    const wrapper = stayRanges.slice(
      stayRanges.indexOf("export function getLodgeVisibleGuestsForDate<"),
    );
    expect(wrapper).toContain("isGuestVisibleOnLodgeDate(guest, date, booking, options)");
  });

  it("freezes the deprecated includeDepartureDate flag to the lobby wall alone", () => {
    // #2631 converted the two kiosk read surfaces (`api/lodge/week` and
    // `api/lodge/guests/[date]`) onto the named operational-day helpers, so the
    // flag has ONE caller left: `lodge-display-state.ts`, the unauthenticated
    // lobby wall. It stays the only one. The wall keeps a single named entry
    // point so this census can fence it and so the privacy-load-bearing file has
    // one import to audit; every other surface calls the named model directly
    // (INV-DATE-005). No caller may be added back.
    const callers = allSourceFiles(path.join(ROOT, "src"))
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => /includeDepartureDate/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual([
      "src/lib/booking-guest-stay-ranges.ts",
      "src/lib/lodge-display-state.ts",
    ]);
  });

  it("MUTATION PROBE: every converted read surface loads the explicit night rows (#2631)", () => {
    // The operational-day rule is per-night, so a surface that asks it about a
    // guest loaded without `nights` gets the stayStart/stayEnd envelope back
    // instead — and a sparse stay's internal gap day reads as presence. Drop
    // the load anywhere and this fails.
    for (const surface of [
      "src/app/api/lodge/guests/[date]/route.ts",
      "src/app/api/lodge/week/route.ts",
      "src/lib/roster-status.ts",
      "src/lib/roster-eligibility.ts",
    ]) {
      const contents = source(surface);
      expect(contents, surface).toMatch(/nights: \{\s*select: \{\s*stayDate: true,?\s*\},?\s*\}/);
    }
  });

  it("MUTATION PROBE: no converted read surface reverts to a checkout-EXCLUSIVE bound (#2631)", () => {
    // `gt` on a checkout/stay-end bound is the old night model. It silently
    // drops the changeover morning — the whole complaint — and on the roster
    // calendar it drops a departure that falls on the first displayed date.
    for (const surface of [
      "src/app/api/lodge/guests/[date]/route.ts",
      "src/app/api/lodge/week/route.ts",
      "src/app/api/chores/roster/[date]/print/route.ts",
      "src/lib/roster-status.ts",
      "src/lib/roster-eligibility.ts",
    ]) {
      const contents = source(surface);
      expect(contents, surface).not.toMatch(/checkOut: \{ gt: /);
      expect(contents, surface).not.toMatch(/stayEnd: \{ gt: /);
    }
  });

  it("MUTATION PROBE: the roster calendar's own queries carry the consent predicate (#2631)", () => {
    // The calendar used to count guests the roster excludes, so a day painted
    // "needs roster" could open empty. Both DB entry points in roster-status
    // now apply D-12's predicate in the booking `some` AND the guest select —
    // four occurrences. Removing any one of them fails here.
    //
    // Counted over CODE ONLY: comments are stripped first, so naming the
    // predicate in a docstring neither satisfies this probe nor trips it.
    const rosterStatus = source("src/lib/roster-status.ts");
    expect(rosterStatus).toContain(
      'from "@/lib/member-guest-consent"',
    );
    const rosterStatusCode = stripComments(rosterStatus);
    expect(
      rosterStatusCode.split("OPERATIONALLY_PRESENT_GUEST_WHERE").length - 1,
    ).toBe(5); // 1 import + 2 per entry point
  });

  it("keeps the roster calendar and the kiosk week strip on one candidate set (#2631)", () => {
    // The week endpoint's guest count, departing count and roster colour must
    // come from the same list, or the payload can say four guests and
    // "no-guests to roster" in the same breath again.
    const week = source("src/app/api/lodge/week/route.ts");
    expect(week).toContain("getRosterStatusStayingBookings");
    expect(week).toContain("computeRosterDayStatusForStayingBookings");
    expect(week).not.toContain("getLodgeVisibleGuestsForDate");
    expect(source("src/lib/roster-status.ts")).toContain(
      "getOperationallyPresentGuestsForDay",
    );
  });

  it("MUTATION PROBE: every roster generation path reads the canonical selector", () => {
    // Chore eligibility has exactly one query. If a generation path ever
    // re-grows its own booking/guest predicate, the two can disagree about who
    // was in the lodge — which is the bug #2622 exists to remove.
    for (const consumer of [
      "src/lib/admin-roster-service.ts",
      "src/app/api/lodge/roster/[date]/generate/route.ts",
    ]) {
      const contents = source(consumer);
      expect(contents, consumer).toContain(
        'from "@/lib/roster-eligibility"',
      );
      expect(contents, consumer).toContain("getOperationalRosterGuestsForDate");
      // No local copy of the coarse stay predicate.
      expect(contents, consumer).not.toMatch(/stayEnd: \{ gt: date \}/);
      expect(contents, consumer).not.toMatch(/checkOut: \{ gt: date \}/);
    }
  });

  it("keeps roster eligibility and chore cleanup on the same rule (D-M6)", () => {
    expect(source("src/lib/roster-eligibility.ts")).toContain(
      "getOperationallyPresentGuestsForDay",
    );
    expect(source("src/lib/chore-cleanup.ts")).toContain(
      "isGuestOperationallyPresentOnDay",
    );
  });
});
