// @vitest-environment jsdom

// #2934, the clause the rest of this issue could not prove on a real surface:
// A FAILED SAVE NEVER ALSO RUNS THE SUCCESS POSITIONING.
//
// The committee screen was the last admin surface holding the two outcomes
// apart with two independent effects — `closeRoleForm(); await
// fetchCommitteeData(); scrollToTop(pageRef);` beside a separate `if (error)
// scrollToError(errorRef)`. `fetchCommitteeData` sets an error of its own, so a
// role that POSTed successfully and then failed its refresh ran BOTH: two
// smooth scrolls raced, and the admin could be left at the top of the page with
// the failure they had to act on off-screen below. The page now goes through
// `useActionAttention`, where the two outcomes are ONE decision.
//
// Both halves are asserted here, because "never scrolls" alone is satisfied by
// a page that never positions at all.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
  type ScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

// Not under test, and its own `/api/admin/public-content` round trip would only
// add a second unrelated fetch shape to every case here.
vi.mock("@/components/admin/committee-photo-display-control", () => ({
  CommitteePhotoDisplayControl: () => null,
}));

import CommitteePage from "@/app/(admin)/admin/committee/page";

const fetchMock = vi.fn();
let scrollIntoView: ScrollIntoViewSpy;
let scrollHost: HTMLElement;
let scrollTo: ReturnType<typeof vi.fn<(options?: ScrollToOptions) => void>>;

function json(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

/** The committee reads roles and assignments; everything else is chrome. */
function respondOk(url: string) {
  if (url.includes("/api/admin/committee/roles")) return json({ roles: [] });
  if (url.includes("/api/admin/committee/assignments")) {
    return json({ assignments: [] });
  }
  return json({});
}

beforeEach(() => {
  vi.clearAllMocks();
  scrollIntoView = installScrollIntoViewSpy();
  // The real admin layout puts every page inside an `overflow-y-auto` main;
  // without one, `getNearestScrollContainer` finds nothing and "did not scroll"
  // would pass for the wrong reason.
  scrollHost = document.createElement("main");
  scrollHost.style.overflowY = "auto";
  scrollTo = vi.fn<(options?: ScrollToOptions) => void>();
  // `Element.scrollTo` is overloaded (options, or an x/y pair); the primitive
  // only ever calls the options form, so the spy states that one.
  scrollHost.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  document.body.append(scrollHost);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
  scrollHost.remove();
  vi.unstubAllGlobals();
});

async function openRoleForm() {
  render(<CommitteePage />, { container: scrollHost });
  await screen.findByRole("button", { name: /Add Role/i });
  fireEvent.click(screen.getByRole("button", { name: /Add Role/i }));
  fireEvent.change(await screen.findByLabelText(/Role Name/i), {
    target: { value: "Treasurer" },
  });
}

describe("committee save attention (#2934)", () => {
  it("positions at the top of the page when the save and its refresh both land", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      respondOk(String(input)),
    );
    await openRoleForm();
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Save Role" }));

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("runs ONLY the failure position when the save lands and its refresh fails", async () => {
    let posted = false;
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posted = true;
          return json({ role: { id: "r-1" } });
        }
        // The refresh that follows the successful POST fails.
        if (posted && url.includes("/api/admin/committee/roles")) {
          return json({ error: "Committee roles are unavailable." }, 500);
        }
        return respondOk(url);
      },
    );
    await openRoleForm();
    scrollTo.mockClear();
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Save Role" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Committee roles are unavailable.");
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
    expect(scrollIntoView.mock.instances).toEqual([alert]);
    expect(
      scrollTo,
      "the POST succeeded and the refresh failed: the success position must not " +
        "run as well, or two smooth scrolls race and the admin is left at the " +
        "top of the page with the failure off-screen below it",
    ).not.toHaveBeenCalled();
  });
});
