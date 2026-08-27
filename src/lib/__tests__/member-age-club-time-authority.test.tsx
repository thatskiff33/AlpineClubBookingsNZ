// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — a member's AGE YEAR is decided by the club's persisted timezone, on
 * every one of the five surfaces that shows one.
 *
 * ## Why this file exists at all
 *
 * `calculateMemberAgeParts` used to default its reference day to
 * `todayDateOnlyForTimeZone()`, which reads `APP_TIME_ZONE`. On a server that is
 * the CONTAINER's zone; in the browser it is whatever `NEXT_PUBLIC_TZ` was baked
 * into the bundle. `INV-CONFIG-002` says neither is the club's civil-time
 * authority — the persisted `ClubTimeSettings.timeZone` is. And
 * `member-summary-strip.tsx` is `"use client"`, so the age an administrator
 * reads on the member-detail page was being computed IN THE BROWSER from a
 * build-time constant.
 *
 * The default was deleted rather than repaired, so this file's subject is the
 * five callers rather than the helper: the helper can no longer be wrong,
 * because it no longer knows what day it is.
 *
 * ## Why the age year, specifically
 *
 * This is an identity-confirmation surface (#2568). The label is what an
 * administrator reads while deciding WHICH member record a Family Group action
 * applies to, and the case it exists to separate is a parent from a child of the
 * same name. A birthday that lands one day either side of the club's today
 * therefore changes the number on the screen, so the boundary is pinned
 * explicitly below rather than sampled from the middle of a year.
 *
 * ## DISCRIMINATION
 *
 * `APP_TIME_ZONE` is pinned to `America/Denver` — behind Greenwich, which is the
 * side these defects show on — and the persisted club zone is set to something
 * the environment does NOT claim, then MOVED between assertions. Under the
 * frozen clock (`2026-07-01T00:00:00.000Z`) Denver reads 30 June and Auckland
 * reads 1 July, so the two never agree and no assertion here can pass by
 * coincidence. A suite persisting `Pacific/Auckland` while the environment also
 * claims it cannot tell the persisted zone from the environment zone (#3123
 * execution contract), which is why the environment is pinned elsewhere.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const { mockMemberFindMany, mockMemberCount, mockClubTimeSettingsFindUnique } =
  vi.hoisted(() => ({
    mockMemberFindMany: vi.fn(),
    mockMemberCount: vi.fn(),
    mockClubTimeSettingsFindUnique: vi.fn(),
  }));

/*
  THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. `getClubTimeZone`
  is fail-soft on a missing delegate, a throwing query and a missing row, and
  every one of those degrades silently to the environment — so a prisma mock
  without it passes BOTH BEFORE AND AFTER the migration, for exactly the reason
  this file exists to rule out.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mockMemberFindMany, count: mockMemberCount },
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { cleanup, render, screen } from "@testing-library/react";

import { APP_TIME_ZONE } from "@/config/operational";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { MemberSummaryStrip } from "@/app/(admin)/admin/members/[id]/_components/member-summary-strip";
import { searchFamilyGroupCandidateMembers } from "@/lib/admin-family-group-member-search";
import type { MemberDetail } from "@/app/(admin)/admin/members/[id]/_types";

const ENVIRONMENT_ZONE = "America/Denver";
/** 1 July at the frozen instant. The environment is still on 30 June. */
const CLUB_AHEAD = "Pacific/Auckland";
/** Also 1 July, and NOT the zone above — so a hard-coded Auckland still fails. */
const CLUB_FURTHER_AHEAD = "Pacific/Kiritimati";
/** Still 30 June, so a club really on the container's day agrees with it. */
const CLUB_BEHIND = "Pacific/Pago_Pago";

/**
 * A birthday on 1 JULY. At the frozen instant this member has just turned 19 in
 * a club whose day is 1 July, and is still 18 in one whose day is 30 June — so
 * the age YEAR is the assertion, not a formatted string.
 */
const BIRTHDAY_TODAY_IN_CLUB = "2007-07-01";

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({ timeZone });
}

function memberFixture(): MemberDetail {
  return {
    id: "member-1",
    firstName: "Tui",
    lastName: "Kingi",
    email: "tui@kingi.example.org",
    ageTier: "ADULT",
    dateOfBirth: BIRTHDAY_TODAY_IN_CLUB,
    currentSeasonYear: 2026,
    stats: { totalBookings: 0, totalSpendCents: 0, lastStay: null },
  } as unknown as MemberDetail;
}

function renderStripUnderClubZone(zone: string) {
  return render(
    <ClubTimeProvider zone={zone}>
      <MemberSummaryStrip
        member={memberFixture()}
        membershipLabel="Full"
        creditBalance={0}
        creditLoading={false}
      />
    </ClubTimeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(CLUB_AHEAD);
});

afterEach(() => {
  cleanup();
});

describe("PREMISE: the club and the container disagree about today", () => {
  it("pins the environment behind Greenwich, so 30 June and 1 July are both live", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    const now = new Date();
    const inEnvironment = new Intl.DateTimeFormat("en-CA", {
      timeZone: ENVIRONMENT_ZONE,
    }).format(now);
    const inClub = new Intl.DateTimeFormat("en-CA", {
      timeZone: CLUB_AHEAD,
    }).format(now);
    expect(inEnvironment).toBe("2026-06-30");
    expect(inClub).toBe("2026-07-01");
    // Without this leg the suite would pass just as well with the environment
    // read left in place, which is the false green the contract names.
    expect(inEnvironment).not.toBe(inClub);
  });
});

describe("the member-detail summary strip ages the member in the CLUB's day", () => {
  it("shows 19 years on the club's birthday, though the browser bundle is a day behind", () => {
    // BEFORE #3123 this read `APP_TIME_ZONE` from the CLIENT bundle and showed
    // "18 years 11 months" — the member's own birthday, understated by a year,
    // on the screen an administrator uses to confirm which record they have.
    renderStripUnderClubZone(CLUB_AHEAD);
    expect(screen.getByText(/19 years/)).toBeInTheDocument();
    expect(screen.queryByText(/18 years/)).not.toBeInTheDocument();
  });

  it("shows 18 years for a club whose own day has not reached the birthday", () => {
    renderStripUnderClubZone(CLUB_BEHIND);
    expect(screen.getByText(/18 years/)).toBeInTheDocument();
    expect(screen.queryByText(/19 years/)).not.toBeInTheDocument();
  });

  it("follows the provided zone when it MOVES — kills a hard-coded Pacific/Auckland", () => {
    renderStripUnderClubZone(CLUB_FURTHER_AHEAD);
    expect(screen.getByText(/19 years/)).toBeInTheDocument();
    cleanup();
    renderStripUnderClubZone(CLUB_BEHIND);
    expect(screen.getByText(/18 years/)).toBeInTheDocument();
  });
});

describe("the Family Group candidate search ages every row in the CLUB's day", () => {
  function candidateRow() {
    return {
      id: "member-1",
      firstName: "Tui",
      lastName: "Kingi",
      email: "tui@kingi.example.org",
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      dateOfBirth: new Date(`${BIRTHDAY_TODAY_IN_CLUB}T00:00:00.000Z`),
      parentMemberId: null,
      secondaryParentId: null,
      parent: null,
      secondaryParent: null,
    };
  }

  beforeEach(() => {
    mockMemberFindMany.mockResolvedValue([candidateRow()]);
    mockMemberCount.mockResolvedValue(1);
  });

  it("reads the age from the PERSISTED zone, not from the container's", async () => {
    persistClubZone(CLUB_AHEAD);
    const ahead = await searchFamilyGroupCandidateMembers({ q: "Kingi" });
    expect(ahead.members[0].ageLabel).toBe("19 years");

    persistClubZone(CLUB_BEHIND);
    const behind = await searchFamilyGroupCandidateMembers({ q: "Kingi" });
    expect(behind.members[0].ageLabel).toBe("18 years");
  });

  it("follows the persisted zone when it MOVES — kills a hard-coded Pacific/Auckland", async () => {
    persistClubZone(CLUB_FURTHER_AHEAD);
    const result = await searchFamilyGroupCandidateMembers({ q: "Kingi" });
    expect(result.members[0].ageLabel).toBe("19 years");
  });
});
