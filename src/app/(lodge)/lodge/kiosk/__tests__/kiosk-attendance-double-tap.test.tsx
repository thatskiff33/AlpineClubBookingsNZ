// @vitest-environment jsdom

/**
 * #4965 — a second tap on Mark Arrived must not undo the first, and a failure
 * must not vanish on a timer.
 *
 * On slow lodge Wi-Fi nothing used to change while the request travelled, so a
 * hut leader tapped again; the server, a toggle, checked the guest in and then
 * straight back out. The kiosk now sends the state it wants and refuses a
 * second tap on a row whose request is still in flight. Its failure message,
 * once a three-second strip at the top of the page, now stays beside the row
 * that failed with `role="alert"` until it is dismissed.
 *
 * Frozen clock discipline: fixed July 2026 dates, never the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const DAY = { dateKey: "2026-07-14", openLabel: "Open Tuesday, 14 July" };
const ARRIVE_PATH = `/api/lodge/guests/${DAY.dateKey}/arrive`;

function guestsPayload() {
  return {
    bookings: [
      {
        bookingId: "booking-1",
        memberName: "Bev Booker",
        expectedArrivalTime: null,
        blockedFromCheckin: false,
        guests: [
          {
            id: "sam",
            firstName: "Sam",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            isArriving: true,
            isDeparting: false,
            canMarkArrived: true,
            canMarkDeparted: false,
            arrivedAt: null,
            departedAt: null,
            phone: null,
          },
        ],
      },
    ],
    totalGuests: 1,
  };
}

/**
 * Serves the page's reads, and answers each arrival write with `arrive`. Every
 * arrival request body is recorded.
 */
function installFetchMock(arrive: () => Promise<Response>) {
  const arrivalBodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      if (path === ARRIVE_PATH) {
        arrivalBodies.push(JSON.parse(String(init?.body)));
        return arrive();
      }
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
            arrivingCount: 1,
            departingCount: 0,
            rosterStatus: "needs-roster",
          })),
        });
      }
      if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}$/.test(path)) {
        return Response.json(guestsPayload());
      }
      if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(path)) {
        return Response.json({ assignments: [] });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
  return arrivalBodies;
}

async function openGuestRow(): Promise<HTMLElement> {
  vi.setSystemTime(new Date(`${DAY.dateKey}T02:00:00.000Z`));
  renderKiosk();
  fireEvent.click(await screen.findByRole("button", { name: DAY.openLabel }));
  const name = await screen.findByText("Sam Guest");
  const row = name.closest("div.flex.items-center.justify-between");
  if (!row) throw new Error("no guest row rendered for Sam Guest");
  return row as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(frozenTestNow());
});

describe("kiosk attendance: a double tap cannot undo a check-in (#4965)", () => {
  it("sends one request carrying the wanted state, busy until it answers", async () => {
    // MUTATION PROBE: delete the in-flight guard in `useKioskRowActions().run`
    // and the second tap below sends a second request.
    let answer: (response: Response) => void = () => {};
    const arrivalBodies = installFetchMock(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    const row = await openGuestRow();

    const button = within(row).getByRole("button", { name: "Mark Arrived" });
    // Both taps land before React re-renders, as two quick taps on a tablet do.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(arrivalBodies).toEqual([{ bookingGuestId: "sam", arrived: true }]);
    const busy = within(row).getByRole("button", { name: "Saving…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    // A tap on the busy control does nothing either.
    fireEvent.click(busy);
    expect(arrivalBodies).toHaveLength(1);

    await act(async () => {
      answer(
        Response.json({
          success: true,
          arrivedAt: "2026-07-14T02:00:00.000Z",
          departedAt: null,
        }),
      );
    });

    const arrived = await within(row).findByRole("button", { name: "Arrived" });
    expect(arrived).toBeEnabled();
    expect(arrived).toHaveAttribute("aria-busy", "false");
    expect(arrivalBodies).toHaveLength(1);
  });
});

describe("kiosk attendance: a failure stays on screen (#4965)", () => {
  it("is still beside the row long after three seconds, as an alert", async () => {
    // MUTATION PROBE: put back a `setTimeout(..., 3000)` that clears the
    // message and this fails, because `setTimeout` is faked from the tap on.
    installFetchMock(async () =>
      Response.json({ error: "boom" }, { status: 500 }),
    );
    const row = await openGuestRow();

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(`${DAY.dateKey}T02:00:00.000Z`));
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Mark Arrived" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Failed to update arrival");
    // Beside the row that failed, not in a strip at the top of the page.
    expect(row.parentElement).toContainElement(alert);

    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
