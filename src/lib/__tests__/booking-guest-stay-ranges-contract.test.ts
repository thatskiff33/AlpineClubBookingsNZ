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

  it("keeps the deprecated flag on LEGACY semantics, never the operational day", () => {
    // PRIVACY CONTRACT. `lodge-display-state.ts` (fenced, issue #58) subtracts
    // only the envelope end from this list to get its NIGHT counts, so giving
    // the flag D-M4 per-segment presence turns a sparse stay's gap morning into
    // a phantom night, breaks sole-occupancy detection and puts guest names and
    // phone numbers on the unauthenticated lobby wall. The per-segment rule
    // belongs to the named helpers only.
    const wrapper = stayRanges.slice(
      stayRanges.indexOf("export function getLodgeVisibleGuestsForDate<"),
    );
    expect(wrapper).toContain("isGuestVisibleOnLodgeDate(guest, date, booking, options)");
    expect(wrapper).not.toContain("getOperationallyPresentGuestsForDay(");

    // The legacy true-branch, byte-for-byte: night-set membership OR the single
    // morning after the FINAL listed night; otherwise the closed envelope.
    const legacyBranch = stayRanges.slice(
      stayRanges.indexOf("function isGuestVisibleOnLodgeDate("),
      stayRanges.indexOf("export function getLodgeVisibleGuestsForDate<"),
    );
    expect(legacyBranch).toContain("if (maxKey === null || key > maxKey) maxKey = key;");
    expect(legacyBranch).toContain("return dateKey === shiftDateOnlyKey(maxKey, 1);");
    expect(legacyBranch).toContain(
      "return stayStartKey <= dateKey && dateKey <= stayEndKey;",
    );
  });

  it("freezes the deprecated includeDepartureDate flag to the lobby wall alone", () => {
    // #2631 converted the two kiosk read surfaces (`api/lodge/week` and
    // `api/lodge/guests/[date]`) onto the named operational-day helpers, so the
    // flag has ONE caller left: `lodge-display-state.ts`, the unauthenticated
    // lobby wall. That one is permanent, not pending — it needs the LEGACY
    // final-morning-only semantics to derive its night counts, and the test
    // above spells out why giving it D-M4 per-segment presence would put guest
    // names on a public screen (issue #58). No caller may be added back.
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
    const rosterStatusCode = rosterStatus
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
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
