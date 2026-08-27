// @vitest-environment jsdom

// The shared renderer, not Testing Library directly: this page derives the club's
// current season from `useClubTime()` since CT-4 group F1 (#2870), and that hook
// throws deliberately when no provider is mounted.
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
// #1940: the page now reads the session permission matrix for view-only gating;
// provide an edit-level admin session so the pre-existing edit-interaction cases
// keep working.
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

import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";

const fetchMock = vi.fn();

const membershipTypes = [
  {
    id: "type-full",
    key: "FULL",
    name: "Full",
    description: "Default full club membership.",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    assignmentCount: 12,
    allowedAgeTiers: ["INFANT", "CHILD", "YOUTH", "ADULT"],
    xeroContactGroupRules: [],
  },
  {
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    description: "Associate membership.",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 1,
    assignmentCount: 3,
    allowedAgeTiers: ["ADULT"],
    xeroContactGroupRules: [
      {
        id: "rule-associate",
        ageTiers: ["ADULT"],
        mode: "ACCEPTED",
        groupId: "group-associate",
        groupName: "Associate members",
        isActive: true,
        sortOrder: 0,
      },
    ],
  },
];

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  };
}

function mockFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith("/api/admin/xero/contact-groups")) {
      return jsonResponse({
        groups: [
          {
            id: "group-associate",
            name: "Associate members",
            contactCount: 3,
          },
          {
            id: "group-life",
            name: "Life members",
            contactCount: 4,
          },
        ],
      });
    }

    if (url === "/api/admin/membership-types/reorder") {
      const payload = JSON.parse(String(init?.body));
      const reordered = payload.orderedIds.map((id: string, index: number) => ({
        ...membershipTypes.find((type) => type.id === id),
        sortOrder: index,
      }));
      return jsonResponse({ membershipTypes: reordered });
    }

    if (url === "/api/admin/membership-types/type-full") {
      return jsonResponse({
        membershipType: {
          ...membershipTypes[0],
          description: "Updated description",
        },
      });
    }

    if (url === "/api/admin/membership-types") {
      return jsonResponse({ membershipTypes });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function renderPage() {
  render(<AdminMembershipTypesPage />);
  await waitFor(() => expect(screen.queryByText("Full")).not.toBeNull());
}

describe("AdminMembershipTypesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    mockFetch();
  });

  it("renders a scannable list and posts the new order when a type is moved", async () => {
    await renderPage();

    expect(screen.queryByText("Default full club membership.")).not.toBeNull();
    expect(screen.queryByText("Member rate")).not.toBeNull();
    expect(screen.queryByText("12 assignments")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Move Associate up" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/reorder",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            orderedIds: ["type-associate", "type-full"],
          }),
        }),
      ),
    );
  });

  it("keeps dirty editor state when outside pointer dismissal is attempted", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(
      screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    expect(screen.getByText("Unsaved changes")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.pointerDown(document.body, { pointerType: "touch" });

    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );
    expect(screen.getByText("Unsaved changes")).not.toBeNull();
  });

  it("confirms before discarding dirty editor state from Escape", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit Full" }), {
      key: "Escape",
      code: "Escape",
    });

    expect(screen.getByText("Discard unsaved changes?")).not.toBeNull();
    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit Full" }), {
      key: "Escape",
      code: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Full" })).toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Default full club membership.",
    );
  });

  it("discards dirty editor state when Cancel is clicked", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);

    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Default full club membership.",
    );
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("closes the editor on a successful save and persists the saved state", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/type-full",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("Updated description"),
        }),
      ),
    );

    expect(screen.getByText("Membership type saved.")).not.toBeNull();

    // #2045: a successful edit save closes the dialog automatically — the admin
    // never needs Cancel to leave a saved state.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Full" })).toBeNull(),
    );

    // Reopening shows the persisted saved value and is not dirty.
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );
    expect(
      screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("routes the header close (X) through the discard guard when dirty", async () => {
    await renderPage();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });

    // Clicking the header X with unsaved changes must not silently drop them —
    // it triggers the existing discard-confirm (#2045).
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByText("Discard unsaved changes?")).not.toBeNull();
    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );

    // Keep editing leaves the dialog open with the draft intact.
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit Full" })).not.toBeNull();

    // Confirming the discard via the X closes the dialog and drops the change.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Full" })).toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByLabelText("Description")).toHaveProperty(
      "value",
      "Default full club membership.",
    );
  });

  it("keeps the editor open and shows the server error inside the dialog when a save fails", async () => {
    await renderPage();

    // A 500/network failure keeps the editor open; the error must be visible on
    // the dialog itself, not only in the page banner behind the modal (#2045 F1).
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (
          url === "/api/admin/membership-types/type-full" &&
          method === "PATCH"
        ) {
          return jsonResponse({ error: "Server rejected the save." }, false);
        }
        if (url === "/api/admin/membership-types") {
          return jsonResponse({ membershipTypes });
        }
        if (url.startsWith("/api/admin/xero/contact-groups")) {
          return jsonResponse({ groups: [] });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit Full" });
    // The server error renders inside the still-open dialog...
    await waitFor(() =>
      expect(
        within(dialog).queryByText("Server rejected the save."),
      ).not.toBeNull(),
    );
    // ...and the unsaved edit is preserved.
    expect(within(dialog).getByLabelText("Description")).toHaveProperty(
      "value",
      "Updated description",
    );
  });

  it("makes the editor header X and Escape inert while a save is in flight", async () => {
    await renderPage();

    let resolveSave: (value?: unknown) => void = () => {};
    const savePromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (
          url === "/api/admin/membership-types/type-full" &&
          method === "PATCH"
        ) {
          await savePromise;
          return jsonResponse({
            membershipType: {
              ...membershipTypes[0],
              description: "Updated description",
            },
          });
        }
        if (url === "/api/admin/membership-types") {
          return jsonResponse({ membershipTypes });
        }
        if (url.startsWith("/api/admin/xero/contact-groups")) {
          return jsonResponse({ groups: [] });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated description" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // While the save is in flight the header X is hidden so dismissal cannot
    // open a discard-confirm the auto-close would orphan (#2045 F2).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull(),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit Full" });

    // Escape is inert mid-save: no discard-confirm, dialog stays open.
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit Full" })).not.toBeNull();

    // Completing the save closes the editor via the success path.
    resolveSave(undefined);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Full" })).toBeNull(),
    );
  });

  it(
    "validates required tiers in the editor",
    async () => {
      await renderPage();

      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
      for (const label of ["Infant", "Child", "Youth", "Adult"]) {
        fireEvent.click(screen.getByLabelText(label));
      }

      expect(screen.getByRole("alert").textContent).toContain(
        "Select at least one allowed age tier.",
      );
      expect(
        screen
          .getByRole("button", { name: "Save changes" })
          .hasAttribute("disabled"),
      ).toBe(true);

      // Re-selecting a tier clears the validation error.
      fireEvent.click(screen.getByLabelText("Adult"));
      expect(
        screen.queryByText("Select at least one allowed age tier."),
      ).toBeNull();
    },
    10000,
  );

  it("offers an N/A (no age) tier in the new-type editor and still blocks an empty selection (#2069)", async () => {
    await renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: "New membership type" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "New membership type",
    });

    // The explicit N/A option is offered even though no existing type uses it...
    const naCheckbox = within(dialog).getByLabelText("N/A (no age)");
    expect(naCheckbox).not.toBeNull();
    // ...and it is opt-in: a fresh draft pre-checks only the four age tiers.
    expect(naCheckbox).toHaveProperty("checked", false);
    for (const label of ["Infant", "Child", "Youth", "Adult"]) {
      expect(within(dialog).getByLabelText(label)).toHaveProperty(
        "checked",
        true,
      );
    }

    // Make the draft dirty so validation surfaces, then clear every age tier.
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "School org" },
    });
    for (const label of ["Infant", "Child", "Youth", "Adult"]) {
      fireEvent.click(within(dialog).getByLabelText(label));
    }

    // Empty selection stays blocked (client-side).
    expect(
      within(dialog).getByText("Select at least one allowed age tier."),
    ).not.toBeNull();
    expect(
      within(dialog)
        .getByRole("button", { name: "Create type" })
        .hasAttribute("disabled"),
    ).toBe(true);

    // Ticking N/A alone is a valid selection and clears the block.
    fireEvent.click(within(dialog).getByLabelText("N/A (no age)"));
    expect(
      within(dialog).queryByText("Select at least one allowed age tier."),
    ).toBeNull();
    expect(
      within(dialog)
        .getByRole("button", { name: "Create type" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("labels a BASED_ON_AGE_TIER type and shows the age-tier helper text in the editor (#2041)", async () => {
    // Custom list with a type that defers its subscription answer to the age
    // tier. Overrides only the list endpoint; other endpoints keep the default.
    const ageTierType = {
      id: "type-ageband",
      key: "FULL",
      name: "Full Member",
      description: "Age-banded full membership.",
      isActive: true,
      isBuiltIn: false,
      bookingBehavior: "MEMBER_RATE",
      subscriptionBehavior: "BASED_ON_AGE_TIER",
      sortOrder: 0,
      assignmentCount: 5,
      allowedAgeTiers: ["INFANT", "CHILD", "YOUTH", "ADULT"],
      xeroContactGroupRules: [],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/xero/contact-groups")) {
        return jsonResponse({ groups: [] });
      }
      if (url === "/api/admin/membership-types") {
        return jsonResponse({ membershipTypes: [ageTierType] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AdminMembershipTypesPage />);
    await waitFor(() =>
      expect(
        screen.queryByText("Subscription required based on age tier"),
      ).not.toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const helperLink = await screen.findByRole("link", {
      name: "age tier settings",
    });
    expect(helperLink.getAttribute("href")).toBe("/admin/age-tier-settings");
  });
});
