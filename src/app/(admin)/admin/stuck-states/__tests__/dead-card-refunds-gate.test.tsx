// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  areas: [] as string[],
  listDeadCardRefunds: vi.fn(),
  listCardRefundsPaidTwice: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "officer-1" } }) }));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: (_user: unknown, { area }: { area: string }) => mocks.areas.includes(area),
}));
vi.mock("@/lib/stuck-state-dashboard", () => ({
  getStuckStateDashboard: async () => ({
    generatedAt: "2026-07-01T00:00:00.000Z",
    totals: { affectedCount: 0, itemCount: 0, critical: 0, warning: 0, info: 0 },
    domains: [],
    items: [],
  }),
}));
vi.mock("@/lib/card-refund-paid-another-way", () => ({
  listDeadCardRefunds: mocks.listDeadCardRefunds,
  listCardRefundsPaidTwice: mocks.listCardRefundsPaidTwice,
}));
vi.mock("@/lib/club-time/server", async () => {
  const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  const zone = requireClubTimeZone("Pacific/Auckland");
  return { clubTime: async () => bindClubTime(zone, CLUB_FORMAT_TEST), clubTimeZone: async () => zone };
});
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import AdminStuckStatesPage from "@/app/(admin)/admin/stuck-states/page";

/**
 * #3372 (owner, 7 Oct 2026) and #3924 round 4 (U6): the stuck-states page is
 * admitted at support:view, but the dead card refunds name bookings and the
 * money each still owes - finance information. Only a Finance viewer gets the
 * list; anyone else gets neither the list nor the read behind it.
 */

const DEAD = {
  operationId: "op-1",
  bookingId: "b-1",
  bookingReference: "BK-0001",
  raisedAt: "2026-06-20T00:00:00.000Z",
  owedCents: 15_000,
  wholeAmountOnly: false,
  takesXeroRefundNote: true,
  stripeMayHaveRefunded: false,
};

const PAID_TWICE = {
  operationId: "op-2",
  bookingId: "b-2",
  bookingReference: "BK-0002",
  closedAt: "2026-06-25T00:00:00.000Z",
  paidAnotherWayCents: 9_000,
  refundedByCardCents: 9_000,
};

beforeEach(() => {
  mocks.listDeadCardRefunds.mockResolvedValue([DEAD]);
  mocks.listCardRefundsPaidTwice.mockResolvedValue([PAID_TWICE]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("who sees the card refunds Stripe gave up on", () => {
  it("a Support viewer without Finance view gets no list, and the list is never read", async () => {
    mocks.areas = ["support"];
    render(await AdminStuckStatesPage());

    expect(mocks.listDeadCardRefunds).not.toHaveBeenCalled();
    expect(mocks.listCardRefundsPaidTwice).not.toHaveBeenCalled();
    expect(screen.queryByText("Card refunds Stripe gave up on")).not.toBeInTheDocument();
    expect(screen.queryByText(/still owed/)).not.toBeInTheDocument();
    expect(screen.queryByText("Card refunds paid back twice")).not.toBeInTheDocument();
  });

  it("a Finance viewer gets the list", async () => {
    mocks.areas = ["support", "finance"];
    render(await AdminStuckStatesPage());

    expect(mocks.listDeadCardRefunds).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Card refunds Stripe gave up on")).toBeInTheDocument();
    expect(screen.getByText(/\$150\.00 still owed/)).toBeInTheDocument();
  });

  it("#3924 round 5 (concurrency F2): a Finance viewer also sees a close Stripe paid as well", async () => {
    mocks.areas = ["support", "finance"];
    render(await AdminStuckStatesPage());

    expect(mocks.listCardRefundsPaidTwice).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Card refunds paid back twice")).toBeInTheDocument();
    expect(screen.getByText(/\$90\.00 refunded to the card after \$90\.00 was paid back another way/)).toBeInTheDocument();
  });
});
