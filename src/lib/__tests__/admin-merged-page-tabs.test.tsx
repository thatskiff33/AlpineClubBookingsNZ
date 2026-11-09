// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

// ---------------------------------------------------------------------------
// The tabs that hold a merged page (S1 #4796), on their real pages.
//
// Each tab keeps the gate its page had: the Suggestions tab of Family Groups
// and the Settings tab of Membership Cancellations are `membership`, as the
// pages they were (`/admin/family-suggestions`, `/admin/membership-cancellation`)
// were, and each stays read-only for a membership:view admin. The page-level
// admission is the route map's, proven by the parity census and the area pin;
// this suite proves each tab opens from its `?tab=` (the old page's redirect)
// and gates its own controls.
// ---------------------------------------------------------------------------

let sessionMatrix: AdminPermissionMatrix | null = null;
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: sessionMatrix ? { user: { id: "u1", adminPermissionMatrix: sessionMatrix } } : null,
    status: "authenticated",
  }),
}));

let searchParams = new URLSearchParams();
const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}));

function matrix(overrides: Partial<AdminPermissionMatrix>): AdminPermissionMatrix {
  return {
    overview: "view",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...overrides,
  };
}

function stubFetchRoutes(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

import FamilyGroupsPage from "@/app/(admin)/admin/family-groups/page";
import MembershipCancellationsPage from "@/app/(admin)/admin/membership-cancellations/page";

const SUGGESTIONS_VIEW_ONLY = /can view family group suggestions but cannot create, hide, or reset/i;
const SETTINGS_VIEW_ONLY = /can view membership cancellation settings but cannot change/i;

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  routerReplace.mockReset();
  searchParams = new URLSearchParams();
  sessionMatrix = null;
});

describe("Family Groups' Suggestions tab", () => {
  beforeEach(() => {
    stubFetchRoutes({
      "/api/admin/family-groups/requests": { requests: [] },
      "/api/admin/family-groups/partner-invites": { invites: [] },
      "/api/admin/family-groups": { familyGroups: [] },
      "/api/admin/family-suggestions": {
        suggestions: [],
        ungroupedCount: 0,
        totalMembers: 0,
        hiddenCount: 1,
      },
    });
  });

  it("opens on Groups without a tab, and does not load suggestions", async () => {
    sessionMatrix = matrix({ membership: "edit" });
    render(<FamilyGroupsPage />);

    expect(await screen.findByRole("button", { name: /New Group/i })).toBeEnabled();
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    // Every tab has its own h2 under the page's h1.
    expect(screen.getByRole("heading", { level: 1, name: "Family Groups" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Groups" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reset hidden/i })).not.toBeInTheDocument();
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.startsWith("/api/admin/family-suggestions"))).toBe(false);
  });

  it("opens on Suggestions at ?tab=suggestions, read-only for a membership:view admin", async () => {
    searchParams = new URLSearchParams("tab=suggestions");
    sessionMatrix = matrix({ membership: "view" });
    render(<FamilyGroupsPage />);

    expect(await screen.findByText(SUGGESTIONS_VIEW_ONLY)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Family Group Suggestions" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Reset hidden (1)" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Suggestions" })).toHaveAttribute("aria-selected", "true");
    // The Groups tab is not mounted, so its controls are not offered here.
    expect(screen.queryByRole("button", { name: /New Group/i })).not.toBeInTheDocument();
  });

  it("lets a membership:edit admin act on Suggestions", async () => {
    searchParams = new URLSearchParams("tab=suggestions");
    sessionMatrix = matrix({ membership: "edit" });
    render(<FamilyGroupsPage />);

    // The count is in the label once the suggestions have loaded; until then
    // the button is disabled for every admin.
    expect(await screen.findByRole("button", { name: "Reset hidden (1)" })).toBeEnabled();
    expect(screen.queryByText(SUGGESTIONS_VIEW_ONLY)).not.toBeInTheDocument();
  });

  it("puts the tab in the URL, keeping the rest of the query and dropping ?edit", async () => {
    searchParams = new URLSearchParams("edit=g1&q=smith");
    sessionMatrix = matrix({ membership: "edit" });
    render(<FamilyGroupsPage />);

    const tab = await screen.findByRole("tab", { name: "Suggestions" });
    fireEvent.mouseDown(tab);
    expect(routerReplace).toHaveBeenCalledWith("/admin/family-groups?q=smith&tab=suggestions", {
      scroll: false,
    });
  });
});

describe("Membership Cancellations' Settings tab", () => {
  beforeEach(() => {
    stubFetchRoutes({
      "/api/admin/membership-cancellation-settings": {
        settings: {
          warningText: "Warn",
          rejoinProcessText: "Rejoin",
          xeroArchiveContactsOnCancellation: false,
          xeroContactGroups: [],
        },
      },
      "/api/admin/membership-cancellation-requests": { requests: [], total: 0, pendingCount: 0 },
      "/api/admin/member-lifecycle-action-requests": { requests: [], total: 0, pendingCount: 0 },
    });
  });

  it("opens on Requests without a tab", async () => {
    sessionMatrix = matrix({ membership: "edit" });
    render(<MembershipCancellationsPage />);

    expect(await screen.findByRole("heading", { level: 2, name: "Requests" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Membership Cancellations" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save Cancellation Settings/i }),
    ).not.toBeInTheDocument();
  });

  it("opens on Settings at ?tab=settings, read-only for a membership:view admin", async () => {
    searchParams = new URLSearchParams("tab=settings");
    sessionMatrix = matrix({ membership: "view" });
    render(<MembershipCancellationsPage />);

    expect(
      await screen.findByRole("button", { name: /Save Cancellation Settings/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add Group/i })).toBeDisabled();
    expect(screen.getByText(SETTINGS_VIEW_ONLY)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  });

  it("lets a membership:edit admin change the settings", async () => {
    searchParams = new URLSearchParams("tab=settings");
    sessionMatrix = matrix({ membership: "edit" });
    render(<MembershipCancellationsPage />);

    expect(
      await screen.findByRole("button", { name: /Save Cancellation Settings/i }),
    ).toBeEnabled();
    expect(screen.queryByText(SETTINGS_VIEW_ONLY)).not.toBeInTheDocument();
  });

  it("links Email Messages only for an admin who can open it (support)", async () => {
    searchParams = new URLSearchParams("tab=settings");
    sessionMatrix = matrix({ membership: "edit" });
    render(<MembershipCancellationsPage />);
    await screen.findByRole("button", { name: /Save Cancellation Settings/i });
    expect(screen.queryByRole("link", { name: "Email Messages" })).not.toBeInTheDocument();
    cleanup();

    sessionMatrix = matrix({ membership: "edit", support: "view" });
    render(<MembershipCancellationsPage />);
    await screen.findByRole("button", { name: /Save Cancellation Settings/i });
    expect(screen.getByRole("link", { name: "Email Messages" })).toHaveAttribute(
      "href",
      "/admin/email-messages",
    );
  });

  it("goes back to Requests with no tab in the URL", async () => {
    searchParams = new URLSearchParams("tab=settings&x=1");
    sessionMatrix = matrix({ membership: "edit" });
    render(<MembershipCancellationsPage />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Requests" }));
    expect(routerReplace).toHaveBeenCalledWith("/admin/membership-cancellations?x=1", {
      scroll: false,
    });
  });
});
