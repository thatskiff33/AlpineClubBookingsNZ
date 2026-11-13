// @vitest-environment jsdom

/**
 * A refused work-party delete says why (#4976 follow-up).
 *
 * The handler used to parse the body before checking `res.ok`, with no catch,
 * so an HTML 502 from the proxy in front of the app became an unhandled
 * rejection and the officer saw nothing at all. The failure is now read through
 * `apiErrorMessageFromResponse`: the route's own sentence when it sent one,
 * this screen's fallback otherwise. A 403 keeps its own permission sentence.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/lodge-select")),
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-a", name: "Lodge A" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}));

import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import AdminWorkPartiesPage from "../page";

const BEE = {
  id: "wp-1",
  name: "Spring working bee",
  description: null,
  startDate: "2026-09-12T00:00:00.000Z",
  endDate: "2026-09-13T00:00:00.000Z",
  discountPercent: 100,
  active: true,
  lodgeId: null,
  lodgeName: null,
  bookingCount: 0,
  totalDiscountCents: 0,
};

function mockDelete(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/admin/work-parties/") && init?.method === "DELETE") return answer();
    if (url === "/api/admin/work-parties") return Response.json({ events: [BEE] });
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function deleteBee() {
  render(<AdminWorkPartiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
}

beforeEach(() => {
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Work parties: a refused delete says why", () => {
  it("shows the route's own sentence from a JSON refusal", async () => {
    mockDelete(() => Response.json({ error: "Work party event not found" }, { status: 404 }));
    await deleteBee();

    expect(await screen.findByText("Work party event not found")).toBeInTheDocument();
  });

  it("keeps the permission sentence for a 403", async () => {
    mockDelete(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    await deleteBee();

    expect(await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeInTheDocument();
  });

  it.each([500, 502])("shows the fallback, not a parse error, for an HTML %i", async (status) => {
    mockDelete(
      () =>
        new Response("<html><body>Bad Gateway</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        }),
    );
    await deleteBee();

    expect(await screen.findByText("Failed to delete work party event")).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });

  it("shows the fallback when the request never gets an answer", async () => {
    mockDelete(() => Promise.reject(new TypeError("Failed to fetch")));
    await deleteBee();

    expect(await screen.findByText("Failed to delete work party event")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("reloads the events on success", async () => {
    const fetchMock = mockDelete(() => Response.json({ ok: true }));
    await deleteBee();

    await waitFor(() => {
      const listReads = fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/admin/work-parties",
      );
      expect(listReads.length).toBe(2);
    });
  });
});
