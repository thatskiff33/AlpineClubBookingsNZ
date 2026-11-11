// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1997: the card derives view-only gating from the session matrix via
// useAdminAreaEditAccess("membership"). Mock an all-edit admin so the existing
// add/edit/remove assertions (enabled controls) hold.
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

import { MemberCommitteeAssignmentsCard } from "../member-committee-assignments-card";
import type { MemberDetail } from "../../_types";

// Radix Select does not open in jsdom; a native select keeps value binding and
// onValueChange testable. Options carry their label text so we can tell the two
// selects (committee role vs contact-email mode) apart.
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
    children?: React.ReactNode;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

const ROLE = {
  id: "role-chair",
  key: "chair",
  name: "Chair",
  description: null,
  contactEmail: "chair@club.test" as string | null,
  isActive: true,
  sortOrder: 0,
  assignmentCount: 0,
};

function buildMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Summit",
    email: "alice@example.test",
    committeeAssignments: [],
    ...overrides,
  } as unknown as MemberDetail;
}

function stubRolesFetch(role = ROLE) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/admin/committee/roles")) {
      return { ok: true, json: async () => ({ roles: [role] }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

// The mode <select> is the one whose options include "Custom email".
function modeSelect() {
  const select = screen
    .getAllByRole("combobox")
    .find((el) => within(el).queryByText("Custom email"));
  if (!select) throw new Error("contact-email mode select not found");
  return select as HTMLSelectElement;
}

async function openFormAndEnableContactable(member: MemberDetail) {
  render(<MemberCommitteeAssignmentsCard member={member} onSaved={vi.fn()} />);
  const addButton = await screen.findByRole("button", {
    name: /add assignment/i,
  });
  await waitFor(() => expect(addButton).not.toBeDisabled());
  fireEvent.click(addButton);
  fireEvent.click(screen.getByLabelText("Contactable"));
}

describe("MemberCommitteeAssignmentsCard contact-email clarity (#1550)", () => {
  beforeEach(() => {
    stubRolesFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("defaults to the committee role email and says so explicitly", async () => {
    await openFormAndEnableContactable(buildMember());

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Public contact messages will be sent to chair@club.test",
    );
    expect(status).toHaveTextContent("the committee role email");
    // It must NOT silently read as the member's own inbox.
    expect(status).not.toHaveTextContent("alice@example.test");
  });

  it("shows the member's own email when MEMBER mode is chosen", async () => {
    await openFormAndEnableContactable(buildMember());

    fireEvent.change(modeSelect(), { target: { value: "MEMBER" } });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Public contact messages will be sent to alice@example.test",
    );
    expect(status).toHaveTextContent("this member's own email");
  });

  it("reflects the custom address as the operator types it", async () => {
    await openFormAndEnableContactable(buildMember());

    fireEvent.change(modeSelect(), { target: { value: "CUSTOM" } });
    fireEvent.change(screen.getByLabelText("Custom committee email"), {
      target: { value: "bookings@club.test" },
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Public contact messages will be sent to bookings@club.test",
    );
    expect(status).toHaveTextContent("the custom address below");
  });

  it("falls back to the member's own email (labelled) when the role has no email", async () => {
    stubRolesFetch({ ...ROLE, contactEmail: null });
    await openFormAndEnableContactable(buildMember());

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Public contact messages will be sent to alice@example.test",
    );
    expect(status).toHaveTextContent("the role has no email set");
  });
});
