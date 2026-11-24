// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SubscriptionsPage from "@/app/(admin)/admin/finance/subscriptions/page";
import { NOT_REQUIRED_ROW_BILLING_NOTE } from "@/lib/subscription-season-row-note";

/*
  #5190 (owner decision 22 Nov 2026, issue comment 7070827526): a saved
  "Not required" row whose member billing treats as owing carries a plain note
  under its status badge. The route computes it; the page shows it.
*/

// One instance each: the list query depends on both, so a fresh one per render
// refires it forever.
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
  useAdminAreaEditAccess: () => true,
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
  useConfirm: () => ({ confirm: async () => true, confirmDialog: null }),
}));
vi.mock("@/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel", () => ({
  SubscriptionBillingPanel: () => null,
}));

const NOTE = NOT_REQUIRED_ROW_BILLING_NOTE;

function subscription(billingNote: string | null) {
  return {
    id: "sub-1",
    memberId: "member-1",
    seasonYear: 2026,
    status: "NOT_REQUIRED",
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    paidAt: null,
    manuallyMarkedPaidAt: null,
    manualPaymentNote: null,
    billingNote,
    xeroContactGroupsLoaded: true,
    xeroContactGroups: [],
    member: {
      firstName: "Aroha",
      lastName: "Ngata",
      email: "a@example.test",
      ageTier: "CHILD",
      canLogin: true,
      hasCompletedAccountSetup: true,
      pendingInviteExpiresAt: null,
      xeroContactId: null,
    },
  };
}

function mockList(row: ReturnType<typeof subscription>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: [row],
        total: 1,
        summary: { total: 1, paid: 0, unpaid: 0, overdue: 0, notInvoiced: 0, notRequired: 1 },
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("subscriptions list: billing note on a saved Not-required row (#5190)", () => {
  it("shows the note under the badge when the row carries one", async () => {
    mockList(subscription(NOTE));
    render(<SubscriptionsPage />);
    await screen.findByText(/Aroha/);
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("shows no note when the row carries none", async () => {
    mockList(subscription(null));
    render(<SubscriptionsPage />);
    await screen.findByText(/Aroha/);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
