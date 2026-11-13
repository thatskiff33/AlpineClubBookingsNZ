// @vitest-environment jsdom

/**
 * A refused family-group save says why (#4976 follow-up).
 *
 * The create form's handler used to `await res.json()` on every failure with no
 * catch, so an HTML 502 from the proxy in front of the app became an unhandled
 * rejection and the officer saw nothing at all. The failure is now read through
 * `apiErrorMessageFromResponse`: the route's own sentence when it sent one,
 * this screen's fallback otherwise.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const EDIT_EVERYTHING: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "u1", adminPermissionMatrix: EDIT_EVERYTHING } },
    status: "authenticated",
  }),
}));

const stableSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => stableSearchParams,
}));

import FamilyGroupsPage from "../page";

const ARIHIA = {
  id: "m1",
  firstName: "Arihia",
  lastName: "Kea",
  email: "arihia@example.test",
  ageLabel: "Adult",
};

function mockSave(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/admin/family-groups" && init?.method === "POST") return answer();
    if (url.startsWith("/api/admin/family-groups/requests")) return Response.json({ requests: [] });
    if (url.startsWith("/api/admin/family-groups/partner-invites")) {
      return Response.json({ invites: [] });
    }
    if (url.startsWith("/api/admin/family-groups/member-search")) {
      return Response.json({ members: [ARIHIA] });
    }
    if (url.startsWith("/api/admin/family-groups")) return Response.json({ familyGroups: [] });
    if (url.startsWith("/api/admin/members")) return Response.json({ members: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function createGroup() {
  render(<FamilyGroupsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /New Group/ }));
  fireEvent.change(screen.getByLabelText("Group Name"), { target: { value: "Kea Family" } });
  fireEvent.change(screen.getByPlaceholderText("Search members by name or email..."), {
    target: { value: "Ari" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /Arihia Kea/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
}

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Family groups: a refused save says why", () => {
  it("shows the route's own sentence from a JSON refusal", async () => {
    mockSave(() => Response.json({ error: "Member not found" }, { status: 404 }));
    await createGroup();

    expect(await screen.findByText("Member not found")).toBeInTheDocument();
  });

  it.each([500, 502])("shows the fallback, not a parse error, for an HTML %i", async (status) => {
    mockSave(
      () =>
        new Response("<html><body>Bad Gateway</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        }),
    );
    await createGroup();

    expect(await screen.findByText("Failed to save")).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });

  it("shows the fallback when the request never gets an answer", async () => {
    mockSave(() => Promise.reject(new TypeError("Failed to fetch")));
    await createGroup();

    expect(await screen.findByText("Failed to save")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("closes the form and reloads the groups on success", async () => {
    const fetchMock = mockSave(() => Response.json({ id: "g1" }, { status: 201 }));
    await createGroup();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Create Group" })).not.toBeInTheDocument(),
    );
    const listReads = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === "/api/admin/family-groups" && init?.method !== "POST",
    );
    expect(listReads.length).toBeGreaterThanOrEqual(2);
  });
});
