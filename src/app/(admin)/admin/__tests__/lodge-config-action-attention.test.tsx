// @vitest-environment jsdom

// Chores, Lockers and Lodges: an admin ACTION's failure takes focus; a passive
// READ's failure does not (#4975 follow-up).
//
// All three screens used to write every failure — a failed list load, a failed
// save, a failed delete clicked in a table row far below — into ONE page-level
// string rendered as a plain box. The box appeared somewhere else on the page
// and nothing moved, so a keyboard or screen-reader admin was left on the
// re-enabled button with no idea the action had failed. Each screen now keeps
// the two apart: the read failure stays passive, and the action failure goes
// through the permanently mounted `FocusedActionError`.
//
// Every case asserts the half a page that never positions at all would fail, so
// "nothing moved" is never the only evidence.

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  expectRecoveryAlertToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The permission gate is not under test; every case here is an edit-capable
// admin whose action the server then refuses or fails.
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
}));

import ChoresPage from "@/app/(admin)/admin/chores/page";
import LockersPage from "@/app/(admin)/admin/lockers/page";
import AdminLodgesPage from "@/app/(admin)/admin/lodges/page";

type Handler = (
  url: string,
  method: string,
) => { status: number; body: unknown } | undefined;

const LODGE = { id: "lodge-1", name: "Lodge One", slug: "lodge-one", active: true };

let handler: Handler;
let scrollHost: HTMLElement;
let scrollTo: ReturnType<typeof vi.fn<(options?: ScrollToOptions) => void>>;

function respond(url: string, method: string) {
  const answer = handler(url, method);
  if (answer) return answer;
  if (url.startsWith("/api/admin/lodges")) {
    return { status: 200, body: { lodges: [LODGE] } };
  }
  if (url.startsWith("/api/admin/modules")) {
    return { status: 200, body: { settings: { bedAllocation: false } } };
  }
  if (url.startsWith("/api/admin/other-lodges")) {
    return { status: 200, body: { lodges: [] } };
  }
  throw new Error(`Unstubbed fetch in test: ${method} ${url}`);
}

beforeEach(() => {
  installScrollIntoViewSpy();
  // The admin layout scrolls inside an `overflow-y-auto` main; without one the
  // success position would find no container and "did not scroll" would pass
  // for the wrong reason.
  scrollHost = document.createElement("main");
  scrollHost.style.overflowY = "auto";
  scrollTo = vi.fn<(options?: ScrollToOptions) => void>();
  scrollHost.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  document.body.append(scrollHost);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { status, body } = respond(String(input), init?.method ?? "GET");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
  scrollHost.remove();
  vi.unstubAllGlobals();
});

function actionAlert(id: string) {
  const alert = document.getElementById(id);
  if (!alert) throw new Error(`#${id} is not mounted`);
  return alert;
}

/** Hand focus back to the control, as an admin trying again would. */
function refocus(control: HTMLElement) {
  act(() => control.focus());
  expect(document.activeElement).toBe(control);
}

describe("Chores action attention", () => {
  const CHORE = {
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
  };

  it("shows a failed list load without taking focus", async () => {
    handler = (url) =>
      url.startsWith("/api/admin/chores")
        ? { status: 500, body: {} }
        : undefined;
    render(<ChoresPage />, { container: scrollHost });

    expect(await screen.findByText("Failed to fetch chores")).toBeVisible();
    expect(actionAlert("chores-action-error")).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses a failed toggle, and again when the same failure repeats", async () => {
    handler = (url, method) => {
      if (!url.startsWith("/api/admin/chores")) return undefined;
      if (method === "PUT") {
        return { status: 409, body: { error: "Chore is in use." } };
      }
      return { status: 200, body: [CHORE] };
    };
    render(<ChoresPage />, { container: scrollHost });
    const toggle = await screen.findByRole("button", { name: /Deactivate/i });

    fireEvent.click(toggle);
    const alert = actionAlert("chores-action-error");
    await waitFor(() => expect(alert).toHaveTextContent("Chore is in use."));
    await expectRecoveryAlertToHoldFocus(alert);

    refocus(toggle);
    fireEvent.click(toggle);
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("puts a refused delete in the focused alert", async () => {
    vi.stubGlobal("confirm", () => true);
    handler = (url, method) => {
      if (!url.startsWith("/api/admin/chores")) return undefined;
      if (method === "DELETE") return { status: 403, body: {} };
      return { status: 200, body: [CHORE] };
    };
    render(<ChoresPage />, { container: scrollHost });

    fireEvent.click(await screen.findByRole("button", { name: /Delete/i }));
    const alert = actionAlert("chores-action-error");
    await waitFor(() =>
      expect(alert).toHaveTextContent(ADMIN_FORBIDDEN_SAVE_REASON),
    );
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("positions at the top of the page when a save lands", async () => {
    handler = (url, method) => {
      if (!url.startsWith("/api/admin/chores")) return undefined;
      if (method === "POST") return { status: 201, body: CHORE };
      return { status: 200, body: [] };
    };
    render(<ChoresPage />, { container: scrollHost });
    fireEvent.click(await screen.findByRole("button", { name: /Add Chore/i }));
    fireEvent.change(screen.getByLabelText("Chore Name"), {
      target: { value: "Breakfast dishes" },
    });
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Create Chore/i }));

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" }),
    );
    expect(actionAlert("chores-action-error")).toBeEmptyDOMElement();
  });
});

describe("Lockers action attention", () => {
  const LOCKER = {
    id: "locker-1",
    name: "Locker A1",
    allocatedToMemberId: null,
    allocatedTo: null,
  };

  it("shows a failed list load in the list without taking focus", async () => {
    handler = (url) =>
      url.startsWith("/api/admin/lockers")
        ? { status: 500, body: { error: "Lockers are unavailable." } }
        : undefined;
    render(<LockersPage />);

    expect(await screen.findByText("Lockers are unavailable.")).toBeVisible();
    expect(actionAlert("lockers-action-error")).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses a delete failure clicked in the table, and again on a repeat", async () => {
    handler = (url, method) => {
      if (!url.startsWith("/api/admin/lockers")) return undefined;
      if (method === "DELETE") {
        return { status: 409, body: { error: "Locker is allocated." } };
      }
      return { status: 200, body: { members: [], lockers: [LOCKER] } };
    };
    render(<LockersPage />);
    const remove = await screen.findByRole("button", {
      name: "Delete locker Locker A1",
    });

    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const alert = actionAlert("lockers-action-error");
    await waitFor(() => expect(alert).toHaveTextContent("Locker is allocated."));
    await expectRecoveryAlertToHoldFocus(alert);

    refocus(remove);
    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await expectRecoveryAlertToHoldFocus(alert);
    // An action failure leaves the list it was taken from on screen.
    expect(screen.getByText("Locker A1")).toBeVisible();
  });

  it("puts a refused bulk create in the focused alert", async () => {
    handler = (url, method) => {
      if (url.startsWith("/api/admin/lockers/bulk") && method === "POST") {
        return { status: 403, body: {} };
      }
      if (url.startsWith("/api/admin/lockers")) {
        return { status: 200, body: { members: [], lockers: [] } };
      }
      return undefined;
    };
    render(<LockersPage />);
    fireEvent.change(await screen.findByLabelText("How many"), {
      target: { value: "3" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Lockers" }));
    const alert = actionAlert("lockers-action-error");
    await waitFor(() =>
      expect(alert).toHaveTextContent(ADMIN_FORBIDDEN_SAVE_REASON),
    );
    await expectRecoveryAlertToHoldFocus(alert);
  });
});

describe("Lodges action attention", () => {
  it("shows a failed list load without taking focus", async () => {
    handler = (url) =>
      url === "/api/admin/lodges" ? { status: 500, body: {} } : undefined;
    render(<AdminLodgesPage />, { container: scrollHost });

    expect(
      await screen.findByText("Could not load lodges. Please try again."),
    ).toBeVisible();
    expect(actionAlert("lodges-page-error")).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses a failed deactivation, keeps the list, and re-focuses a repeat", async () => {
    handler = (url, method) =>
      url === `/api/admin/lodges/${LODGE.id}` && method === "PATCH"
        ? { status: 409, body: { error: "At least one lodge must stay active." } }
        : undefined;
    render(<AdminLodgesPage />, { container: scrollHost });
    const deactivate = await screen.findByRole("button", { name: "Deactivate" });

    fireEvent.click(deactivate);
    const alert = actionAlert("lodges-page-error");
    await waitFor(() =>
      expect(alert).toHaveTextContent("At least one lodge must stay active."),
    );
    await expectRecoveryAlertToHoldFocus(alert);
    // The failure is about one action; it does not replace the lodge list or
    // lock Add lodge the way a failed load does.
    expect(screen.getByText("Lodge One")).toBeVisible();
    expect(screen.getByRole("button", { name: /Add lodge/i })).toBeEnabled();

    refocus(deactivate);
    fireEvent.click(deactivate);
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("positions at the top of the page when an edit save lands", async () => {
    handler = (url, method) =>
      url === `/api/admin/lodges/${LODGE.id}` && method === "PATCH"
        ? { status: 200, body: { lodge: LODGE } }
        : undefined;
    render(<AdminLodgesPage />, { container: scrollHost });
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" }),
    );
    expect(actionAlert("lodges-page-error")).toBeEmptyDOMElement();
  });

  it("does not position at the top when an edit save is refused", async () => {
    handler = (url, method) =>
      url === `/api/admin/lodges/${LODGE.id}` && method === "PATCH"
        ? { status: 403, body: {} }
        : undefined;
    render(<AdminLodgesPage />, { container: scrollHost });
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    const alert = actionAlert("lodges-page-error");
    await waitFor(() =>
      expect(alert).toHaveTextContent(ADMIN_FORBIDDEN_SAVE_REASON),
    );
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
