// @vitest-environment jsdom

/**
 * A refused chore save, delete or active toggle, or a failed list read, says
 * why (ALP-649, #4976 follow-up).
 *
 * Each write handler parsed the reply as JSON before checking `ok`, so an HTML
 * error page from the proxy in front of the app reached the officer as a JSON
 * parse error. The list read showed the browser's own words for a dropped
 * connection and never the route's sentence. Each now throws the refusal through `apiRefusalFromResponse`: the
 * route's own sentence when it sent one, this screen's fallback otherwise, and
 * the fallback again when the request never arrives. A 403 keeps its own
 * permission sentence (pinned in lodge-config-action-attention.test.tsx).
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import ChoresPage from "../page";

const LODGE = { id: "lodge-1", name: "Lodge One", slug: "lodge-one", active: true };
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

type Answer = () => Response | Promise<Response>;

/** Answers the request `target` picks with `answer`; everything else succeeds. */
function stubFetch(target: (url: string, method: string) => boolean, answer: Answer) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (target(url, method)) return answer();
    if (url.startsWith("/api/admin/lodges")) return Response.json({ lodges: [LODGE] });
    if (url.startsWith("/api/admin/chores")) {
      return method === "GET" ? Response.json([CHORE]) : Response.json(CHORE);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const isList = (url: string, method: string) => url.startsWith("/api/admin/chores?") && method === "GET";
const listCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url, init]) => isList(String(url), init?.method ?? "GET"));

async function createChore(answer: Answer) {
  const fetchMock = stubFetch((url, method) => url === "/api/admin/chores" && method === "POST", answer);
  render(<ChoresPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Add Chore/i }));
  fireEvent.change(screen.getByLabelText("Chore Name"), { target: { value: "Lunch dishes" } });
  fireEvent.click(screen.getByRole("button", { name: /Create Chore/i }));
  return fetchMock;
}

async function deleteChore(answer: Answer) {
  const fetchMock = stubFetch((url, method) => url === "/api/admin/chores/chore-1" && method === "DELETE", answer);
  render(<ChoresPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Delete/i }));
  return fetchMock;
}

async function toggleChore(answer: Answer) {
  const fetchMock = stubFetch((url, method) => url === "/api/admin/chores/chore-1" && method === "PUT", answer);
  render(<ChoresPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Deactivate/i }));
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Chores: a refused save says why", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await createChore(answer)), fallback: "Failed to save" });

  it("closes the form and reloads the list after a successful save", async () => {
    const fetchMock = await createChore(() => Response.json(CHORE, { status: 201 }));
    await waitFor(() => expect(screen.queryByLabelText("Chore Name")).not.toBeInTheDocument());
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(2));
    expect(document.getElementById("chores-action-error")).toBeEmptyDOMElement();
  });
});

describe("Chores: a refused delete says why", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await deleteChore(answer)), fallback: "Failed to delete" });

  it("reloads the list after a successful delete", async () => {
    const fetchMock = await deleteChore(() => Response.json({ success: true }));
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(2));
    expect(document.getElementById("chores-action-error")).toBeEmptyDOMElement();
  });
});

describe("Chores: a refused active toggle says why", () => {
  itShowsEveryRefusal({ submit: async (answer) => void (await toggleChore(answer)), fallback: "Failed to update" });

  it("reloads the list after a successful toggle", async () => {
    const fetchMock = await toggleChore(() => Response.json({ ...CHORE, active: false }));
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(2));
    expect(document.getElementById("chores-action-error")).toBeEmptyDOMElement();
  });
});

describe("Chores: a failed list read says why", () => {
  itShowsEveryRefusal({
    submit: async (answer) => {
      stubFetch(isList, answer);
      render(<ChoresPage />);
    },
    fallback: "Failed to fetch chores",
  });

  it("lists the chores when the read succeeds", async () => {
    stubFetch(() => false, () => Response.json([]));
    render(<ChoresPage />);
    expect(await screen.findByText("Breakfast dishes")).toBeInTheDocument();
  });
});
