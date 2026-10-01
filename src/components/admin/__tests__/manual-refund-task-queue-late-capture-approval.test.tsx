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
 * #3639 (owner decision 26 Sep 2026): a card payment captured after its booking
 * was cancelled, held because the club has a treasurer approve these refunds.
 *
 * Completing it refunds the CARD through Stripe; nothing is paid back by hand.
 * So the hand-back wording ("paid in cash", "Mark paid back", "only once the
 * money has actually gone back") is wrong on this row in the one direction that
 * matters: a treasurer who read it would hand the money back themselves and then
 * press the button, and the member would be paid twice.
 */

const STAY = {
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

const HELD_TASK = {
  id: "task-held",
  bookingId: "booking-9",
  amountCents: 2500,
  raisedAmountCents: 2500,
  // #3639: the #2700 kind, marked by the route's flag.
  kind: "DELETED_BOOKING_LATE_CAPTURE",
  awaitingLateCaptureApproval: true,
  reason:
    "A payment for a change to the booking (pi_1) was captured after the booking was cancelled (#3639).",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Grace Hopper",
  reviewEvidence: null,
  reviewEvidenceUnreadable: false,
  ...STAY,
};

async function renderQueue(tasks: unknown[] = [HELD_TASK]) {
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

describe("#3639 - a late capture held for a treasurer", () => {
  it("explains the item and never prints the cash hand-back sentence", async () => {
    await renderQueue();

    expect(
      screen.getByTestId("manual-refund-task-late-capture-intro"),
    ).toHaveTextContent(/held for a treasurer to\s+approve/i);
    expect(
      screen.queryByTestId("manual-refund-task-hand-back-intro"),
    ).not.toBeInTheDocument();
  });

  it("offers 'Refund to card' and 'Close without refunding', never 'Mark paid back'", async () => {
    const queue = await renderQueue();

    expect(within(queue).getByRole("button", { name: "Refund to card" })).toBeInTheDocument();
    expect(within(queue).getByRole("button", { name: "Close without refunding" })).toBeInTheDocument();
    expect(within(queue).queryByRole("button", { name: "Mark paid back" })).not.toBeInTheDocument();
  });

  it("says in the dialog that Stripe refunds the card now", async () => {
    const queue = await renderQueue();
    fireEvent.click(within(queue).getByRole("button", { name: "Refund to card" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Refund $25.00 to Grace Hopper's card?");
    expect(dialog).toHaveTextContent(/through Stripe, now/);
    expect(dialog).not.toHaveTextContent(/once the money has actually gone back/);
  });

  it("keeps the hand-back wording on a #2700 row of the same kind that is not held for approval", async () => {
    const queue = await renderQueue([
      { ...HELD_TASK, id: "task-2700", awaitingLateCaptureApproval: false },
    ]);

    expect(within(queue).getByRole("button", { name: "Mark paid back" })).toBeInTheDocument();
    expect(
      screen.queryByTestId("manual-refund-task-late-capture-intro"),
    ).not.toBeInTheDocument();
  });
});
