/**
 * The admin layout's year-end wait is bounded (#5259 review).
 *
 * With no override and a cold Xero year-end cache, resolving the club's
 * financial year-end is a live Xero read, which can queue behind another
 * process's token-refresh lease and then call `getOrganisations` with no
 * timeout. The layout awaits it on every admin page, so it must give up after
 * `LAYOUT_YEAR_END_WAIT_MS` and draw with the last month this process resolved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  xeroMonth: vi.fn<() => Promise<number | null>>(),
  warn: vi.fn(),
}));

vi.mock("@/lib/xero-organisation", () => ({
  getXeroFinancialYearEndMonth: mocks.xeroMonth,
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
// No stored override, so the resolution goes on to read Xero.
vi.mock("@/lib/membership-lockout-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/membership-lockout-settings");
  return {
    ...actual,
    loadMembershipLockoutSettings: async () => actual.normalizeMembershipLockoutSettings(null),
  };
});

import {
  __setFinancialYearEndMonthForTesting,
  getFinancialYearEndMonth,
} from "@/lib/financial-year";
import {
  LAYOUT_YEAR_END_WAIT_MS,
  clubFinancialYearEndMonthForLayout,
} from "@/lib/financial-year-server";

describe("clubFinancialYearEndMonthForLayout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.xeroMonth.mockReset();
    mocks.warn.mockReset();
    // This process last resolved a June year-end.
    __setFinancialYearEndMonthForTesting(6);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setFinancialYearEndMonthForTesting(3);
  });

  it("returns the live month when Xero answers inside the wait", async () => {
    mocks.xeroMonth.mockResolvedValue(12);

    await expect(clubFinancialYearEndMonthForLayout()).resolves.toBe(12);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("gives up on a slow Xero after the wait and serves this process's last month", async () => {
    let answer: (month: number) => void = () => undefined;
    mocks.xeroMonth.mockReturnValue(
      new Promise<number>((resolve) => {
        answer = resolve;
      }),
    );

    const month = clubFinancialYearEndMonthForLayout();
    await vi.advanceTimersByTimeAsync(LAYOUT_YEAR_END_WAIT_MS - 1);
    let settled = false;
    void month.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(month).resolves.toBe(6);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackMonth: 6, waitMs: LAYOUT_YEAR_END_WAIT_MS }),
      expect.stringContaining("exceeded the admin layout's wait"),
    );

    // The abandoned read still lands and reseeds the process, so the next
    // page draws with the real month.
    answer(12);
    await vi.waitFor(() => expect(getFinancialYearEndMonth()).toBe(12));
  });

  it("serves this process's last month when the resolution rejects", async () => {
    mocks.xeroMonth.mockRejectedValue(new Error("boom"));

    await expect(clubFinancialYearEndMonthForLayout()).resolves.toBe(6);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
