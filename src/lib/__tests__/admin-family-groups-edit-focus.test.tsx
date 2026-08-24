// @vitest-environment jsdom

// #2256: on /admin/family-groups the create/edit form renders in one anchor
// below the filter card and the two queue cards, while its triggers sit
// elsewhere — New Group in the page header, Edit on a row in the groups table
// below. Either way the form could open entirely off-screen: the viewport never
// moved and the button looked dead. These cases pin the fix — every open (first
// open, same group re-opened, close-then-reopen, switching groups, and the
// create form) moves the viewport and focus to the form, the row being edited
// says so, focus goes back to the trigger on close, and the landmark/tabstop
// exist only while the form is open.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
// NOT bare `@testing-library/react`: since CT-4 (#2870) this tree reads the
// club's zone from `ClubTimeProvider`, and `useClubTime()` throws without one —
// deliberately, so a tree that forgot to mount it fails loudly instead of
// rendering a plausible wrong day. The support wrapper mounts it with
// `CLUB_TIME_TEST_ZONE`, which is the zone this suite's expectations already
// assumed, so no assertion here changes meaning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const routerReplace = vi.fn();
const stableSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn() }),
  // One stable instance: the page's mount effect depends on the searchParams
  // identity, and a fresh object per render would refetch in a loop.
  useSearchParams: () => stableSearchParams,
}));

// Imported after the mocks are registered.
import FamilyGroupsPage from "@/app/(admin)/admin/family-groups/page";

const KEA = {
  id: "g1",
  name: "Kea Family",
  members: [],
  memberCount: 0,
  inactiveCount: 0,
  pendingRequests: 0,
  createdAt: "2026-04-15T23:30:00.000Z",
};
const TUI = { ...KEA, id: "g2", name: "Tui Family" };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/admin/family-groups/requests")) {
        return jsonResponse({ requests: [] });
      }
      if (url.startsWith("/api/admin/family-groups/partner-invites")) {
        return jsonResponse({ invites: [] });
      }
      // The inline editor's own detail fetch returns the group directly.
      if (url.startsWith("/api/admin/family-groups/g")) {
        const id = url.includes("g2") ? "g2" : "g1";
        return jsonResponse({
          id,
          name: id === "g2" ? "Tui Family" : "Kea Family",
          createdAt: KEA.createdAt,
          members: [],
        });
      }
      if (url.startsWith("/api/admin/family-groups")) {
        return jsonResponse({ familyGroups: [KEA, TUI] });
      }
      if (url.startsWith("/api/admin/members")) {
        return jsonResponse({ members: [] });
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

describe("FamilyGroupsPage edit focus (#2256)", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: unknown;

  beforeEach(() => {
    stubFetch();
    // jsdom does not implement scrollIntoView, so install a spy in its place
    // (the hook guards on `typeof … === "function"`, which is exactly why the
    // real defect could not be caught without one).
    originalScrollIntoView = (
      Element.prototype as unknown as { scrollIntoView?: unknown }
    ).scrollIntoView;
    scrollIntoView = vi.fn();
    (
      Element.prototype as unknown as { scrollIntoView: unknown }
    ).scrollIntoView = scrollIntoView;
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    (
      Element.prototype as unknown as { scrollIntoView?: unknown }
    ).scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("moves focus and the viewport to the editor when a row's Edit is clicked", async () => {
    render(<FamilyGroupsPage />);

    const edit = await screen.findByRole("button", { name: /Edit Kea Family/i });
    // Nothing is being edited yet, so there is no named editor region.
    expect(
      screen.queryByRole("region", { name: /Editing Kea Family/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(edit);

    const region = await screen.findByRole("region", {
      name: /Editing Kea Family/i,
    });
    // Focus lands on the editor region rather than staying on the row button
    // that is now scrolled off the bottom of the page.
    await waitFor(() => expect(region).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.instances[0]).toBe(region);
    // scroll-mt-20 (5rem) keeps the region clear of the sticky admin header.
    expect(region).toHaveClass("scroll-mt-20");
  });

  it("marks the row being edited so edit mode is unmistakable", async () => {
    render(<FamilyGroupsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Edit Kea Family/i }),
    );

    const badge = await screen.findByText("Editing");
    const row = badge.closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Kea Family");
    expect(row).toHaveAttribute("aria-current", "true");
    // Only the edited row is marked.
    expect(screen.getAllByText("Editing")).toHaveLength(1);
    expect(
      screen.getByText("Tui Family").closest("tr"),
    ).not.toHaveAttribute("aria-current");
  });

  it("re-anchors when the SAME row's Edit is clicked again", async () => {
    // The groups table sits below the editor, so an admin routinely scrolls
    // back down and clicks the same row again. Nothing the effect depends on
    // changes on that second click unless the open is explicitly nonce'd, so
    // the page would sit still and look broken a second time.
    render(<FamilyGroupsPage />);

    const edit = await screen.findByRole("button", { name: /Edit Kea Family/i });
    fireEvent.click(edit);
    await screen.findByRole("region", { name: /Editing Kea Family/i });
    const callsAfterFirst = scrollIntoView.mock.calls.length;

    // Simulate the admin scrolling back down to the row and clicking it again.
    edit.focus();
    fireEvent.click(edit);

    await waitFor(() =>
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsAfterFirst),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: /Editing Kea Family/i }),
      ).toHaveFocus(),
    );
  });

  it("re-anchors after the form is closed and the same group re-opened", async () => {
    render(<FamilyGroupsPage />);

    const edit = await screen.findByRole("button", { name: /Edit Kea Family/i });
    fireEvent.click(edit);
    await screen.findByRole("region", { name: /Editing Kea Family/i });

    fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: /Editing Kea Family/i }),
      ).not.toBeInTheDocument(),
    );
    const callsAfterClose = scrollIntoView.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /Edit Kea Family/i }));

    const region = await screen.findByRole("region", {
      name: /Editing Kea Family/i,
    });
    await waitFor(() =>
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsAfterClose),
    );
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("returns focus to the trigger when the form is closed", async () => {
    // We took focus on open, so we hand it back on close — otherwise the form
    // unmounts under the keyboard cursor and focus drops to <body>.
    render(<FamilyGroupsPage />);

    const edit = await screen.findByRole("button", { name: /Edit Kea Family/i });
    fireEvent.click(edit);
    await screen.findByRole("region", { name: /Editing Kea Family/i });

    fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(edit).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });

  it("scrolls to the create form too, and names the region", async () => {
    // New Group sits in the page header, but the form renders below the filter
    // card and both queue cards — with a populated queue that is several
    // screens down, exactly the same defect as the row Edit button.
    render(<FamilyGroupsPage />);

    const newGroup = await screen.findByRole("button", { name: /New Group/i });
    expect(
      screen.queryByRole("region", { name: /New family group/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(newGroup);

    const region = await screen.findByRole("region", {
      name: /New family group/i,
    });
    await waitFor(() => expect(region).toHaveFocus());
    expect(scrollIntoView.mock.instances).toContain(region);
    // No group is being edited, so no row is marked.
    expect(screen.queryByText("Editing")).not.toBeInTheDocument();
  });

  it("drops the landmark and its tabstop when the form is closed", async () => {
    render(<FamilyGroupsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /New Group/i }));
    const region = await screen.findByRole("region", {
      name: /New family group/i,
    });
    expect(region).toHaveAttribute("tabindex", "-1");

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: /New family group/i }),
      ).not.toBeInTheDocument(),
    );
    // The anchor stays in the DOM but must not linger as an unnamed landmark
    // or a stray tab stop.
    expect(region).not.toHaveAttribute("role");
    expect(region).not.toHaveAttribute("tabindex");
  });

  it("re-anchors when the admin switches straight to another group's Edit", async () => {
    render(<FamilyGroupsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Edit Kea Family/i }),
    );
    await screen.findByRole("region", { name: /Editing Kea Family/i });
    const callsAfterFirst = scrollIntoView.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /Edit Tui Family/i }));

    const region = await screen.findByRole("region", {
      name: /Editing Tui Family/i,
    });
    await waitFor(() =>
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsAfterFirst),
    );
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("renders family-group dates in the NZ calendar, never the browser locale", async () => {
    render(<FamilyGroupsPage />);

    // 2026-04-15T23:30Z is 16 April in New Zealand; a bare toLocaleDateString()
    // would render "4/16/2026" (US locale) or "15/04/2026" (behind NZ).
    const created = await screen.findAllByText("16 Apr 2026");
    expect(created.length).toBeGreaterThan(0);
  });

  it("degrades on a malformed stored date instead of crashing the table", async () => {
    // Intl.DateTimeFormat throws RangeError on an invalid Date, so the date
    // cells must go through the guarded helper, not a raw formatter.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.startsWith("/api/admin/family-groups/requests")) {
          return jsonResponse({ requests: [] });
        }
        if (url.startsWith("/api/admin/family-groups/partner-invites")) {
          return jsonResponse({ invites: [] });
        }
        if (url.startsWith("/api/admin/family-groups")) {
          return jsonResponse({
            familyGroups: [{ ...KEA, createdAt: "not-a-date" }],
          });
        }
        throw new Error(`Unstubbed fetch in test: ${url}`);
      }),
    );

    render(<FamilyGroupsPage />);

    expect(await screen.findByText("Kea Family")).toBeInTheDocument();
    expect(screen.getByText("Not provided")).toBeInTheDocument();
  });
});
