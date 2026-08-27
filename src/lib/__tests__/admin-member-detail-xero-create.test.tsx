// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemberDetailPage from "@/app/(admin)/admin/members/[id]/page";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const fetchMock = vi.fn();
let searchParamsMock = new URLSearchParams();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => searchParamsMock,
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

vi.mock(
  "@/app/(admin)/admin/members/[id]/_components/member-lodge-access-card",
  () => ({ MemberLodgeAccessCard: () => null }),
);

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/accordion", () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionPlainTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  AccordionTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

function adminMember(overrides: Record<string, unknown> = {}) {
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
    ageTier: "ADULT",
    financeAccessLevel: "NONE",
    active: true,
    forcePasswordChange: false,
    xeroContactId: null,
    xeroContactCreateRecoveryPending: false,
    joinedDate: "2024-05-01T00:00:00.000Z",
    createdAt: "2024-05-01T00:00:00.000Z",
    canLogin: true,
    parentMemberId: null,
    parent: null,
    xeroContactGroupsLoaded: true,
    xeroContactGroups: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    familyGroups: [],
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
    stats: { totalBookings: 0, totalSpendCents: 0, lastStay: null },
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
    ...overrides,
  };
}

describe("Admin member detail Xero create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsMock = new URLSearchParams();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/admin/members/member-1") {
        return Promise.resolve({
          ok: true,
          json: async () => adminMember(),
        });
      }

      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            balanceCents: 0,
            history: [],
            pendingRequests: [],
          }),
        });
      }

      if (url === "/api/admin/xero/status") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ connected: true, features: {} }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  it("opens the Create Xero Contact dialog from an unlinked member", async () => {
    const params = Promise.resolve({ id: "member-1" });
    await params;

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={params} />
        </Suspense>
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: /Create in Xero/ }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Create Xero Contact")).toBeTruthy();
  });

  it("ignores a forged legacy recovery query without server proof", async () => {
    searchParamsMock = new URLSearchParams(
      "xeroRecovery=contact-created-link-unconfirmed&returnTo=%2Fadmin%2Fmembers",
    );

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });

    expect(await screen.findByRole("button", { name: "Link to Xero" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create in Xero/ })).toBeInTheDocument();
    const alert = document.getElementById("member-xero-recovery-error");
    expect(alert).not.toHaveTextContent(/Do not create another contact/i);
  });

  it("suppresses Create from authoritative unresolved-operation proof", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        return Promise.resolve({
          ok: true,
          json: async () =>
            adminMember({ xeroContactCreateRecoveryPending: true }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });

    expect(await screen.findByRole("button", { name: "Link to Xero" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create in Xero/ })).not.toBeInTheDocument();
    const alert = document.getElementById("member-xero-recovery-error");
    await screen.findByText(/Do not create another contact/i);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("suppresses Create for an unmarked stale-reset reservation without claiming provider creation", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        return Promise.resolve({
          ok: true,
          json: async () =>
            adminMember({
              xeroContactCreateRecoveryState: "CREATE_IN_PROGRESS",
              xeroContactCreateRecoveryPending: false,
            }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });

    await screen.findByText(/contact create is still in progress or awaiting recovery/i);
    expect(screen.queryByRole("button", { name: "Link to Xero" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create in Xero/ })).not.toBeInTheDocument();
    const alert = document.getElementById("member-xero-recovery-error");
    expect(alert).not.toHaveTextContent(/A Xero contact was created/i);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("clears recovery after authoritative proof is resolved", async () => {
    let memberReads = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        memberReads += 1;
        return Promise.resolve({
          ok: true,
          json: async () =>
            adminMember({
              xeroContactCreateRecoveryPending: memberReads === 1,
            }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: /Create in Xero/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(document.getElementById("member-xero-recovery-error")).not.toHaveTextContent(
        /Do not create another contact/i,
      ),
    );
  });

  it("clears recovery after linking and reloading the authoritative member", async () => {
    let memberReads = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        memberReads += 1;
        return Promise.resolve({
          ok: true,
          json: async () =>
            adminMember(
              memberReads === 1
                ? { xeroContactCreateRecoveryPending: true }
                : {
                    xeroContactId: "contact-linked",
                    xeroContactCreateRecoveryPending: false,
                  },
            ),
        });
      }
      if (url === "/api/admin/xero/search-contacts?q=Alice") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            contacts: [
              {
                contactId: "contact-linked",
                name: "Alice Smith",
                email: "alice@example.com",
                isLinked: false,
              },
            ],
          }),
        });
      }
      if (url === "/api/admin/members/member-1/xero-link") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ contactName: "Alice Smith" }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });
    await screen.findByText(/Do not create another contact/i);
    fireEvent.click(screen.getByRole("button", { name: "Link to Xero" }));
    fireEvent.change(screen.getByPlaceholderText("Search by name or email..."), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Link" }));

    await screen.findByRole("button", { name: "View in Xero" });
    await waitFor(() =>
      expect(document.getElementById("member-xero-recovery-error")).not.toHaveTextContent(
        /Do not create another contact/i,
      ),
    );
  });

  it("retains route-proven provider creation when both recorders leave only a RUNNING reservation", async () => {
    let memberReads = 0;
    let resolveRefresh: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        memberReads += 1;
        if (memberReads === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => adminMember(),
          });
        }
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (url === "/api/admin/members/member-1/xero-push") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            code: "XERO_PARTIAL_SUCCESS",
            error: "server copy",
            recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
            xeroContactCreated: true,
            xeroContactId: "contact-provider-only",
            xeroPostProcessingPending: true,
          }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: /Create in Xero/ }));
    fireEvent.change(screen.getByLabelText("Reason for not raising invoice"), {
      target: { value: "Already invoiced" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const alert = document.getElementById("member-xero-recovery-error");
    await screen.findByText(/Refreshing the member now/i);
    expect(alert).toHaveTextContent(/Do not create another contact/i);
    expect(screen.getByText("Loading member details...")).toBeInTheDocument();

    // Mutation pin: the pre-action member snapshot says `pending=false`, but
    // cannot clear recovery while this authoritative GET is unresolved.
    await act(async () => {
      await Promise.resolve();
    });
    expect(alert).toHaveTextContent(/Do not create another contact/i);

    await act(async () => {
      resolveRefresh?.({
        ok: true,
        json: async () =>
          adminMember({
            xeroContactCreateRecoveryState: "CREATE_IN_PROGRESS",
            xeroContactCreateRecoveryPending: false,
          }),
      } as Response);
    });
    await screen.findByText(/member was refreshed successfully/i);
    expect(alert).toHaveTextContent(/A Xero contact was created/i);
    expect(
      screen.queryByRole("button", { name: /Create in Xero/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link to Xero" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("retains unconfirmed-create recovery when the authoritative refresh fails", async () => {
    let memberReads = 0;
    let rejectRefresh: ((reason?: unknown) => void) | null = null;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        memberReads += 1;
        if (memberReads === 1) {
          return Promise.resolve({ ok: true, json: async () => adminMember() });
        }
        return new Promise<Response>((_resolve, reject) => {
          rejectRefresh = reject;
        });
      }
      if (url === "/api/admin/members/member-1/xero-push") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            code: "XERO_PARTIAL_SUCCESS",
            error: "server copy",
            recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
            xeroContactCreated: true,
            xeroContactId: "contact-provider-only",
            xeroPostProcessingPending: true,
          }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: /Create in Xero/ }));
    fireEvent.change(screen.getByLabelText("Reason for not raising invoice"), {
      target: { value: "Already invoiced" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const alert = document.getElementById("member-xero-recovery-error");
    await screen.findByText(/Refreshing the member now/i);
    await act(async () => {
      rejectRefresh?.(new Error("member read unavailable"));
    });

    await screen.findByText(/member could not be refreshed/i);
    expect(alert).toHaveTextContent(/Do not create another contact/i);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps partial-unlink recovery mounted and focused through a successful refresh", async () => {
    let memberReads = 0;
    let resolveRefresh: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        memberReads += 1;
        if (memberReads === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => adminMember({ xeroContactId: "contact-1" }),
          });
        }
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (url === "/api/admin/members/member-1/xero-unlink") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            code: "XERO_PARTIAL_SUCCESS",
            error: "server copy",
            recoveryKind: "CONTACT_UNLINKED",
            xeroContactUnlinked: true,
            subscriptionCleanupPending: true,
            xeroPostProcessingPending: true,
          }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Unlink Xero Contact" }),
    );

    const alert = document.getElementById("member-xero-recovery-error");
    await screen.findByText(/Refreshing the member now/i);
    expect(alert).toBe(document.getElementById("member-xero-recovery-error"));
    expect(alert).toHaveTextContent(/Xero link was removed/i);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(screen.getByText("Loading member details...")).toBeInTheDocument();

    await act(async () => {
      resolveRefresh?.({
        ok: true,
        json: async () => adminMember({ xeroContactId: null }),
      } as Response);
    });
    await screen.findByText(/member was refreshed successfully/i);
    expect(alert).toBe(document.getElementById("member-xero-recovery-error"));
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps partial-unlink recovery visible when the canonical refresh fails", async () => {
    let memberReads = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/members/member-1") {
        memberReads += 1;
        return Promise.resolve(
          memberReads === 1
            ? {
                ok: true,
                json: async () => adminMember({ xeroContactId: "contact-1" }),
              }
            : { ok: false, status: 503, json: async () => ({}) },
        );
      }
      if (url === "/api/admin/members/member-1/xero-unlink") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            code: "XERO_PARTIAL_SUCCESS",
            error: "server copy",
            recoveryKind: "CONTACT_UNLINKED",
            xeroContactUnlinked: true,
            subscriptionCleanupPending: true,
            xeroPostProcessingPending: true,
          }),
        });
      }
      if (url === "/api/admin/members/member-1/credits") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ balanceCents: 0, history: [], pendingRequests: [] }),
        });
      }
      if (url === "/api/admin/xero/status") {
        return Promise.resolve({ ok: true, json: async () => ({ connected: true, features: {} }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    await act(async () => {
      render(
        <Suspense fallback={<div>Loading route params...</div>}>
          <MemberDetailPage params={Promise.resolve({ id: "member-1" })} />
        </Suspense>,
      );
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Unlink Xero Contact" }),
    );

    const alert = document.getElementById("member-xero-recovery-error");
    await screen.findByText(/member could not be refreshed/i);
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/warning remains active/i);
    expect(screen.getByText("Failed to load member")).toBeInTheDocument();
    await expectRecoveryAlertToHoldFocus(alert);
  });
});
