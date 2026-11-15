// @vitest-environment jsdom

/**
 * #4965 — a second tap on Mark Arrived, Mark Departed or a chore must not undo
 * the first, and a failure must not vanish on a timer.
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
const DEPART_PATH = `/api/lodge/guests/${DAY.dateKey}/depart`;
const ROSTER_PATH = `/api/lodge/roster/${DAY.dateKey}`;

type GuestFixture = {
  isArriving: boolean;
  isDeparting: boolean;
  canMarkArrived: boolean;
  canMarkDeparted: boolean;
  arrivedAt: string | null;
  departedAt: string | null;
};

/** Sam as an arriving guest: Mark Arrived is offered, nothing recorded yet. */
const ARRIVING_SAM: GuestFixture = {
  isArriving: true,
  isDeparting: false,
  canMarkArrived: true,
  canMarkDeparted: false,
  arrivedAt: null,
  departedAt: null,
};

/** Sam on the morning he leaves: Mark Departed is offered, nothing recorded. */
const DEPARTING_SAM: GuestFixture = {
  isArriving: false,
  isDeparting: true,
  canMarkArrived: false,
  canMarkDeparted: true,
  arrivedAt: "2026-07-12T02:00:00.000Z",
  departedAt: null,
};

const CHORE_ASSIGNMENT = {
  id: "chore-1",
  choreTemplateId: "template-1",
  choreTemplateName: "Dishes",
  choreDescription: null,
  choreSortOrder: 1,
  choreTimeOfDay: "MORNING",
  bookingGuestId: null,
  guestName: "Pat Chore",
  guestAgeTier: "ADULT",
  bookingId: "booking-1",
  status: "CONFIRMED",
  completedAt: null,
  completedVia: null,
};

function guestsPayload(guest: GuestFixture) {
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
            phone: null,
            ...guest,
          },
        ],
      },
    ],
    totalGuests: 1,
  };
}

type WriteAnswers = {
  arrive?: () => Promise<Response>;
  depart?: () => Promise<Response>;
  chore?: () => Promise<Response>;
};

/**
 * Serves the page's reads, and answers each write with the matching entry in
 * `answers`. Every write's request body is recorded under its name.
 */
function installFetchMock(
  answers: WriteAnswers,
  fixture: { guest?: GuestFixture; assignments?: unknown[] } = {},
) {
  const bodies = {
    arrive: [] as unknown[],
    depart: [] as unknown[],
    chore: [] as unknown[],
  };
  const guest = fixture.guest ?? ARRIVING_SAM;
  const assignments = fixture.assignments ?? [];
  const recordWrite = (
    name: keyof WriteAnswers,
    init: RequestInit | undefined,
  ) => {
    bodies[name].push(JSON.parse(String(init?.body)));
    const answer = answers[name];
    if (!answer) throw new Error(`Unexpected ${name} write`);
    return answer();
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      if (path === ARRIVE_PATH) return recordWrite("arrive", init);
      if (path === DEPART_PATH) return recordWrite("depart", init);
      if (path === ROSTER_PATH && init?.method === "PUT") {
        return recordWrite("chore", init);
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
        return Response.json(guestsPayload(guest));
      }
      if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(path)) {
        return Response.json({ assignments });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
  return bodies;
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
    const { arrive: arrivalBodies } = installFetchMock({
      arrive: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
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

  it("sends one departed:true for a double tap on Mark Departed, busy until it answers", async () => {
    // MUTATION PROBES: invert the wanted state in `toggleDeparture` (or drop the
    // field, which falls back to the server's legacy toggle) and the body below
    // is wrong; delete the in-flight guard and the second tap sends a second.
    let answer: (response: Response) => void = () => {};
    const { depart: departureBodies } = installFetchMock(
      {
        depart: () => new Promise<Response>((resolve) => (answer = resolve)),
      },
      { guest: DEPARTING_SAM },
    );
    const row = await openGuestRow();

    const button = within(row).getByRole("button", { name: "Mark Departed" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(departureBodies).toEqual([{ bookingGuestId: "sam", departed: true }]);
    const busy = within(row).getByRole("button", { name: "Saving…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    fireEvent.click(busy);
    expect(departureBodies).toHaveLength(1);

    await act(async () => {
      answer(
        Response.json({ success: true, departedAt: "2026-07-14T02:00:00.000Z" }),
      );
    });

    const departed = await within(row).findByRole("button", { name: "Departed" });
    expect(departed).toBeEnabled();
    expect(departed).toHaveAttribute("aria-busy", "false");
    expect(departureBodies).toHaveLength(1);
  });

  it("sends departed:false from a stale Departed card, then departed:true from the cleared one", async () => {
    // MUTATION PROBE: send `departed: true` unconditionally and the first body
    // below is wrong — the server would call it a repeat and change nothing, so
    // a stale card from an earlier segment could never be cleared.
    let departedAt: string | null = null;
    const { depart: departureBodies } = installFetchMock(
      {
        depart: async () =>
          Response.json({ success: true, departedAt }),
      },
      {
        guest: {
          ...DEPARTING_SAM,
          departedAt: "2026-07-12T02:00:00.000Z",
        },
      },
    );
    const row = await openGuestRow();

    fireEvent.click(within(row).getByRole("button", { name: "Departed" }));
    expect(departureBodies).toEqual([{ bookingGuestId: "sam", departed: false }]);
    const cleared = await within(row).findByRole("button", { name: "Mark Departed" });

    departedAt = "2026-07-14T02:00:00.000Z";
    fireEvent.click(cleared);
    await within(row).findByRole("button", { name: "Departed" });
    expect(departureBodies).toEqual([
      { bookingGuestId: "sam", departed: false },
      { bookingGuestId: "sam", departed: true },
    ]);
  });
});

describe("kiosk chore ticks: a double tap sends one request (#4965)", () => {
  it("is busy, and refuses the second tap, until the server answers", async () => {
    // MUTATION PROBES: delete the in-flight guard in `useKioskRowActions().run`
    // and the second tap sends a second request; drop `disabled` or `aria-busy`
    // from the chore button and the busy assertions fail.
    let answer: (response: Response) => void = () => {};
    const { chore: choreBodies } = installFetchMock(
      {
        chore: () => new Promise<Response>((resolve) => (answer = resolve)),
      },
      { assignments: [CHORE_ASSIGNMENT] },
    );
    await openGuestRow();

    const button = await screen.findByRole("button", { name: /Pat Chore/ });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(choreBodies).toEqual([{ action: "complete", assignmentId: "chore-1" }]);
    const busy = screen.getByRole("button", { name: /Pat Chore/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(within(busy).getByText("Saving…")).toBeInTheDocument();
    fireEvent.click(busy);
    expect(choreBodies).toHaveLength(1);

    await act(async () => {
      answer(Response.json({ success: true }));
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Pat Chore/ })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: /Pat Chore/ })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(choreBodies).toHaveLength(1);
  });
});

describe("kiosk attendance: a failure stays on screen (#4965)", () => {
  it("is still beside the row long after three seconds, as an alert", async () => {
    // MUTATION PROBE: put back a `setTimeout(..., 3000)` that clears the
    // message and this fails, because `setTimeout` is faked from the tap on.
    installFetchMock({
      arrive: async () => Response.json({ error: "boom" }, { status: 500 }),
    });
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
