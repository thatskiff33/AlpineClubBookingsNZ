import { describe, expect, it, vi } from "vitest";

/**
 * #3123 — the member-import "cancelled date cannot be in the future" boundary
 * is decided against the CLUB's day, and this module cannot read it.
 *
 * `member-import-dialog.tsx` is `"use client"`, so `member-csv-import.ts` is in
 * the browser bundle: `club-time/server` is `server-only` and the CLI-safe
 * runtime reader imports Prisma, so NEITHER reader is available here. The only
 * correct shape is to take the day as data — the dialog from
 * `useClubTime().today()`, the route from `club.today()` — and that is why the
 * parameter was made REQUIRED rather than re-pointed at a different default.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is pinned to `Pacific/Auckland`: the value the
 * removed default (`todayDateOnlyForTimeZone()`) would have produced, AND this
 * codebase's own fallback. So it is the one pin under which a half-done fix
 * could still look right, and every case below is chosen so the club's day and
 * that value disagree.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  isMemberImportCancelledDateInFuture,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";

/**
 * The frozen clock is `2026-07-01T00:00:00.000Z` — midday on 1 July in
 * Auckland, and still 30 June in every zone behind Greenwich. So a club on
 * `America/Denver` is on 30 June while `APP_TIME_ZONE` says 1 July, and a
 * cancellation dated 1 July is the FUTURE for that club and TODAY for the
 * container.
 */
const CLUB_DAY_BEHIND = "2026-06-30";
const CONTAINER_DAY = "2026-07-01";

const CSV = [
  "First Name,Last Name,Email,Cancelled Date",
  "Ada,Lovelace,ada@example.com,2026-07-01",
].join("\n");

describe("PREMISE: the container's day is not the club's", () => {
  it("pins the environment to the removed default's own answer", () => {
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(
        new Date(),
      ),
    ).toBe(CONTAINER_DAY);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
        new Date(),
      ),
    ).toBe(CLUB_DAY_BEHIND);
  });
});

describe("the cancelled-date boundary follows the day it is given (#3123)", () => {
  it("calls 1 July future for a club still on 30 June", () => {
    expect(
      isMemberImportCancelledDateInFuture("2026-07-01", CLUB_DAY_BEHIND),
    ).toBe(true);
  });

  it("and calls it acceptable for a club already on 1 July", () => {
    expect(
      isMemberImportCancelledDateInFuture("2026-07-01", CONTAINER_DAY),
    ).toBe(false);
  });

  it("declares the day as a parameter with NO default of its own", () => {
    /*
      `Function.length` counts the parameters BEFORE the first defaulted one, so
      it is the one runtime witness of "there is no default left to be wrong":
      reintroduce `today: string = todayDateOnlyForTimeZone()` and this drops to
      1, and give `buildMemberImportPreview` back a defaulted `todayAtClub` and
      that drops to 2. Both are asserted because both parameters were removed by
      the same change and either could come back alone.

      This replaces a call-through with the type cast away
      (`(fn as unknown as (v: string) => boolean)("2026-07-01")`), which returned
      false BOTH before and after the change — `"2026-07-01" > "2026-07-01"` on
      the pinned zone, and `"2026-07-01" > undefined` afterwards. It read as
      coverage of the removal and measured nothing at all.

      The primary guard remains the TYPE: `npm run typecheck` refuses a
      one-argument call, and that is what enumerated the call sites. A test
      cannot assert a compile error without casting the type away, which is
      precisely how the previous spelling stopped being able to fail.
    */
    expect(isMemberImportCancelledDateInFuture.length).toBe(2);
    expect(buildMemberImportPreview.length).toBe(3);
  });
});

describe("the preview reaches the same verdict as the boundary", () => {
  const parsed = parseMemberImportCsv(CSV);

  it("flags the row for a club behind the container", () => {
    if (!parsed.ok) throw new Error("fixture CSV did not parse");
    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    const preview = buildMemberImportPreview(
      parsed.data,
      mapping,
      CLUB_DAY_BEHIND,
    );
    expect(preview.rows[0].errors.join(" ")).toContain(
      "cannot be in the future",
    );
  });

  it("accepts the same row once the club's own day has arrived", () => {
    if (!parsed.ok) throw new Error("fixture CSV did not parse");
    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    const preview = buildMemberImportPreview(
      parsed.data,
      mapping,
      CONTAINER_DAY,
    );
    expect(preview.rows[0].errors.join(" ")).not.toContain(
      "cannot be in the future",
    );
  });
});
