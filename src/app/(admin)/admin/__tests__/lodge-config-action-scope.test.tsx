// @vitest-environment jsdom

// A late failure belongs to the lodge it was taken on (#4975 follow-up).
//
// Chores, Lockers and Seasons are lodge-scoped. An admin clicks Save, Delete or Toggle
// on lodge A, switches the lodge select to B, and only then does A's request
// come back refused. The success paths already drop a late response for a lodge
// the admin has left (#2887). A failure must too: it now lands in the
// permanently mounted `FocusedActionError`, which takes focus and scrolls to
// the centre, so a late refusal would pull the admin onto a message about a
// lodge they are no longer looking at.
//
// The lodge select is a native stand-in for the Radix one, so the switch goes
// through the pages' real `handleLodgeChange`, as a user's does.

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LodgeOptionState = {
  lodges: ReadonlyArray<{ id: string; name: string }>;
  loading: boolean;
  failed: boolean;
  forbidden: boolean;
  reload: () => void;
};

const LODGE_A = { id: "lodge-a", name: "Lodge A" };
const LODGE_B = { id: "lodge-b", name: "Lodge B" };

let lodgeOptions: LodgeOptionState;

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/components/lodge-select");
  return {
    ...actual,
    initialLodgeIdFromLocation: () => null,
    useLodgeOptions: () => lodgeOptions,
    LodgeSelect: ({
      lodges,
      value,
      onChange,
    }: {
      lodges: ReadonlyArray<{ id: string; name: string }>;
      value: string | null;
      onChange: (value: string | null, source: "auto" | "user") => void;
    }) => {
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id, "auto");
      }, [lodges, onChange, value]);
      return (
        <select
          aria-label="Lodge"
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value, "user")}
        >
          {lodges.map((lodge) => (
            <option key={lodge.id} value={lodge.id}>
              {lodge.name}
            </option>
          ))}
        </select>
      );
    },
  };
});

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

import ChoresPage from "@/app/(admin)/admin/chores/page";
import LockersPage from "@/app/(admin)/admin/lockers/page";
import SeasonsPage from "@/app/(admin)/admin/rules/seasons/page";

type Answer = { status: number; body: unknown };

/** The one request the test holds open, and whether its body was read. */
let releaseHeld: (answer: Answer) => void;
let failHeld: (reason: unknown) => void;
let heldStarted: boolean;
let heldBodyRead: boolean;

function reply({ status, body }: Answer) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      heldBodyRead = heldBodyRead || status >= 400;
      return body;
    },
  } as unknown as Response;
}

function holdRequest() {
  return new Promise<Answer>((resolve, reject) => {
    heldStarted = true;
    releaseHeld = resolve;
    failHeld = reject;
  });
}

beforeEach(() => {
  heldStarted = false;
  heldBodyRead = false;
  lodgeOptions = {
    lodges: [LODGE_A, LODGE_B],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function actionAlert(id: string) {
  const alert = document.getElementById(id);
  if (!alert) throw new Error(`#${id} is not mounted`);
  return alert;
}

/** The refused request comes back after the admin has moved to lodge B. */
async function refuseAfterSwitch(answer: Answer) {
  await act(async () => {
    releaseHeld(answer);
  });
  await waitFor(() => expect(heldBodyRead).toBe(true));
  // One more turn for the handler's catch to run once the body is read.
  await act(async () => {});
}

describe("a late failure after a lodge switch", () => {
  it("is dropped on Chores", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "PUT") return reply(await holdRequest());
        if (url === "/api/admin/chores?lodgeId=lodge-a") {
          return reply({
            status: 200,
            body: [
              {
                id: "chore-1",
                name: "Breakfast dishes",
                description: null,
                recommendedPeopleMin: 1,
                recommendedPeopleMax: 2,
                isEssential: false,
                ageRestriction: "ANY",
                conditionalNote: null,
                minAge: 0,
                sortOrder: 1,
                timeOfDay: "MORNING",
                frequencyMode: "DAILY",
                frequencyDays: null,
                frequencyDaysOfWeek: [],
                active: true,
              },
            ],
          });
        }
        if (url === "/api/admin/chores?lodgeId=lodge-b") {
          return reply({ status: 200, body: [] });
        }
        throw new Error(`Unstubbed fetch in test: ${method} ${url}`);
      }),
    );
    render(<ChoresPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Deactivate/i }));
    await waitFor(() => expect(heldStarted).toBe(true));

    fireEvent.change(screen.getByLabelText("Lodge"), {
      target: { value: LODGE_B.id },
    });
    expect(
      await screen.findByText(/No chore templates configured yet/),
    ).toBeVisible();

    await refuseAfterSwitch({
      status: 500,
      body: { error: "Lodge A chore failed." },
    });

    expect(screen.queryByText("Lodge A chore failed.")).toBeNull();
    expect(actionAlert("chores-action-error")).toBeEmptyDOMElement();
    expect(document.activeElement).not.toBe(actionAlert("chores-action-error"));
  });

  it("is dropped on Lockers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/admin/lockers/bulk" && method === "POST") {
          return reply(await holdRequest());
        }
        if (url.startsWith("/api/admin/lockers?lodgeId=")) {
          return reply({
            status: 200,
            body: {
              members: [],
              lockers: url.endsWith("lodge-b")
                ? []
                : [
                    {
                      id: "locker-1",
                      name: "Locker A1",
                      allocatedToMemberId: null,
                      allocatedTo: null,
                    },
                  ],
            },
          });
        }
        throw new Error(`Unstubbed fetch in test: ${method} ${url}`);
      }),
    );
    render(<LockersPage />);
    fireEvent.change(await screen.findByLabelText("How many"), {
      target: { value: "3" },
    });
    expect(await screen.findByText("Locker A1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create Lockers" }));
    await waitFor(() => expect(heldStarted).toBe(true));

    fireEvent.change(screen.getByLabelText("Lodge"), {
      target: { value: LODGE_B.id },
    });
    expect(await screen.findByText("No lockers created yet.")).toBeVisible();

    await refuseAfterSwitch({
      status: 500,
      body: { error: "Lodge A bulk create failed." },
    });

    expect(screen.queryByText("Lodge A bulk create failed.")).toBeNull();
    expect(actionAlert("lockers-action-error")).toBeEmptyDOMElement();
    expect(document.activeElement).not.toBe(actionAlert("lockers-action-error"));
  });

  /*
    Seasons has three refusable actions, and each guards a late failure twice
    (`activeScopeRef.current !== requestedScope`): once on a refusal the server
    sent, once in the catch for a request that never arrived. Each case is a
    mutation probe for one guard: delete that guard and only its case fails.
  */
  const SEASON = {
    id: "season-winter",
    name: "Winter 2026",
    type: "WINTER",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
  };

  function stubSeasonsFetch(heldMethod: "PUT" | "DELETE") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === `/api/admin/seasons/${SEASON.id}` && method === heldMethod) {
          return reply(await holdRequest());
        }
        if (url === "/api/admin/seasons?lodgeId=lodge-a") {
          return reply({ status: 200, body: [SEASON] });
        }
        if (url === "/api/admin/seasons?lodgeId=lodge-b") {
          return reply({ status: 200, body: [] });
        }
        throw new Error(`Unstubbed fetch in test: ${method} ${url}`);
      }),
    );
  }

  // The method the test holds open, and the clicks that start the action.
  const SEASON_ACTIONS: Array<[string, "PUT" | "DELETE", () => Promise<unknown>]> = [
    [
      "a toggle",
      "PUT",
      async () =>
        fireEvent.click(
          await screen.findByRole("button", { name: "Deactivate Winter 2026" }),
        ),
    ],
    [
      "a delete",
      "DELETE",
      async () => {
        fireEvent.click(
          await screen.findByRole("button", { name: "Delete Winter 2026" }),
        );
        // Delete asks first through the shared confirmation dialog (#4973); the
        // request this test holds open starts once it is confirmed.
        fireEvent.click(
          within(await screen.findByRole("dialog")).getByRole("button", {
            name: "Delete season",
          }),
        );
      },
    ],
    [
      "a window save",
      "PUT",
      async () => {
        fireEvent.click(
          await screen.findByRole("button", { name: "Edit window of Winter 2026" }),
        );
        fireEvent.click(await screen.findByRole("button", { name: "Update Season" }));
      },
    ],
  ];

  it.each(SEASON_ACTIONS)("is dropped on Seasons for %s", async (_name, heldMethod, startAction) => {
    stubSeasonsFetch(heldMethod);
    render(<SeasonsPage />);
    await startAction();
    await waitFor(() => expect(heldStarted).toBe(true));

    fireEvent.change(screen.getByLabelText("Lodge"), {
      target: { value: LODGE_B.id },
    });
    expect(await screen.findByText(/No seasons configured yet/)).toBeVisible();

    await refuseAfterSwitch({
      status: 500,
      body: { error: "Lodge A season failed." },
    });

    expect(screen.queryByText("Lodge A season failed.")).toBeNull();
    expect(actionAlert("season-action-error")).toBeEmptyDOMElement();
    expect(document.activeElement).not.toBe(actionAlert("season-action-error"));
  });

  it.each(SEASON_ACTIONS)(
    "is dropped on Seasons for %s when the request never arrives",
    async (_name, heldMethod, startAction) => {
      stubSeasonsFetch(heldMethod);
      render(<SeasonsPage />);
      await startAction();
      await waitFor(() => expect(heldStarted).toBe(true));

      fireEvent.change(screen.getByLabelText("Lodge"), {
        target: { value: LODGE_B.id },
      });
      expect(await screen.findByText(/No seasons configured yet/)).toBeVisible();

      // The browser's own wording for a dropped connection.
      await act(async () => {
        failHeld(new TypeError("Failed to fetch"));
      });
      await act(async () => {});

      // The screen's fallback sentence would be the message if the guard were gone.
      expect(actionAlert("season-action-error")).toBeEmptyDOMElement();
      expect(document.activeElement).not.toBe(actionAlert("season-action-error"));
    },
  );
});
