// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "Today" is an NZ calendar day, never a UTC one (#2682).
 *
 * New Zealand runs 12-13 hours ahead of UTC, so for roughly the first half of
 * every NZ day, "today in UTC" is still YESTERDAY in New Zealand. Several
 * places derived today's lodge night as `new Date().toISOString().slice(0, 10)`
 * — the UTC date — which `INV-DATE-019`
 * (`docs/invariants/booking-dates-and-capacity.md`) forbids and
 * `todayDateOnlyForTimeZone()` (`src/lib/date-only.ts`) already answers
 * correctly.
 *
 * Every case here runs at **09:00 on 1 July 2026 in New Zealand**, which is
 * `2026-06-30T21:00:00.000Z` — inside the divergence window, where the UTC date
 * (2026-06-30) and the NZ date (2026-07-01) differ. Each assertion fails
 * against the pre-#2682 code, which returned the UTC day.
 */

// 09:00 NZST on 2026-07-01. NZ is UTC+12 in July, so this is the PREVIOUS UTC
// day — the window in which a UTC "today" is a day behind the club.
const NZ_MORNING = new Date("2026-06-30T21:00:00.000Z");
const NZ_DAY = "2026-07-01";
const UTC_DAY = "2026-06-30";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({
    lodgeName: "Test Alpine Lodge",
    lodgeCapacity: 20,
    hutLeaderLabel: "Hut Leader",
  }),
}));

const financeMocks = vi.hoisted(() => ({
  prisma: {
    booking: { findMany: vi.fn() },
    lodgeSettings: { findUnique: vi.fn() },
  },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  requireFinanceViewerApiAccess: vi.fn(),
  getLegacyDashboardBookingExport: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: financeMocks.prisma }));
vi.mock("@/lib/logger", () => ({ default: financeMocks.logger }));
vi.mock("@/lib/finance-api-auth", () => ({
  requireFinanceViewerApiAccess: financeMocks.requireFinanceViewerApiAccess,
}));
vi.mock("@/lib/finance-legacy-dashboard-export", () => ({
  getLegacyDashboardBookingExport: financeMocks.getLegacyDashboardBookingExport,
}));

import type { ClubIdentity } from "@/config/club-identity-types";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { BookingRequestForm } from "@/app/(website-dynamic)/booking-requests/booking-request-form";
import { SchoolBookingForm } from "@/app/(website-dynamic)/school-bookings/school-booking-form";

/*
  CT-4 (#2870) MOVED WHERE THESE TWO FORMS GET THE CLUB'S DAY FROM, and this
  suite's fixture is unchanged by it.

  Both used to call `todayDateOnlyForTimeZone()`, which reads `APP_TIME_ZONE`:
  the container's `TZ`. They now read the club's PERSISTED zone from
  `ClubTimeProvider`, so each render below has to say which club it is rendering
  for. It says `Pacific/Auckland`, which is the same answer `APP_TIME_ZONE`
  gives here, so every expected string in this file is the one #2682 pinned and
  the suite still means exactly what it meant.

  It is named at the call site rather than taken from the shared default in
  `support/club-time-render`, because on THIS suite the zone is the subject: the
  whole claim is that the day offered is New Zealand's and not UTC's, and a
  reader has to be able to see which zone produced it.

  Zone AUTHORITY, meaning that the club's persisted setting beats the
  environment and the browser, is a different claim and is not made here. It is
  made under `America/Denver` in
  `src/app/__tests__/member-public-club-time-authority.test.tsx`.
*/
const CLUB_ZONE = "Pacific/Auckland";

// Only the fields the forms read need real values; the cast satisfies the type.
const STUB_CLUB = {
  lodgeName: "Test Alpine Lodge",
  lodgeCapacity: 20,
  hutLeaderLabel: "Hut Leader",
} as unknown as ClubIdentity;
import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";
import { GET as getLegacyDashboardBookings } from "@/app/api/finance/legacy-dashboard/bookings/route";
import { todayDateOnlyForTimeZone } from "@/lib/date-only";
import { APP_TIME_ZONE } from "@/config/operational";

function mockPublicSettingsFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/settings")) {
      return {
        ok: true,
        json: async () => ({ showPricingToNonMembers: false, lodges: [] }),
      } as Response;
    }
    return { ok: true, json: async () => ({ settings: [] }) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NZ_MORNING);
  vi.clearAllMocks();
  mockPublicSettingsFetch();
  financeMocks.prisma.booking.findMany.mockResolvedValue([]);
  financeMocks.prisma.lodgeSettings.findUnique.mockResolvedValue({ capacity: 20 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#2682 the fixture really is inside the UTC/NZ divergence window", () => {
  it("runs with the club time zone actually set to New Zealand", () => {
    // docs/TESTING.md rule 6: setting TZ=UTC to imitate the CI runner ALSO
    // moves APP_TIME_ZONE, because it is `process.env.TZ || NEXT_PUBLIC_TZ ||
    // "Pacific/Auckland"`. This suite's entire premise is that the club day and
    // the UTC day differ, so under TZ=UTC every assertion below goes red and
    // reads like a product bug. Say what happened instead.
    expect(
      APP_TIME_ZONE,
      "This suite exists to prove the club day and the UTC day differ, so it needs the club zone to be New Zealand. TZ (or NEXT_PUBLIC_TZ) is overriding APP_TIME_ZONE — see docs/TESTING.md rule 6.",
    ).toBe("Pacific/Auckland");
  });

  it("is a different calendar day in UTC than in New Zealand", () => {
    expect(new Date().toISOString().slice(0, 10)).toBe(UTC_DAY);
    // `CLUB_ZONE`, named, for the reason the block above gives: on this suite
    // the zone IS the subject, so the reader has to be able to see which one
    // produced the day (#3123).
    expect(todayDateOnlyForTimeZone(CLUB_ZONE)).toBe(NZ_DAY);
    expect(UTC_DAY).not.toBe(NZ_DAY);
  });
});

describe("#2682 public lodge-night pickers offer the NZ day, not the UTC day", () => {
  it("the public booking-request form's earliest selectable night is the NZ day", async () => {
    render(
      <ClubTimeProvider zone={CLUB_ZONE}>
        <BookingRequestForm club={STUB_CLUB} />
      </ClubTimeProvider>,
    );

    const checkIn = (await screen.findByLabelText(/check-?in/i)) as HTMLInputElement;
    await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());

    // Before #2682 this was the UTC day, so between NZ midnight and roughly NZ
    // midday the form offered a night that had already started and the server
    // then refused.
    expect(checkIn.getAttribute("min")).toBe(NZ_DAY);
    expect(checkIn.getAttribute("min")).not.toBe(UTC_DAY);
  });

  it("the public school-booking form's earliest selectable night is the NZ day", async () => {
    render(
      <ClubTimeProvider zone={CLUB_ZONE}>
        <SchoolBookingForm club={STUB_CLUB} />
      </ClubTimeProvider>,
    );

    const checkIn = (await screen.findByLabelText(/check-?in/i)) as HTMLInputElement;
    await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());

    expect(checkIn.getAttribute("min")).toBe(NZ_DAY);
    expect(checkIn.getAttribute("min")).not.toBe(UTC_DAY);
  });
});

describe("#2682 finance windows default their cut-off to the NZ day", () => {
  it("getFinanceBookingMetrics defaults forward.asOfDate to the NZ day", async () => {
    const result = await getFinanceBookingMetrics({
      forward: { from: "2026-07-01", to: "2026-07-31" },
    });

    // asOfDate decides which stays count as realised. A UTC default made the
    // morning's figures a day behind the afternoon's, with no input changed.
    expect(result.forward?.window.asOfDate).toBe(NZ_DAY);
    expect(result.forward?.window.asOfDate).not.toBe(UTC_DAY);
  });

  it("the legacy dashboard export defaults asOfDate to the NZ day", async () => {
    process.env.LEGACY_DASHBOARD_EXPORT_TOKEN = "test-export-token";
    financeMocks.requireFinanceViewerApiAccess.mockResolvedValue({
      ok: true,
      member: { id: "finance-viewer-1", financeAccessLevel: "VIEWER" },
    });
    financeMocks.getLegacyDashboardBookingExport.mockResolvedValue({
      generatedAt: "2026-07-01T00:00:00.000Z",
      historyStartDate: "2020-04-01",
      asOfDate: NZ_DAY,
      bookings: [],
      forward_bookings: [],
    });

    await getLegacyDashboardBookings(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings",
        { headers: { authorization: "Bearer test-export-token" } },
      ),
    );

    expect(financeMocks.getLegacyDashboardBookingExport).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: NZ_DAY }),
    );
    expect(financeMocks.getLegacyDashboardBookingExport).not.toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: UTC_DAY }),
    );
  });
});

describe("#2682 no surface derives today from UTC any more", () => {
  const SOURCE_ROOT = path.resolve(process.cwd(), "src");

  function listSourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : listSourceFiles(entryPath);
      }
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
      return [path.relative(process.cwd(), entryPath).split(path.sep).join("/")];
    });
  }

  it("leaves no clock-read date-only truncation in non-test src/", () => {
    // The same mistake has several spellings, and the audit's grep only knew
    // two of them — which is why it reported thirteen sites when there were
    // fifteen. The receiver forms (`new Date()`, `new Date(Date.now())`) and
    // the truncations (`.slice(0, 10)`, `.substring(0, 10)`, `.substr(0, 10)`,
    // `.split("T")[0]` in either quote style) are matched as an explicit
    // cross-product, plus `.toJSON()` which is `.toISOString()` by another name.
    //
    // Bounded deliberately: this matches only a truncation applied DIRECTLY to
    // a freshly constructed Date. Truncating an existing `@db.Date` value the
    // same way is legitimate (~119 sites) and is the subject of #2684's lint
    // rule, so it stays out of scope here. The gap that leaves — assigning the
    // clock to a variable first, or truncating a `DateTime` column such as
    // `createdAt` — is real and is why the lint rule in #2684 exists.
    const clock = String.raw`new Date\(\s*(?:Date\.now\(\)\s*)?\)`;
    const iso = String.raw`\.(?:toISOString|toJSON)\(\)`;
    const truncation = String.raw`\.(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)|\.split\(\s*["']T["']\s*\)\s*\[\s*0\s*\]`;
    const utcToday = new RegExp(`${clock}\\s*${iso}\\s*(?:${truncation})`);

    const offenders = listSourceFiles(SOURCE_ROOT).filter((file) =>
      utcToday.test(fs.readFileSync(path.resolve(process.cwd(), file), "utf8")),
    );

    expect(
      offenders,
      "These files derive today's date in UTC. Lodge nights and finance windows are NZ calendar days — use todayDateOnlyForTimeZone() from @/lib/date-only (#2682).",
    ).toEqual([]);
  });

  it("leaves neither public booking form defining a date helper of its own", () => {
    for (const page of [
      // The booking date pickers live in the extracted form components, now under
      // the (website) group (both are real website pages).
      "src/app/(website-dynamic)/booking-requests/booking-request-form.tsx",
      "src/app/(website-dynamic)/school-bookings/school-booking-form.tsx",
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), page), "utf8");
      // The byte-identical private `todayDateOnly()` in both files is what made
      // this a copy-paste defect rather than a one-off; a third public form
      // would have copied it again. Arrow-function and `const` spellings count
      // as "its own helper" too.
      expect(
        /(?:function\s+\w*[Tt]oday\w*\s*\(|(?:const|let)\s+\w*[Tt]oday\w*\s*(?::[^=]+)?=\s*(?:\(|async|function))/.test(
          source,
        ),
        `${page} must not define its own "today" helper — import todayDateOnlyForTimeZone from @/lib/date-only`,
      ).toBe(false);
      /*
        AND IT TAKES "TODAY" FROM THE ONE CANONICAL PLACE, which CT-4 (#2870)
        moved. It used to be `todayDateOnlyForTimeZone` from `@/lib/date-only`,
        which reads `APP_TIME_ZONE`; it is now `useClubTime()` from
        `@/components/club-time-provider`, whose zone is the persisted
        `ClubTimeSettings.timeZone` delivered to the browser as data
        (INV-CONFIG-002). The point of the assertion is unchanged, so the import
        it names moved with the answer rather than being deleted: neither public
        form may invent its own.

        The legacy helper is refused BY NAME as well. Re-adding it would put a
        second temporal authority in a file that already has one, and the two
        agree on every deployment today, so nothing at runtime would say so.
      */
      expect(
        /import\s*\{[^}]*\buseClubTime\b[^}]*\}\s*from\s*["']@\/components\/club-time-provider["']/.test(
          source,
        ),
        `${page} must take the club's today from useClubTime() (@/components/club-time-provider) — the persisted club zone, delivered to the browser as data (CT-4, #2870; INV-CONFIG-002).`,
      ).toBe(true);
      expect(
        /\btodayDateOnlyForTimeZone\s*\(/.test(source),
        `${page} must not also call todayDateOnlyForTimeZone(): that reads APP_TIME_ZONE, the container's TZ, so the file would carry two temporal authorities that agree on every deployment today and therefore nothing would catch the difference (CT-4, #2870).`,
      ).toBe(false);
    }
  });

  it("compares a date of birth against the NZ day, not the raw clock", () => {
    // #2682 moved the profile form's date-of-birth `max` from the UTC day to
    // the NZ day. `parseDateOnly("<NZ day>")` is UTC midnight of that day,
    // which is still in the FUTURE of the raw clock until midday NZ — so a
    // server guard written as `dob > new Date()` would refuse the very date its
    // own picker offers, for the first half of every NZ day. Every guard must
    // compare date-only against date-only.
    const guards = [
      "src/app/api/profile/route.ts",
      "src/app/api/members/family/request-adult/route.ts",
      "src/app/api/members/family/request-child/route.ts",
      "src/app/api/members/family/create-group/route.ts",
      "src/app/api/members/family/[memberId]/details/route.ts",
    ];

    for (const guard of guards) {
      const source = fs.readFileSync(path.resolve(process.cwd(), guard), "utf8");
      expect(
        source.includes("Date of birth cannot be in the future"),
        `${guard} is listed as a date-of-birth guard but no longer refuses a future date`,
      ).toBe(true);
      expect(
        /\b(?:dob|dateOfBirth|childDob)\s*>\s*new Date\(\)/.test(source),
        `${guard} compares a date-only date of birth against the raw clock. Use getTodayDateOnly() so today's NZ date — the date the form's own picker offers — is accepted (#2682).`,
      ).toBe(false);
    }
  });
});
