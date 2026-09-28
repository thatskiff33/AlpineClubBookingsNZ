// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

/**
 * #3643 (owner decision 28 Sep 2026, `INV-PAY-107`): an officer cancelled an
 * internet banking booking as unpaid while Xero recorded a payment the app could
 * not hand back as credit. The club settles that payment in Xero, so the task
 * carries NO amount and is closed by dismissal only: it must never read as a
 * $0.00 hand-back, "awaiting pricing", or offer "Mark paid back".
 */

const REVIEW_TASK = {
  id: "task-review",
  bookingId: "booking-7",
  amountCents: null,
  raisedAmountCents: null,
  // The ordinary hand-back kind, marked by the route's flag.
  kind: "CANCELLED_BOOKING_HAND_BACK",
  partPaymentReview: true,
  reason:
    "Booking booking-7 was cancelled as unpaid, but Xero records a payment against its invoice.",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Ada Lovelace",
  reviewEvidence: null,
  reviewEvidenceUnreadable: false,
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

async function renderQueue(tasks: unknown[] = [REVIEW_TASK]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        viewerCanViewBookings: true,
        tasks,
        autoRefunded: [],
      }),
    })),
  );
  render(<ManualRefundTaskQueue />);
  await waitFor(() =>
    expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
  );
  return screen.getByTestId("manual-refund-task-queue");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("#3643 - a part payment the club settles in Xero", () => {
  it("renders the unpriced task as an unknown amount, with its own explanation", async () => {
    const queue = await renderQueue();

    expect(queue).toHaveTextContent("Ada Lovelace — Amount not known");
    expect(queue).not.toHaveTextContent("$0.00");
    expect(queue).not.toHaveTextContent("Awaiting pricing");
    expect(
      screen.getByTestId("manual-refund-task-part-payment-review-intro"),
    ).toHaveTextContent(/Settle the payment in\s+Xero/);
    expect(
      screen.queryByTestId("manual-refund-task-hand-back-intro"),
    ).not.toBeInTheDocument();
  });

  it("offers only 'Close this item', never 'Mark paid back'", async () => {
    const queue = await renderQueue();

    expect(within(queue).getByRole("button", { name: "Close this item" })).toBeInTheDocument();
    expect(within(queue).queryByRole("button", { name: "Mark paid back" })).not.toBeInTheDocument();
  });

  it("closes it with a note, saying the repair tool stops listing the booking", async () => {
    const queue = await renderQueue();
    fireEvent.click(within(queue).getByRole("button", { name: "Close this item" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Close this payment from Ada Lovelace as settled in Xero?");
    expect(dialog).toHaveTextContent(/repair tool stops listing the booking/);
    expect(within(dialog).getByRole("button", { name: "Close as settled in Xero" })).toBeDisabled();
  });

  // #3643 (`INV-PAY-109`, ORCHESTRATOR DECISION 3): the sync's note is the
  // record that Xero reported the invoice paid, so the card prints it.
  it("prints the sync's note that Xero reported the invoice paid, with the date and the cash", async () => {
    const queue = await renderQueue([
      {
        ...REVIEW_TASK,
        partPaymentReviewXeroPaid: { reportedAt: "2026-07-01T00:00:00.000Z", cashCents: 20000 },
      },
    ]);

    expect(queue).toHaveTextContent(
      /Xero reported this invoice paid on 1 Jul 2026, with \$200\.00 of cash recorded against it\./,
    );
    expect(queue).toHaveTextContent(/Nothing was credited or handed back automatically/);
  });

  it("prints no such note on a review the sync has not touched", async () => {
    const queue = await renderQueue();

    expect(queue).not.toHaveTextContent(/Xero reported this invoice paid/);
  });

  it("keeps the hand-back wording on an unmarked hand-back of the same kind", async () => {
    const queue = await renderQueue([
      { ...REVIEW_TASK, id: "task-cash", amountCents: 4000, raisedAmountCents: 4000, partPaymentReview: false },
    ]);

    expect(within(queue).getByRole("button", { name: "Mark paid back" })).toBeInTheDocument();
    expect(
      screen.queryByTestId("manual-refund-task-part-payment-review-intro"),
    ).not.toBeInTheDocument();
  });
});
