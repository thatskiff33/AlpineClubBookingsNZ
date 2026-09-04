// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";

/**
 * #3213 (epic #2797) — what the finance queue says about an amount the club may
 * not have asked for.
 *
 * A booking change was settled as money the member owes, but the Xero invoice
 * for that change had already been picked up for sending and could not be raised
 * to include it. Nothing is invoiced automatically, on purpose: an invoice in
 * that state can still come back and go out at the full amount, so a second one
 * raised now could bill the member twice.
 *
 * THE HAZARD RUNS ONE WAY, and every assertion here is about that direction. An
 * officer who bills without checking bills twice; an officer who bills the
 * change's TOTAL rather than the missing part bills most of it twice. So the row
 * has to say check-then-bill, in that order, and must never offer the total as
 * the figure to raise.
 *
 * MUTATION PROOF. Let the hand-back sentence fall through to this kind and
 * "keeps the cash hand-back sentence off a row it does not describe" fails.
 * Render the completion control on this kind and "offers no completion control,
 * because the server refuses one" fails. Print "Awaiting pricing" for its
 * unknown amount and "says the amount is not known, not that it is awaiting
 * pricing" fails. Drop the amount out of the instruction and "names the amount
 * to check for, and never the change's full total" fails.
 *
 * REGISTERED BUT NOT YET WRITTEN: no row can carry this kind until the runtime
 * half of the two-release enum addition ships. The wording is exercised here in
 * the same release it lands, so that release changes a writer and not a screen.
 */

const STAY = {
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

const HAND_BACK_TASK = {
  id: "task-cash",
  bookingId: "booking-cash",
  amountCents: 8000,
  raisedAmountCents: 8000,
  kind: "CANCELLED_BOOKING_HAND_BACK",
  reason: "Cancelled after a cash payment",
  createdAt: "2026-06-20T00:00:00Z",
  memberName: "Ada Lovelace",
  reviewEvidence: null,
  reviewEvidenceUnreadable: false,
  ...STAY,
};

/** The ordinary shape: the settlement leg knows exactly which share is missing. */
const WITHHELD_SHARE_TASK = {
  id: "task-withheld",
  bookingId: "booking-edit",
  amountCents: 4500,
  raisedAmountCents: 4500,
  kind: "UNCOLLECTED_EDIT_REVIEW_SHARE",
  reason:
    "A share of this booking change was settled while its Xero invoice was being sent.",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Grace Hopper",
  reviewEvidence: null,
  reviewEvidenceUnreadable: false,
  ...STAY,
};

/**
 * The recovery replay's shape: it holds the change's COMBINED total and cannot
 * say which part the sent invoice already carried, so the missing amount is
 * genuinely unknown rather than merely unpriced.
 */
const UNKNOWN_AMOUNT_TASK = {
  ...WITHHELD_SHARE_TASK,
  id: "task-withheld-unknown",
  amountCents: null,
  raisedAmountCents: null,
  memberName: "Katherine Johnson",
};

function stubLoad(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderQueue(body: unknown) {
  stubLoad(body);
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

describe("#3213 — a withheld share on the finance queue", () => {
  it("keeps the cash hand-back sentence off a row it does not describe", async () => {
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [WITHHELD_SHARE_TASK],
      autoRefunded: [],
    });

    // "paid in cash or by a bank transfer that never reached Xero, and have
    // since been cancelled" is three claims, none of them true here: the
    // booking is live, the change saved, and the money is an ask that may have
    // gone out short.
    expect(
      screen.queryByTestId("manual-refund-task-hand-back-intro"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("manual-refund-task-review-intro"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("manual-refund-task-withheld-share-intro"),
    ).toBeInTheDocument();
  });

  it("still prints the hand-back sentence when a hand-back is present beside it", async () => {
    // The grouping is per row, not per queue: excluding the new kind from the
    // hand-back sentence must not silence that sentence for the rows it is
    // actually about.
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [WITHHELD_SHARE_TASK, HAND_BACK_TASK],
      autoRefunded: [],
    });

    expect(
      screen.getByTestId("manual-refund-task-hand-back-intro"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("manual-refund-task-withheld-share-intro"),
    ).toBeInTheDocument();
  });

  it("says to check Xero BEFORE billing, which is the order that matters", async () => {
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [WITHHELD_SHARE_TASK],
      autoRefunded: [],
    });

    const intro = screen.getByTestId("manual-refund-task-withheld-share-intro");
    expect(intro).toHaveTextContent(/could bill the member twice/i);
    expect(intro).toHaveTextContent(/Check the booking's invoices in Xero first/i);

    const instruction = screen.getByTestId(
      "manual-refund-task-withheld-share-instruction",
    );
    const text = instruction.textContent ?? "";
    expect(text).toMatch(/^Open this booking's invoices in Xero/);
    // The check is stated before the bill, in the running order of the sentence.
    expect(text.indexOf("check whether they already include")).toBeLessThan(
      text.indexOf("raise a supplementary invoice"),
    );
  });

  it("names the amount to check for, and never the change's full total", async () => {
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [WITHHELD_SHARE_TASK],
      autoRefunded: [],
    });

    const instruction = screen.getByTestId(
      "manual-refund-task-withheld-share-instruction",
    );
    expect(instruction).toHaveTextContent("$45.00");
    // The one sentence that has to survive every future edit of this copy.
    expect(instruction).toHaveTextContent(
      /never for the change's full total, which the member has already been asked for/i,
    );
  });

  it("says the amount is not known, not that it is awaiting pricing", async () => {
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [UNKNOWN_AMOUNT_TASK],
      autoRefunded: [],
    });

    // "Awaiting pricing" would send an officer looking for a control that does
    // not exist on this row: nothing on this screen can ever price it, because
    // the writer that raised it does not know the figure either.
    expect(screen.getByText(/Amount not known/)).toBeInTheDocument();
    expect(screen.queryByText(/Awaiting pricing/)).not.toBeInTheDocument();

    const instruction = screen.getByTestId(
      "manual-refund-task-withheld-share-instruction",
    );
    expect(instruction).toHaveTextContent(/cannot say how much is missing/i);
    // It must not offer a figure it does not have — a printed total here is the
    // number an officer would bill.
    expect(instruction.textContent ?? "").not.toMatch(/\$\d/);
  });

  it("offers no completion control, because the server refuses one", async () => {
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [WITHHELD_SHARE_TASK],
      autoRefunded: [],
    });

    // Absent rather than disabled: a control whose only outcome is a refusal is
    // worse than no control, and a greyed-out "Mark paid back" would still say
    // the club might owe this money back, which it does not.
    expect(
      screen.queryByRole("button", { name: "Mark paid back" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record the adjustment" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close this item" }),
    ).toBeInTheDocument();
  });

  it("leaves the other kinds' controls exactly as they were", async () => {
    // The mutation this pins: hiding the completion control by row rather than
    // by kind would strip the queue's real work of the control that settles it.
    await renderQueue({
      viewerCanViewBookings: true,
      tasks: [WITHHELD_SHARE_TASK, HAND_BACK_TASK],
      autoRefunded: [],
    });

    expect(
      screen.getByRole("button", { name: "Mark paid back" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close this item" }),
    ).toBeInTheDocument();
  });
});
