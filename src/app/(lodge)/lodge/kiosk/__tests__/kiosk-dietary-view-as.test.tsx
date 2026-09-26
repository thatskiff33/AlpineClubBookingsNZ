// @vitest-environment jsdom

/**
 * #3029 S4 (`INV-PRIV-022`): the kiosk's "Viewing as" preview shows a Full
 * Admin what the SIMULATED tier would see. The day-list route sends the
 * dietary notes to the admin's real tier, so the page must withhold them while
 * the admin simulates the lodge wall or a staying guest — those tiers never
 * receive the notes at all.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderKiosk } from "./helpers/kiosk-harness";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { buildWeekDateKeys } from "../_components/kiosk-week-view";

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: () => null,
}));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

const NOTE = "Severe peanut allergy";

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      if (path === "/api/lodge/access") {
        return Response.json({
          tier: "admin",
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
            arrivingCount: 1,
            departingCount: 0,
            rosterStatus: "needs-roster",
          })),
        });
      }
      if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}$/.test(path)) {
        return Response.json({
          bookings: [
            {
              bookingId: "booking-1",
              memberName: "Bev Booker",
              expectedArrivalTime: null,
              blockedFromCheckin: false,
              guests: [
                {
                  id: "g1",
                  firstName: "Aroha",
                  lastName: "Guest",
                  ageTier: "ADULT",
                  isMember: true,
                  isArriving: true,
                  isDeparting: false,
                  canMarkArrived: false,
                  canMarkDeparted: false,
                  arrivedAt: null,
                  departedAt: null,
                  phone: null,
                  dietaryRequirements: NOTE,
                },
              ],
            },
          ],
          totalGuests: 1,
        });
      }
      if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(path)) {
        return Response.json({ assignments: [] });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
}

describe("kiosk dietary notes follow the simulated tier (#3029 S4)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.setSystemTime(frozenTestNow());
  });

  it("shows the note as admin and hut leader, and hides it as lodge or staying guest", async () => {
    installFetchMock();
    vi.setSystemTime(new Date("2026-07-12T02:00:00.000Z"));
    renderKiosk();
    fireEvent.click(await screen.findByRole("button", { name: "Open Sunday, 12 July" }));
    await screen.findByText("Aroha Guest");
    expect(screen.getByText(NOTE)).toBeVisible();

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "hut-leader" } });
    expect(screen.getByText(NOTE)).toBeVisible();

    for (const tier of ["lodge", "staying-guest"]) {
      fireEvent.change(select, { target: { value: tier } });
      expect(screen.queryByText(NOTE), tier).toBeNull();
    }
  });
});
