// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-season-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectSoundOutline } from "@/lib/__tests__/support/heading-outline";
import SubscriptionsPage from "@/app/(admin)/admin/finance/subscriptions/page";

/**
 * Subscriptions' heading outline in every state it renders (#5216,
 * `INV-PUB-006`): the page h1, the real billing panel's title at level 2 with
 * its "Durable charge queue" h3 inside it, and the summary figures as labels.
 */

const access = vi.hoisted(() => ({ canEdit: true }));
const navigation = vi.hoisted(() => ({
  router: { replace: () => {}, push: () => {}, refresh: () => {} },
  searchParams: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.searchParams,
  usePathname: () => "/admin/finance/subscriptions",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => access.canEdit,
  useAdminAreaViewAccess: () => true,
}));
vi.mock("@/hooks/use-xero-status", () => ({ useXeroStatus: () => ({ connected: true }) }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));
vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: async () => ({ groups: [] }),
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: async () => false, confirmDialog: null }),
}));

const SUBSCRIPTION = {
  id: "sub-1",
  memberId: "member-1",
  seasonYear: 2026,
  status: "UNPAID",
  xeroInvoiceId: null,
  xeroInvoiceNumber: null,
  paidAt: null,
  manuallyMarkedPaidAt: null,
  manualPaymentNote: null,
  xeroContactGroupsLoaded: true,
  xeroContactGroups: [],
  member: {
    firstName: "Aroha",
    lastName: "Ngata",
    email: "a@example.test",
    ageTier: "ADULT",
    canLogin: true,
    hasCompletedAccountSetup: true,
    pendingInviteExpiresAt: null,
    xeroContactId: null,
  },
};

const BILLING = {
  preview: {
    seasonYear: 2026,
    decisionDate: "2026-07-13",
    dueDays: 30,
    totalCents: 12_000,
    confirmationToken: "a".repeat(64),
    entries: [],
    exceptions: [],
    exemptMembers: [],
    ungroupedCategoryMembers: [],
    alreadyInvoiced: [],
  },
  charges: [
    {
      id: "charge-1",
      status: "EMAIL_FAILED",
      membershipTypeName: "Full",
      subscriptionCategoryName: null,
      chargedAmountCents: 12_000,
      recipientName: "Member One",
      xeroInvoiceNumber: "INV-1",
      lastErrorMessage: "Mail failed",
      coverage: [{ memberName: "Member One" }],
    },
  ],
  exceptions: [],
  settings: { invoiceDueDays: 30, familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" },
};

type Answer = () => Response | Promise<Response>;

function serve(answers: { list: Answer; billing: Answer }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.startsWith("/api/admin/subscription-billing") ? answers.billing() : answers.list(),
    ),
  );
}

function list(rows: unknown[]) {
  return Response.json({
    data: rows,
    total: rows.length,
    summary: { total: rows.length, paid: 0, unpaid: rows.length, overdue: 0, notInvoiced: 0, notRequired: 0 },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.canEdit = true;
});

describe("/admin/finance/subscriptions heading outline (#5216)", () => {
  it("loading", () => {
    const never = () => new Promise<Response>(() => {});
    serve({ list: never, billing: never });
    render(<SubscriptionsPage />);
    expectSoundOutline("Subscriptions");
  });

  it.each([
    ["an officer who can edit", true],
    ["a view-only officer", false],
  ])("loaded, with the billing panel's charge queue, for %s", async (_who, canEdit) => {
    access.canEdit = canEdit;
    serve({ list: () => list([SUBSCRIPTION]), billing: () => Response.json(BILLING) });
    render(<SubscriptionsPage />);
    await screen.findAllByText(/Aroha/);
    await screen.findByRole("heading", { name: "Durable charge queue" });

    expectSoundOutline("Subscriptions");
    expect(
      screen.getByRole("heading", { level: 2, name: /Annual Membership Fee billing/ }),
    ).toBeInTheDocument();
  });

  it("empty", async () => {
    serve({ list: () => list([]), billing: () => Response.json({ ...BILLING, charges: [] }) });
    render(<SubscriptionsPage />);
    await screen.findAllByText(/No subscriptions/i);
    expectSoundOutline("Subscriptions");
  });

  it("error", async () => {
    const down = () => Response.json({ error: "down" }, { status: 500 });
    serve({ list: down, billing: down });
    render(<SubscriptionsPage />);
    await screen.findAllByRole("alert");
    expectSoundOutline("Subscriptions");
  });
});
