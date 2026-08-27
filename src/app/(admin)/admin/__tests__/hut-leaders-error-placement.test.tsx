// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";

// #1940: HutLeadersPage reads the session permission matrix for view-only
// gating; provide an edit-level admin session so the error-placement cases keep
// working.
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
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

vi.mock("@/components/admin/occupancy-calendar", () => ({
  OccupancyCalendar: ({
    mode,
    onSelectionChange,
  }: {
    mode: "range" | "single";
    onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
  }) => (
    <div data-testid={`occupancy-calendar-${mode}`}>
      <button
        type="button"
        onClick={() =>
          onSelectionChange(
            mode === "range"
              ? { startDate: "2099-07-10", endDate: "2099-07-12" }
              : { startDate: "2099-07-11", endDate: "2099-07-11" },
          )
        }
      >
        Pick {mode}
      </button>
    </div>
  ),
}));

const OVERLAP_ERROR =
  "Assignment overlaps with Bob Jones's assignment (2026-07-10 to 2026-07-17) by 5 days. Maximum 1 day overlap is allowed for handover.";

const eligibleMember = {
  id: "m1",
  firstName: "Dana",
  lastName: "Diaz",
  email: "dana@test.com",
  hutLeaderEligible: true,
  hutLeaderEligibleAt: null,
  bookingCheckIn: "2099-07-10",
  bookingCheckOut: "2099-07-12",
  suggestedStartDate: "2099-07-10",
  suggestedEndDate: "2099-07-12",
  uncoveredNightCount: 3,
  fullyCovered: false,
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/admin/lodges") {
      return { ok: true, status: 200, json: async () => ({ lodges: [{ id: "lodge-1", name: "Lodge One" }] }) };
    }
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) {
      return { ok: true, json: async () => ({ members: [eligibleMember] }) };
    }
    if (url.startsWith("/api/admin/hut-leaders/unassigned-dates?lodgeId=")) {
      return { ok: true, json: async () => ({ unassignedDates: [] }) };
    }
    // The Confirm click POSTs the assignment; simulate a 409 overlap conflict.
    if (url === "/api/admin/hut-leaders" && method === "POST") {
      return { ok: false, json: async () => ({ error: OVERLAP_ERROR }) };
    }
    if (url.startsWith("/api/admin/hut-leaders?lodgeId=")) {
      return { ok: true, json: async () => ({ assignments: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("hut leaders assignment error placement", () => {
  it("surfaces a POST overlap error in the member card and the page-level alert", async () => {
    stubFetch();
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;

    render(<HutLeadersPage />);

    // Settle the page's lodge scope before touching the mocked calendar
    // (#2944): a click that lands before the lodge-reset effect has run is
    // wiped by it, and step 2 — the member card this case is about — never
    // renders. Ordering, not a timeout; a wider RTL window does not fix it.
    // Mechanism and measurements in the helper.
    await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
    // Calendar-first: pick a range to trigger the eligible-members fetch.
    fireEvent.click(screen.getByRole("button", { name: /pick range/i }));

    // Wait for the member card to render, then select the member (step 2).
    const nameNode = await screen.findByText("Dana Diaz");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    // Confirm (step 3) -> POST returns the overlap error.
    fireEvent.click(await screen.findByRole("button", { name: /confirm assignment/i }));

    // Page-level alert shows the error immediately (the core fix).
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(OVERLAP_ERROR);
    });

    // The same error also renders inside the member's own card.
    const card = nameNode.closest("div.rounded-lg");
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent(OVERLAP_ERROR);
  });
});

/*
 * #2286: the custodian bed hold's admin controls. Two review findings live here.
 *
 * M6 — the over-capacity question appears BELOW the form after a save the server
 * declined to complete, so it must be announced and take focus. Rendering it
 * silently means a keyboard or screen-reader admin presses Confirm, hears
 * nothing, and never learns a second step is waiting.
 *
 * M7 — the PUT route and its three-state `bedId` already existed but nothing
 * called them: a hold could only be removed by DELETING the whole assignment
 * (losing the coverage record and the kiosk PIN), and a hold on a cron-created
 * assignment had no control at all. Every "clear the bed first" refusal
 * elsewhere in the app depends on these two buttons existing.
 */
describe("custodian bed hold controls (#2286)", () => {
  const ASSIGNMENT_WITH_BED = {
    id: "a1",
    memberId: "m1",
    memberName: "Dana Diaz",
    memberEmail: "dana@test.com",
    startDate: "2099-07-10",
    endDate: "2099-07-12",
    createdAt: "2099-01-01T00:00:00.000Z",
    lodgeId: "lodge-1",
    lodgeName: "Silverpeak",
    bedId: "bed-1",
    bedName: "A1",
    bedRoomName: "Kea",
  };

  const OVER_CAPACITY_BODY = {
    error: "Holding that bed puts the lodge over capacity on at least one night.",
    code: "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED",
    nightDetails: [{ date: "2099-07-11", occupiedBeds: 11, capacity: 10 }],
    nonHoldingBookings: [
      {
        id: "booking-override",
        memberName: "Pat Payer",
        checkIn: "2099-07-11",
        checkOut: "2099-07-13",
        guestCount: 3,
        status: "PAYMENT_PENDING",
      },
    ],
  };

  function stubWithAssignment(
    putResponse: { ok: boolean; body: unknown } = { ok: true, body: {} },
  ) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/lodges") {
        return { ok: true, status: 200, json: async () => ({ lodges: [{ id: "lodge-1", name: "Lodge One" }] }) };
      }
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.startsWith("/api/admin/hut-leaders/available-beds")) {
        return { ok: true, status: 200, json: async () => ({ rooms: [] }) };
      }
      if (url.startsWith("/api/admin/hut-leaders/eligible-members")) {
        return { ok: true, json: async () => ({ members: [] }) };
      }
      if (url.startsWith("/api/admin/hut-leaders/unassigned-dates?lodgeId=")) {
        return { ok: true, json: async () => ({ unassignedDates: [] }) };
      }
      if (url === "/api/admin/hut-leaders/a1" && method === "PUT") {
        return {
          ok: putResponse.ok,
          status: putResponse.ok ? 200 : 409,
          json: async () => putResponse.body,
        };
      }
      if (url.startsWith("/api/admin/hut-leaders?lodgeId=")) {
        return {
          ok: true,
          json: async () => ({ assignments: [ASSIGNMENT_WITH_BED] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("releases the bed with ONE explicit null bedId, keeping the assignment", async () => {
    const calls = stubWithAssignment();
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page"))
      .default;
    render(<HutLeadersPage />);

    const release = await screen.findByRole("button", { name: /release bed/i });
    fireEvent.click(release);

    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put).toBeDefined();
      // Explicit null, never an omitted key: to the route, absent means "leave
      // the bed alone", which is the one thing a release must not do.
      expect(put!.body).toEqual({ bedId: null });
      expect(put!.url).toBe("/api/admin/hut-leaders/a1");
    });
    // The assignment itself is NOT deleted.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("announces the over-capacity question, takes focus, and names the uncounted bookings", async () => {
    const calls = stubWithAssignment({ ok: false, body: OVER_CAPACITY_BODY });
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page"))
      .default;
    render(<HutLeadersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /release bed/i }));

    const card = await screen.findByTestId("custodian-over-capacity-confirm");
    // Announced, not merely rendered — and it holds focus, because it appeared
    // below the control the admin just used.
    expect(card).toHaveAttribute("role", "alert");
    // The page focuses the card from an effect, which runs after the node is in
    // the DOM — so `findByTestId` resolving is not proof the effect has flushed.
    // Asserting focus directly races it on a loaded runner.
    await waitFor(() => {
      expect(card).toHaveFocus();
    });
    expect(card).toHaveTextContent("2099-07-11");

    // #2286 review M5: the per-night figures count only capacity-HOLDING
    // bookings, so the overridden booking that will settle onto these nights is
    // invisible to them. It must be named, or the confirmation understates what
    // is being accepted.
    const uncounted = screen.getByTestId("custodian-over-capacity-bookings");
    expect(uncounted).toHaveTextContent("Pat Payer");
    expect(uncounted).toHaveTextContent("PAYMENT_PENDING");

    // Confirming re-sends the SAME action with the override.
    fireEvent.click(screen.getByRole("button", { name: /confirm anyway/i }));
    await waitFor(() => {
      expect(
        calls.filter(
          (call) =>
            call.method === "PUT" &&
            (call.body as { confirmOverCapacity?: boolean })
              ?.confirmOverCapacity === true,
        ),
      ).toHaveLength(1);
    });
  });

  it("offers a bed picker per row, so a cron-created assignment can hold a bed too", async () => {
    stubWithAssignment();
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page"))
      .default;
    render(<HutLeadersPage />);

    fireEvent.click(await screen.findByRole("button", { name: /change bed/i }));
    expect(await screen.findByTestId("bed-picker-a1")).toBeInTheDocument();
  });
});
