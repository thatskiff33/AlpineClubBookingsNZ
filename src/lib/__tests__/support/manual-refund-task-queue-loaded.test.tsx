// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import(
    "@/hooks/use-admin-area-edit-access"
  )),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { waitForManualRefundQueueLoaded } from "@/lib/__tests__/support/manual-refund-task-queue-loaded";

/**
 * #5357: the queue's tests read its rows straight after waiting for it to load.
 * The wait they used before matched the loading card too, so it returned before
 * the rows existed and CI failed whenever a busy runner made the load late.
 *
 * This makes the load late on purpose — the response body arrives a timer turn
 * after the fetch resolves, well past the one `setTimeout(0)` React Testing
 * Library drains — so a helper that returns early fails here every time rather
 * than now and then on a loaded runner.
 */

const SLOW_BODY_MS = 25;

const TASK = {
  id: "task-1",
  bookingId: "booking-1",
  amountCents: 2500,
  raisedAmountCents: 2500,
  kind: "DELETED_BOOKING_LATE_CAPTURE",
  awaitingLateCaptureApproval: true,
  reason: "A payment was captured after the booking was cancelled.",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Grace Hopper",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

function stubSlowLoad(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => setTimeout(() => resolve(body), SLOW_BODY_MS)),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("waitForManualRefundQueueLoaded (#5357)", () => {
  it("returns only once a slow load has put the rows on screen", async () => {
    stubSlowLoad({ viewerCanViewBookings: true, tasks: [TASK], autoRefunded: [] });
    render(<ManualRefundTaskQueue />);

    await waitForManualRefundQueueLoaded();

    expect(screen.getByRole("button", { name: "Refund to card" })).toBeInTheDocument();
  });

  it("returns once a slow load finds nothing, so a test of an empty queue is not vacuous", async () => {
    stubSlowLoad({ viewerCanViewBookings: true, tasks: [], autoRefunded: [] });
    render(<ManualRefundTaskQueue />);

    await waitForManualRefundQueueLoaded();

    expect(screen.queryByTestId("manual-refund-task-queue")).not.toBeInTheDocument();
  });

  it("fails at once when called with no load in flight, rather than passing without waiting", async () => {
    await expect(waitForManualRefundQueueLoaded()).rejects.toThrow(/Loading…/);
  });
});
