// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import { expectSoundOutline } from "@/lib/__tests__/support/heading-outline";
import PaymentsPage from "@/app/(admin)/admin/finance/payments/page";

/**
 * /admin/finance/payments' heading outline in every state it renders (#5216,
 * `INV-PUB-006`): the page's "Payments" h1, the refund queue's three cards
 * (the real `ManualRefundTaskQueue`) at level 2 under it, and the summary
 * figures as labels, not headings.
 */

const access = vi.hoisted(() => ({ canEdit: true }));
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => access.canEdit,
}));
vi.mock("@/hooks/use-xero-status", () => ({ useXeroStatus: () => ({ connected: true }) }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));

const STAY = { checkIn: "2026-08-10T00:00:00Z", checkOut: "2026-08-12T00:00:00Z" };

const QUEUE = {
  tasks: [
    {
      id: "task-open",
      bookingId: "booking-cash",
      amountCents: 8000,
      reason: "Cancelled after a cash payment",
      createdAt: "2026-06-20T00:00:00Z",
      memberName: "Ada Lovelace",
      ...STAY,
    },
  ],
  dismissed: [
    {
      id: "task-dismissed",
      bookingId: "booking-edit",
      amountCents: 4500,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      reason: "Cancelled after a cash payment.",
      note: "Nothing owed either way.",
      dismissedAt: "2026-06-25T02:00:00.000Z",
      bookingDeleted: false,
      memberName: "Ada Lovelace",
      ...STAY,
    },
  ],
  autoRefunded: [
    {
      id: "task-auto",
      bookingId: "booking-deleted",
      amountCents: 2500,
      reason: "Captured against a booking the club had already deleted.",
      note: "Closed automatically: Stripe refunded this capture.",
      refundedAt: "2026-06-28T09:00:00Z",
      bookingDeleted: true,
      memberName: "Grace Hopper",
      ...STAY,
    },
  ],
};

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

function paymentsList(data: unknown[]) {
  return Response.json({
    data,
    total: data.length,
    page: 1,
    pageSize: 25,
    summary: { netCollectedCents: 13_000, refundedCents: 0, count: data.length },
  });
}

/** Answers the queue's read and the payments list's read separately. */
function serve(answers: { queue: () => Response | Promise<Response>; payments: () => Response | Promise<Response> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/manual-refund-tasks") ? answers.queue() : answers.payments(),
    ),
  );
}

function renderPage() {
  render(
    <HelpWidgetProvider>
      <PaymentsPage />
    </HelpWidgetProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.canEdit = true;
});

describe("/admin/finance/payments heading outline (#5216)", () => {
  it("loading", () => {
    const never = () => new Promise<Response>(() => {});
    serve({ queue: never, payments: never });
    renderPage();
    expectSoundOutline("Payments");
  });

  it.each([
    ["an officer who can edit", true],
    ["a view-only officer", false],
  ])("loaded, with every refund card, for %s", async (_who, canEdit) => {
    access.canEdit = canEdit;
    serve({ queue: () => Response.json(QUEUE), payments: () => paymentsList([PAYMENT]) });
    renderPage();
    await screen.findAllByText(/Ngata/);
    await waitFor(() => expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument());

    expectSoundOutline("Payments");
    for (const card of [/Money to settle/, /Closed with no adjustment/, /Refunded automatically/]) {
      expect(screen.getByRole("heading", { level: 2, name: card })).toBeInTheDocument();
    }
  });

  it("empty: no payments and nothing in the refund queue", async () => {
    serve({
      queue: () => Response.json({ tasks: [], dismissed: [], autoRefunded: [] }),
      payments: () => paymentsList([]),
    });
    renderPage();
    await screen.findAllByText(/No payments/i);
    expectSoundOutline("Payments");
  });

  it("error: both reads fail", async () => {
    serve({
      queue: () => Response.json({ error: "down" }, { status: 500 }),
      payments: () => Response.json({ error: "down" }, { status: 500 }),
    });
    renderPage();
    await screen.findByTestId("manual-refund-task-load-error");
    expectSoundOutline("Payments");
  });
});
