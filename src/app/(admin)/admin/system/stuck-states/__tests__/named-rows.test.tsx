// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StuckStateDashboard, StuckStateItem } from "@/lib/stuck-state-dashboard";

const mocks = vi.hoisted(() => ({
  areas: [] as string[],
  items: [] as StuckStateItem[],
  getStuckStateDashboard: vi.fn(),
  listDeadCardRefunds: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "officer-1" } }) }));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: (_user: unknown, { area }: { area: string }) => mocks.areas.includes(area),
}));
vi.mock("@/lib/stuck-state-dashboard", () => ({ getStuckStateDashboard: mocks.getStuckStateDashboard }));
vi.mock("@/lib/card-refund-paid-another-way", () => ({ listDeadCardRefunds: mocks.listDeadCardRefunds }));
vi.mock("@/lib/bank-refund-void-follow-up", () => ({ listBankRefundVoidsToAnswerRows: async () => [] }));
vi.mock("@/lib/card-refund-paid-twice", () => ({ listCardRefundsPaidTwice: async () => [] }));
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

import AdminStuckStatesPage from "@/app/(admin)/admin/system/stuck-states/page";

/**
 * #4959: a signal lists at most its capped named rows; the page says how many
 * more the count holds, and the row is the anchor its card link points at.
 */

function item(id: string, count: number, details: number): StuckStateItem {
  return {
    id,
    domain: "payment",
    domainLabel: "Payment recovery",
    title: `Signal ${id}`,
    severity: "critical",
    owner: "Finance",
    count,
    href: `/admin/stuck-states#${id}`,
    summary: "Summary.",
    details: Array.from({ length: details }, (_unused, index) => ({
      id: `${id}-row-${index}`,
      title: `B-${index} - Aroha Ngata`,
      summary: "Row summary.",
      href: `/bookings/${id}-${index}`,
    })),
  };
}

function dashboard(items: StuckStateItem[]): StuckStateDashboard {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    totals: { affectedCount: 0, itemCount: items.length, critical: items.length, warning: 0, info: 0 },
    domains: [],
    items,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("named rows on Stuck States (#4959)", () => {
  it("says how many more a capped signal holds, and nothing for a signal it lists in full", async () => {
    mocks.areas = ["support"];
    mocks.getStuckStateDashboard.mockResolvedValue(
      dashboard([item("payment-recovery-exhausted", 53, 50), item("payment-recovery-stale-processing", 2, 2)]),
    );
    const { container } = render(await AdminStuckStatesPage());

    expect(screen.getByText("and 3 more")).toBeInTheDocument();
    expect(screen.queryAllByText(/^and \d+ more$/)).toHaveLength(1);
    expect(container.querySelector("#payment-recovery-exhausted")).not.toBeNull();
    expect(container.querySelector("#payment-recovery-stale-processing")).not.toBeNull();
  });

  it("hands a Finance viewer's dead card refunds to the dashboard, reading them once", async () => {
    mocks.areas = ["support", "finance"];
    const dead = (operationId: string) => ({
      operationId, bookingId: `b-${operationId}`, bookingReference: "BK-0001", raisedAt: "2026-06-20T00:00:00.000Z",
      owedCents: 15_000, wholeAmountOnly: false, xeroRefundNote: "now", stripeMayHaveRefunded: false,
    });
    mocks.listDeadCardRefunds.mockResolvedValue([dead("op-1"), dead("op-2")]);
    mocks.getStuckStateDashboard.mockResolvedValue(dashboard([]));
    render(await AdminStuckStatesPage());

    expect(mocks.listDeadCardRefunds).toHaveBeenCalledTimes(1);
    const input = mocks.getStuckStateDashboard.mock.calls[0]?.[0] as {
      deps: { listDeadCardRefundOperationIds: () => Promise<ReadonlySet<string>> };
    };
    mocks.listDeadCardRefunds.mockClear();
    await expect(input.deps.listDeadCardRefundOperationIds()).resolves.toEqual(new Set(["op-1", "op-2"]));
    expect(mocks.listDeadCardRefunds).not.toHaveBeenCalled();
  });
});
