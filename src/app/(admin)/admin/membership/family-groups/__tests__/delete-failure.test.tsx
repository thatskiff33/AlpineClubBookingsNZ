// @vitest-environment jsdom

// #4976: a refused family-group delete used to leave the row in place with no
// message — the page's only error text sits inside the edit form, which is
// hidden while the officer is looking at the list. A second officer deleting a
// group someone else already removed got a 404 and nothing at all, so they kept
// clicking. The refusal now shows above the list, read through the shared
// error-message helper so an HTML error page cannot become a parse error.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import {
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

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

import FamilyGroupsPage from "@/app/(admin)/admin/membership/family-groups/page";

const SMITH = {
  id: "g1",
  name: "Smith Family",
  members: [],
  memberCount: 0,
  inactiveCount: 0,
  pendingRequests: 0,
  createdAt: "2026-04-15T23:30:00.000Z",
};

let deleteResponse: () => Response;
let listFetches = 0;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return deleteResponse();
      if (url.startsWith("/api/admin/family-groups/requests")) {
        return Response.json({ requests: [] });
      }
      if (url.startsWith("/api/admin/family-groups/partner-invites")) {
        return Response.json({ invites: [] });
      }
      if (url.startsWith("/api/admin/family-groups/g1")) {
        return Response.json({ ...SMITH, members: [] });
      }
      if (url.startsWith("/api/admin/family-groups")) {
        listFetches += 1;
        return Response.json({ familyGroups: [SMITH] });
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

async function clickDelete() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete Smith Family" }));
}

beforeEach(() => {
  listFetches = 0;
  installScrollIntoViewSpy();
  stubFetch();
  vi.stubGlobal("confirm", () => true);
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

describe("family groups: a refused delete is visible (#4976)", () => {
  it("shows the server's sentence for a 404 above the list, with the form closed", async () => {
    deleteResponse = () => Response.json({ error: "Family group not found" }, { status: 404 });
    render(<FamilyGroupsPage />);
    await clickDelete();

    const alert = await screen.findByText("Family group not found");
    expect(alert.closest('[role="alert"]')).toBeVisible();
    expect(screen.queryByRole("region", { name: /Smith Family/i })).not.toBeInTheDocument();
  });

  it("shows the fallback, not a parse error, for an HTML 500", async () => {
    deleteResponse = () =>
      new Response("<html>Bad gateway</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    render(<FamilyGroupsPage />);
    await clickDelete();

    expect(await screen.findByText("Failed to delete family group")).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });

  it("shows the fallback when the request never reaches the server", async () => {
    deleteResponse = () => {
      throw new TypeError("Failed to fetch");
    };
    render(<FamilyGroupsPage />);
    await clickDelete();

    expect(await screen.findByText("Failed to delete family group")).toBeInTheDocument();
  });

  it("refreshes the list on success and shows no error", async () => {
    deleteResponse = () => Response.json({ success: true });
    render(<FamilyGroupsPage />);
    await clickDelete();

    await waitFor(() => expect(listFetches).toBe(2));
    expect(screen.queryByText("Failed to delete family group")).not.toBeInTheDocument();
  });

  it("drops the list error once the edit form opens", async () => {
    deleteResponse = () => Response.json({ error: "Family group not found" }, { status: 404 });
    render(<FamilyGroupsPage />);
    await clickDelete();
    await screen.findByText("Family group not found");

    fireEvent.click(screen.getByRole("button", { name: "Edit Smith Family" }));

    await screen.findByRole("region", { name: /Smith Family/i });
    expect(screen.queryByText("Family group not found")).not.toBeInTheDocument();
  });
});
