// @vitest-environment jsdom

/**
 * A refused membership-type write says why (#4976, ALP-589).
 *
 * The load, create, save, reorder and roll-forward parsed every reply as JSON,
 * and every handler showed `err.message`: an HTML 502 from the proxy read as
 * a JSON parse error and a dropped connection as "Failed to fetch". Each now
 * parses with a catch and throws an `ApiRefusalError`, so anything else shows
 * the handler's own fallback. A 403 keeps the shared forbidden-save reason.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

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

type Answer = () => Response | Promise<Response>;

/** Every route answers well unless the case names the one to refuse. */
function installFetch(refused?: { method: string; url: string; answer: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (refused && refused.method === method && refused.url === url) {
      return refused.answer();
    }
    if (url.startsWith("/api/admin/xero/contact-groups")) {
      return Response.json({ groups: [] });
    }
    if (url === "/api/admin/membership-types" && method === "GET") {
      return Response.json({ membershipTypes });
    }
    if (url === "/api/admin/membership-types/reorder") {
      return Response.json({ membershipTypes });
    }
    if (url === "/api/admin/membership-types/type-full" && method === "PATCH") {
      return Response.json({ membershipType: membershipTypes[0] });
    }
    if (url === "/api/admin/membership-types/type-empty" && method === "DELETE") {
      return Response.json({ ok: true });
    }
    if (url === "/api/admin/membership-types/type-social/merge") {
      return Response.json({ ok: true, reassignedCount: 4 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderPage() {
  render(<AdminMembershipTypesPage />);
  await screen.findByText("Social");
}

async function saveADescription() {
  await renderPage();
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "Updated description" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}

async function moveAssociateUp() {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Move Associate up" }));
}

async function deleteTheEmptyType() {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Delete Empty custom" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete type" }));
}

async function mergeSocialIntoAssociate() {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Delete Social" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Social" });
  fireEvent.change(within(dialog).getByRole("combobox"), {
    target: { value: "type-associate" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Merge and delete" }));
}

describe("membership-type refusals", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
  });

  describe("loading the types", () => {
    itShowsEveryRefusal({
      fallback: "Failed to load membership types",
      submit: async (answer) => {
        installFetch({ method: "GET", url: "/api/admin/membership-types", answer });
        render(<AdminMembershipTypesPage />);
      },
    });
  });

  describe("saving a type", () => {
    itShowsEveryRefusal({
      fallback: "Failed to save membership type",
      submit: async (answer) => {
        installFetch({ method: "PATCH", url: "/api/admin/membership-types/type-full", answer });
        await saveADescription();
      },
    });

    it("keeps the forbidden-save reason for a 403", async () => {
      installFetch({
        method: "PATCH",
        url: "/api/admin/membership-types/type-full",
        answer: () => Response.json({ error: "Forbidden" }, { status: 403 }),
      });
      await saveADescription();

      expect(await screen.findAllByText(ADMIN_FORBIDDEN_SAVE_REASON)).not.toHaveLength(0);
    });

    it("says so after a successful save", async () => {
      installFetch();
      await saveADescription();

      expect(await screen.findByText("Membership type saved.")).toBeInTheDocument();
    });
  });

  describe("reordering the types", () => {
    itShowsEveryRefusal({
      fallback: "Failed to reorder membership types",
      submit: async (answer) => {
        installFetch({ method: "POST", url: "/api/admin/membership-types/reorder", answer });
        await moveAssociateUp();
      },
    });

    it("says so after a successful reorder", async () => {
      installFetch();
      await moveAssociateUp();

      expect(await screen.findByText("Membership type order saved.")).toBeInTheDocument();
    });
  });

  describe("deleting a type", () => {
    itShowsEveryRefusal({
      fallback: "Failed to delete membership type",
      submit: async (answer) => {
        installFetch({ method: "DELETE", url: "/api/admin/membership-types/type-empty", answer });
        await deleteTheEmptyType();
      },
    });

    it("says so after a successful delete", async () => {
      installFetch();
      await deleteTheEmptyType();

      expect(await screen.findByText("Deleted Empty custom.")).toBeInTheDocument();
    });
  });

  describe("merging a type into another", () => {
    itShowsEveryRefusal({
      fallback: "Failed to merge membership type",
      submit: async (answer) => {
        installFetch({ method: "POST", url: "/api/admin/membership-types/type-social/merge", answer });
        await mergeSocialIntoAssociate();
      },
    });

    it("reloads the types after a successful merge", async () => {
      const fetchMock = installFetch();
      await mergeSocialIntoAssociate();

      expect(await screen.findByText(/^Moved 4 assignments from Social to Associate/)).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) => String(input) === "/api/admin/membership-types" && !init?.method,
        ),
      ).toHaveLength(2);
    });
  });
});
