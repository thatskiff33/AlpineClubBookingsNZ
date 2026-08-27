// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";

// #1940: the Hut Leader / Roster pages read the session permission matrix for
// view-only gating; provide an edit-level admin session so the calendar-sync
// cases keep working.
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

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/admin/lodges") {
      return { ok: true, status: 200, json: async () => ({ lodges: [{ id: "lodge-1", name: "Lodge One" }] }) };
    }
    if (url.startsWith("/api/admin/hut-leaders/eligible-members")) {
      return { ok: true, json: async () => ({ members: [] }) };
    }
    if (url.startsWith("/api/admin/hut-leaders/unassigned-dates?lodgeId=")) {
      return { ok: true, json: async () => ({ unassignedDates: [] }) };
    }
    if (url.startsWith("/api/admin/hut-leaders?lodgeId=")) {
      return { ok: true, json: async () => ({ assignments: [] }) };
    }
    if (url.startsWith("/api/admin/roster/")) {
      return {
        ok: true,
        json: async () => ({
          date: "2099-07-11",
          guests: [],
          assignments: [],
          templates: [],
          guestHistory: {},
          guestCount: 0,
        }),
      };
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

describe("occupancy calendar page integration", () => {
  it("syncs Hut Leader date inputs from the range calendar", async () => {
    stubFetch();
    const HutLeadersPage = (await import("@/app/(admin)/admin/hut-leaders/page")).default;

    render(<HutLeadersPage />);
    // Settle BEFORE interacting, and note what this is and is not (#2944).
    // The calendar is mocked, so its button is in the DOM on the commit that
    // first renders the lodge-scoped form — before that commit's passive
    // effects have run, one of which resets the picked range. Clicking into
    // that gap sets the range and then has it wiped, and the SYNCHRONOUS
    // assertion below fails with an empty value. That is an ordering bug, not a
    // slow query: it reproduces with the RTL async window at 4,000ms and
    // `testTimeout` at 60,000ms, and no wider window can fix it. Do not
    // "simplify" this back to an immediate click, and do not wrap the
    // synchronous expectations in `waitFor` — that would convert the bug into a
    // slow pass. Full mechanism in the helper.
    await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
    // Calendar-first: the range picker is visible without opening a form, and
    // by now it must already be there — hence `getByRole`, not `findByRole`.
    fireEvent.click(screen.getByRole("button", { name: /pick range/i }));

    expect(screen.getByLabelText("Start Date")).toHaveValue("2099-07-10");
    expect(screen.getByLabelText("End Date")).toHaveValue("2099-07-12");
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/admin/hut-leaders/eligible-members?startDate=2099-07-10&endDate=2099-07-12&lodgeId="),
      ),
    );
  });

  it("syncs the Roster date input from the single-date calendar", async () => {
    stubFetch();
    const RosterPage = (await import("@/app/(admin)/admin/roster/page")).default;

    render(<RosterPage />);
    // Same settle-before-interact as the Hut Leader case above (#2944): this
    // page gates its date control and its calendar behind one `lodgeScopeReady`
    // check too, so the mocked button is clickable a commit before the page has
    // finished loading. The roster's settled read is the roster itself, for
    // today's (frozen) date.
    await settleLodgeScopedPage("/api/admin/roster/");
    fireEvent.click(screen.getByRole("button", { name: /pick single/i }));

    expect(screen.getByLabelText("Date")).toHaveValue("2099-07-11");
    // #2701: the roster URL always carries `?lodgeId=`, because the page now
    // fetches nothing until a lodge is settled — `stubFetch` answers
    // `/api/admin/lodges` with a single lodge, the selector adopts it
    // (ADR-002), and every roster read is scoped to it. This comment used to
    // say the opposite: that the lodge list was unstubbed and the query string
    // empty. That stopped being true when the stub was added, and the
    // assertion below already expected `?lodgeId=lodge-1`. The fetch also
    // carries an AbortSignal (pre-existing abort-on-date-change pattern,
    // unrelated to lodge scoping).
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/roster/2099-07-11?lodgeId=lodge-1",
        expect.anything(),
      ),
    );
  });
});
