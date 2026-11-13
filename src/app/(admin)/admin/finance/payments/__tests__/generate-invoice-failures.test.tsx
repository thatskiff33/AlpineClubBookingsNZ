// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import PaymentsPage from "@/app/(admin)/admin/finance/payments/page";

/*
  Generate Invoice on the payments board reads a refusal through
  `apiErrorMessageFromResponse` (ALP-589): an HTML error page from the proxy
  shows the screen's own sentence, never "Unexpected token < in JSON".
*/

// One instance each: the page's queries depend on both, so a fresh one per
// render refires the list and overwrites the row the write just updated.
const navigation = vi.hoisted(() => ({
  router: { replace: () => {}, push: () => {}, refresh: () => {} },
  searchParams: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.searchParams,
  usePathname: () => "/admin/finance/payments",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("@/hooks/use-xero-status", () => ({ useXeroStatus: () => ({ connected: true }) }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));
vi.mock("@/components/admin/manual-refund-task-queue", () => ({
  ManualRefundTaskQueue: () => null,
}));

const PAYMENT = {
  id: "pay-1",
  bookingId: "booking-1",
  amountCents: 13_000,
  source: "STRIPE",
  reference: null,
  status: "SUCCEEDED",
  stripePaymentIntentId: null,
  xeroInvoiceId: null,
  xeroInvoiceNumber: null,
  refundedAmountCents: 0,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  lastUpdatedAt: "2026-06-20T00:00:00.000Z",
  xeroState: "invoiceMissing",
  xeroActivity: {
    failed: 0,
    partial: 0,
    pending: 0,
    latestOperationId: null,
    latestOperationStatus: null,
    latestOperationAt: null,
  },
  settlementKind: "STRIPE",
  booking: {
    id: "booking-1",
    status: "CONFIRMED",
    checkIn: "2026-07-10",
    checkOut: "2026-07-12",
    creditsFromCancellation: [],
    member: { id: "member-1", firstName: "Aroha", lastName: "Ngata", email: "a@example.test" },
  },
};

function mockInvoiceWrite(answer: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/generate-invoice")) return answer();
      return Response.json({
        data: [PAYMENT],
        total: 1,
        page: 1,
        pageSize: 25,
        summary: { netCollectedCents: 13_000, refundedCents: 0, count: 1 },
      });
    }),
  );
}

async function generateInvoice(answer: () => Response | Promise<Response>) {
  mockInvoiceWrite(answer);
  render(
    <HelpWidgetProvider>
      <PaymentsPage />
    </HelpWidgetProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Generate Invoice/ }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("payments: Generate Invoice refused", () => {
  itShowsEveryRefusal({ submit: generateInvoice, fallback: "Failed to generate invoice" });

  it("links the new invoice on success", async () => {
    await generateInvoice(() =>
      Response.json({ xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-0042" }),
    );

    expect(await screen.findByText("INV-0042")).toBeInTheDocument();
  });
});
