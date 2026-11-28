// @vitest-environment jsdom

/**
 * The admin membership-types page names a season by the club's year-end (#3103).
 *
 * This page kept its own `formatSeasonLabel` returning
 * `${seasonYear}/${seasonYear + 1}`, rendered in the roll-forward result banner
 * as "<from> to <to>". The template asserts a season spans two calendar years,
 * which is false under a December year-end.
 *
 * ## The year-end arrives as data (#5259)
 *
 * The page is `"use client"`; the admin layout resolves the club's year-end on
 * the server and mounts `ClubSeasonProvider` with it, and the page derives BOTH
 * `defaultSeasonYear` (the two roll-forward pickers) and the banner's names from
 * `useClubSeason()`. So label and value move together, and each case below
 * passes its year-end through that provider, as production does.
 *
 * ## `defaultSeasonYear + 1` is arithmetic and must stay
 *
 * The "to season" picker is seeded with `defaultSeasonYear + 1`, which is the
 * NEXT SEASON YEAR rather than the second half of a label. Rewriting it would
 * change which season the page rolls forward into. The banner assertions below
 * pin from-2026/to-2027, so a rewrite there shows up as a wrong season rather
 * than as a wrong string.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared renderer, not Testing Library directly: this page derives the
// club's current season from `useClubTime()`, which throws with no provider.
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-season-render";

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

import AdminMembershipTypesPage from "@/app/(admin)/admin/membership/membership-types/page";

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

async function previewRollForward(yearEndMonth?: number) {
  render(<AdminMembershipTypesPage />, { yearEndMonth });
  await waitFor(() => expect(screen.queryByText("Full")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
  await waitFor(() => expect(screen.queryByText("Seasons")).not.toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = fetchMock as typeof fetch;
  mockFetch();
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
    await previewRollForward(12);

    expect(
      screen.queryByText(/2026 \(Jan-Dec\) to 2027 \(Jan-Dec\)/),
    ).not.toBeNull();
    expect(screen.queryByText(/2026 - 2027/)).toBeNull();
  });

  it("rolls a June club from the season it is in, named Jul-Jun", async () => {
    // 1 July 2026 is the first day of a June club's season 2026.
    await previewRollForward(6);

    expect(
      screen.queryByText(/2026 - 2027 \(Jul-Jun\) to 2027 - 2028 \(Jul-Jun\)/),
    ).not.toBeNull();
    expect(screen.queryByText(/Apr-Mar/)).toBeNull();
  });
});
