// @vitest-environment jsdom

// A late failure belongs to the lodge it was taken on (#4975 follow-up).
//
// Chores and Lockers are lodge-scoped. An admin clicks Save, Delete or Toggle
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

type Answer = { status: number; body: unknown };

/** The one request the test holds open, and whether its body was read. */
let releaseHeld: (answer: Answer) => void;
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
  return new Promise<Answer>((resolve) => {
    heldStarted = true;
    releaseHeld = resolve;
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
});
