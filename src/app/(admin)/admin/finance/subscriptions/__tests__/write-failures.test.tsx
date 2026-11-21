// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import SubscriptionsPage from "@/app/(admin)/admin/finance/subscriptions/page";

/*
  The two writes on the subscriptions board — the Xero membership sync and the
  manual mark-paid — check `res.ok` before parsing and read a refusal through
  `apiErrorMessageFromResponse` (ALP-589). The billing panel and the manual
  payment dialog have their own suites; here they are stand-ins.
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
vi.mock("@/app/(admin)/admin/finance/subscriptions/_components/manual-payment-dialog", () => ({
  ManualPaymentDialog: ({
    target,
    onSubmit,
  }: {
    target: unknown;
    onSubmit: (submission: { note: string; notifyMember?: boolean }) => void;
  }) =>
    target ? (
      <button type="button" onClick={() => onSubmit({ note: "Cash at the lodge", notifyMember: false })}>
        Record manual payment
      </button>
    ) : null,
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

const listCalls = () =>
  vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("/api/admin/subscriptions?"));

function mockWrite(path: string, answer: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes(path)) return answer();
      return Response.json({
        data: [SUBSCRIPTION],
        total: 1,
        summary: { total: 1, paid: 0, unpaid: 1, overdue: 0, notInvoiced: 0, notRequired: 0 },
      });
    }),
  );
}

async function sync(answer: () => Response | Promise<Response>) {
  mockWrite("/api/admin/xero/sync-memberships", answer);
  render(<SubscriptionsPage />);
  await screen.findByText(/Aroha/);
  fireEvent.click(screen.getByRole("button", { name: /Incremental Sync/ }));
}

async function markPaid(answer: () => Response | Promise<Response>) {
  mockWrite("/manual-payment", answer);
  render(<SubscriptionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Mark as paid/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Record manual payment" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscriptions: Xero membership sync refused", () => {
  itShowsEveryRefusal({ submit: sync, fallback: "Sync failed" });

  it("reports the counts and reloads the list on success", async () => {
    await sync(() => Response.json({ checked: 4, updated: 1 }));

    expect(await screen.findByText("Incremental sync checked 4 members (1 updated)")).toBeInTheDocument();
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
  });
});

describe("subscriptions: manual mark-paid refused", () => {
  itShowsEveryRefusal({ submit: markPaid, fallback: "Manual payment failed." });

  it("shows the route's message and reloads the list on success", async () => {
    await markPaid(() => Response.json({ message: "Marked paid." }));

    expect(await screen.findByText("Marked paid.")).toBeInTheDocument();
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
  });
});
