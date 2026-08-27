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
 * ## THE CARD IS `"use client"`, AND THAT LIMITS WHAT THIS PROVES
 *
 * Saying so plainly, because the passing December case below could otherwise be
 * read as "a December club now sees the right label on this screen". It does
 * not. The year-end month lives in a module cache seeded only by
 * `refreshFinancialYearConfig()`, which reads Prisma and is therefore
 * server-side (`INV-OPS-013`), so in a browser the derivation answers for the
 * March default. Under vitest the module is the same instance the test writes
 * to, which is why `__setFinancialYearEndMonthForTesting` reaches it here.
 *
 * What that buys is not nothing: the RULE is shared, so when the year-end does
 * reach the client the label follows it. And in the browser the label reads the
 * same unseeded cache as the `clubSeasonYear` call beside it, so the two are
 * stale TOGETHER and cannot name different seasons - which is the property
 * `src/lib/season-label.ts` explains at length and #3102 refused to break by
 * plumbing half of it.
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
import { render, screen } from "@/lib/__tests__/support/club-time-render";

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

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
} from "@/lib/financial-year";
import { MemberSeasonalMembershipCard } from "@/app/(admin)/admin/members/[id]/_components/member-seasonal-membership-card";

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
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ membershipTypes: [] }) })),
  );
});

afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
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
    __setFinancialYearEndMonthForTesting(12);

    render(<MemberSeasonalMembershipCard member={member()} onSaved={vi.fn()} />);

    expect(
      screen.getByText("No assignment for 2026 (Jan-Dec)"),
    ).toBeTruthy();
    expect(screen.queryByText(/2026\/2027/)).toBeNull();
    expect(screen.queryByText(/2026 - 2027/)).toBeNull();
  });
});
