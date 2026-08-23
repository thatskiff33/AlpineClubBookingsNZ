// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { APP_TIME_ZONE } from "@/config/operational";
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
 * ## Why `America/Denver`
 *
 * Because `Pacific/Auckland` cannot discriminate. It is what `APP_TIME_ZONE`
 * resolves to under test, so the migrated code and the `formatNZDate` it
 * replaced return the identical string, and an assertion under it would pass
 * against the defect. Denver is behind UTC, which is where these defects show.
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

function renderInClubZone(members: Member[]) {
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
        <ClubTimeProvider zone={CLUB_ZONE}>{children}</ClubTimeProvider>
      ),
    },
  );
}

describe("members list · 'Member since' reads two concepts, not one (CT-4, #2870)", () => {
  afterEach(() => cleanup());

  it("has a premise: the club's zone and the environment's disagree on this instant", () => {
    // Not `expect(APP_TIME_ZONE).not.toBe(CLUB_ZONE)` — an identifier check
    // passes under America/Chicago while the assertions below go vacuous. What
    // has to be true is that the two zones give DIFFERENT ANSWERS here.
    const environmentAnswer = bindClubTime(
      requireClubTimeZone(APP_TIME_ZONE),
    ).instantDate(new Date(WIRE_VALUE));
    const clubAnswer = bindClubTime(requireClubTimeZone(CLUB_ZONE)).instantDate(
      new Date(WIRE_VALUE),
    );
    expect(clubAnswer).not.toBe(environmentAnswer);
    expect(clubAnswer).toBe(DENVER_CIVIL_DAY);
    expect(environmentAnswer).toBe(CALENDAR_DAY);
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
    // Reading the instant in UTC — or in APP_TIME_ZONE — would produce this.
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
});
