// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../../_types";
import {
  emptyFilters,
  formatAgeTierLabel,
  formatTypeTierLabel,
} from "../../_utils";
import { MemberFilterToolbar } from "../member-filter-toolbar";
import { MemberTable } from "../member-table";

// The toolbar resolves its option lists via hooks that fetch in the browser;
// the tests pin them to deterministic values.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

vi.mock("@/hooks/use-membership-type-options", () => ({
  useMembershipTypeOptions: () => [
    { id: "mt-full", name: "Full" },
    { id: "mt-life", name: "Life" },
  ],
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
  }: {
    children: ReactNode;
    value: string;
  }) => (
    <div role="option" aria-selected="false" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
}));

const baseMember: Member = {
  id: "member-1",
  title: null,
  firstName: "Alice",
  lastName: "Summit",
  gender: null,
  occupation: null,
  email: "alice@example.test",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: "1990-01-01",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  xeroContactId: null,
  cancelledAt: null,
  cancelledReason: null,
  lifeMemberDate: null,
  comments: null,
  archivedAt: null,
  archivedReason: null,
  xeroContactGroupsLoaded: false,
  xeroContactGroups: [],
  subscriptionStatus: "PAID",
  subscriptionXeroInvoiceId: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  joinedDate: "2026-04-01",
  forcePasswordChange: false,
  hasCompletedAccountSetup: true,
  pendingInviteExpiresAt: null,
  canLogin: true,
  streetAddressLine1: null,
  streetAddressLine2: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalAddressLine2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  familyGroups: [],
  currentMembershipType: null,
};

function renderToolbar() {
  return render(
    <MemberFilterToolbar
      search=""
      filters={emptyFilters}
      activeFilterCount={0}
      xeroFeatures={{ liveMemberGroupLookups: false, autoLoadContactGroups: false }}
      xeroContactGroupsList={[]}
      onSearchChange={vi.fn()}
      onSetFilter={vi.fn()}
      onClearFilters={vi.fn()}
    />,
  );
}

function renderMemberTable(members: Member[]) {
  return render(
    <MemberTable
      members={members}
      loading={false}
      debouncedSearch=""
      selectedIds={new Set()}
      canEdit
      xeroOrgShortCode={null}
      sortBy="name"
      sortDir="asc"
      membersListPath="/admin/members"
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      onToggleSort={vi.fn()}
      onOpenPasswordActionDialog={vi.fn()}
      onEditMember={vi.fn()}
    />,
  );
}

describe("members list: Membership Type filter + Non-Member Category rename (#1445)", () => {
  afterEach(() => cleanup());

  it("renders a real Membership Type filter with active DB types and an Unassigned option", () => {
    renderToolbar();

    expect(screen.getByText("All Membership Types")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unassigned" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Life" })).toBeInTheDocument();
  });

  it("renames the Role-based control to Non-Member Category, keeping its options", () => {
    renderToolbar();

    // Non-Member Category lives under the "More filters" disclosure (#1806);
    // open it before asserting on the renamed control.
    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));

    // The renamed control's placeholder + neutral option use the new wording.
    expect(screen.getByText("Non-Member Category")).toBeInTheDocument();
    expect(screen.getByText("All Non-Member Categories")).toBeInTheDocument();
    // Behaviour unchanged: it still offers the two non-member Role categories.
    expect(screen.getByRole("option", { name: "Non-Member" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "School" })).toBeInTheDocument();
    // The conflating "Member Type" label is gone.
    expect(screen.queryByText("Member Type")).not.toBeInTheDocument();
  });
});

describe("members list: combined Type – Tier column (#1445)", () => {
  afterEach(() => cleanup());

  it("renders one Type – Tier header instead of the separate Membership Type + Age Tier columns", () => {
    renderMemberTable([baseMember]);

    expect(
      screen.getByRole("columnheader", { name: /Type – Tier/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Membership Type" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Age Tier" }),
    ).not.toBeInTheDocument();
  });

  it("renders '{Type} – {Tier}' for a member with a current-season membership type", () => {
    renderMemberTable([
      {
        ...baseMember,
        ageTier: "ADULT",
        currentMembershipType: {
          id: "mt-full",
          key: "full",
          name: "Full",
          isActive: true,
          ageExemption: "DISALLOWED",
        },
      },
    ]);

    expect(screen.getByText("Full – Adult")).toBeInTheDocument();
  });

  it("renders 'Unassigned – {Tier}' when the member has no current-season type", () => {
    renderMemberTable([
      { ...baseMember, ageTier: "ADULT", currentMembershipType: null },
    ]);

    expect(screen.getByText("Unassigned – Adult")).toBeInTheDocument();
  });
});

describe("Type – Tier display helpers (#1445)", () => {
  it("formats a stored age tier as a capitalised label", () => {
    expect(formatAgeTierLabel("ADULT")).toBe("Adult");
    expect(formatAgeTierLabel("YOUTH")).toBe("Youth");
  });

  it("defensively maps a NOT_APPLICABLE tier string to N/A (forward-compat for #1440)", () => {
    expect(formatAgeTierLabel("NOT_APPLICABLE")).toBe("N/A");
  });

  it("combines type and tier, defaulting a missing type to Unassigned", () => {
    expect(formatTypeTierLabel("Full", "ADULT")).toBe("Full – Adult");
    expect(formatTypeTierLabel(null, "ADULT")).toBe("Unassigned – Adult");
    expect(formatTypeTierLabel("School", "NOT_APPLICABLE")).toBe("School – N/A");
  });
});
