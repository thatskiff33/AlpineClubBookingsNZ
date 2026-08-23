// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MemberDetailPage from "@/app/(admin)/admin/members/[id]/page";
import { memberSectionStorageKeys } from "@/lib/admin-member-detail-helpers";

const fetchMock = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));

let searchParamsValue = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => searchParamsValue,
}));

vi.mock("@/components/admin/family-group-editor-dialog", () => ({
  FamilyGroupEditorDialog: () => null,
}));

vi.mock("@/components/admin/xero-record-activity-panel", () => ({
  XeroRecordActivityPanel: () => <div data-testid="xero-record-activity" />,
}));

vi.mock("@/components/audit-timeline", () => ({
  AuditTimeline: () => <div data-testid="audit-timeline" />,
}));

vi.mock("@/components/member-address-fields", () => ({
  MemberAddressFields: () => <div data-testid="member-address-fields" />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

function adminMember() {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@example.com",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "4224115",
    dateOfBirth: "1990-01-15T00:00:00.000Z",
    role: "MEMBER",
    accessRoles: ["USER"],
    ageTier: "ADULT",
    financeAccessLevel: "NONE",
    active: true,
    forcePasswordChange: false,
    xeroContactId: null as string | null,
    joinedDate: "2024-05-01T00:00:00.000Z",
    createdAt: "2024-05-01T00:00:00.000Z",
    canLogin: true,
    requiresInduction: false,
    cancelledAt: null,
    archivedAt: null,
    comments: null,
    parentMemberId: null,
    parent: null,
    parentLinks: [],
    xeroContactGroupsLoaded: true,
    xeroContactGroups: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    familyGroups: [],
    currentSeasonYear: 2026,
    seasonalMembershipAssignments: [
      {
        id: "assignment-1",
        memberId: "member-1",
        seasonYear: 2026,
        membershipTypeId: "type-1",
        applyFrom: null,
        assignedByMemberId: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        membershipType: {
          id: "type-1",
          key: "full",
          name: "Full Member",
          description: null,
          isActive: true,
          isBuiltIn: true,
          bookingBehavior: "MEMBER",
          subscriptionBehavior: "REQUIRED",
          sortOrder: 1,
        },
      },
    ],
    committeeAssignments: [],
    subscriptions: [],
    bookings: [],
    promoCodes: [],
    auditLogs: [],
    deleteEligibility: {
      eligible: true,
      blockers: [],
      checkedAt: "2026-05-24T00:00:00.000Z",
    },
    lifecycleActionRequests: [],
    openCancellationRequest: null,
    stats: { totalBookings: 3, totalSpendCents: 12000, lastStay: null },
    dependents: [],
    streetAddressLine1: "1 Main Road",
    streetAddressLine2: null,
    streetCity: "Example",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "1 Main Road",
    postalAddressLine2: null,
    postalCity: "Example",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "NZ",
  };
}

async function renderPage() {
  const params = Promise.resolve({ id: "member-1" });
  await params;
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading route params...</div>}>
        <MemberDetailPage params={params} />
      </Suspense>
    );
  });
}

describe("Admin member detail grouped layout", () => {
  let memberOverrides: Partial<ReturnType<typeof adminMember>>;
  let xeroStatusResponse: { connected: boolean };

  beforeEach(() => {
    vi.clearAllMocks();
    memberOverrides = {};
    xeroStatusResponse = { connected: false };
    searchParamsValue = new URLSearchParams();
    window.localStorage.clear();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/admin/members/member-1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...adminMember(), ...memberOverrides }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            balanceCents: 4050,
            history: [],
            pendingRequests: [],
          }),
        });
      }
      if (url.startsWith("/api/admin/access-roles")) {
        return Promise.resolve({ ok: true, json: async () => ({ roles: [] }) });
      }
      if (url.startsWith("/api/admin/member-fields")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            showTitle: true,
            showGender: true,
            showOccupation: true,
          }),
        });
      }
      if (url.startsWith("/api/admin/membership-types")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ membershipTypes: [] }),
        });
      }
      if (url.startsWith("/api/admin/committee/roles")) {
        return Promise.resolve({ ok: true, json: async () => ({ roles: [] }) });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...xeroStatusResponse, features: {} }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  afterEach(() => {
    window.location.hash = "";
  });

  it("renders every group collapsed by default with preview lines", async () => {
    await renderPage();

    for (const title of [
      "Contact & Personal",
      "Account & Access",
      "Family",
      "Membership",
      "Finance",
      "Committee",
      "History & Activity",
      "Lifecycle & Deletion",
    ]) {
      // getAllByText: some titles (e.g. "Membership") also appear as summary
      // strip labels; the group trigger is asserted separately below.
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
      expect(
        screen.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
      ).toBeTruthy();
    }

    // Collapsed content stays unmounted.
    expect(screen.queryByText("First Name")).toBeNull();
    expect(screen.queryByText("Parent Links")).toBeNull();
    expect(screen.queryByText("Account Credit")).toBeNull();

    // Preview lines summarise each group while collapsed.
    expect(
      screen.getByText("alice@example.com · +64 27 4224115 · Example")
    ).toBeTruthy();
    expect(screen.getByText("Can log in · 1 role · Active")).toBeTruthy();
    expect(
      screen.getByText("2026/2027: Full Member", { exact: false })
    ).toBeTruthy();
    expect(
      screen.getByText("Credit $40.50 · Not linked to Xero")
    ).toBeTruthy();
  });

  /**
   * #2978 review: the roster now reads "Non-Member – Adult" for a non-member
   * booking contact, so the record it links to must not read "None" and "No
   * seasonal type set" for the same person. Before the roster change the two
   * agreed; this keeps them agreeing.
   */
  it("names the non-member category where the roster does, instead of an empty state", async () => {
    memberOverrides = {
      role: "NON_MEMBER",
      accessRoles: [],
      canLogin: false,
      seasonalMembershipAssignments: [],
    };

    await renderPage();

    // The Membership group's preview line…
    expect(
      screen.getByText("2026/2027: Non-Member", { exact: false })
    ).toBeTruthy();
    expect(screen.queryByText(/No seasonal type set/)).toBeNull();
    // …and the summary strip beside it, whose Membership tile read "None".
    // Matched by the tile's own value node: the preview line above renders
    // "2026/2027: Non-Member", so an exact match can only be the tile.
    expect(screen.getByText("Non-Member", { exact: true })).toBeTruthy();
  });

  it("still shows the empty state for a MEMBER with no season type, where it is the truth", async () => {
    // An ordinary member with no type assigned really is an administrative
    // to-do, and #2978 must not paper over it.
    memberOverrides = { seasonalMembershipAssignments: [] };

    await renderPage();

    expect(
      screen.getByText("2026/2027: No seasonal type set", { exact: false })
    ).toBeTruthy();
  });

  it("expands a group on click and persists the choice per section", async () => {
    await renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: /Contact & Personal/ })
    );
    expect(await screen.findByText("First Name")).toBeTruthy();
    expect(
      window.localStorage.getItem(memberSectionStorageKeys.contact)
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: /Contact & Personal/ })
    );
    await waitFor(() =>
      expect(
        window.localStorage.getItem(memberSectionStorageKeys.contact)
      ).toBe("false")
    );
  });

  it("hydrates expanded groups from localStorage", async () => {
    window.localStorage.setItem(memberSectionStorageKeys.family, "true");

    await renderPage();

    expect(await screen.findByText("Parent Links")).toBeTruthy();
    expect(screen.getByText("Dependents")).toBeTruthy();
    // Other groups stay collapsed.
    expect(screen.queryByText("First Name")).toBeNull();
  });

  it("hides all Xero header actions while Xero is disconnected", async () => {
    // Default mock: connected false. Add Dependent keeps its own gating.
    await renderPage();

    expect(screen.getByRole("button", { name: /Add Dependent/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View in Xero/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Link to Xero/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More member actions" })
    ).toBeNull();
  });

  it("shows View in Xero plus an overflow menu when connected and linked", async () => {
    xeroStatusResponse = { connected: true };
    memberOverrides = { xeroContactId: "xero-contact-1" };

    await renderPage();

    expect(
      screen.getByRole("button", { name: /View in Xero/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "More member actions" })
    ).toBeTruthy();
    // Rare actions stay tucked away until the menu is opened.
    expect(screen.queryByText("Change Xero Link")).toBeNull();
    expect(screen.queryByText("Unlink Xero Contact")).toBeNull();
    expect(screen.queryByRole("button", { name: /Link to Xero/ })).toBeNull();
  });

  it("shows Link to Xero when connected and unlinked", async () => {
    xeroStatusResponse = { connected: true };

    await renderPage();

    expect(screen.getByRole("button", { name: /Link to Xero/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "More member actions" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View in Xero/ })).toBeNull();
    expect(screen.queryByText("Create in Xero")).toBeNull();
  });

  it("saves an inline contact edit with only the contact group's fields", async () => {
    await renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: /Contact & Personal/ })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    const phoneInput = await screen.findByLabelText("Phone number");
    fireEvent.change(phoneInput, { target: { value: "7654321" } });

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
      );
      expect(putCall).toBeTruthy();
    });
    const [putUrl, putInit] = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
    )!;
    expect(String(putUrl)).toBe("/api/admin/members/member-1");
    const body = JSON.parse(String((putInit as RequestInit).body));
    expect(body.phoneNumber).toBe("7654321");
    expect(body.email).toBe("alice@example.com");
    // Group scoping: no access/auth fields, no lifeMemberDate ride-alongs.
    expect(body).not.toHaveProperty("accessRoles");
    expect(body).not.toHaveProperty("canLogin");
    expect(body).not.toHaveProperty("active");
    expect(body).not.toHaveProperty("lifeMemberDate");
    // Edit mode exits and the display view returns after refetch.
    expect(await screen.findByText("First Name")).toBeTruthy();
  });

  it("surfaces server field validation errors on an inline contact save", async () => {
    await renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: /Contact & Personal/ })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    // The next fetch is the PUT save; make it fail with per-field zod errors
    // so the hook has to flatten `details` into human-readable lines.
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        json: async () => ({
          error: "Validation failed",
          details: {
            dateOfBirth: ["Invalid date format"],
            email: ["Invalid email address"],
          },
        }),
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    // Both fields surface with friendly labels instead of "Validation failed".
    expect(
      await screen.findByText(/Date of birth: Invalid date format/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Email: Invalid email address/)
    ).toBeTruthy();
    // The edit form stays open so the admin can fix the fields.
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
  });

  it("ignores a forged legacy ?edit=true query and opens read-only", async () => {
    searchParamsValue = new URLSearchParams("edit=true");

    await renderPage();

    expect(await screen.findByRole("button", { name: /Contact & Personal/ })).toBeTruthy();
    expect(screen.queryByLabelText("First Name *")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
    // The query does not expand, persist, or activate any editor.
    expect(
      window.localStorage.getItem(memberSectionStorageKeys.contact)
    ).not.toBe("true");
  });

  it("opens the Finance group and scrolls for the #account-credit deep link", async () => {
    window.location.hash = "#account-credit";

    await renderPage();

    expect(await screen.findByText("Account Credit")).toBeTruthy();
    await waitFor(() =>
      expect(
        window.HTMLElement.prototype.scrollIntoView
      ).toHaveBeenCalled()
    );
    // The transient deep-link open is not persisted.
    expect(
      window.localStorage.getItem(memberSectionStorageKeys.finance)
    ).not.toBe("true");
  });
});
