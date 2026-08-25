// @vitest-environment jsdom

/**
 * The admin membership-types page names a season by the club's year-end (#3103).
 *
 * This page kept its own `formatSeasonLabel` returning
 * `${seasonYear}/${seasonYear + 1}`, rendered in the roll-forward result banner
 * as "<from> to <to>". The template asserts a season spans two calendar years,
 * which is false under a December year-end.
 *
 * ## THE PAGE IS `"use client"`, SO THE DECEMBER CASE PROVES THE RULE, NOT THE SCREEN
 *
 * The year-end month lives in a module cache seeded only by
 * `refreshFinancialYearConfig()`, which reads Prisma and is therefore
 * server-side (`INV-OPS-013`). In a browser this page's derivation answers for
 * the March default, and it will keep doing so until the year-end reaches the
 * client the way the zone already does. Under vitest the cache is the same
 * module instance the test writes to, which is the only reason
 * `__setFinancialYearEndMonthForTesting` reaches the component here.
 *
 * That is not a hole this change opened. `defaultSeasonYear`, which drives the
 * two roll-forward pickers, reads the SAME unseeded cache - so label and value
 * are stale together and the banner cannot name a season the pickers did not
 * select. #3102 refused to plumb one half without the other for exactly that
 * reason, and `src/lib/season-label.ts` records it.
 *
 * ## `defaultSeasonYear + 1` is arithmetic and must stay
 *
 * The "to season" picker is seeded with `defaultSeasonYear + 1`, which is the
 * NEXT SEASON YEAR rather than the second half of a label. Rewriting it would
 * change which season the page rolls forward into. The banner assertions below
 * pin from-2026/to-2027, so a rewrite there shows up as a wrong season rather
 * than as a wrong string.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The shared renderer, not Testing Library directly: this page derives the
// club's current season from `useClubTime()`, which throws with no provider.
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";

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
import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";

const membershipTypes = [
  {
    id: "type-full",
    key: "FULL",
    name: "Full",
    description: "Default full club membership.",
    publicDescription: "",
    publiclyListed: false,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    assignmentCount: 12,
    allowedAgeTiers: ["INFANT", "CHILD", "YOUTH", "ADULT"],
    xeroContactGroupRules: [],
  },
];

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

/**
 * The frozen clock is 1 July 2026, so the page's own pickers default to season
 * 2026 rolling into 2027 under every year-end this file exercises. The route
 * echoes the seasons it was asked for, as the real one does, so the banner is
 * naming the seasons the page actually selected.
 */
function mockFetch() {
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/membership-types/roll-forward") {
        const payload = JSON.parse(String(init?.body)) as {
          fromSeasonYear: number;
          toSeasonYear: number;
          dryRun: boolean;
        };
        return jsonResponse({
          fromSeasonYear: payload.fromSeasonYear,
          toSeasonYear: payload.toSeasonYear,
          dryRun: payload.dryRun,
          sourceAssignmentCount: 3,
          wouldCopyCount: 3,
          copiedCount: 0,
          skippedExistingCount: 0,
          exceptionCount: 0,
          exceptions: [],
        });
      }
      if (url.startsWith("/api/admin/xero/contact-groups")) {
        return jsonResponse({ groups: [] });
      }
      if (url === "/api/admin/membership-types") {
        return jsonResponse({ membershipTypes });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  );
}

async function previewRollForward() {
  render(<AdminMembershipTypesPage />);
  await waitFor(() => expect(screen.queryByText("Full")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
  await waitFor(() => expect(screen.queryByText("Seasons")).not.toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  global.fetch = fetchMock as typeof fetch;
  mockFetch();
});

afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

describe("AdminMembershipTypesPage season naming (#3103)", () => {
  it("names both calendar years under the March default", async () => {
    await previewRollForward();

    expect(
      screen.queryByText(/2026 - 2027 \(Apr-Mar\) to 2027 - 2028 \(Apr-Mar\)/),
    ).not.toBeNull();
    expect(screen.queryByText(/2026\/2027/)).toBeNull();
  });

  it("names ONE calendar year under a December year-end", async () => {
    // The discriminator: re-inline the local template and the March case above
    // still passes while this one fails.
    __setFinancialYearEndMonthForTesting(12);

    await previewRollForward();

    expect(
      screen.queryByText(/2026 \(Jan-Dec\) to 2027 \(Jan-Dec\)/),
    ).not.toBeNull();
    expect(screen.queryByText(/2026 - 2027/)).toBeNull();
  });
});
