// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, Filters } from "../../_types";
import { emptyFilters } from "../../_utils";
import { MemberBulkDialog } from "../member-bulk-dialog";
import { MemberEditorDialog } from "../member-editor-dialog";
import { MemberFilterToolbar } from "../member-filter-toolbar";
import { MemberTable } from "../member-table";
import { MemberAccessRolePicker } from "@/components/member-access-role-picker";
import { buildFallbackAccessRoleOptions } from "@/lib/access-role-definitions";
import { AdminMemberXeroActionError } from "@/lib/admin-member-xero-actions";

// Components resolve role options via this hook (a fetch in the browser);
// tests use the static fallback options, which mirror the seeded defaults.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

const pickerRoleOptions = buildFallbackAccessRoleOptions();

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const entranceFeeDecisionMock = vi.hoisted(() => ({
  createEntranceFeeInvoice: false,
  dueDate: "",
  selectedFee: null,
  selectedFeeId: "",
  setCreateEntranceFeeInvoice: vi.fn(),
  setDueDate: vi.fn(),
  setSelectedFeeId: vi.fn(),
  loadEntranceFeeOptions: vi.fn(),
  resetXeroEntranceFeeDecision: vi.fn(),
  entranceFeeOptions: [],
  entranceFeeOptionsLoading: false,
  entranceFeeOptionsError: "",
  buildXeroEntranceFeeInvoiceOptions: vi.fn(() => ({
    createEntranceFeeInvoice: false,
    entranceFeeInvoiceDecision: "SKIP",
    entranceFeeInvoiceSkipReason: "No joining fee invoice requested",
  })),
}));

const xeroActionMocks = vi.hoisted(() => ({
  link: vi.fn(),
  push: vi.fn(),
  search: vi.fn().mockResolvedValue([]),
  unlink: vi.fn(),
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
  // #2978: the Membership Type picker now carries a `SelectLabel` hint. A mock
  // factory missing an export the widened tree reads at render time kills the
  // whole file, so it is listed here even though nothing asserts on it.
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

vi.mock("@/components/member-address-fields", () => ({
  MemberAddressFields: () => <div data-testid="member-address-fields" />,
}));

vi.mock("../member-xero-controls", () => ({
  MemberXeroControls: ({
    editingMember,
    onChangeXeroChoice,
    onChangeSelectedXeroContactId,
    onXeroUnlink,
  }: {
    editingMember: Member | null;
    onChangeXeroChoice: (choice: "link" | "create") => void;
    onChangeSelectedXeroContactId: (contactId: string) => void;
    onXeroUnlink: (memberId: string) => void;
  }) => (
    <div data-testid="member-xero-controls">
      {!editingMember ? (
        <>
          <button
            type="button"
            onClick={() => {
              onChangeXeroChoice("link");
              onChangeSelectedXeroContactId("xero-contact-1");
            }}
          >
            Test link existing Xero contact
          </button>
          <button type="button" onClick={() => onChangeXeroChoice("create")}>
            Test create Xero contact
          </button>
        </>
      ) : editingMember.xeroContactId ? (
        <button type="button" onClick={() => onXeroUnlink(editingMember.id)}>
          Test unlink Xero contact
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("../member-xero-duplicate-decision-dialog", () => ({
  MemberXeroDuplicateDecisionDialog: ({
    decision,
    onLinkSelected,
    onForceCreate,
  }: {
    decision: unknown;
    onLinkSelected: () => void;
    onForceCreate: () => void;
  }) =>
    decision ? (
      <div role="dialog" aria-label="Review Similar Xero Contacts">
        <button type="button" onClick={onLinkSelected}>
          Link Selected Contact
        </button>
        <button type="button" onClick={onForceCreate}>
          Create New Contact Anyway
        </button>
      </div>
    ) : null,
}));

vi.mock("@/lib/admin-member-xero-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-member-xero-actions")>()),
  linkMemberXeroContact: (...args: unknown[]) => xeroActionMocks.link(...args),
  pushMemberToXero: (...args: unknown[]) => xeroActionMocks.push(...args),
  searchXeroContacts: (...args: unknown[]) => xeroActionMocks.search(...args),
  unlinkMemberXeroContact: (...args: unknown[]) => xeroActionMocks.unlink(...args),
}));

vi.mock("@/lib/admin-xero-entrance-fee", () => ({
  useXeroEntranceFeeDecision: () => entranceFeeDecisionMock,
}));

vi.mock("@/lib/use-member-fields-settings", () => ({
  useMemberFieldsSettings: () => ({
    showTitle: false,
    showGender: false,
    showOccupation: false,
  }),
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

function renderMemberTable(
  members: Member[],
  canEdit = true,
) {
  return render(
    <MemberTable
      members={members}
      loading={false}
      debouncedSearch=""
      selectedIds={new Set()}
      canEdit={canEdit}
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

describe("admin member access-role UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ updated: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows one semantic Access column from login stage, never role", () => {
    renderMemberTable([
      // USER, canLogin, setup complete -> "Can log in".
      { ...baseMember, id: "member-user-can-login" },
      // Privileged tokens + a pending unexpired invite -> "Invited".
      {
        ...baseMember,
        id: "member-admin-invited",
        accessRoles: ["USER", "ADMIN"],
        hasCompletedAccountSetup: false,
        pendingInviteExpiresAt: "2999-01-01T00:00:00.000Z",
      },
      // ORG, login on, no invite/password yet -> "Not invited".
      {
        ...baseMember,
        id: "member-org-not-invited",
        accessRoles: ["ORG"],
        hasCompletedAccountSetup: false,
        pendingInviteExpiresAt: null,
      },
      // canLogin off → bare "No login" (no type prefix). Name deliberately
      // avoids the "No Login" tokens so the absence assertions below only
      // catch the retired badge copy, not this member's name link.
      {
        ...baseMember,
        id: "member-no-login",
        firstName: "Nadia",
        lastName: "Offline",
        email: "nologin@example.test",
        accessRoles: [],
        canLogin: false,
      },
    ]);

    expect(screen.getByRole("columnheader", { name: /Access/ })).toBeInTheDocument();
    // The redundant standalone Login column and the old finance column are gone.
    expect(screen.queryByRole("columnheader", { name: /^Login$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Finance Access/ })).not.toBeInTheDocument();

    expect(screen.getByText("Can log in")).toHaveClass("bg-success-3", "text-success-11");
    expect(screen.getByText("Invited")).toHaveClass("bg-info-3", "text-info-11");
    expect(screen.getByText("Not invited")).toHaveClass("bg-warning-3", "text-warning-11");
    expect(screen.getByText("No login")).toHaveClass("bg-muted", "text-foreground");
    expect(screen.queryByText(/Admin ·|Organisation ·|User ·/)).not.toBeInTheDocument();

    // The old duplicated copy is gone from both retired surfaces.
    expect(screen.queryByText("No Login")).not.toBeInTheDocument();
    expect(screen.queryByText("Non-Login")).not.toBeInTheDocument();
    expect(screen.queryByText("Can Login")).not.toBeInTheDocument();
  });

  it("announces and requests the visible Access sort key", () => {
    const onToggleSort = vi.fn();
    render(
      <MemberTable
        members={[baseMember]}
        loading={false}
        debouncedSearch=""
        selectedIds={new Set()}
        canEdit
        xeroOrgShortCode={null}
        sortBy="access"
        sortDir="asc"
        membersListPath="/admin/members?sortBy=access"
        onToggleSelect={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onToggleSort={onToggleSort}
        onOpenPasswordActionDialog={vi.fn()}
      />,
    );

    const header = screen.getByRole("columnheader", { name: /Access/ });
    expect(header).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: /Access/ }));
    expect(onToggleSort).toHaveBeenCalledWith("access");
  });

  it("relabels the login-access filter and offers all four stages including No login (#1444)", () => {
    render(
      <MemberFilterToolbar
        search=""
        filters={emptyFilters}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        resetDisabled={true}
        onReset={vi.fn()}
      />,
    );

    // Login Access lives under the "More filters" disclosure (#1806); open it
    // before asserting on its options.
    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));

    expect(screen.getByText("All Login Access")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No login" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Not invited" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Invited" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Can log in" })).toBeInTheDocument();
    // The old "Invite Status" phrasing is retired.
    expect(screen.queryByText("Invite Status")).not.toBeInTheDocument();
  });

  it("hides member write and bulk-selection controls for view-only membership access", () => {
    renderMemberTable(
      [
        {
          ...baseMember,
          familyGroups: [{ id: "family-1", name: "Summit Household" }],
        },
      ],
      false,
    );

    expect(screen.queryByLabelText("Select all members on this page")).toBeNull();
    expect(screen.queryByLabelText("Select Alice Summit")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Alice Summit" })).toHaveAttribute(
      "href",
      "/admin/members/member-1?returnTo=%2Fadmin%2Fmembers",
    );
    expect(screen.getByText("Summit Household")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Summit Household" }),
    ).not.toBeInTheDocument();
  });

  it("labels access-role list filters with the new model", () => {
    const filters: Filters = {
      ...emptyFilters,
      role: "FINANCE_ADMIN",
    };
    render(
      <MemberFilterToolbar
        search=""
        filters={filters}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        resetDisabled={false}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByText(/Access Role: Treasurer/)).toBeInTheDocument();
    expect(screen.queryByText("Finance Access")).not.toBeInTheDocument();
  });

  it("offers non-login member-type options in the filter toolbar", () => {
    render(
      <MemberFilterToolbar
        search=""
        filters={emptyFilters}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        resetDisabled={true}
        onReset={vi.fn()}
      />,
    );

    // Non-Member Category lives under the "More filters" disclosure (#1806);
    // open it before asserting on its options.
    fireEvent.click(screen.getByRole("button", { name: /more filters/i }));

    // The old Role-based control is now labelled "Non-Member Category" (#1445);
    // its behaviour and Non-Member/School options are unchanged.
    expect(screen.getByText("All Non-Member Categories")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Non-Member" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "School" })).toBeInTheDocument();
  });

  it("labels a member-type filter chip with the friendly role name", () => {
    const filters: Filters = {
      ...emptyFilters,
      role: "NON_MEMBER",
    };
    render(
      <MemberFilterToolbar
        search=""
        filters={filters}
        xeroFeatures={{
          liveMemberGroupLookups: false,
          autoLoadContactGroups: false,
        }}
        xeroContactGroupsList={[]}
        onSearchChange={vi.fn()}
        onSetFilter={vi.fn()}
        resetDisabled={false}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByText(/Access Role: Non-Member/)).toBeInTheDocument();
  });

  it("submits bulk access changes through accessRoles instead of the legacy role field", async () => {
    const onUpdated = vi.fn();
    render(
      <MemberBulkDialog
        open
        action="set-role"
        selectedIds={new Set(["member-1", "member-2"])}
        onOpenChange={vi.fn()}
        onUpdated={onUpdated}
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(2));
    const requestBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    );
    expect(requestBody).toEqual({
      ids: ["member-1", "member-2"],
      action: "set-role",
      accessRoles: ["USER"],
    });
    expect(requestBody).not.toHaveProperty("role");
  });

  it("clears access roles while canLogin is off and restores User when login is re-enabled", () => {
    render(
      <MemberEditorDialog
        open
        editingMember={{
          ...baseMember,
          accessRoles: ["USER", "FINANCE_ADMIN"],
          financeAccessLevel: "MANAGER",
        }}
        xeroConnected={false}
        xeroOrgShortCode={null}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
      />,
    );

    const canLogin = screen.getByLabelText("Can Login");
    const roleCheckbox = (name: string) =>
      screen.getByRole("checkbox", {
        // Test helper: name is escaped via escapeRegExp and test-controlled; not user input.
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        name: new RegExp(`^${escapeRegExp(name)}(?:\\b|Can)`),
      });

    expect(roleCheckbox("User")).toBeChecked();
    expect(roleCheckbox("Treasurer")).toBeChecked();
    expect(screen.queryByText("Finance Access")).not.toBeInTheDocument();
    expect(screen.getByText("Bookings & Beds")).toBeInTheDocument();
    expect(screen.getAllByText("Edit").length).toBeGreaterThan(0);

    fireEvent.click(canLogin);

    expect(roleCheckbox("User")).toBeDisabled();
    expect(roleCheckbox("Full Admin")).toBeDisabled();
    expect(roleCheckbox("Read-only Admin")).toBeDisabled();
    expect(roleCheckbox("Booking Officer")).toBeDisabled();
    expect(roleCheckbox("Membership Officer")).toBeDisabled();
    expect(roleCheckbox("Content Manager")).toBeDisabled();
    expect(roleCheckbox("Lodge")).toBeDisabled();
    expect(roleCheckbox("Finance Viewer")).toBeDisabled();
    expect(roleCheckbox("Treasurer")).toBeDisabled();
    expect(roleCheckbox("Organisation")).toBeDisabled();
    expect(
      screen.getByText("Access roles only apply to login-enabled records."),
    ).toBeInTheDocument();

    fireEvent.click(canLogin);

    expect(roleCheckbox("User")).toBeChecked();
    expect(roleCheckbox("Treasurer")).not.toBeChecked();
  });

  it("surfaces server field validation errors when creating a member", async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method;
      if (url === "/api/admin/members" && method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "Validation failed",
              details: {
                email: ["Invalid email address"],
                dateOfBirth: ["Invalid date format"],
              },
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    render(
      <MemberEditorDialog
        open
        xeroConnected={false}
        xeroOrgShortCode={null}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Member" }));

    // Field-level messages surface with friendly labels, one line per field.
    expect(
      await screen.findByText(/Email: Invalid email address/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Date of birth: Invalid date format/),
    ).toBeInTheDocument();
  });

  it("closes the member-list editor and reports a durable warning after a proven unlink", async () => {
    const onOpenChange = vi.fn();
    const onRecoveryWarning = vi.fn().mockResolvedValue(undefined);
    xeroActionMocks.unlink.mockRejectedValueOnce(
      new AdminMemberXeroActionError("private cleanup detail", {
        recoveryKind: "CONTACT_UNLINKED",
        xeroContactUnlinked: true,
        xeroLinkMayHaveChanged: true,
        subscriptionCleanupPending: true,
        xeroPostProcessingPending: true,
      }),
    );

    render(
      <MemberEditorDialog
        open
        editingMember={{ ...baseMember, xeroContactId: "xero-contact-1" }}
        xeroConnected
        xeroOrgShortCode={null}
        onOpenChange={onOpenChange}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
        onRecoveryWarning={onRecoveryWarning}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test unlink Xero contact" }));

    await waitFor(() => expect(onRecoveryWarning).toHaveBeenCalledTimes(1));
    expect(onRecoveryWarning.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ recoveryKind: "CONTACT_UNLINKED" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(xeroActionMocks.unlink).toHaveBeenCalledTimes(1);
  });

  it("suppresses retry after a newly-created member's Xero link commits only in part", async () => {
    const onOpenChange = vi.fn();
    const onRecoveryWarning = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "member-new",
          firstName: "Riley",
          lastName: "Chen",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    xeroActionMocks.link.mockRejectedValueOnce(
      new AdminMemberXeroActionError("private post-link detail", {
        recoveryKind: "CONTACT_LINKED",
        xeroContactLinked: true,
        xeroContactId: "xero-contact-1",
        xeroLinkMayHaveChanged: true,
        subscriptionRefreshPending: true,
        xeroPostProcessingPending: true,
      }),
    );

    render(
      <MemberEditorDialog
        open
        xeroConnected
        xeroOrgShortCode={null}
        onOpenChange={onOpenChange}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
        onRecoveryWarning={onRecoveryWarning}
      />,
    );
    fireEvent.change(screen.getByLabelText("First Name *"), {
      target: { value: "Riley" },
    });
    fireEvent.change(screen.getByLabelText("Last Name *"), {
      target: { value: "Chen" },
    });
    fireEvent.change(screen.getByLabelText("Email *"), {
      target: { value: "riley@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Test link existing Xero contact" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Member" }));

    await waitFor(() => expect(onRecoveryWarning).toHaveBeenCalledTimes(1));
    expect(onRecoveryWarning.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        recoveryKind: "CONTACT_LINKED",
        memberId: "member-new",
      }),
    );
    expect(xeroActionMocks.link).toHaveBeenCalledWith(
      "member-new",
      "xero-contact-1",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("routes duplicate-decision Link selected recovery with the new member id", async () => {
    const onRecoveryWarning = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "member-new",
          firstName: "Riley",
          lastName: "Chen",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    xeroActionMocks.push.mockResolvedValueOnce({
      status: "needsDecision",
      suggestedContacts: [
        {
          contactId: "xero-contact-existing",
          name: "Riley Chen",
          email: "riley@example.test",
          isLinked: false,
        },
      ],
    });
    xeroActionMocks.link.mockRejectedValueOnce(
      new AdminMemberXeroActionError("private post-link detail", {
        recoveryKind: "CONTACT_LINKED",
        xeroContactLinked: true,
        xeroLinkMayHaveChanged: true,
        xeroContactId: "xero-contact-existing",
        xeroPostProcessingPending: true,
      }),
    );

    render(
      <MemberEditorDialog
        open
        xeroConnected
        xeroOrgShortCode={null}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
        onRecoveryWarning={onRecoveryWarning}
      />,
    );
    fireEvent.change(screen.getByLabelText("First Name *"), {
      target: { value: "Riley" },
    });
    fireEvent.change(screen.getByLabelText("Last Name *"), {
      target: { value: "Chen" },
    });
    fireEvent.change(screen.getByLabelText("Email *"), {
      target: { value: "riley@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Test create Xero contact" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Member" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Link Selected Contact" }),
    );

    await waitFor(() => expect(onRecoveryWarning).toHaveBeenCalledTimes(1));
    expect(onRecoveryWarning.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        recoveryKind: "CONTACT_LINKED",
        memberId: "member-new",
      }),
    );
    expect(xeroActionMocks.link).toHaveBeenCalledWith(
      "member-new",
      "xero-contact-existing",
    );
    expect(
      screen.queryByRole("dialog", { name: "Review Similar Xero Contacts" }),
    ).not.toBeInTheDocument();
  });

  it("closes the duplicate-create decision after provider creation is proven", async () => {
    const onRecoveryWarning = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "member-new",
          firstName: "Riley",
          lastName: "Chen",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    xeroActionMocks.push
      .mockResolvedValueOnce({
        status: "needsDecision",
        suggestedContacts: [
          {
            contactId: "xero-contact-existing",
            name: "Riley Chen",
            email: "riley@example.test",
            isLinked: false,
          },
        ],
      })
      .mockRejectedValueOnce(
        new AdminMemberXeroActionError("private local-link detail", {
          recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
          xeroContactCreated: true,
          xeroContactId: "xero-contact-created",
          xeroPostProcessingPending: true,
        }),
      );

    render(
      <MemberEditorDialog
        open
        xeroConnected
        xeroOrgShortCode={null}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        onSuccess={vi.fn()}
        onWarning={vi.fn()}
        onRecoveryWarning={onRecoveryWarning}
      />,
    );
    fireEvent.change(screen.getByLabelText("First Name *"), {
      target: { value: "Riley" },
    });
    fireEvent.change(screen.getByLabelText("Last Name *"), {
      target: { value: "Chen" },
    });
    fireEvent.change(screen.getByLabelText("Email *"), {
      target: { value: "riley@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Test create Xero contact" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Member" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Create New Contact Anyway" }),
    );

    await waitFor(() => expect(onRecoveryWarning).toHaveBeenCalledTimes(1));
    const recovery = onRecoveryWarning.mock.calls[0]?.[0];
    expect(recovery).toEqual(
      expect.objectContaining({
        recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
        xeroContactCreated: true,
        memberId: "member-new",
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Review Similar Xero Contacts" }),
    ).not.toBeInTheDocument();
    expect(xeroActionMocks.push).toHaveBeenLastCalledWith(
      "member-new",
      expect.objectContaining({ forceCreate: true }),
    );

  });
});

describe("scoped-admin gated access-role picker (#1038)", () => {
  afterEach(() => cleanup());

  it("disables privileged roles for scoped admins but leaves User/Org usable", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["USER"]}
        canLogin
        actorIsFullAdmin={false}
        onToggleRole={vi.fn()}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    const enabled = checkboxes.filter((box) => !box.hasAttribute("disabled"));
    // Only the two unprivileged classifications stay editable.
    expect(enabled).toHaveLength(2);
    expect(
      screen.getByText(/Granting or revoking privileged roles requires Full Admin/),
    ).toBeInTheDocument();
  });

  it("locks the whole picker when the member holds a live privileged role", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["ADMIN"]}
        canLogin
        actorIsFullAdmin={false}
        memberPrivilege="live"
        onToggleRole={vi.fn()}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    expect(
      screen.getByText(/Only a Full Admin can change this member's access roles/),
    ).toBeInTheDocument();
  });

  it("explains the dormant legacy-role case", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["USER"]}
        canLogin
        actorIsFullAdmin={false}
        memberPrivilege="dormant"
        onToggleRole={vi.fn()}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    expect(
      screen.getByText(/dormant privileged legacy role.*requires Full Admin/),
    ).toBeInTheDocument();
  });

  it("keeps every control enabled for Full Admins (default)", () => {
    render(
      <MemberAccessRolePicker
        roleOptions={pickerRoleOptions}
        accessRoles={["USER"]}
        canLogin
        onToggleRole={vi.fn()}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).not.toBeDisabled();
    }
  });
});
