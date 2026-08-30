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
    // This edit added nobody; the #3166 cases below supply their own.
    guestsAddedByEdit: null,
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

  it("says that the same change added guests, and that they have not been charged (#3166)", async () => {
    // The block above describes an existing guest nobody touched. Without this
    // line the card reads "nights given back: none · nights added: none" while
    // the booking has just gained two people worth $640 that a parked edit
    // deliberately did not bill — money recorded only on their own rows.
    await renderQueue({
      tasks: [
        {
          ...REVIEW_TASK,
          reviewEvidence: {
            ...REVIEW_TASK.reviewEvidence!,
            guestsAddedByEdit: { count: 2, totalPriceCents: 64000 },
          },
        },
      ],
      viewerCanViewBookings: true,
    });

    const evidence = screen.getByTestId("manual-refund-task-review-evidence");
    expect(evidence).toHaveTextContent("This change also added 2 guests");
    expect(evidence).toHaveTextContent("$640.00");
    expect(evidence).toHaveTextContent(/has not been charged/);
  });

  it("says nothing about added guests when the change added none", async () => {
    // The CONTROL. A line that appeared on every review would be furniture, and
    // an admin would stop reading it.
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });

    expect(
      screen.getByTestId("manual-refund-task-review-evidence"),
    ).not.toHaveTextContent("This change also added");
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

  it("refuses to offer a completion until the officer has said how much and which way", async () => {
    /*
      #3033 disarmed this button whenever the task carried no amount, because
      nothing on this screen could supply one and a button whose only outcome is
      a refusal is worse than no button. #3170 supplies one, so the guard moves
      to the two things the officer must now decide: an unpriced review opens with
      neither, and the button is still dead.
    */
    const dialog = await openDialog(REVIEW_TASK, "Record the adjustment");

    expect(dialog).toHaveTextContent(/Which way does this money go\?/);
    // And it does not print "Record Awaiting pricing as paid back".
    expect(dialog).not.toHaveTextContent("Awaiting pricing as paid back");
    expect(
      screen.getByRole("button", { name: "Settle the review" }),
    ).toBeDisabled();

    // An amount alone is not enough: the direction is what stops a wrong-way
    // movement, so it is required rather than defaulted.
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "45.00" },
    });
    expect(
      screen.getByRole("button", { name: "Settle the review" }),
    ).toBeDisabled();

    // And a direction alone is not enough either — the control is a genuine
    // pair, not one requirement wearing two labels.
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText(/The club owes the member/));
    expect(
      screen.getByRole("button", { name: "Pay the member back" }),
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

    // #3170: the figure is now in the box the officer can amend, not printed in
    // the title - the title carries no direction at all any more (see below).
    expect(screen.getByLabelText("Amount")).toHaveValue("45.00");
    expect(dialog).not.toHaveTextContent(/as paid back/);
    expect(dialog).not.toHaveTextContent(/actually gone back to the member/);
    fireEvent.click(screen.getByLabelText(/The club owes the member/));
    expect(
      screen.getByRole("button", { name: "Pay the member back" }),
    ).not.toBeDisabled();
  });

  it("never names a direction before the officer has chosen one (#3170)", async () => {
    /*
      THE MEASURED HAZARD. Every settlement route was refund-shaped and the copy
      read "Record an adjustment", which is neutral to read and settles as a
      refund. This child is the first that can park an edit which RAISED the
      price, so an officer who correctly concludes "they owe us $200" and types it
      would have had $200 sent to their card.

      So: no direction in the title, no pre-ticked radio, and the button - the
      last thing read before money moves - says which way.
    */
    const priced = { ...REVIEW_TASK, id: "task-review-dir", amountCents: 4500 };
    const dialog = await openDialog(priced, "Record the adjustment");

    expect(dialog).toHaveTextContent("Settle this review for Grace Hopper?");
    expect(dialog).not.toHaveTextContent(/Record an adjustment/);
    expect(screen.getByLabelText(/The club owes the member/)).not.toBeChecked();
    expect(screen.getByLabelText(/The member owes the club/)).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Settle the review" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/The member owes the club/));
    expect(
      screen.getByRole("button", { name: "Ask the member to pay" }),
    ).toBeInTheDocument();
    // And it says plainly that this screen does not take the money.
    expect(dialog).toHaveTextContent(
      /Nothing is taken from their card by this screen/,
    );
  });

  it("posts a positive magnitude and an explicit direction (#3170)", async () => {
    const priced = { ...REVIEW_TASK, id: "task-review-post", amountCents: null };
    await openDialog(priced, "Record the adjustment");

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "200.00" },
    });
    fireEvent.click(screen.getByLabelText(/The member owes the club/));
    fireEvent.change(screen.getByLabelText(/^Note/), {
      target: { value: "two extra nights, priced from the 2024 rate card" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask the member to pay" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(
        ([url]) =>
          typeof url === "string" &&
          url.includes("/manual-refund-tasks/task-review-post"),
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      // A magnitude and a direction, never a signed amount.
      expect(body.confirmedAmountCents).toBe(20000);
      expect(body.direction).toBe("CHARGE_TO_MEMBER");
    });
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

/**
 * #3191: the settle screen asks what a booking's unpriced nights sold for, and
 * #3195: the $0 refusal says what to do instead.
 *
 * MUTATION PROOF. Pre-fill a night box from the remaining balance and "fills
 * nothing in" fails. Enable the confirm button on a half-filled set and "will
 * not settle a half-answered set of nights" fails. Drop the zero sentence and
 * "explains a $0 settlement instead of just refusing to move" fails. Render the
 * section on a row that has no blanks and "asks nothing where there is nothing
 * to fill in" fails.
 */
const REVIEW_WITH_BLANKS = {
  ...REVIEW_TASK,
  unpricedNights: {
    dates: ["2026-08-11", "2026-08-12"],
    knownNightTotalCents: 6000,
    storedGuestTotalCents: 12000,
  },
};

function nightBox(date: string) {
  return screen.getByLabelText(
    date === "2026-08-11" ? "11 Aug 2026" : "12 Aug 2026",
  );
}

async function openSettleDialog(task: unknown, control: string) {
  await renderQueue({ tasks: [task], viewerCanViewBookings: true });
  fireEvent.click(screen.getByRole("button", { name: control }));
  await waitFor(() =>
    expect(screen.getByTestId("unpriced-night-price-fields")).toBeInTheDocument(),
  );
}

function postBody(fetchMock: { mock: { calls: unknown[][] } }) {
  const post = fetchMock.mock.calls.find((call) => call[1] !== undefined);
  return JSON.parse((post?.[1] as { body: string }).body) as Record<
    string,
    unknown
  >;
}

describe("recording what the unpriced nights sold for (#3191)", () => {
  it("asks nothing where there is nothing to fill in", async () => {
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Record the adjustment" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Amount")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("unpriced-night-price-fields"),
    ).not.toBeInTheDocument();
  });

  it("fills nothing in, and cannot state a target until the settlement is known", async () => {
    await openSettleDialog(REVIEW_WITH_BLANKS, "Record the adjustment");

    // Nothing is offered as a starting figure. A box that arrives with a number
    // in it is a derivation an officer can accept by pressing a button, which is
    // exactly what INV-MOD-028 forbids.
    expect(nightBox("2026-08-11")).toHaveValue("");
    expect(nightBox("2026-08-12")).toHaveValue("");
    expect(
      screen.getByTestId("unpriced-night-price-target-unknown"),
    ).toBeInTheDocument();
  });

  it("offers the same boxes on the no-adjustment path, where most parked stays end", async () => {
    await openSettleDialog(REVIEW_WITH_BLANKS, "No adjustment");

    expect(nightBox("2026-08-11")).toBeInTheDocument();
    // Nothing moves, so the target is known immediately: the nights make up the
    // difference between what is already priced and the stored total.
    expect(
      screen.queryByTestId("unpriced-night-price-target-unknown"),
    ).not.toBeInTheDocument();
  });

  it("no box is ever filled in by the screen, however many of the others are", async () => {
    /*
      THE HALF THE SOURCE CENSUS CANNOT SEE (#3191 fix round). A remainder fill
      - `targetCents - enteredCents` into the last empty box - matches none of
      `stored-night-price-repair-census.test.ts`'s patterns, and the server
      cannot catch it either: it would arrive as a complete, reconciling vector
      the checker is obliged to accept. The property is about the RESULT, so it
      is asserted as behaviour on the real screen rather than as a regex over
      the source.

      MUTATION PROOF: default the second box to the remaining balance and this
      test fails; the census stays green.
    */
    await openSettleDialog(REVIEW_WITH_BLANKS, "No adjustment");
    fireEvent.change(nightBox("2026-08-11"), { target: { value: "35.00" } });

    // One night left, one figure outstanding, and the arithmetic is forced -
    // which is exactly when a screen is tempted to be helpful.
    expect(nightBox("2026-08-12")).toHaveValue("");
    // And nothing offers to work it out either.
    expect(
      screen.queryByRole("button", {
        name: /split|evenly|remainder|work (it|the rest) out|fill in/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("takes a typed 0.00 as a real price, not as an empty box", async () => {
    /*
      #3191: "a free night is 0.00, which is a real price and not the same as
      leaving it blank" is printed under the boxes and asserted nowhere until
      this test. The distinction is the whole epic in miniature, and it runs
      through three layers that each collapse null and zero differently, so it
      is pinned end to end: typed here, posted as `priceCents: 0`.
    */
    const fetchMock = stubLoad({
      tasks: [REVIEW_WITH_BLANKS],
      viewerCanViewBookings: true,
    });
    render(<ManualRefundTaskQueue />);
    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "No adjustment" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("unpriced-night-price-fields"),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Note (required)"), {
      target: { value: "The second night was comped." },
    });
    // $120.00 stored, $60.00 already priced, nothing moving: the first night
    // carries the whole $60.00 and the second was genuinely free.
    fireEvent.change(nightBox("2026-08-11"), { target: { value: "60.00" } });
    fireEvent.change(nightBox("2026-08-12"), { target: { value: "0.00" } });

    const confirm = screen.getByRole("button", {
      name: "Close with no adjustment",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(postBody(fetchMock).recordedNightPrices).toEqual([
      { date: "2026-08-11", priceCents: 6000 },
      { date: "2026-08-12", priceCents: 0 },
    ]);
  });

  it("names the box it cannot read, instead of asking for amounts it already has", async () => {
    /*
      #3191 fix round. `parseDecimalDollarsToCents` answers null for "1,200.00",
      "$45" and "45." alike, and folding that in with "not typed" told the
      officer to give an amount for every night while every night visibly held
      one - the #2685 class `money-input.ts` warns its callers about.
    */
    await openSettleDialog(REVIEW_WITH_BLANKS, "No adjustment");
    fireEvent.change(nightBox("2026-08-11"), { target: { value: "1,200.00" } });
    fireEvent.change(nightBox("2026-08-12"), { target: { value: "25.00" } });

    const verdict = screen.getByTestId("unpriced-night-price-reconciliation");
    expect(verdict).toHaveTextContent(/11 Aug 2026/);
    expect(verdict).toHaveTextContent(/not one this box can read/);
    expect(verdict).not.toHaveTextContent(/every night listed/);
    expect(
      screen.getByRole("button", { name: "Close with no adjustment" }),
    ).toBeDisabled();
  });

  it("tells a screen reader why the button will not press", async () => {
    /*
      #3191 fix round. The confirm control is DISABLED behind the running
      verdict, so a reader who cannot see that paragraph is left with a control
      that will not press and no reason given - the bare refusal the owner's
      31 Aug 2026 decision rejected on the $0.00 control in this same dialog.
      Every box is described by it, and by the "0.00 is a real price" hint,
      in that order.
    */
    await openSettleDialog(REVIEW_WITH_BLANKS, "No adjustment");
    const verdict = screen.getByTestId("unpriced-night-price-reconciliation");
    expect(verdict).toHaveAttribute("aria-live", "polite");

    for (const date of ["2026-08-11", "2026-08-12"]) {
      const described = (
        nightBox(date).getAttribute("aria-describedby") ?? ""
      ).split(" ");
      expect(described[0]).toBe(verdict.id);
      expect(described).toHaveLength(2);
      expect(document.getElementById(described[1])).toHaveTextContent(
        /a free night is 0.00/,
      );
    }
  });

  it("will not settle a half-answered set of nights", async () => {
    await openSettleDialog(REVIEW_WITH_BLANKS, "No adjustment");
    fireEvent.change(screen.getByLabelText("Note (required)"), {
      target: { value: "Nothing owed either way." },
    });
    fireEvent.change(nightBox("2026-08-11"), { target: { value: "60.00" } });

    expect(
      screen.getByRole("button", { name: "Close with no adjustment" }),
    ).toBeDisabled();
    const verdict = screen.getByTestId("unpriced-night-price-reconciliation");
    expect(verdict).toHaveTextContent(/every night listed, or leave them all blank/);
    /*
      #3191 fix round: said as guidance, not as a rejection. This is what an
      officer sees on their very first keystroke of a multi-night answer, and
      warning colour there reads as "you have done something wrong" when they
      have simply not finished. The sentence is unchanged; only its loudness is.
    */
    expect(verdict.className).toContain("text-muted-foreground");
    fireEvent.change(nightBox("2026-08-12"), { target: { value: "1.00" } });
    // Both boxes answered and the figures still wrong: now it is a rejection.
    expect(
      screen.getByTestId("unpriced-night-price-reconciliation").className,
    ).toContain("text-warning-11");
  });

  it("settles once the figures add up, and posts exactly what was typed", async () => {
    const fetchMock = stubLoad({
      tasks: [REVIEW_WITH_BLANKS],
      viewerCanViewBookings: true,
    });
    render(<ManualRefundTaskQueue />);
    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "No adjustment" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("unpriced-night-price-fields"),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Note (required)"), {
      target: { value: "Nothing owed either way." },
    });
    // $120.00 stored, $60.00 already priced, nothing moving: $60.00 to place.
    fireEvent.change(nightBox("2026-08-11"), { target: { value: "35.00" } });
    fireEvent.change(nightBox("2026-08-12"), { target: { value: "25.00" } });

    const confirm = screen.getByRole("button", {
      name: "Close with no adjustment",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1),
    );
    expect(postBody(fetchMock).recordedNightPrices).toEqual([
      { date: "2026-08-11", priceCents: 3500 },
      { date: "2026-08-12", priceCents: 2500 },
    ]);
  });

  it("posts no night prices at all when the boxes were left alone", async () => {
    // THE CONTROL. Leaving them blank must send the body this screen sent before
    // #3191, so an officer who cannot produce a breakdown is never held up.
    const fetchMock = stubLoad({
      tasks: [REVIEW_WITH_BLANKS],
      viewerCanViewBookings: true,
    });
    render(<ManualRefundTaskQueue />);
    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "No adjustment" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("unpriced-night-price-fields"),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Note (required)"), {
      target: { value: "Nothing owed either way." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Close with no adjustment" }),
    );

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1),
    );
    expect(postBody(fetchMock).recordedNightPrices).toBeUndefined();
  });
});

describe("a $0 settlement is refused in words that help (#3195)", () => {
  it("explains a $0 settlement instead of just refusing to move", async () => {
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Record the adjustment" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Amount")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "0.00" },
    });

    const refusal = await screen.findByTestId(
      "manual-refund-task-zero-amount-refusal",
    );
    // It names the control the officer can actually see on this row.
    expect(refusal).toHaveTextContent(/close the review with no adjustment/);
    expect(
      screen.getByRole("button", { name: "Settle the review" }),
    ).toBeDisabled();

    /*
      #3195 fix round: and it is announced. The button is disabled behind this
      sentence, so a reader who never hears it gets the bare refusal the owner's
      decision rejected. It is listed FIRST on the amount box, ahead of the
      worked example, which is the ordering `field-hint.tsx` exists to enforce.
    */
    expect(refusal).toHaveAttribute("aria-live", "polite");
    const described = (
      screen.getByLabelText("Amount").getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(described[0]).toBe(refusal.id);
    expect(described).toHaveLength(2);
    expect(document.getElementById(described[1])).toHaveTextContent(
      /how much, without a plus or minus/,
    );
  });

  it("says nothing about zero when a real amount is typed", async () => {
    // THE CONTROL: the sentence is about a zero, not a standing warning.
    await renderQueue({ tasks: [REVIEW_TASK], viewerCanViewBookings: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Record the adjustment" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Amount")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "45.00" },
    });

    expect(
      screen.queryByTestId("manual-refund-task-zero-amount-refusal"),
    ).not.toBeInTheDocument();
  });
});
