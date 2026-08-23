// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MembersPage from "@/app/(admin)/admin/members/page";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const fetchMock = vi.fn();
const scrollIntoView = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}));

vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

vi.mock("@/components/admin/admin-page-header", () => ({
  AdminPageHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}));

vi.mock("@/components/admin/view-only-action", () => ({
  AdminViewOnlySectionBanner: () => null,
  ViewOnlyActionButton: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const queryState = vi.hoisted(() => ({
  search: "",
  setSearch: vi.fn(),
  debouncedSearch: "",
  page: 4,
  setPage: vi.fn(),
  pageSize: 25,
  sortBy: "lastName",
  sortDir: "asc" as const,
  filters: {},
  setFilter: vi.fn(),
  resetDataset: vi.fn(),
  isDatasetDefault: false,
  activeFilterCount: 1,
  toggleSort: vi.fn(),
  buildMembersSearchParams: vi.fn(() => {
    const params = new URLSearchParams();
    params.set("active", "false");
    return params;
  }),
  buildMembersListPath: vi.fn(() => "/admin/members?page=4&active=false"),
  buildExportUrl: vi.fn(() => "/api/admin/members/export"),
}));

vi.mock("@/app/(admin)/admin/members/_hooks/use-members-query-state", () => ({
  useMembersQueryState: () => queryState,
}));

vi.mock("@/app/(admin)/admin/members/_hooks/use-xero-contact-groups", () => ({
  useXeroContactGroups: () => ({
    xeroConnected: true,
    xeroFeatures: {},
    xeroContactGroupsList: [],
    refreshingXeroGroups: false,
    refreshXeroGroups: vi.fn(),
    lastRefreshedAt: null,
  }),
}));

vi.mock("@/app/(admin)/admin/members/_components/member-editor-dialog", () => ({
  MemberEditorDialog: ({
    open,
    onRecoveryWarning,
  }: {
    open: boolean;
    onRecoveryWarning?: (recovery: Record<string, unknown>) => Promise<void>;
  }) =>
    open ? (
      <div role="dialog" aria-label="Member editor">
        <button
          type="button"
          onClick={() =>
            void onRecoveryWarning?.({
              recoveryKind: "CONTACT_LINKED",
              xeroContactLinked: true,
              xeroPostProcessingPending: true,
              memberId: "member/off-page",
            })
          }
        >
          Link selected partial
        </button>
        <button
          type="button"
          onClick={() =>
            void onRecoveryWarning?.({
              recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
              xeroContactCreated: true,
              xeroPostProcessingPending: true,
              memberId: "member/off-page",
            })
          }
        >
          Create anyway partial
        </button>
      </div>
    ) : null,
}));

vi.mock("@/app/(admin)/admin/members/_components/member-bulk-action-bar", () => ({
  MemberBulkActionBar: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-bulk-dialog", () => ({
  MemberBulkDialog: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-bulk-membership-dialog", () => ({
  MemberBulkMembershipDialog: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-filter-toolbar", () => ({
  MemberFilterToolbar: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-import-dialog", () => ({
  MemberImportDialog: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-pagination", () => ({
  MemberPagination: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/member-password-action-dialog", () => ({
  MemberPasswordActionDialog: () => null,
}));
vi.mock("@/app/(admin)/admin/members/_components/xero-groups-refresh-hint", () => ({
  XeroGroupsRefreshHint: () => null,
}));

vi.mock("@/app/(admin)/admin/members/_components/member-table", () => ({
  MemberTable: () => <div>No affected member in this filtered page</div>,
}));

// #2978: the page fetches the club's membership types once and hands them to
// the toolbar and the table. Both are stubbed above, and this suite's fetch mock
// is ORDER-keyed (mockResolvedValueOnce / mockRejectedValueOnce), so a second
// caller of the shared `fetch` would consume the response queued for the list
// refresh. Stubbed rather than URL-routed, because what this file tests is the
// Xero recovery alert, not where the type names come from.
vi.mock("@/hooks/use-membership-type-options", () => ({
  useMembershipTypeOptions: () => [],
}));

describe("members-list Xero partial-success recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  it("keeps Create-anyway recovery reachable when the affected member is off-page", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ members: [], total: 100, totalPages: 4 }),
    });
    render(<MembersPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add Member" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Create anyway partial" }),
    );

    const alert = document.getElementById("members-xero-recovery-error");
    await screen.findByText(/member list was refreshed successfully/i);
    await expectRecoveryAlertToHoldFocus(alert);
    const action = screen.getByRole("link", { name: "Open affected member" });
    expect(action).toHaveAttribute(
      "href",
      "/admin/members/member%2Foff-page?returnTo=%2Fadmin%2Fmembers%3Fpage%3D4%26active%3Dfalse",
    );
    expect(screen.getByText(/No affected member in this filtered page/i)).toBeInTheDocument();
  });

  it("retains Link-selected recovery, focus and navigation when refresh fails", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ members: [], total: 100, totalPages: 4 }),
      })
      .mockRejectedValueOnce(new Error("list refresh unavailable"));
    render(<MembersPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Add Member" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Link selected partial" }),
    );

    const alert = document.getElementById("members-xero-recovery-error");
    await screen.findByText(/member list could not be refreshed/i);
    expect(alert).toHaveTextContent(/Do not link it again/i);
    expect(screen.getByText("Failed to load members")).toBeInTheDocument();
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(screen.getByRole("link", { name: "Open affected member" })).toHaveAttribute(
      "href",
      "/admin/members/member%2Foff-page?returnTo=%2Fadmin%2Fmembers%3Fpage%3D4%26active%3Dfalse",
    );
  });
});
