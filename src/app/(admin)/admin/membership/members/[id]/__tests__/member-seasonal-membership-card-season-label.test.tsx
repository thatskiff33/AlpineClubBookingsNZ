// @vitest-environment jsdom

/**
 * The admin member card names a season by the club's year-end (#3103).
 *
 * The card kept its own `formatSeasonLabel` returning
 * `${seasonYear}/${seasonYear + 1}`, used in four places. That template asserts
 * a season spans two calendar years, which is false under a December year-end -
 * the season starts in January and `seasonYearOfCalendarDate` returns the
 * calendar year itself, so the label would have contradicted the season the card
 * had selected.
 *
 * ## The year-end arrives as data (#5259)
 *
 * The card is `"use client"`, so it cannot read the server-resolved year-end;
 * the admin layout mounts `ClubSeasonProvider` with it, and the card binds both
 * its fallback season year and every label from `useClubSeason()`. Each case
 * below passes the year-end through that provider, which is the only route it
 * has in production. The process cache is never read.
 *
 * ## Why the assertions are on rendered text
 *
 * The four call sites build sentences (`No assignment for ...`,
 * `<type> for ...`), so asserting the label alone would pass with a site left
 * behind. The `No assignment for` and `Current assignment` cases together reach
 * both of the two sites a card with no preview loaded can render.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

// The shared renderer, not Testing Library directly: this card reads the club's
// zone from `useClubTime()`, which throws deliberately with no provider mounted.
import { render, screen } from "@/lib/__tests__/support/club-season-render";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { MemberSeasonalMembershipCard } from "@/app/(admin)/admin/membership/members/[id]/_components/member-seasonal-membership-card";

type CardMember = ComponentProps<typeof MemberSeasonalMembershipCard>["member"];

function member(overrides: Record<string, unknown> = {}): CardMember {
  return {
    id: "m1",
    role: "MEMBER",
    // The frozen clock is 1 July 2026, which is inside season 2026 under a
    // March year-end (season starts April) and under a December one (season
    // starts January) alike - so the two cases below differ only in the label.
    currentSeasonYear: 2026,
    subscriptions: [],
    seasonalMembershipAssignments: [],
    ...overrides,
  } as unknown as CardMember;
}

const assignment = {
  id: "a1",
  seasonYear: 2026,
  applyFrom: null,
  membershipTypeId: "type-full",
  membershipType: { id: "type-full", name: "Full" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    // Subscription-category decoupling: the card also fetches
    // /api/admin/subscription-categories on mount; one body serves both.
    vi.fn(async () => ({ ok: true, json: async () => ({ membershipTypes: [], subscriptionCategories: [] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MemberSeasonalMembershipCard season naming (#3103)", () => {
  it("names both calendar years under the March default", () => {
    render(<MemberSeasonalMembershipCard member={member()} onSaved={vi.fn()} />);

    expect(
      screen.getByText("No assignment for 2026 - 2027 (Apr-Mar)"),
    ).toBeTruthy();
  });

  it("names the assigned season the same way", () => {
    render(
      <MemberSeasonalMembershipCard
        member={member({ seasonalMembershipAssignments: [assignment] })}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Full for 2026 - 2027 (Apr-Mar)"),
    ).toBeTruthy();
  });

  it("names ONE calendar year under a December year-end", () => {
    // The discriminator. Re-inline the local template and the March cases above
    // still pass while this one fails.
    render(<MemberSeasonalMembershipCard member={member()} onSaved={vi.fn()} />, {
      yearEndMonth: 12,
    });

    expect(
      screen.getByText("No assignment for 2026 (Jan-Dec)"),
    ).toBeTruthy();
    expect(screen.queryByText(/2026\/2027/)).toBeNull();
    expect(screen.queryByText(/2026 - 2027/)).toBeNull();
  });

  it("falls back to the June club's own current season and names it Jul-Jun", () => {
    // No server season on the member, so the card derives one: on the frozen
    // 1 July 2026 a June-year-end club has just started season 2026.
    render(
      <MemberSeasonalMembershipCard
        member={member({ currentSeasonYear: null })}
        onSaved={vi.fn()}
      />,
      { yearEndMonth: 6 },
    );

    expect(screen.getByText("No assignment for 2026 - 2027 (Jul-Jun)")).toBeTruthy();
    expect(screen.queryByText(/Apr-Mar/)).toBeNull();
  });
});
