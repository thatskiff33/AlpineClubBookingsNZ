// @vitest-environment jsdom

/**
 * #4973. A ticked member stays ticked when the officer pages on, so the bulk
 * dialog has to name members from every page the selection came from, not only
 * the page that is loaded when the dialog opens.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MembersPage from "../page";

type ListedMember = { id: string; firstName: string; lastName: string; email: string; canLogin: boolean };

const pageOne: ListedMember[] = [
  { id: "m1", firstName: "Aroha", lastName: "Smith", email: "aroha@example.test", canLogin: false },
  { id: "m2", firstName: "Bea", lastName: "Jones", email: "bea@example.test", canLogin: false },
];
const pageTwo: ListedMember[] = [
  { id: "m3", firstName: "Cass", lastName: "Wilson", email: "cass@example.test", canLogin: false },
];

const queryState = vi.hoisted(() => ({
  search: "",
  setSearch: vi.fn(),
  debouncedSearch: "",
  page: 1,
  setPage: vi.fn(),
  pageSize: 25,
  sortBy: "lastName",
  sortDir: "asc" as const,
  filters: {},
  setFilter: vi.fn(),
  resetDataset: vi.fn(),
  isDatasetDefault: true,
  activeFilterCount: 0,
  toggleSort: vi.fn(),
  buildMembersSearchParams: vi.fn(() => new URLSearchParams()),
  buildMembersListPath: vi.fn(() => "/admin/membership/members"),
  buildExportUrl: vi.fn(() => "/api/admin/members/export"),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "admin-1", accessRoles: [{ role: "ADMIN" }] } } }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({ useAdminAreaEditAccess: () => true }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({ useXeroOrgShortCode: () => ({ shortCode: null }) }));
vi.mock("@/hooks/use-membership-type-options", () => ({ useMembershipTypeOptions: () => [] }));
vi.mock("@/hooks/use-access-role-options", () => ({
  useAccessRoleOptions: () => [{ token: "USER", label: "Member" }],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/components/admin/admin-page-header", () => ({
  AdminPageHeader: ({ title }: { title: string }) => <header><h1>{title}</h1></header>,
}));
vi.mock("@/components/admin/view-only-action", () => ({
  AdminViewOnlySectionBanner: () => null,
  ViewOnlyActionButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));
vi.mock("../_hooks/use-members-query-state", () => ({ useMembersQueryState: () => queryState }));
vi.mock("../_hooks/use-xero-contact-groups", () => ({
  useXeroContactGroups: () => ({
    xeroConnected: false,
    xeroFeatures: {},
    xeroContactGroupsList: [],
    refreshingXeroGroups: false,
    refreshXeroGroups: vi.fn(),
    lastRefreshedAt: null,
  }),
}));
// The table and the bulk bar are stubs that expose just the handlers the page
// hands them; the bulk dialog under test is the real one.
vi.mock("../_components/member-table", () => ({
  MemberTable: ({ members, onToggleSelect }: {
    members: ListedMember[];
    onToggleSelect: (id: string) => void;
  }) => (
    <div>
      {members.map((member) => (
        <button key={member.id} type="button" onClick={() => onToggleSelect(member.id)}>
          Tick {member.firstName} {member.lastName}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../_components/member-bulk-action-bar", () => ({
  MemberBulkActionBar: ({ onOpenBulkDialog }: { onOpenBulkDialog: (action: "deactivate") => void }) => (
    <button type="button" onClick={() => onOpenBulkDialog("deactivate")}>Open bulk deactivate</button>
  ),
}));
vi.mock("../_components/member-bulk-membership-dialog", () => ({ MemberBulkMembershipDialog: () => null }));
vi.mock("../_components/member-bulk-subscription-category-dialog", () => ({ MemberBulkSubscriptionCategoryDialog: () => null }));
vi.mock("../_components/member-editor-dialog", () => ({ MemberEditorDialog: () => null }));
vi.mock("../_components/member-filter-toolbar", () => ({ MemberFilterToolbar: () => null }));
vi.mock("../_components/member-import-dialog", () => ({ MemberImportDialog: () => null }));
vi.mock("../_components/member-pagination", () => ({ MemberPagination: () => null }));
vi.mock("../_components/member-password-action-dialog", () => ({ MemberPasswordActionDialog: () => null }));
vi.mock("../_components/xero-groups-refresh-hint", () => ({ XeroGroupsRefreshHint: () => null }));

beforeEach(() => {
  queryState.page = 1;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const page = new URL(url, "http://localhost").searchParams.get("page");
    return Response.json({ members: page === "2" ? pageTwo : pageOne, total: 3, totalPages: 2 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("bulk dialog names a selection that spans pages (#4973)", () => {
  it("names a member ticked on an earlier page, not just the loaded page", async () => {
    const { rerender } = render(<MembersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Tick Aroha Smith" }));

    queryState.page = 2;
    rerender(<MembersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Tick Cass Wilson" }));
    expect(screen.queryByRole("button", { name: "Tick Aroha Smith" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open bulk deactivate" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(2));
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Aroha Smith",
      "Cass Wilson",
    ]);
    expect(dialog).toHaveTextContent("This will affect 2 selected member(s).");
  });
});
