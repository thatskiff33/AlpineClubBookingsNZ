// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemberDetailPage from "@/app/(admin)/admin/members/[id]/page";

const fetchMock = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "admin-1", role: "ADMIN" } },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

vi.mock("@/components/ui/accordion", () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
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
    ageTier: "ADULT",
    financeAccessLevel: "NONE",
    active: true,
    forcePasswordChange: false,
    xeroContactId: null,
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
    stats: { totalBookings: 0, totalSpendCents: 0, lastStay: null },
    dependents: [],
    streetAddressLine1: "1 Main Road",
    streetAddressLine2: null,
    streetCity: "Tokoroa",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "1 Main Road",
    postalAddressLine2: null,
    postalCity: "Tokoroa",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "NZ",
  };
}

describe("Admin member detail Xero create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
