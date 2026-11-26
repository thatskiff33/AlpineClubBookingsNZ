// @vitest-environment jsdom

/**
 * For a June-year-end club, the season the Subscriptions picker selects is the
 * season the routes behind it default to (#5259).
 *
 * The picker learns the year-end from the admin layout; `GET
 * /api/admin/subscriptions` (no `seasonYear`) and `GET
 * /api/admin/membership-types` (`currentSeasonYear`, which the bulk dialog
 * adopts) resolve it themselves. If one of them read the process cache instead,
 * an officer would see one season picked and be served another. The year-end
 * comes from the stored admin override, so the real resolver runs end to end
 * and no Xero read is reached.
 */
import type { ReactNode } from "react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  memberSubscriptionFindMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipLockoutSettings: {
      findUnique: vi.fn(async () => ({ financialYearEndMonthOverride: 6 })),
    },
    clubTimeSettings: { findUnique: vi.fn(async () => null) },
    memberSubscription: { findMany: db.memberSubscriptionFindMany },
    member: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    membershipType: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, session: { user: { id: "admin-1" } } })),
}));
vi.mock("@/lib/age-tier", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/age-tier")),
  getAgeTierSettings: vi.fn(async () => []),
}));
vi.mock("@/lib/xero-contact-groups", () => ({
  getXeroContactGroupMemberships: vi.fn(async () => ({})),
  getXeroContactIdsForGroup: vi.fn(async () => []),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderHook } from "@testing-library/react";
import { ClubSeasonTestProvider } from "@/lib/__tests__/support/club-season-render";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import { useClubSeason } from "@/components/club-season-provider";
import { clubFinancialYearEndMonth } from "@/lib/financial-year-server";
import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
} from "@/lib/financial-year";
import { GET as getSubscriptions } from "@/app/api/admin/subscriptions/route";
import { GET as getMembershipTypes } from "@/app/api/admin/membership-types/route";

beforeEach(() => {
  // Noon on 15 June 2026 in New Zealand: the last month of a June club's 2025.
  vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
  db.memberSubscriptionFindMany.mockClear();
});

afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
});

describe("a June-year-end club on 15 June 2026", () => {
  it("is served the season its picker selects, by both routes", async () => {
    // What the admin layout hands the page: the server-resolved year-end.
    const yearEndMonth = await clubFinancialYearEndMonth();
    expect(yearEndMonth).toBe(6);
    // Resolving seeds this process's cache as a side effect. A route served by
    // another instance, or before any page render, finds it cold: reset it so a
    // route that read the cache instead of resolving would answer March here.
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);

    const { result } = renderHook(() => useClubSeason().currentSeasonYear(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClubSeasonTestProvider yearEndMonth={yearEndMonth}>{children}</ClubSeasonTestProvider>
      ),
    });
    const pickerSeason = result.current;
    expect(pickerSeason).toBe(2025);

    const subscriptions = await getSubscriptions(
      new NextRequest("http://localhost/api/admin/subscriptions"),
    );
    expect(subscriptions.status).toBe(200);
    expect(db.memberSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ seasonYear: pickerSeason }),
      }),
    );

    // The first route's own resolution reseeded the cache; cold it again.
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    const membershipTypes = await getMembershipTypes(
      new Request("http://localhost/api/admin/membership-types"),
    );
    expect(membershipTypes.status).toBe(200);
    expect((await membershipTypes.json()).currentSeasonYear).toBe(pickerSeason);
  });
});
