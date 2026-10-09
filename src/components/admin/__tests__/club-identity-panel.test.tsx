// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ClubIdentityPanel } from "@/components/admin/club-identity-panel";

const SETTINGS = {
  name: "",
  shortName: "",
  hutLeaderLabel: "",
  facebookUrl: "",
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ settings: SETTINGS })),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/*
  #2257 — the other production user of `describedByFieldHint`. This panel builds
  its fields from a `.map()` over a config array, so the hint id is derived
  rather than generated, AND a view-only admin already has a second description
  ("you can view this but not change it") pointed at the same control. That makes
  it the one place where the ORDERING contract is exercised for real:
  `aria-describedby` is read out in list order, so the view-only reason — the
  thing that explains why the control is dead — must come before the example.
*/
describe("ClubIdentityPanel — club-name field hint (#2257)", () => {
  it("points the club-name field at its example instead of parking it in the box", async () => {
    render(<ClubIdentityPanel />);

    const clubName = await screen.findByLabelText("Club name");
    // The example used to be the placeholder; a value-looking grey string inside
    // the box is exactly what was reported.
    expect(clubName.getAttribute("placeholder")).toBeNull();

    const describedBy = clubName.getAttribute("aria-describedby");
    expect(describedBy).toBe("club-identity-hint-name");
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
      "Example: Alpine Sports Club",
    );
  });

  it("announces the view-only reason BEFORE the example for a view-only admin", async () => {
    mocks.canEdit.mockReturnValue(false);
    render(<ClubIdentityPanel />);

    const clubName = await screen.findByLabelText("Club name");
    const ids = (clubName.getAttribute("aria-describedby") ?? "").split(" ");

    // Both descriptions survive — a hint must never displace the reason.
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe("club-identity-hint-name");
    // The first id is the generated view-only wrapper; resolve it rather than
    // pinning the generated value.
    const reason = document.getElementById(ids[0] ?? "");
    expect(reason).not.toBeNull();
    expect(reason).toHaveTextContent(/Content edit access is required/i);
    expect(document.getElementById(ids[1] ?? "")).toHaveTextContent(
      "Example: Alpine Sports Club",
    );
  });

  it("leaves the fields whose placeholder is a genuine instruction alone", async () => {
    render(<ClubIdentityPanel />);

    // Not examples, so #2257 does not touch them; the sweep is #2264.
    const shortName = await screen.findByLabelText("Short name");
    expect(shortName).toHaveAttribute(
      "placeholder",
      "Optional — defaults to the club name",
    );
    expect(shortName.getAttribute("aria-describedby")).toBeNull();
  });

  it("tells the admin to enter the hut-leader label in the singular (#3976)", async () => {
    render(<ClubIdentityPanel />);

    // Screens build the plural themselves, so a club that typed "Hut Leaders"
    // read "Hut Leaderss" in the sidebar. The field now says which form it wants.
    const hutLeader = await screen.findByLabelText("Hut-leader label");
    const describedBy = hutLeader.getAttribute("aria-describedby");
    expect(describedBy).toBe("club-identity-hint-hutLeaderLabel");
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
      /Enter the singular, for example "Hut Leader"/,
    );
  });
});
