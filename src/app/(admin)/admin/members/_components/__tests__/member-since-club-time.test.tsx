// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import type { Member } from "../../_types";
import { MemberTable } from "../member-table";

/**
 * "Member since" is the mandatory regression anchor on #2870 (CT-4) — the
 * `joinedDate || createdAt` branch, which is TWO temporal concepts sharing one
 * column and, before this change, one formatter.
 *
 * ## What each branch must do, and why they differ
 *
 * `joinedDate` is a `@db.Date` CALENDAR DATE. 1 April 2026 is 1 April 2026 in
 * every zone on earth, so it must render identically for a club in Ohakune and
 * one in Colorado. Projecting it through a zone is `INV-DATE-019`, and through a
 * zone behind UTC it names the day BEFORE the member joined.
 *
 * `createdAt` is a real INSTANT and has no civil date until a zone is chosen.
 * That zone is the club's persisted one (`INV-CONFIG-002`) — so the very same
 * wire value, `2026-04-01T00:00:00.000Z`, must render as 1 April through the
 * calendar branch and as 31 MARCH through the instant branch for a Denver club.
 *
 * That opposition is the whole test. A single formatter cannot satisfy both, so
 * either mutation — projecting the calendar date, or refusing to project the
 * instant — fails one of the two assertions below.
 *
 * ## Two different claims, and they need two different fixtures
 *
 * This file used to make both claims with one zone and one wire value, and that
 * could not work. They are:
 *
 * 1. **The opposition** — one wire value, two branches, two different strings.
 *    This REQUIRES a club zone behind UTC, and no choice about it is available:
 *    a `@db.Date` column arrives as UTC midnight, so every zone at or ahead of
 *    UTC reads the instant back as the very day the calendar branch renders and
 *    the opposition disappears. `America/Denver` is fixed here for that reason,
 *    and the premise below asserts the opposition really exists rather than
 *    assuming it.
 * 2. **Zone authority** — the club's PERSISTED zone decided this, not
 *    `APP_TIME_ZONE`. That needs the club zone to DISAGREE with the environment,
 *    and at UTC midnight there are only two possible days on earth, both of them
 *    already spoken for by claim 1. So on a behind-UTC host — `TZ=America/Denver`
 *    is the measured case — claim 2 is unsatisfiable at this fixture: the club's
 *    reading and the environment's are the same string, and the old code and the
 *    new code cannot be told apart.
 *
 * Claim 2 therefore gets its own fixture: a MID-DAY instant, where the two
 * candidate club zones straddle the day boundary in opposite directions, so
 * whichever day the environment lands on, one candidate still contradicts it.
 * `chooseDivergentClubZone` makes that choice; see the last test.
 */

/**
 * Fixed, not chosen. See claim 1 above: the opposition only exists for a club
 * zone behind UTC, so there is nothing here to pick between.
 */
const CLUB_ZONE = "America/Denver";

/** The wire value both branches are given, so only the READING can differ. */
const WIRE_VALUE = "2026-04-01T00:00:00.000Z";

/** The calendar day that value encodes — zone-free, so true everywhere. */
const CALENDAR_DAY = "1 Apr 2026";

/** The same instant read in the club's zone. Six hours behind UTC. */
const DENVER_CIVIL_DAY = "31 Mar 2026";

vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const baseMember: Member = {
  id: "member-1",
  title: null,
  firstName: "Alice",
  lastName: "Summit",
  gender: null,
  occupation: null,
  email: "alice@example.test",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: "1990-01-01",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  xeroContactId: null,
  cancelledAt: null,
  cancelledReason: null,
  lifeMemberDate: null,
  comments: null,
  archivedAt: null,
  archivedReason: null,
  xeroContactGroupsLoaded: false,
  xeroContactGroups: [],
  subscriptionStatus: "PAID",
  subscriptionXeroInvoiceId: null,
  createdAt: WIRE_VALUE,
  joinedDate: null,
  forcePasswordChange: false,
  hasCompletedAccountSetup: true,
  pendingInviteExpiresAt: null,
  canLogin: true,
  streetAddressLine1: null,
  streetAddressLine2: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalAddressLine2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  familyGroups: [],
  currentMembershipType: null,
};

function renderInClubZone(members: Member[], zone: string = CLUB_ZONE) {
  return render(
    <MemberTable
      members={members}
      membershipTypes={[]}
      loading={false}
      debouncedSearch=""
      selectedIds={new Set()}
      canEdit
      xeroOrgShortCode={null}
      sortBy="name"
      sortDir="asc"
      membersListPath="/admin/members"
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      onToggleSort={vi.fn()}
      onOpenPasswordActionDialog={vi.fn()}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>
      ),
    },
  );
}

describe("members list · 'Member since' reads two concepts, not one (CT-4, #2870)", () => {
  afterEach(() => cleanup());

  it("has a premise: the OPPOSITION exists — the club's zone reads this wire value as a different day from the one it encodes", () => {
    // This used to compare the club's zone against `APP_TIME_ZONE`, and with
    // `TZ=America/Denver` it went red with a bare
    // `expected '31 Mar 2026' not to be '31 Mar 2026'` — which reads exactly
    // like the product bug the file exists to disprove. That was the wrong
    // premise for these two assertions: what they need is that the two BRANCHES
    // disagree, not that the club and the environment do. Zone authority is a
    // separate claim with its own fixture, in the last test.
    //
    // This premise is true on every host, because both readings are computed
    // from explicit zones and neither consults the machine.
    const clubAnswer = bindClubTime(requireClubTimeZone(CLUB_ZONE)).instantDate(
      new Date(WIRE_VALUE),
    );
    expect(clubAnswer).toBe(DENVER_CIVIL_DAY);
    expect(clubAnswer).not.toBe(CALENDAR_DAY);
  });

  it("renders joinedDate as the stored CALENDAR DAY, with no zone applied", () => {
    renderInClubZone([{ ...baseMember, joinedDate: WIRE_VALUE }]);

    expect(screen.getByText(CALENDAR_DAY)).toBeInTheDocument();
    // Projecting the calendar date through the club's zone would produce this.
    expect(screen.queryByText(DENVER_CIVIL_DAY)).toBeNull();
  });

  it("renders the createdAt fallback as an INSTANT in the club's persisted zone", () => {
    renderInClubZone([{ ...baseMember, joinedDate: null }]);

    expect(screen.getByText(DENVER_CIVIL_DAY)).toBeInTheDocument();
    // Reading the instant in UTC, or refusing to project it at all and treating
    // it as the calendar day it encodes, would produce this instead.
    expect(screen.queryByText(CALENDAR_DAY)).toBeNull();
  });

  it("accepts the bare yyyy-MM-dd spelling of a joinedDate as the same day", () => {
    // Some admin routes hand a `@db.Date` column over as a bare day rather than
    // as Prisma's UTC-midnight ISO. Both name the same civil date and must
    // render alike; a decoder that took only one spelling would throw into the
    // table and blank the members list.
    renderInClubZone([{ ...baseMember, joinedDate: "2026-04-01" }]);

    expect(screen.getByText(CALENDAR_DAY)).toBeInTheDocument();
  });

  /**
   * CLAIM 2: the PERSISTED zone decided this, not the environment's.
   *
   * A mid-day instant, because that is what leaves the choice open. At
   * `2026-04-01T13:00:00Z` a club six hours behind UTC is still on 1 April while
   * one fourteen hours ahead has reached 2 April, so whichever of those two days
   * the environment happens to be on, the other candidate contradicts it. The
   * opposition fixture above cannot do this — see the file docblock.
   *
   * The host is pinned to the environment's own zone for the render. That is not
   * a weakening: it collapses the two ways of being wrong ("read
   * `APP_TIME_ZONE`" and "read the machine") into ONE answer, which the single
   * assertion below then excludes. With the two left free, at date granularity
   * they can occupy both available days between them and no club zone can
   * contradict both.
   */
  it("reads createdAt in the club's PERSISTED zone, not the environment's and not the host's", () => {
    const MID_DAY_INSTANT = "2026-04-01T13:00:00.000Z";
    const chosen = chooseDivergentClubZone({
      subject: "the civil day of a mid-day createdAt",
      answerKey: "civilDay",
      cases: [
        { zone: "America/Denver", civilDay: "1 Apr 2026" }, // −6, still 1 April
        { zone: "Pacific/Kiritimati", civilDay: "2 Apr 2026" }, // +14, already 2 April
      ],
      // An INDEPENDENT oracle, not `bindClubTime`: computing "what this zone
      // would render" through the kernel under test would let one kernel-wide
      // defect satisfy both sides. It also has to accept zones the kernel
      // rightly refuses as a CLUB zone — a runner with `TZ=UTC` makes
      // `APP_TIME_ZONE` a fixed offset, which `requireClubTimeZone` throws on.
      answerFor: (zone) =>
        new Intl.DateTimeFormat(APP_LOCALE, {
          timeZone: zone,
          dateStyle: "medium",
        }).format(new Date(MID_DAY_INSTANT)),
    });
    const environmentDay = new Intl.DateTimeFormat(APP_LOCALE, {
      timeZone: APP_TIME_ZONE,
      dateStyle: "medium",
    }).format(new Date(MID_DAY_INSTANT));
    expect(chosen.civilDay).not.toBe(environmentDay);

    withTimeZone(APP_TIME_ZONE, () => {
      renderInClubZone(
        [{ ...baseMember, joinedDate: null, createdAt: MID_DAY_INSTANT }],
        chosen.zone,
      );
      expect(screen.getByText(chosen.civilDay)).toBeInTheDocument();
      expect(screen.queryByText(environmentDay)).toBeNull();
    });
  });
});
