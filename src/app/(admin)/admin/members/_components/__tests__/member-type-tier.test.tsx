// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
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

/**
 * The club's own types, as the page now fetches them ONCE and hands to both the
 * toolbar and the table (#2978). `key` rides along because `name` is editable
 * and the Type – Tier fallback has to resolve by key.
 */
const clubMembershipTypes = [
  { id: "mt-full", key: "FULL", name: "Full", isActive: true },
  { id: "mt-life", key: "LIFE", name: "Life", isActive: true },
];

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
  // Plain text inside the listbox, NOT an option — which is the point of using
  // it for the Unassigned hint (#2978): it can never be selected as a value.
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
      xeroFeatures={{ liveMemberGroupLookups: false, autoLoadContactGroups: false }}
      xeroContactGroupsList={[]}
      membershipTypes={clubMembershipTypes}
      onSearchChange={vi.fn()}
      onSetFilter={vi.fn()}
      resetDisabled={true}
      onReset={vi.fn()}
    />,
  );
}

function renderMemberTable(
  members: Member[],
  membershipTypes: Array<{ id: string; key: string; name: string; isActive: boolean }> =
    clubMembershipTypes,
) {
  return render(
    <MemberTable
      members={members}
      membershipTypes={membershipTypes}
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

/**
 * #2978. Booking on behalf of a non-member creates a real `Member` row with role
 * NON_MEMBER, and such a record has no season membership assignment and never
 * will. It therefore read "Unassigned – Adult", which is not a blank but a WRONG
 * answer: it reads as a member whose type nobody has got round to setting, on a
 * row that is already complete and already correctly priced.
 */
describe("Type – Tier names the non-member category (#2978)", () => {
  afterEach(() => cleanup());

  it("names the built-in type for a non-member category with no assignment", () => {
    expect(formatTypeTierLabel(null, "ADULT", "NON_MEMBER")).toBe(
      "Non-Member – Adult",
    );
    expect(formatTypeTierLabel(null, "CHILD", "NON_MEMBER")).toBe(
      "Non-Member – Child",
    );
    // The sibling category, fixed with it: leaving one of the pair reading
    // "Unassigned" would be arbitrary.
    expect(formatTypeTierLabel(null, "ADULT", "SCHOOL")).toBe("School – Adult");
  });

  it("still reads Unassigned for a MEMBER-level role, where that is the truth", () => {
    // An ordinary member with no type assigned really is an administrative
    // to-do, so the old label is right for them and must not change.
    expect(formatTypeTierLabel(null, "ADULT", "USER")).toBe("Unassigned – Adult");
    expect(formatTypeTierLabel(null, "ADULT", "ADMIN")).toBe("Unassigned – Adult");
    expect(formatTypeTierLabel(null, "ADULT", null)).toBe("Unassigned – Adult");
  });

  it("never overrides a real assignment, whatever the role", () => {
    // The fallback is a FALLBACK. A non-member category that has somehow been
    // given a season type shows the type they were actually given.
    expect(formatTypeTierLabel("Full", "ADULT", "NON_MEMBER")).toBe("Full – Adult");
  });

  it("renders it in the members table for a non-member booking contact", () => {
    renderMemberTable([
      {
        ...baseMember,
        id: "contact-1",
        firstName: "Vic",
        lastName: "Visitor",
        role: "NON_MEMBER",
        accessRoles: [],
        canLogin: false,
        ageTier: "ADULT",
        currentMembershipType: null,
      },
    ]);

    expect(screen.getByText("Non-Member – Adult")).toBeInTheDocument();
    expect(screen.queryByText("Unassigned – Adult")).not.toBeInTheDocument();
  });
});

/**
 * #2978 review: the word is the CLUB'S, not the seed's.
 *
 * `MembershipType.name` is editable — the membership-types PATCH writes it with
 * no built-in guard, and the ASSOCIATE seed's own description invites renaming —
 * so hard-coding "Non-Member" here would put the seed's wording on this one
 * screen while every other surface showed the club's. That is the
 * generic-product rule (`INV-CONFIG-001`), and it is also just wrong on the
 * screen: the officer would see two different names for one thing.
 */
describe("Type – Tier uses the club's own name for the fallback type (#2978)", () => {
  afterEach(() => cleanup());

  const renamedTypes = [
    { id: "mt-nm", key: "NON_MEMBER", name: "Visitor", isActive: true },
    { id: "mt-school", key: "SCHOOL", name: "School Group", isActive: true },
  ];

  it("prefers the club's row over the built-in seed name", () => {
    expect(
      formatTypeTierLabel(null, "ADULT", "NON_MEMBER", renamedTypes),
    ).toBe("Visitor – Adult");
    expect(formatTypeTierLabel(null, "ADULT", "SCHOOL", renamedTypes)).toBe(
      "School Group – Adult",
    );
  });

  it("falls back to the seed name when the club's list is not to hand", () => {
    // The list arrives from a fetch, so the first paint has none — and a viewer
    // without membership:view never gets one. The seed name is right for every
    // club that has not renamed the type, which is the overwhelming majority.
    expect(formatTypeTierLabel(null, "ADULT", "NON_MEMBER", [])).toBe(
      "Non-Member – Adult",
    );
    expect(formatTypeTierLabel(null, "ADULT", "NON_MEMBER")).toBe(
      "Non-Member – Adult",
    );
  });

  it("renders the renamed word in the members table", () => {
    renderMemberTable(
      [
        {
          ...baseMember,
          id: "contact-2",
          firstName: "Vic",
          lastName: "Visitor",
          role: "NON_MEMBER",
          accessRoles: [],
          canLogin: false,
          ageTier: "ADULT",
          currentMembershipType: null,
        },
      ],
      renamedTypes,
    );

    expect(screen.getByText("Visitor – Adult")).toBeInTheDocument();
    expect(screen.queryByText("Non-Member – Adult")).not.toBeInTheDocument();
  });
});
