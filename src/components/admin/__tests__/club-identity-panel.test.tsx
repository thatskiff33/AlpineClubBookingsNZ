// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

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

/*
  #3976 / #3990 — the owner's scope decision brought this section onto the
  canonical staged settings model (`useSectionEditState`): read-only on mount,
  Edit → Save/Cancel, Cancel restores the snapshot, and Save is dirty-gated so a
  pristine re-save cannot write an unchanged row and a misleading audit entry
  (#2143). These mirror the sibling sections' staged-edit tests.
*/
describe("ClubIdentityPanel — staged Edit → Save/Cancel (#3976)", () => {
  const LOADED = {
    name: "Alpine Sports Club",
    shortName: null,
    hutLeaderLabel: "Hut Leader",
    facebookUrl: null,
  };

  function putCalls() {
    return fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
  }

  function field(label: string) {
    return screen.getByLabelText(label) as HTMLInputElement;
  }

  beforeEach(() => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        // What the route stores: trimmed, blank cleared to null.
        const stored = Object.fromEntries(
          Object.entries(body).map(([key, value]) => [
            key,
            value.trim() ? value.trim() : null,
          ]),
        );
        return new Response(JSON.stringify({ settings: stored }));
      }
      return new Response(JSON.stringify({ settings: LOADED }));
    });
  });

  it("loads read-only, and Edit opens every field with a pristine Save", async () => {
    render(<ClubIdentityPanel />);

    await screen.findByDisplayValue("Alpine Sports Club");
    for (const label of [
      "Club name",
      "Short name",
      "Hut-leader label",
      "Facebook URL",
    ]) {
      expect(field(label)).toBeDisabled();
    }
    expect(
      screen.queryByRole("button", { name: "Save club identity" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    for (const label of [
      "Club name",
      "Short name",
      "Hut-leader label",
      "Facebook URL",
    ]) {
      expect(field(label)).toBeEnabled();
    }
    // Nothing changed yet, so there is nothing to save.
    expect(
      screen.getByRole("button", { name: "Save club identity" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("Save writes once, re-seeds from the server's stored value and returns to read-only", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(field("Club name"), {
      target: { value: "  Renamed Club  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save club identity" }));

    await screen.findByText("Club identity updated.");
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(String(putCalls()[0]?.[1]?.body))).toEqual({
      name: "  Renamed Club  ",
      shortName: "",
      hutLeaderLabel: "Hut Leader",
      facebookUrl: "",
      legalName: "",
      postalAddress: "",
    });
    // The box shows what the server STORED (trimmed), not the typed draft.
    expect(field("Club name")).toHaveValue("Renamed Club");
    expect(field("Club name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it("Cancel restores every field from the saved snapshot without writing", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(field("Club name"), { target: { value: "Changed" } });
    fireEvent.change(field("Hut-leader label"), {
      target: { value: "Custodian" },
    });
    fireEvent.change(field("Facebook URL"), {
      target: { value: "https://www.facebook.com/changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(field("Club name")).toHaveValue("Alpine Sports Club");
    expect(field("Hut-leader label")).toHaveValue("Hut Leader");
    expect(field("Facebook URL")).toHaveValue("");
    expect(field("Club name")).toBeDisabled();
    expect(putCalls()).toHaveLength(0);
  });

  it("keeps Save disabled for a change the server would store as the same row (#2143)", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = () =>
      screen.getByRole("button", { name: "Save club identity" });

    // Trailing whitespace is trimmed by the route, and a blank box over a
    // null override stays null: neither is a change.
    fireEvent.change(field("Club name"), {
      target: { value: "Alpine Sports Club  " },
    });
    fireEvent.change(field("Short name"), { target: { value: "   " } });
    expect(save()).toBeDisabled();

    // A real change arms it; reverting the change disarms it again.
    fireEvent.change(field("Short name"), { target: { value: "ASC" } });
    expect(save()).toBeEnabled();
    fireEvent.change(field("Short name"), { target: { value: "" } });
    expect(save()).toBeDisabled();
    expect(putCalls()).toHaveLength(0);
  });

  it("keeps the draft open and says why when the save fails", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");
    fetchMock.mockImplementationOnce(
      async () => new Response("{}", { status: 400 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(field("Facebook URL"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Save club identity" }));

    expect(
      await screen.findByText("Could not update club identity."),
    ).toBeInTheDocument();
    expect(field("Facebook URL")).toHaveValue("not a url");
    expect(field("Facebook URL")).toBeEnabled();
  });

  it("Cancel after a failed save clears the message about the discarded edits", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");
    fetchMock.mockImplementationOnce(
      async () => new Response("{}", { status: 400 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(field("Facebook URL"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Save club identity" }));
    await screen.findByText("Could not update club identity.");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByText("Could not update club identity."),
    ).not.toBeInTheDocument();
    expect(field("Facebook URL")).toHaveValue("");
  });

  it("moves focus to the section when Edit replaces the focused button", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("region", { name: "Club identity" }),
      ),
    );
  });

  it("maps a 403 to the shared forbidden-save reason", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");
    fetchMock.mockImplementationOnce(
      async () => new Response("{}", { status: 403 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(field("Club name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save club identity" }));

    expect(
      await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON),
    ).toBeInTheDocument();
  });

  it("gives a view-only admin a disabled Edit, the section banner and read-only fields", async () => {
    mocks.canEdit.mockReturnValue(false);
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByText(/Content edit access is required/i)).toBeVisible();
    expect(field("Club name")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(field("Club name")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save club identity" }),
    ).toBeNull();
  });

  it("keeps Edit neutral while the permission is still resolving", async () => {
    mocks.canEdit.mockReturnValue(undefined);
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club");

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.queryByText(/Content edit access is required/i)).toBeNull();
  });

  it("retries a failed load in place", async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response("{}", { status: 500 }))
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ settings: LOADED })),
      );
    render(<ClubIdentityPanel />);

    expect(
      await screen.findByText("Could not load club identity settings."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(field("Club name")).toHaveValue("Alpine Sports Club"),
    );
    expect(screen.queryByText("Could not load club identity settings.")).toBeNull();
  });
});

describe("ClubIdentityPanel — invoice supplier fields (#5066)", () => {
  const LOADED = {
    name: "Alpine Sports Club",
    shortName: null,
    hutLeaderLabel: null,
    facebookUrl: null,
    legalName: "Alpine Sports Club Incorporated",
    postalAddress: "PO Box 7\nOhakune 4625",
  };

  beforeEach(() => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ settings: { ...LOADED, ...JSON.parse(String(init.body)) } }));
      return new Response(JSON.stringify({ settings: LOADED }));
    });
  });

  it("shows the legal name and a multi-line postal address read-only until Edit", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club Incorporated");
    const address = screen.getByLabelText("Postal address");
    expect(address.tagName).toBe("TEXTAREA");
    expect(address).toHaveValue("PO Box 7\nOhakune 4625");
    expect(address).toBeDisabled();
    expect(screen.getByLabelText("Legal name")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(address).toBeEnabled();
    expect(screen.getByLabelText("Legal name")).toBeEnabled();
  });

  it("keeps Save disabled for an address the route would store unchanged, and sends a real change", async () => {
    render(<ClubIdentityPanel />);
    await screen.findByDisplayValue("Alpine Sports Club Incorporated");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = () => screen.getByRole("button", { name: "Save club identity" });

    fireEvent.change(screen.getByLabelText("Postal address"), { target: { value: " PO Box 7 \n\nOhakune 4625  " } });
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Postal address"), { target: { value: "PO Box 8\nOhakune 4625" } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await screen.findByText("Club identity updated.");
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({
      legalName: "Alpine Sports Club Incorporated",
      postalAddress: "PO Box 8\nOhakune 4625",
    });
  });
});
