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
import type { ReactNode } from "react";

// #1940: the page reads the session permission matrix for view-only gating;
// provide an edit-level admin session so the delete/merge cases keep working.
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

// The membership-types editor and merge dialogs use the Radix Select, which
// jsdom cannot drive through its pointer-capture flow. Following the repo
// pattern (e.g. access-role-ui.test.tsx), swap it for a native <select> so the
// merge target picker can be exercised deterministically.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";

const fetchMock = vi.fn();

function customType(overrides: Record<string, unknown> = {}) {
  return {
    id: "type-social",
    key: "SOCIAL",
    name: "Social",
    description: "Social membership.",
    isActive: true,
    isBuiltIn: false,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 2,
    assignmentCount: 4,
    allowedAgeTiers: ["ADULT"],
    xeroContactGroupRules: [
      {
        id: "rule-social",
        ageTiers: ["ADULT"],
        mode: "MANAGED",
        groupId: "group-social",
        groupName: "Social members",
        isActive: true,
        sortOrder: 0,
      },
    ],
    ...overrides,
  };
}

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
  customType(),
  customType({
    id: "type-empty",
    key: "EMPTY",
    name: "Empty custom",
    assignmentCount: 0,
    xeroContactGroupRules: [],
  }),
];

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function mockFetch() {
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/admin/xero/contact-groups")) {
        return jsonResponse({ groups: [] });
      }

      if (url === "/api/admin/membership-types/type-empty" && method === "DELETE") {
        return jsonResponse({ ok: true });
      }

      if (
        url === "/api/admin/membership-types/type-social/merge" &&
        method === "POST"
      ) {
        return jsonResponse({
          ok: true,
          reassignedCount: 4,
          sourceId: "type-social",
          targetId: "type-associate",
        });
      }

      if (url === "/api/admin/membership-types") {
        return jsonResponse({ membershipTypes });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    },
  );
}

async function renderPage() {
  render(<AdminMembershipTypesPage />);
  await waitFor(() => expect(screen.queryByText("Social")).not.toBeNull());
}

describe("AdminMembershipTypesPage delete + merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    mockFetch();
  });

  it("deletes a zero-assignment custom type after confirmation", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Empty custom" }));

    expect(screen.getByText("Delete Empty custom?")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete type" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/type-empty",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Deleted Empty custom.")).not.toBeNull(),
    );
  });

  it("opens the merge dialog for a still-assigned custom type and posts the merge", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));

    // Affected-count summary is shown up front (DialogDescription is one block).
    expect(screen.getByText(/still has 4 seasonal assignments/)).not.toBeNull();

    // Confirm is disabled until a target is chosen.
    const confirmButton = screen.getByRole("button", {
      name: "Merge and delete",
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);

    // Choosing a target enables the merge.
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "type-associate" },
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/membership-types/type-social/merge",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ targetId: "type-associate" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Moved 4 assignments from Social to Associate, then deleted Social.",
        ),
      ).not.toBeNull(),
    );
  });

  it("cancels the merge dialog from the header close (X) when idle and resets the target", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Social" });

    // Pick a target so a non-empty selection exists.
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "type-associate" },
    });
    expect(
      within(dialog)
        .getByRole("button", { name: "Merge and delete" })
        .hasAttribute("disabled"),
    ).toBe(false);

    // The header X closes the dialog when idle without posting a merge (#2045 F3).
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete Social" })).toBeNull(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/membership-types/type-social/merge",
      expect.anything(),
    );

    // Reopening starts with no target selected again (Merge stays disabled),
    // confirming the cancel reset the selection.
    fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));
    const reopened = await screen.findByRole("dialog", {
      name: "Delete Social",
    });
    expect(
      within(reopened)
        .getByRole("button", { name: "Merge and delete" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("hides the merge dialog X while a merge is in flight", async () => {
    let resolveMerge: (value?: unknown) => void = () => {};
    const mergePromise = new Promise((resolve) => {
      resolveMerge = resolve;
    });
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (
          url === "/api/admin/membership-types/type-social/merge" &&
          method === "POST"
        ) {
          await mergePromise;
          return jsonResponse({ ok: true, reassignedCount: 4 });
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

    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Social" });
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "type-associate" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge and delete" }));

    // Mid-merge the header X is hidden (mirrors the disabled Cancel) so it is not
    // a silent no-op (#2045 F3); the dialog stays open until the merge resolves.
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: "Close" }),
      ).toBeNull(),
    );
    expect(
      within(dialog)
        .getByRole("button", { name: "Cancel" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("dialog", { name: "Delete Social" })).not.toBeNull();

    resolveMerge(undefined);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete Social" })).toBeNull(),
    );
  });

  it("keeps the merge dialog open and shows the server error inside it when the merge fails", async () => {
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (
          url === "/api/admin/membership-types/type-social/merge" &&
          method === "POST"
        ) {
          return jsonResponse({ error: "Target type is archived." }, false);
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

    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Social" });
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "type-associate" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Merge and delete" }),
    );

    // A failed merge keeps the dialog open and surfaces the reason on the
    // modal itself (the page banner is occluded by the overlay).
    await waitFor(() =>
      expect(
        within(dialog).queryByText("Target type is archived."),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Delete Social" })).not.toBeNull();
    expect(
      within(dialog)
        .getByRole("button", { name: "Merge and delete" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
