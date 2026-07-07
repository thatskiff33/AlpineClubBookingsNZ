// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import {
  buildWeekDateKeys,
  type KioskWeekDaySummary,
} from "../_components/kiosk-week-view";

vi.mock("@/components/theme-switcher", () => ({
  ThemeSwitcher: () => <div data-testid="theme-switcher" />,
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: ({ date }: { date: string }) => (
    <div data-testid="kiosk-instructions">{date}</div>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

function buildWeekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date, index) =>
    index === 0
      ? {
          date,
          accessible: true,
          guestCount: 2,
          arrivingCount: 1,
          departingCount: 0,
          rosterStatus: "needs-roster",
        }
      : {
          date,
          accessible: false,
        }
  );
}

describe("KioskPage week view", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads the week summary by default and drills into the day endpoints", async () => {
    let servedWeekStart = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/lodge/access")) {
        return Response.json({
          tier: "admin",
          dateRange: null,
          canManageRoster: true,
          canMarkAttendance: true,
          canCompleteChores: true,
          lodgeName: "Whakapapa",
        });
      }

      if (url.startsWith("/api/lodge/week?start=")) {
        servedWeekStart = new URL(url, "http://localhost").searchParams.get("start") ?? "";
        return Response.json({
          start: servedWeekStart,
          days: buildWeekDays(servedWeekStart),
        });
      }

      if (url.startsWith(`/api/lodge/guests/${servedWeekStart}`)) {
        return Response.json({
          bookings: [],
          totalGuests: 0,
        });
      }

      if (url.startsWith(`/api/lodge/roster/${servedWeekStart}`)) {
        return Response.json({
          assignments: [],
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<KioskPage />);

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();
    expect(servedWeekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/lodge/week?start="))
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/lodge/guests/"))
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Open / }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === `/api/lodge/guests/${servedWeekStart}?scope=lodge-list`
        )
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/lodge/roster/${servedWeekStart}`
      )
    ).toBe(true);
    expect(screen.getByRole("button", { name: /Week/ })).toBeVisible();

    const weekCallCount = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/lodge/week?start=")
    ).length;
    fireEvent.click(screen.getByRole("button", { name: /Week/ }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/api/lodge/week?start=")
        ).length
      ).toBeGreaterThan(weekCallCount);
    });
  });
});
