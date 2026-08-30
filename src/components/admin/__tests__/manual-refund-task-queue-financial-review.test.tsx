// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
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
 * #3033 (epic #2797) — the finance queue told every admin the wrong thing about
 * a financial-review row, and could not show them the evidence to price it.
 *
 * THE DEFECT THIS FIXES WAS ALREADY LIVE. #3030 added the
 * `EDIT_FINANCIAL_REVIEW` kind and this card could already render one, under a
 * standing paragraph saying every row here "was paid in cash or by a bank
 * transfer that never reached Xero, and have since been cancelled". None of that
 * is true of a review row: the booking is live, the stay change saved, and the
 * money is unresolved rather than owed in cash.
 *
 * MUTATION PROOF. Print the cash paragraph unconditionally and "prints the cash
 * hand-back sentence only over rows it describes" fails. Render the evidence
 * block for a hand-back row, or drop it for a review row, and the two evidence
 * tests fail. Reuse the hand-back dismissal wording on a review row and "a
 * dismissal on a review reads as a finding, not a refusal" fails. Enable the
 * completion button on an unpriced review and "refuses to offer a completion it
 * knows the server will reject" fails. Render the booking link without checking
 * the flag and "prints the identifier instead of a link the viewer cannot
 * follow" fails. Format an absent stored night price as $0.00 and "keeps an
 * absent stored price apart from a comped night" fails.
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
  kind: "CANCELLED_CASH_BOOKING",
  reason: "Cancelled after a cash payment",
  createdAt: "2026-06-20T00:00:00Z",
  memberName: "Ada Lovelace",
  reviewEvidence: null,
  reviewEvidenceUnreadable: false,
  ...STAY,
};

const REVIEW_TASK = {
  id: "task-review",
  bookingId: "booking-edit",
  // Unpriced, which is the ordinary shape of a review: the whole point is that
  // the system refused to invent a number.
  amountCents: null,
  raisedAmountCents: null,
  kind: "EDIT_FINANCIAL_REVIEW",
  reason: "A change to this booking could not be priced from stored history.",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Grace Hopper",
  reviewEvidence: {
    cause: "PARTIAL_STORED_NIGHT_PRICES",
    surrenderedNightDates: ["2026-08-11"],
    addedNightDates: [],
    storedEvidence: {
      guestTotalCents: 12000,
      nightPrices: [
        { date: "2026-08-10", priceCents: 6000 },
        // An absence, not a comped night.
        { date: "2026-08-11", priceCents: null },
      ],
    },
    bookingCheckIn: "2026-08-10",
    bookingCheckOut: "2026-08-12",
  },
  reviewEvidenceUnreadable: false,
  ...STAY,
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

describe("the card only makes claims about rows it actually holds (#3033)", () => {
  it("prints the cash hand-back sentence only over rows it describes", async () => {
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });

    expect(
      screen.queryByTestId("manual-refund-task-hand-back-intro"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("manual-refund-task-review-intro"),
    ).toBeInTheDocument();
  });

  it("prints the review sentence only when a review is waiting", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });

    expect(
      screen.getByTestId("manual-refund-task-hand-back-intro"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("manual-refund-task-review-intro"),
    ).not.toBeInTheDocument();
  });

  it("prints both when the queue holds both, and neither speaks for the other", async () => {
    await renderQueue({
      tasks: [HAND_BACK_TASK, REVIEW_TASK],
      viewerCanViewBookings: true,
    });

    expect(
      screen.getByTestId("manual-refund-task-hand-back-intro"),
    ).toHaveTextContent(/Some of these bookings were paid in cash/);
    expect(
      screen.getByTestId("manual-refund-task-review-intro"),
    ).toHaveTextContent(/could not be worked out/);
  });

  it("never shows an unpriced review as a settled zero", async () => {
    const queue = await renderQueue({
      tasks: [REVIEW_TASK],
      viewerCanViewBookings: true,
    });

    expect(queue).toHaveTextContent("Awaiting pricing");
    expect(queue).not.toHaveTextContent("$0.00");
  });
});

describe("the evidence an admin prices from (#3033, owner decision D3)", () => {
  it("shows the safe diagnostic category, the nights and the stored prices", async () => {
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });

    const evidence = screen.getByTestId("manual-refund-task-review-evidence");
    // The cause reaches the screen as a sentence, never as its enum name.
    expect(evidence).not.toHaveTextContent("PARTIAL_STORED_NIGHT_PRICES");
    expect(evidence).toHaveTextContent(/Only some of the nights given back/);
    expect(evidence).toHaveTextContent("Nights given back: 11 Aug 2026");
    expect(evidence).toHaveTextContent("Nights added by the same change: none");
    expect(evidence).toHaveTextContent("Stored total for this guest: $120.00");
  });

  it("keeps an absent stored price apart from a comped night", async () => {
    // A zero is a real price the club charged; "no stored price" is the evidence
    // gap that raised the task. Collapsing them hides what is being looked at.
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });

    const evidence = screen.getByTestId("manual-refund-task-review-evidence");
    expect(evidence).toHaveTextContent("10 Aug 2026 $60.00");
    expect(evidence).toHaveTextContent("11 Aug 2026 no stored price");
  });

  it("shows no evidence block on a hand-back row, which has none", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });

    expect(
      screen.queryByTestId("manual-refund-task-review-evidence"),
    ).not.toBeInTheDocument();
  });

  it("says out loud when captured evidence cannot be read back", async () => {
    // An absence would be read as "none was captured", which is the opposite of
    // the truth and would send an admin to price from the wrong material.
    await renderQueue({
      tasks: [
        { ...REVIEW_TASK, reviewEvidence: null, reviewEvidenceUnreadable: true },
      ],
      viewerCanViewBookings: true,
    });

    expect(
      screen.getByTestId("manual-refund-task-review-evidence-unreadable"),
    ).toHaveTextContent(/cannot be read/);
  });

  it("prints the identifier instead of a link the viewer cannot follow", async () => {
    // This card is gated on finance:view, which a Finance Viewer holds with no
    // bookings access at all. The route says which it is; absent, the card fails
    // closed.
    const queue = await renderQueue({ tasks: [REVIEW_TASK] });

    expect(queue.querySelectorAll("a")).toHaveLength(0);
    expect(queue).toHaveTextContent("booking-edit");
  });

  it("offers the link to an admin whose own booking this is", async () => {
    /*
      The card is gated on finance:view; opening a booking is a separate
      permission. But a finance-only admin who OWNS the booking reaches the same
      page as its member, so the identifier was a worse answer than a link. Both
      grants are read independently — here the global one is off.
    */
    const queue = await renderQueue({
      tasks: [{ ...REVIEW_TASK, viewerOwnsBooking: true }],
      viewerCanViewBookings: false,
    });

    expect(queue).toHaveTextContent(
      "View the booking's payment and rate history",
    );
  });

  it("offers no link when neither grant is present", async () => {
    // The control for the pair above: absent means false on both, so a response
    // that establishes neither prints the identifier.
    const queue = await renderQueue({
      tasks: [REVIEW_TASK],
      viewerCanViewBookings: false,
    });

    expect(queue).not.toHaveTextContent(
      "View the booking's payment and rate history",
    );
    expect(queue).toHaveTextContent("booking-edit");
  });

  it("offers the payment and rate history link when the viewer may open it", async () => {
    const queue = await renderQueue({
      tasks: [REVIEW_TASK],
      viewerCanViewBookings: true,
    });

    const link = queue.querySelector("a");
    expect(link).toHaveAttribute("href", "/bookings/booking-edit");
    expect(queue).toHaveTextContent("payment and rate history");
  });

  it("says when the amount has been amended since the task was raised", async () => {
    await renderQueue({
      tasks: [
        { ...HAND_BACK_TASK, amountCents: 6500, raisedAmountCents: 8000 },
      ],
      viewerCanViewBookings: true,
    });

    expect(screen.getByTestId("manual-refund-task-queue")).toHaveTextContent(
      "(raised at $80.00)",
    );
  });

  it("says nothing about a raise it cannot compare against", async () => {
    // A review raised unpriced and later confirmed has no raised figure, and
    // "was Awaiting pricing" would read as a movement that never happened.
    await renderQueue({
      tasks: [{ ...REVIEW_TASK, amountCents: 4200, raisedAmountCents: null }],
      viewerCanViewBookings: true,
    });

    expect(
      screen.getByTestId("manual-refund-task-queue"),
    ).not.toHaveTextContent("raised at");
  });
});

describe("what completing or dismissing means, per kind (#3033)", () => {
  async function openDialog(task: unknown, label: string | RegExp) {
    await renderQueue({ tasks: [task], viewerCanViewBookings: true });
    fireEvent.click(screen.getByText(label));
    return waitFor(() => screen.getByRole("dialog"));
  }

  it("a dismissal on a review reads as a finding, not a refusal", async () => {
    // On a hand-back, dismissing means the member declined or it was settled
    // another way. On a review it means somebody looked and nothing is owed —
    // a statement about the money, which the record has to carry.
    const dialog = await openDialog(REVIEW_TASK, "No adjustment");

    expect(dialog).toHaveTextContent(/nothing to pay back or credit/);
    expect(dialog).toHaveTextContent(/moves no money/);
    expect(dialog).not.toHaveTextContent(/declined the refund/);
    expect(dialog).toHaveTextContent("Close with no adjustment");
  });

  it("a dismissal on a hand-back keeps its own wording", async () => {
    const dialog = await openDialog(HAND_BACK_TASK, "Dismiss");

    expect(dialog).toHaveTextContent(/declined the refund/);
    expect(dialog).toHaveTextContent("Dismiss refund");
  });

  it("refuses to offer a completion it knows the server will reject", async () => {
    // The server will not close a task with no amount. A button whose only
    // outcome is a refusal is worse than no button, so it is disarmed and the
    // dialog says what to do instead. Supplying the amount is #3032's.
    const dialog = await openDialog(REVIEW_TASK, "Record the adjustment");

    expect(dialog).toHaveTextContent(/no confirmed amount yet/);
    // And it does not print "Record Awaiting pricing as paid back".
    expect(dialog).not.toHaveTextContent("Awaiting pricing as paid back");
    expect(
      screen.getByRole("button", { name: "Record the adjustment" }),
    ).toBeDisabled();
  });

  it("does not tell an admin a decided adjustment has already gone", async () => {
    /*
      A review whose amount an admin has confirmed used to fall through to the
      hand-back arm: "Record $45.00 as paid back to Grace Hopper?", over a body
      saying "only do this once the money has actually gone back to the member".
      An adjustment is a figure just decided — nothing has physically gone
      anywhere, and waiting until it has is the opposite of what to do.
    */
    const priced = { ...REVIEW_TASK, id: "task-review-priced", amountCents: 4500 };
    const dialog = await openDialog(priced, "Record the adjustment");

    expect(dialog).toHaveTextContent("$45.00");
    expect(dialog).not.toHaveTextContent(/as paid back/);
    expect(dialog).not.toHaveTextContent(/actually gone back to the member/);
    expect(dialog).toHaveTextContent(/adjustment the club has decided on/);
    expect(
      screen.getByRole("button", { name: "Record the adjustment" }),
    ).not.toBeDisabled();
  });

  it("does not read a hand-back's placeholder as an amount", async () => {
    /*
      #2971 made `amountCents` nullable for every kind, so an UNPRICED HAND-BACK
      is representable. Interpolating the amount formatter into the hand-back
      sentence announced it as "Record Awaiting pricing as paid back to Ada
      Lovelace?".
    */
    const unpriced = {
      ...HAND_BACK_TASK,
      id: "task-hand-back-unpriced",
      amountCents: null,
    };
    const dialog = await openDialog(unpriced, "Mark paid back");

    expect(dialog).not.toHaveTextContent("Awaiting pricing as paid back");
    expect(dialog).toHaveTextContent(
      "Record this refund as paid back to Ada Lovelace?",
    );
    // Still a hand-back: it keeps the hand-back body, not the review's.
    expect(dialog).toHaveTextContent(/actually gone back to the member/);
  });

  it("still offers the completion on a priced hand-back", async () => {
    const dialog = await openDialog(HAND_BACK_TASK, "Mark paid back");

    expect(dialog).toHaveTextContent("$80.00");
    expect(
      screen.getByRole("button", { name: "Record as paid back" }),
    ).not.toBeDisabled();
  });
});
