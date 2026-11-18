// @vitest-environment jsdom

/**
 * Every lockers read and write says why it failed (ALP-649, #4976 follow-up).
 *
 * The list load, save, delete and bulk create each parsed the reply as JSON
 * before checking `ok`, so an HTML error page from the proxy in front of the
 * app reached the officer as a JSON parse error. Each now throws the refusal
 * through `apiRefusalFromResponse`: the route's own sentence when it sent one,
 * this screen's fallback otherwise, and the fallback again when the request
 * never arrives.
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

import LockersPage from "../page";

const LODGE = { id: "lodge-1", name: "Lodge One", slug: "lodge-one", active: true };
const LOCKER = { id: "locker-1", name: "Locker A1", allocatedToMemberId: null, allocatedTo: null };

type Answer = () => Response | Promise<Response>;

/** Answers the request `target` picks with `answer`; everything else succeeds. */
function stubFetch(target: (url: string, method: string) => boolean, answer: Answer) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (target(url, method)) return answer();
    if (url.startsWith("/api/admin/lodges")) return Response.json({ lodges: [LODGE] });
    if (url.startsWith("/api/admin/lockers")) {
      return method === "GET"
        ? Response.json({ members: [], lockers: [LOCKER] })
        : Response.json({ success: true });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const isList = (url: string, method: string) => url.startsWith("/api/admin/lockers?") && method === "GET";
const isCreate = (url: string, method: string) => url === "/api/admin/lockers" && method === "POST";
const isDelete = (url: string, method: string) => url.startsWith("/api/admin/lockers/locker-1") && method === "DELETE";
const isBulk = (url: string, method: string) => url.startsWith("/api/admin/lockers/bulk") && method === "POST";

async function createLocker(answer: Answer) {
  stubFetch(isCreate, answer);
  render(<LockersPage />);
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Locker B2" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Locker" }));
}

async function deleteLocker(answer: Answer) {
  vi.stubGlobal("confirm", () => true);
  stubFetch(isDelete, answer);
  render(<LockersPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete locker Locker A1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
}

async function bulkCreate(answer: Answer) {
  stubFetch(isBulk, answer);
  render(<LockersPage />);
  fireEvent.change(await screen.findByLabelText("How many"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Lockers" }));
}

beforeEach(() => {
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Lockers: a failed list load says why", () => {
  itShowsEveryRefusal({
    submit: async (answer) => {
      stubFetch(isList, answer);
      render(<LockersPage />);
    },
    fallback: "Failed to load lockers",
  });

  it("lists the lockers when the load succeeds", async () => {
    stubFetch(() => false, () => Response.json({}));
    render(<LockersPage />);
    expect(await screen.findByText("Locker A1")).toBeVisible();
  });
});

describe("Lockers: a refused save says why", () => {
  itShowsEveryRefusal({ submit: createLocker, fallback: "Failed to create locker" });

  it("adds the saved locker to the list", async () => {
    await createLocker(() =>
      Response.json({ locker: { ...LOCKER, id: "locker-2", name: "Locker B2" } }, { status: 201 }),
    );
    expect(await screen.findByText("Locker B2")).toBeVisible();
    expect(document.getElementById("lockers-action-error")).toBeEmptyDOMElement();
  });
});

describe("Lockers: a refused delete says why", () => {
  itShowsEveryRefusal({ submit: deleteLocker, fallback: "Failed to delete locker" });

  it("drops the locker from the list after a successful delete", async () => {
    await deleteLocker(() => Response.json({ success: true }));
    await waitFor(() => expect(screen.queryByText("Locker A1")).not.toBeInTheDocument());
    expect(document.getElementById("lockers-action-error")).toBeEmptyDOMElement();
  });
});

describe("Lockers: a refused bulk create says why", () => {
  itShowsEveryRefusal({ submit: bulkCreate, fallback: "Failed to create lockers" });

  it("reloads the list after a successful bulk create", async () => {
    const fetchMock = stubFetch(isBulk, () => Response.json({ created: 3 }));
    render(<LockersPage />);
    fireEvent.change(await screen.findByLabelText("How many"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Lockers" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url, init]) => isList(String(url), init?.method ?? "GET"))).toHaveLength(2),
    );
    expect(document.getElementById("lockers-action-error")).toBeEmptyDOMElement();
  });
});
