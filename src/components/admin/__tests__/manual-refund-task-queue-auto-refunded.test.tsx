// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";

/**
 * #2750 — the operator surface for a refund nobody decided.
 *
 * A modification payment captured against a booking the club has already deleted
 * is refunded in full by the #1350 Stripe webhook, and #2700 made that leave a
 * `ManualRefundTask` behind, which the webhook then closes itself as DISMISSED
 * because there is genuinely nothing left to hand back. #2750 kept the automatic
 * refund — the member's money going back is the safe direction when nobody is
 * watching — and fixed the half that was missing: a closed row appeared on no
 * screen at all, because this queue lists OPEN rows.
 *
 * The card is named here, which is the issue's acceptance criterion: the finance
 * queue on `/admin/payments`, `data-testid="automatic-refund-notices"`.
 *
 * COMPLETE SINCE #2760, AND GROUPED. The webhook now writes the DISMISSED row
 * itself when nothing raised one, and does it for a booking that is cancelled but
 * not deleted as well — so the card is the list rather than one ordering's worth
 * of it, and the "this card does not catch every one" paragraph is gone. What
 * replaces it says the card covers the last thirty days and names the audit log as
 * the permanent record for anything older. The rows are split into two groups
 * because the widening added rows for what is usually normal operation, and those
 * would otherwise bury the case that needs a person: a refund on a booking the
 * club DELETED.
 *
 * MUTATION PROOF. Return the automatic refunds as part of `tasks` instead of
 * their own list and "never renders an automatic refund with a button" fails.
 * Keep the component's original `tasks.length === 0` early return and "shows the
 * record even when nothing is waiting to be paid back by hand" fails. Drop the
 * note or the reason from the row and "says both what happened and that the money
 * has already gone" fails. Render the card on an empty list and "renders nothing
 * at all when there is neither work nor a record" fails. Claim the card is
 * complete for all time and "names the audit log as the record beyond its window"
 * fails; put a `View booking` link back on a record row and "offers no booking
 * link on a record row" fails; blank the screen silently on a failed or degraded
 * read and the two "could not be loaded" tests fail. Merge the two groups into one
 * list and "separates a deleted booking from one that is merely cancelled" fails;
 * print the cancelled group first and "puts the deleted group first" fails.
 */

const OPEN_TASK = {
  id: "task-open",
  bookingId: "booking-cash",
  amountCents: 8000,
  reason: "Cancelled after a cash payment",
  createdAt: "2026-06-20T00:00:00Z",
  memberName: "Ada Lovelace",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

const AUTO_REFUND = {
  id: "task-auto",
  bookingId: "booking-deleted",
  amountCents: 2500,
  reason:
    "Booking modification payment pi_modification was captured against a booking the club had already deleted (#2700). Decide by hand whether to refund it.",
  note: "Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path, so there is nothing left to pay back by hand (payment intent pi_modification).",
  refundedAt: "2026-06-28T09:00:00Z",
  bookingDeleted: true,
  memberName: "Grace Hopper",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

/**
 * #2760's second population: the same automatic refund on a booking that is
 * cancelled but has NOT been deleted. Usually normal operation, which is why it
 * gets its own group rather than sitting in the same list as the deleted rows.
 */
const AUTO_REFUND_CANCELLED_ONLY = {
  id: "task-auto-cancelled",
  bookingId: "booking-cancelled-live",
  amountCents: 4500,
  reason:
    "Booking modification payment pi_modification_2 was captured against a booking the club had already cancelled (#2760).",
  note: "Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path, so there is nothing left to pay back by hand (payment intent pi_modification_2).",
  refundedAt: "2026-06-29T09:00:00Z",
  bookingDeleted: false,
  memberName: "Katherine Johnson",
  checkIn: "2026-08-14T00:00:00Z",
  checkOut: "2026-08-16T00:00:00Z",
};

/** Serves one load of the queue endpoint and nothing else. */
function stubLoad(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ManualRefundTaskQueue — automatically refunded late captures (#2750)", () => {
  it("shows the record even when nothing is waiting to be paid back by hand", async () => {
    // This is the case that matters, and the one the pre-#2750 component could
    // not render: the webhook is healthy, so there is no OPEN work, and the only
    // trace of the refund is a closed row.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("manual-refund-task-queue"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  it("names the member, the amount and the day the money went back", async () => {
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card).toHaveTextContent("Grace Hopper");
    expect(card).toHaveTextContent("$25.00");
    expect(card).toHaveTextContent(/refunded on/i);
  });

  it("says both what happened and that the money has already gone", async () => {
    // The reason ends with "Decide by hand whether to refund it" — read on its
    // own it asks for a decision that is no longer anybody's to make. The note is
    // what closes that off, so both have to be on screen.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card).toHaveTextContent(/already deleted/);
    expect(card).toHaveTextContent(/Closed automatically/);
    expect(card).toHaveTextContent(/nothing to pay back/i);
  });

  it("tells the operator the one thing they may still have to do", async () => {
    // If the DELETION was the mistake rather than the payment, the refund has
    // already gone out and the member has to be charged again. That is the whole
    // reason the record has to be seen at all.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("automatic-refund-notices")).toHaveTextContent(
      /charged again/i,
    );
  });

  it("never renders an automatic refund with a button", async () => {
    // There is no decision left. A control here would say there is, and "Mark
    // paid back" on this row would write a second refund allocation.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByText("Mark paid back")).not.toBeInTheDocument();
    expect(screen.queryByText("Dismiss")).not.toBeInTheDocument();
  });

  it("shows both cards, separately, when there is work AND a record", async () => {
    stubLoad({ tasks: [OPEN_TASK], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    const queue = screen.getByTestId("manual-refund-task-queue");
    const notices = screen.getByTestId("automatic-refund-notices");
    // The hand-back row keeps its controls; the record has none, and neither
    // list contains the other's row.
    expect(queue).toHaveTextContent("Ada Lovelace");
    expect(queue).not.toHaveTextContent("Grace Hopper");
    expect(notices).toHaveTextContent("Grace Hopper");
    expect(notices).not.toHaveTextContent("Ada Lovelace");
    expect(queue.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("renders nothing at all when there is neither work nor a record", async () => {
    stubLoad({ tasks: [], autoRefunded: [] });

    const { container } = render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("manual-refund-task-queue"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("survives an older response that carries no automatic-refund list", async () => {
    // A cached client against a pre-#2750 route, or the route degraded: the
    // hand-back queue must still work rather than throw on a missing field.
    stubLoad({ tasks: [OPEN_TASK] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
  });

  it("shows no record when the load fails, and says so rather than reading as a clean slate", async () => {
    // Not showing a STALE list is right. Showing nothing at all is not: a 500
    // would look exactly like "no automatic refunds in the last 30 days", and
    // this card exists so that an absence of rows can be trusted. Both cards stay
    // away and one line says why.
    stubLoad({}, false);

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.getByTestId("manual-refund-task-load-error"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("manual-refund-task-queue"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("manual-refund-task-load-error"),
    ).toHaveTextContent(/could not be loaded/i);
  });

  it("says the record is unavailable when the route could read the queue but not the notices", async () => {
    // The route degrades its informational query on its own so a timeout on it
    // cannot take the hand-back queue off screen. The empty list it then sends is
    // NOT an answer about money, so the surface must not present it as one — and
    // it must not claim the queue beside it is broken either.
    stubLoad({
      tasks: [OPEN_TASK],
      autoRefunded: [],
      autoRefundedUnavailable: true,
    });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.getByTestId("automatic-refund-notices-unavailable"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("manual-refund-task-queue")).toHaveTextContent(
      "Ada Lovelace",
    );
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("manual-refund-task-load-error"),
    ).not.toBeInTheDocument();
  });

  it("shows the unavailable line even when there is no hand-back work at all", async () => {
    // The pre-#2750 component returned `null` on an empty OPEN list, and a silent
    // `null` here would be the same defect in a new place: nothing on screen when
    // the truth is unknown.
    stubLoad({ tasks: [], autoRefunded: [], autoRefundedUnavailable: true });

    const { container } = render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.getByTestId("automatic-refund-notices-unavailable"),
      ).toBeInTheDocument(),
    );
    expect(container).not.toBeEmptyDOMElement();
  });

  it("names the audit log as the record beyond its window, without claiming the card is partial", async () => {
    /*
      #2760 replaced #2750's "this card does not catch every one" paragraph. That
      sentence was true then — a row existed only where the member's browser
      reached the confirm endpoint before Stripe's webhook did — and it is false
      now: the webhook writes the row on every ordering and for both populations.
      What remains honest is the WINDOW: the card reaches back thirty days, and the
      audit entry is the permanent record. Saying either more or less than that on
      a card about money is the failure this test guards.
    */
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card).toHaveTextContent(/every automatic refund/i);
    expect(card).toHaveTextContent(/last 30 days/i);
    expect(card).not.toHaveTextContent(/does not catch every one/i);
    expect(card).toHaveTextContent(
      /booking\.payment\.refunded_after_cancellation/,
    );
    /*
      #2773 lifted the OTHER qualification, and this is what stops it coming back.
      The copy used to read "every automatic refund of a late BOOKING-CHANGE
      payment", which was honest while the sibling handler for a booking's own
      payment wrote no row at all. It does now, through the same writer, so naming
      one of the two handlers would understate what the card holds — and an
      operator who reads a narrower claim than the truth goes hunting in the audit
      log for rows that are on the screen in front of them.
    */
    expect(card).not.toHaveTextContent(/booking-change payment/i);
  });

  it("separates a deleted booking from one that is merely cancelled (#2760)", async () => {
    /*
      Widening the record to every cancelled booking adds rows for what is usually
      the expected outcome of a cancellation. In one flat list they would bury the
      row that actually needs a person — a refund on a booking the club DELETED,
      where remaking it means charging the member again. Each group says what it
      means, and each row sits in the right one.
    */
    stubLoad({
      tasks: [],
      autoRefunded: [AUTO_REFUND, AUTO_REFUND_CANCELLED_ONLY],
    });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const deleted = screen.getByTestId("automatic-refund-notices-deleted");
    const cancelled = screen.getByTestId("automatic-refund-notices-cancelled");
    expect(deleted).toHaveTextContent("Grace Hopper");
    expect(deleted).not.toHaveTextContent("Katherine Johnson");
    expect(cancelled).toHaveTextContent("Katherine Johnson");
    expect(cancelled).not.toHaveTextContent("Grace Hopper");
    // The deleted group says what to do; the cancelled group says there is
    // usually nothing to do, which is what lets it be skimmed.
    expect(deleted).toHaveTextContent(/charged again/i);
    expect(cancelled).toHaveTextContent(/nothing to do/i);
    // The count in the title still covers both groups.
    expect(screen.getByTestId("automatic-refund-notices")).toHaveTextContent(
      /nothing to pay back \(2\)/i,
    );
  });

  it("puts the deleted group first, so normal operation cannot bury it", async () => {
    stubLoad({
      tasks: [],
      // Answered newest-first by the route, and the cancelled row is the newer
      // one here — so ordering alone would put the interesting case second.
      autoRefunded: [AUTO_REFUND_CANCELLED_ONLY, AUTO_REFUND],
    });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.getByTestId("automatic-refund-notices-deleted"),
      ).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    const groups = card.querySelectorAll("section[data-testid]");
    expect(groups[0].getAttribute("data-testid")).toBe(
      "automatic-refund-notices-deleted",
    );
    expect(groups[1].getAttribute("data-testid")).toBe(
      "automatic-refund-notices-cancelled",
    );
  });

  it("shows only the group it has rows for", async () => {
    // An empty "the booking was deleted (0)" heading asserts something about
    // money that the list does not contain.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND_CANCELLED_ONLY] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.getByTestId("automatic-refund-notices-cancelled"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices-deleted"),
    ).not.toBeInTheDocument();
  });

  it("puts a row from an older route with no population in NEITHER claiming group", async () => {
    /*
      A cached client against a pre-#2760 route. The first cut of this filed such a
      row under "cancelled and is still on file", reasoning that the cancelled group
      claims less — and a review of #2760 refuted that: it claims less about the
      WORK and more about the BOOKING. "Still on file" is a positive statement about
      a state we do not know, and if that booking was in fact deleted the heading
      hides the one case on this card that needs a person (remake it and charge the
      member again). So it goes in a neutral third group that asserts nothing and
      asks for a reload, and it must NOT land in either claiming group.
    */
    const { bookingDeleted: _omitted, ...withoutPopulation } = AUTO_REFUND;
    stubLoad({ tasks: [], autoRefunded: [withoutPopulation] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.getByTestId("automatic-refund-notices-unknown"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices-deleted"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("automatic-refund-notices-cancelled"),
    ).not.toBeInTheDocument();
    const unknown = screen.getByTestId("automatic-refund-notices-unknown");
    expect(unknown).toHaveTextContent("Grace Hopper");
    // Neither claiming heading appears over it. (The row's own stored `reason`
    // sentence still says what produced the payment — that is the row's data, not
    // this group's claim, and it is the same text every group prints.)
    expect(unknown).not.toHaveTextContent("The booking was deleted");
    expect(unknown).not.toHaveTextContent(
      "The booking was cancelled and is still on file",
    );
  });

  it("offers no booking link on a record row, in either group", async () => {
    /*
      For a DELETED booking the detail page 404s for anybody who is not a Full
      Admin, and this card is gated on finance:view — which a Finance Viewer and a
      Treasurer hold WITHOUT Full Admin. #2760 added rows whose booking is still on
      file, where the page exists — but it is gated on `bookings:view`, and the
      Finance Viewer bundle carries no bookings access at all, so the link is a
      dead end for part of this card's audience either way. Widening who may open a
      deleted booking is still not on the table; the identifiers are printed as
      text instead.
    */
    stubLoad({
      tasks: [OPEN_TASK],
      autoRefunded: [AUTO_REFUND, AUTO_REFUND_CANCELLED_ONLY],
    });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const notices = screen.getByTestId("automatic-refund-notices");
    expect(notices.querySelectorAll("a")).toHaveLength(0);
    expect(notices).toHaveTextContent("booking-deleted");
    // The hand-back queue keeps its link: those bookings are cancelled, not
    // deleted, so the page opens for every viewer this screen admits.
    expect(
      screen.getByTestId("manual-refund-task-queue").querySelectorAll("a").length,
    ).toBeGreaterThan(0);
  });
});
