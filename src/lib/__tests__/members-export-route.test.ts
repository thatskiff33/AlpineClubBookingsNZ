// Issue #1946 review (FIX-1): the members CSV export must emit the cancellation
// date as an NZ date-only value under the "Cancelled At" header so it round-trips
// back through the member import. A full ISO datetime fails the import's
// date-only parser, and its UTC calendar date can trail the NZ date by a day for
// an early-morning-NZ cancellation. These tests drive the real export route and
// feed its output straight back into the import preview.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: vi.fn() },
    clubTimeSettings: { findUnique: vi.fn() },
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi
    .fn()
    .mockResolvedValue({
      showTitle: false,
      showGender: false,
      showOccupation: false,
    }),
}));
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn().mockResolvedValue([]),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { prisma } from "@/lib/prisma";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";
import {
  formatDateOnlyForTimeZone,
  todayDateOnlyForTimeZone,
} from "@/lib/date-only";
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";

/**
 * The club's today, supplied rather than read (#3123): the import preview runs
 * in the browser too, so it takes the day as data. This case asserts a
 * round-tripped 2020 cancellation, well clear of the future-date boundary, so a
 * fixed club day is enough.
 */
const CLUB_TODAY = "2026-07-01";

const adminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

function baseMember(overrides: Record<string, unknown> = {}) {
  return {
    title: null,
    firstName: "Cora",
    lastName: "Cancelled",
    gender: null,
    occupation: null,
    email: "cora@example.com",
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
    role: "USER",
    financeAccessLevel: "NONE",
    ageTier: "ADULT",
    active: false,
    cancelledAt: new Date("2020-06-30T14:30:00.000Z"),
    archivedAt: null,
    xeroContactId: null,
    createdAt: new Date("2019-01-01T00:00:00.000Z"),
    streetAddressLine1: null,
    streetAddressLine2: null,
    streetCity: null,
    streetRegion: null,
    streetCountry: null,
    streetPostalCode: null,
    lifeMemberDate: null,
    comments: null,
    subscriptions: [],
    seasonalMembershipAssignments: [],
    ...overrides,
  };
}

function exportRequest() {
  return exportMembers(
    new NextRequest("http://localhost/api/admin/members/export"),
  );
}

function cellByHeader(csv: string, header: string) {
  const [headerLine, dataLine] = csv.split("\r\n");
  const headers = headerLine.split(",");
  const index = headers.indexOf(header);
  return { index, value: dataLine.split(",")[index] };
}

describe("issue #1946 — members export cancelled date round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminGuard);
    // CT-4 (#2870): the export now reads the club's PERSISTED zone, so #1946's
    // subject — "the NZ calendar date, not the naive UTC slice" — has to say
    // which club it is talking about. Persisting New Zealand makes these three
    // cases answer the same on any host, where before they silently inherited
    // whatever `TZ` the machine had and failed with a bare date mismatch on a
    // developer laptop outside NZ.
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: "Pacific/Auckland",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    } as never);
  });

  it("emits the cancelled date as an NZ date-only, not a full ISO datetime", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([baseMember()] as never);

    const res = await exportRequest();
    expect(res.status).toBe(200);
    const csv = await res.text();

    const { value } = cellByHeader(csv, "Cancelled At");
    // Date-only, no time component.
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value).not.toContain("T");
    // 2020-06-30T14:30Z is 2020-07-01 in NZ winter (+12): the NZ calendar date
    // is one day ahead of the naive UTC slice, which is the bug this fixes.
    // The zone is named rather than defaulted: the helper's default is
    // `APP_TIME_ZONE`, the ENVIRONMENT's opinion, which is no longer the
    // authority the route obeys. Comparing the route's answer against it would
    // be comparing two different authorities and calling agreement a pass.
    expect(value).toBe(
      formatDateOnlyForTimeZone(
        new Date("2020-06-30T14:30:00.000Z"),
        "Pacific/Auckland",
      ),
    );
    expect(value).toBe("2020-07-01");
    expect(value).not.toBe("2020-06-30");
  });

  it("emits an empty cell for a member with no cancellation", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      baseMember({ active: true, cancelledAt: null }),
    ] as never);

    const res = await exportRequest();
    const csv = await res.text();
    const { value } = cellByHeader(csv, "Cancelled At");
    expect(value).toBe("");
  });

  it("round-trips the exported CSV back through the member import cleanly", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([baseMember()] as never);

    const res = await exportRequest();
    const csv = await res.text();

    // Feed the exact exported CSV straight back into the import.
    const parsed = parseMemberImportCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    // The "Cancelled At" header auto-maps to the cancelledDate field.
    expect(mapping.cancelledDate).not.toBeNull();

    const preview = buildMemberImportPreview(parsed.data, mapping, CLUB_TODAY);
    expect(preview.hasErrors).toBe(false);
    // Same NZ calendar date survives the round-trip.
    expect(preview.rows[0].normalizedDateValues.cancelledDate).toBe(
      "2020-07-01",
    );
  });
});

/*
  CT-4 (#2870), epic #2988 — zone AUTHORITY, on the one CSV that carries both
  kinds of temporal value in adjacent columns.

  `Member.cancelledAt` is a bare `DateTime`: a real moment, with no calendar day
  of its own until a zone is chosen. `Member.dateOfBirth` and `lifeMemberDate`
  are `@db.Date`: calendar days, which have no zone to choose. The export must
  therefore treat two neighbouring columns differently, and the whole of #2870 is
  that the codebase used to treat them the same.

  THIS IS WHERE THE PERSISTED ZONE IS OBSERVABLE, which the lodge-night tests in
  `admin-bookings-calendar-route.test.ts` deliberately are not. `APP_TIME_ZONE` —
  what `formatDateOnlyForTimeZone` and every other legacy helper still read — is
  `Pacific/Auckland` here, because CI sets no `TZ` and that is the documented
  fallback. Persisting `America/Denver` therefore makes the two authorities
  DISAGREE, and each assertion below is the Denver answer. Restore the legacy
  helper and every one of them fails with the Auckland answer instead, which is
  what makes them worth running.
*/
describe("members export — the persisted club timezone, not the environment (CT-4, #2870)", () => {
  const CLUB_ZONE_BEHIND_UTC = "America/Denver";
  /** `baseMember()`'s cancellation instant, so the premise can measure it. */
  const CANCELLED_AT = new Date("2020-06-30T14:30:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminGuard);
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: CLUB_ZONE_BEHIND_UTC,
      updatedByMemberId: null,
      updatedAt: new Date(0),
    } as never);
  });

  it("renders an instant in the persisted zone and a calendar day untouched", async () => {
    // THE PREMISE, ASSERTED AS AN ANSWER RATHER THAN AN IDENTIFIER. What has to
    // be true for the cell below to discriminate is that the ENVIRONMENT
    // authority — which is what `formatDateOnlyForTimeZone` reads, and what this
    // route used to call — names a different day from the persisted one. Naming
    // the two zone IDENTIFIERS and asserting they differ does NOT establish
    // that: measured, `TZ=America/Chicago` gives Denver's answer for every
    // fixture in this file, so the identifier check passes while the assertion
    // goes vacuous.
    //
    // `APP_TIME_ZONE` IS PASSED ON PURPOSE (#3123): the environment authority
    // is this premise's whole subject, and naming any other zone would make the
    // disagreement a coincidence between two literals instead of a measurement
    // of the authority the route must NOT be obeying.
    expect(
      formatDateOnlyForTimeZone(CANCELLED_AT, APP_TIME_ZONE),
      "INV-CONFIG-002: the environment authority now agrees with the persisted " +
        "club zone about this instant, so this cell can no longer tell which of " +
        "the two the route obeyed. Pick a fixture where they disagree.",
    ).not.toBe("2020-06-30");

    vi.mocked(prisma.member.findMany).mockResolvedValue([
      baseMember({
        // A `@db.Date` calendar day, as Prisma returns it: UTC midnight.
        dateOfBirth: new Date("1990-04-16T00:00:00.000Z"),
        lifeMemberDate: new Date("2015-01-01T00:00:00.000Z"),
      }),
    ] as never);

    const res = await exportRequest();
    const csv = await res.text();

    // THE INSTANT. 14:30 UTC on 30 June 2020 is 08:30 the same morning in
    // Denver and 02:30 the NEXT day in Auckland, so the two authorities give
    // different days and this cell says which one was consulted.
    expect(cellByHeader(csv, "Cancelled At").value).toBe("2020-06-30");

    // THE CALENDAR DAYS. Unchanged by the club's zone, in either direction —
    // projecting them through Denver would return the 15th and 31 December.
    expect(cellByHeader(csv, "Date of Birth").value).toBe("1990-04-16");
    expect(cellByHeader(csv, "Life Member Date").value).toBe("2015-01-01");
  });

  it("stamps the download filename with the club's calendar day, not the host's", async () => {
    // Same premise, same reason: the environment's "today" must not already be
    // the club's, or the filename below proves nothing. `APP_TIME_ZONE` is
    // passed on purpose, for the reason given in the case above (#3123).
    expect(
      todayDateOnlyForTimeZone(APP_TIME_ZONE),
      "INV-CONFIG-002: the environment authority already names the club's day, " +
        "so this filename cannot tell the two apart.",
    ).not.toBe("2026-06-30");

    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);

    const res = await exportRequest();

    // The suite's frozen clock is 2026-07-01T00:00:00Z — midday in New Zealand,
    // and still the EVENING OF 30 JUNE in Denver. A club there must not have
    // yesterday's export named for tomorrow.
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="tac-members-2026-06-30.csv"',
    );
  });
});
