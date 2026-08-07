// @vitest-environment jsdom

/**
 * #2631 — the Departing BADGE and the Mark Departed BUTTON are not the same
 * question, and the kiosk must not treat them as one.
 *
 * `isDeparting` is the operational day: "somebody leaves the lodge today". A
 * sparse stay (nights {11, 14}) leaves the lodge twice — on the 12th and again
 * on the 15th — so the badge is correct on both mornings. The depart endpoint
 * is not the operational day: `findLodgeGuestDepartingOnDate` matches `stayEnd`
 * exactly, deliberately and fencedly (see `lodge-arrive-depart-asymmetry`), so
 * a check-out posted on the 12th 404s and there is nothing the hut leader can
 * do about it. Rendering the button off the badge is therefore a dead end, and
 * these cases pin the split that removes it.
 *
 * Frozen clock discipline: the fixtures are anchored to a fixed instant in
 * July 2026 rather than to the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { buildWeekDateKeys } from "../_components/kiosk-week-view";

// The club's zone, pinned independently of the host's (docs/TESTING.md).
vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: () => null,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

// The sparse stay from the route fixture: nights {2026-07-11, 2026-07-14},
// `stayEnd` 2026-07-15. Present on the 11th, 12th, 14th and 15th, and leaving
// the lodge on the 12th AND the 15th. The two mornings fall in different
// kiosk weeks, so each case opens the kiosk on its own day.
const INTERMEDIATE_DEPARTURE = {
  dateKey: "2026-07-12",
  openLabel: "Open Sunday, 12 July",
};
const FINAL_DEPARTURE = {
  dateKey: "2026-07-15",
  openLabel: "Open Wednesday, 15 July",
};

function guestPayload(opts: { isDeparting: boolean; isFinalDeparture: boolean }) {
  return {
    bookings: [
      {
        bookingId: "booking-1",
        memberName: "Bev Booker",
        expectedArrivalTime: null,
        blockedFromCheckin: false,
        guests: [
          {
            id: "sparse",
            firstName: "Sam",
            lastName: "Sparse",
            ageTier: "ADULT",
            isMember: false,
            isArriving: false,
            arrivedAt: null,
            departedAt: null,
            phone: null,
            ...opts,
          },
        ],
      },
    ],
    totalGuests: 1,
  };
}

/**
 * Serves the kiosk's endpoints with a week that spans both departure mornings,
 * and the given guest payload for whichever day is opened.
 */
function installFetchMock(payload: ReturnType<typeof guestPayload>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;

    if (path === "/api/lodge/access") {
      return Response.json({
        tier: "hut-leader",
        dateRange: null,
        canManageRoster: true,
        canMarkAttendance: true,
        canCompleteChores: true,
        lodgeName: "Whakapapa",
      });
    }

    if (path === "/api/lodge/week") {
      const start = url.searchParams.get("start") ?? "";
      return Response.json({
        start,
        days: buildWeekDateKeys(start).map((date) => ({
          date,
          accessible: true,
          guestCount: 1,
          arrivingCount: 0,
          departingCount: 1,
          rosterStatus: "needs-roster",
        })),
      });
    }

    if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      return Response.json(payload);
    }

    if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      return Response.json({ assignments: [] });
    }

    throw new Error(`Unexpected fetch ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Opens the kiosk's day view on the given morning and returns the guest row. */
async function openGuestRow(day: {
  dateKey: string;
  openLabel: string;
}): Promise<HTMLElement> {
  // 02:00 UTC is mid-afternoon in New Zealand on the same date, so the club's
  // "today" — which is what the kiosk opens on — is the day under test.
  vi.setSystemTime(new Date(`${day.dateKey}T02:00:00.000Z`));

  render(<KioskPage />);

  fireEvent.click(await screen.findByRole("button", { name: day.openLabel }));

  const name = await screen.findByText("Sam Sparse");
  await waitFor(() => expect(screen.getByText("Lodge List")).toBeVisible());
  // The guest row is the flex container holding the name and the badges.
  const row = name.closest("div.flex.items-center.justify-between");
  if (!row) throw new Error("no guest row rendered for Sam Sparse");
  return row as HTMLElement;
}

const hostTimeZone = captureHostTimeZone();

describe("kiosk Mark Departed follows the check-out flag, not the badge (#2631)", () => {
  beforeEach(() => {
    process.env.TZ = "Pacific/Auckland";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.setSystemTime(frozenTestNow());
    hostTimeZone.restore();
  });

  it("an intermediate departure morning shows the Departing chip and NO button", async () => {
    installFetchMock(
      guestPayload({ isDeparting: true, isFinalDeparture: false }),
    );

    const row = await openGuestRow(INTERMEDIATE_DEPARTURE);

    // The badge is right: they really are leaving the lodge this morning.
    expect(within(row).getByText("Departing")).toBeVisible();
    // The button is not offered, because the server would refuse it.
    expect(
      within(row).queryByRole("button", { name: "Mark Departed" }),
    ).toBeNull();
  });

  it("the FINAL departure morning shows the chip and the button together", async () => {
    installFetchMock(
      guestPayload({ isDeparting: true, isFinalDeparture: true }),
    );

    const row = await openGuestRow(FINAL_DEPARTURE);

    expect(within(row).getByText("Departing")).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "Mark Departed" }),
    ).toBeVisible();
  });
});
