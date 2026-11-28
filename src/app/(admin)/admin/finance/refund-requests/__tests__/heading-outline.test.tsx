// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectSoundOutline } from "@/lib/__tests__/support/heading-outline";
import RefundRequestsPage from "@/app/(admin)/admin/finance/refund-requests/page";

/**
 * Refunds & Credits' heading outline in every state it renders (#5216,
 * `INV-PUB-006`): the page h1, its two queue sections as h2s, each request
 * card a level 3 inside its section, and the Opening credits card a level 2.
 */

const access = vi.hoisted(() => ({ canEdit: true }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/admin/finance/refund-requests",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "admin-1" } }, status: "authenticated" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => access.canEdit,
}));

const MEMBER = { id: "member-1", firstName: "Aroha", lastName: "Ngata", email: "a@example.test" };

const APPEAL = {
  id: "refund-1",
  bookingId: "booking-1",
  memberId: MEMBER.id,
  reason: "Snowed in",
  requestedAmountCents: 5000,
  status: "PENDING",
  adminNotes: null,
  approvedAmountCents: null,
  reviewedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  booking: {
    id: "booking-1",
    checkIn: "2026-07-10",
    checkOut: "2026-07-12",
    finalPriceCents: 10_000,
    status: "CANCELLED",
    noEmails: false,
    creditsFromCancellation: [],
    payment: {
      status: "SUCCEEDED",
      amountCents: 10_000,
      refundedAmountCents: 0,
      stripePaymentIntentId: null,
    },
    appealCeilingCents: 10_000,
    appealCardRefundOwedCents: 0,
  },
  member: MEMBER,
};

const CREDIT_APPROVAL = {
  id: "credit-1",
  memberId: "member-2",
  amountCents: 2500,
  description: "Goodwill after a closure",
  grantAccount: "GOODWILL",
  status: "PENDING",
  createdAt: "2026-06-21T00:00:00.000Z",
  reviewedAt: null,
  member: { id: "member-2", firstName: "Grace", lastName: "Hopper", email: "g@example.test" },
  requestedBy: { id: "admin-2", firstName: "Ada", lastName: "Lovelace" },
  reviewedBy: null,
  approvedCredit: null,
};

type Answer = () => Response | Promise<Response>;

function serve(answers: { appeals: Answer; credits: Answer }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/admin/refund-requests")) return answers.appeals();
      if (url.includes("/api/admin/credit-approvals")) return answers.credits();
      return Response.json({ batches: [] });
    }),
  );
}

function appealsPage(rows: unknown[]) {
  return Response.json({ data: rows, total: rows.length, page: 1, pageSize: 25 });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.canEdit = true;
});

const H1 = "Refunds & Credits";

describe("/admin/finance/refund-requests heading outline (#5216)", () => {
  it("loading", () => {
    const never = () => new Promise<Response>(() => {});
    serve({ appeals: never, credits: never });
    render(<RefundRequestsPage />);
    expectSoundOutline(H1);
  });

  it.each([
    ["an officer who can edit", true],
    ["a view-only officer", false],
  ])("loaded, both queues, for %s", async (_who, canEdit) => {
    access.canEdit = canEdit;
    serve({ appeals: () => appealsPage([APPEAL]), credits: () => Response.json([CREDIT_APPROVAL]) });
    render(<RefundRequestsPage />);
    await screen.findByRole("heading", { level: 2, name: /Manual Credit Approvals/ });

    expectSoundOutline(H1);
    expect(screen.getByRole("heading", { level: 3, name: /Aroha Ngata/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /Grace Hopper/ })).toBeInTheDocument();
  });

  it("empty", async () => {
    serve({ appeals: () => appealsPage([]), credits: () => Response.json([]) });
    render(<RefundRequestsPage />);
    await screen.findByText(/No pending refund appeals or credit approvals found/);
    expectSoundOutline(H1);
  });

  it("error", async () => {
    serve({
      appeals: () => Response.json({ error: "down" }, { status: 500 }),
      credits: () => Response.json({ error: "down" }, { status: 500 }),
    });
    render(<RefundRequestsPage />);
    await screen.findByText("Failed to load review queue");
    expectSoundOutline(H1);
  });
});
