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
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { waitForManualRefundQueueLoaded } from "@/lib/__tests__/support/manual-refund-task-queue-loaded";
import { DISPUTED_HAND_BACK_LOST_DISMISS_DESCRIPTION, DISPUTED_HAND_BACK_LOST_NOT_PAYABLE, DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL, DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING, disputedHandBackDismissRefusal, JOURNAL_HAND_BACK_DISMISS_REFUSAL, RETIRED_EDIT_REVIEW_REFUSAL } from "@/lib/manual-refund-task-copy";

/**
 * The finance queue's "Money to settle" card: what it says about each kind of
 * row, who may follow its booking link, and - since #4344 (wave C1 of #4302) -
 * that a retired officer edit review is shown read-only.
 *
 * The officer review's own settle screen, its evidence block, its night-price
 * boxes and its still-owed notice were retired with the review. The route no
 * longer lists one (`route.test.ts`) and the resolve route refuses the kind
 * (`resolve-route.test.ts`); a review row reaches this card only from an older
 * route during a deploy, and the cases below hold what the card does then.
 *
 * MUTATION PROOF. Give a review row its old buttons back and "offers no control
 * on a retired review" fails. Print the cash paragraph over a review row and
 * "does not describe a retired review as a cancelled cash booking" fails.
 * Render the booking link without checking the flag and "prints the identifier
 * instead of a link the viewer cannot follow" fails.
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
  ...STAY,
};

/** What an older route still listing an open review would send. */
const RETIRED_REVIEW_TASK = {
  id: "task-review",
  bookingId: "booking-edit",
  amountCents: null,
  raisedAmountCents: null,
  kind: "EDIT_FINANCIAL_REVIEW",
  reason: "A change to this booking could not be priced from stored history.",
  createdAt: "2026-06-21T00:00:00Z",
  memberName: "Grace Hopper",
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
  await waitForManualRefundQueueLoaded();
  return screen.getByTestId("manual-refund-task-queue");
}

/** How many close POSTs the screen made. A load is a GET and has no init. */
function postCount(fetchMock: { mock: { calls: unknown[][] } }): number {
  return fetchMock.mock.calls.filter((call) => call[1] !== undefined).length;
}

function postBody(fetchMock: { mock: { calls: unknown[][] } }) {
  const post = fetchMock.mock.calls.find((call) => call[1] !== undefined);
  return JSON.parse((post?.[1] as { body: string }).body) as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("an edit's refund hand-back is not described as a cancellation (#3827, D-3813-6)", () => {
  it("prints the edit-refund sentence, and not the cancelled-booking one, over an edit refund", async () => {
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, editRefundHandBack: true }],
      viewerCanViewBookings: true,
    });
    expect(screen.getByTestId("manual-refund-task-edit-refund-intro")).toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-hand-back-intro")).not.toBeInTheDocument();
    // Completed like any hand-back: the same paid-back control.
    expect(screen.getByRole("button", { name: /paid back/i })).toBeInTheDocument();
  });

  it("a cancellation's hand-back keeps its own sentence alone", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });
    expect(screen.queryByTestId("manual-refund-task-edit-refund-intro")).not.toBeInTheDocument();
  });
});

describe("an approved appeal's refund hand-back has its own sentence (#3827, D-3813-7)", () => {
  it("prints the appeal sentence, and neither the cancelled-booking nor the edit one", async () => {
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, refundRequestHandBack: true }],
      viewerCanViewBookings: true,
    });
    expect(screen.getByTestId("manual-refund-task-refund-request-intro")).toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-hand-back-intro")).not.toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-edit-refund-intro")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /paid back/i })).toBeInTheDocument();
  });

  it("a cancellation's hand-back does not print it", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });
    expect(screen.queryByTestId("manual-refund-task-refund-request-intro")).not.toBeInTheDocument();
  });
});

describe("a cancel's card refund shortfall has its own sentence (#4097, `INV-PAY-129`)", () => {
  it("prints the card-shortfall sentence, never the cash one, and offers paid back and dismiss", async () => {
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, cardShortfallHandBack: true }],
      viewerCanViewBookings: true,
    });
    const intro = screen.getByTestId("manual-refund-task-card-shortfall-intro");
    expect(intro.textContent).toMatch(/card refund could not carry all of the refund due/);
    // #4154 review: one order on every hand-back - mark first, then pay straight after the app accepts.
    expect(intro.textContent).toMatch(/mark it paid back\s+first/);
    expect(intro.textContent).toMatch(/then pay it by bank\s+transfer straight after the app accepts/);
    // #4159 review round 2 (F4): a Xero note only where the booking has an invoice to credit.
    expect(intro.textContent).toMatch(/where the booking has a Xero invoice, raises its refund credit note/);
    expect(intro.textContent).not.toMatch(/which also raises its Xero refund credit note/);
    expect(intro.textContent).not.toMatch(/pay it by bank\s+transfer, then mark/);
    expect(screen.queryByTestId("manual-refund-task-card-shortfall-check-intro")).not.toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-hand-back-intro")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /paid back/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
  });

  it("a part to check prints its own sentence, which never says to pay it", async () => {
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, cardShortfallCheck: true }],
      viewerCanViewBookings: true,
    });
    const intro = screen.getByTestId("manual-refund-task-card-shortfall-check-intro");
    expect(intro.textContent).toMatch(/Check Stripe and\s+the bank before paying anything, then contact the member with what you found/);
    // #4516 (owner decision, 15 Nov 2026): a part to check keeps Dismiss, used only once the card refund is confirmed.
    expect(intro.textContent).toMatch(/Dismiss it with a note saying how only once you have confirmed the card refund reached them/);
    expect(intro.textContent).not.toMatch(/cannot be dismissed/);
    // Paying it is only the answer once the check shows it is owed - and (#4154 review M3) only after the
    // app has accepted the mark: mark first, then pay, on every surface.
    expect(intro.textContent).toMatch(/If it really is owed, mark it\s+paid\s+back first/);
    expect(intro.textContent).toMatch(/pay it by bank transfer\s+straight after the app accepts/);
    expect(intro.textContent).not.toMatch(/pay it by bank transfer,? (then|and) mark/i);
    // #4154: a capacity race's too - whose member is told on the booking page only, never by email.
    expect(intro.textContent).toMatch(/from a booking cancelled because its dates filled up during the card payment/);
    expect(intro.textContent).toMatch(/on their booking page,\s+and for a cancellation by email unless emails were turned off/);
    expect(screen.queryByTestId("manual-refund-task-card-shortfall-intro")).not.toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-hand-back-intro")).not.toBeInTheDocument();
  });

  it("#4154 review (M3): a part to check's paid-back dialog says to mark first and pay straight after, never that the money has already gone", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, cardShortfallCheck: true }], viewerCanViewBookings: true });
    fireEvent.click(screen.getByRole("button", { name: /paid back/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/The app first checks it can record this; pay straight after it accepts\./);
    expect(dialog.textContent).not.toMatch(/once the money has actually gone back/);
  });

  it("#3949: an edit's or appeal's hand-back on a joiner the organiser paid for by internet banking is paid back to the organiser", async () => {
    for (const marker of [{ editRefundHandBack: true }, { refundRequestHandBack: true }]) {
      cleanup();
      await renderQueue({ tasks: [{ ...HAND_BACK_TASK, ...marker, paidToGroupOrganiser: true }], viewerCanViewBookings: true });
      fireEvent.click(screen.getByRole("button", { name: /paid back/i }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toMatch(/once the money has actually gone back to the group organiser, who paid for this booking/);
      expect(dialog.textContent).toMatch(/emailed to raise its Xero credit note by hand/);
      expect(dialog.textContent).not.toMatch(/gone back to the member/);
      // Review: the title names the organiser too.
      expect(screen.getByRole("heading", { name: /as paid back to the group organiser for /i })).toBeInTheDocument();
    }
  });

  it("#3949 review: such rows get the organiser intro, never the member's edit or appeal sentence, and their dismissal names the organiser", async () => {
    for (const marker of [{ editRefundHandBack: true }, { refundRequestHandBack: true }]) {
      cleanup();
      await renderQueue({ tasks: [{ ...HAND_BACK_TASK, ...marker, paidToGroupOrganiser: true }], viewerCanViewBookings: true });
      expect(screen.getByTestId("manual-refund-task-organiser-payee-intro").textContent).toMatch(/goes back to the organiser by bank transfer/);
      expect(screen.queryByTestId("manual-refund-task-edit-refund-intro")).not.toBeInTheDocument();
      expect(screen.queryByTestId("manual-refund-task-refund-request-intro")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect((await screen.findByRole("dialog")).textContent).toMatch(/for a group organiser who declined the refund/);
    }
  });

  it("CONTROL: a cash hand-back's paid-back dialog keeps its sentence", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });
    fireEvent.click(screen.getByRole("button", { name: /paid back/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/once the money has actually gone back to the member/);
    expect(dialog.textContent).not.toMatch(/first checks it can record this/);
  });

  it("a cash hand-back does not print it", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });
    expect(screen.queryByTestId("manual-refund-task-card-shortfall-intro")).not.toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-card-shortfall-check-intro")).not.toBeInTheDocument();
  });
});

describe("a group organiser's Internet Banking hand-back has its own sentence (#4042)", () => {
  it("prints the group sentence, never the cash one or a Xero claim, is marked paid back and offers no Dismiss", async () => {
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, groupOrganiserHandBack: true }],
      viewerCanViewBookings: true,
    });
    const intro = screen.getByTestId("manual-refund-task-group-organiser-intro");
    expect(intro).toBeInTheDocument();
    expect(intro.textContent).toMatch(/take it to the treasurer/);
    expect(intro.textContent).toMatch(/Marking it paid back sends nothing to Xero/);
    expect(intro.textContent).not.toMatch(/(in|recorded in) Xero/);
    expect(screen.queryByTestId("manual-refund-task-hand-back-intro")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /paid back/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^dismiss$/i })).not.toBeInTheDocument();
  });

  it("marking it paid back posts the total the card showed, so a total grown since is refused by the server", async () => {
    const fetchMock = stubLoad({ tasks: [{ ...HAND_BACK_TASK, groupOrganiserHandBack: true }], viewerCanViewBookings: true });
    render(<ManualRefundTaskQueue />);
    await waitForManualRefundQueueLoaded();
    fireEvent.click(screen.getByRole("button", { name: /paid back/i }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Record as paid back" }));

    await waitFor(() => expect(postCount(fetchMock)).toBe(1));
    expect(postBody(fetchMock)).toEqual({ resolution: "completed", confirmed: true, note: null, confirmedAmountCents: 8000 });
  });

  it("CONTROL: a cash hand-back posts the body it always did, with no amount", async () => {
    const fetchMock = stubLoad({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });
    render(<ManualRefundTaskQueue />);
    await waitForManualRefundQueueLoaded();
    fireEvent.click(screen.getByRole("button", { name: /paid back/i }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Record as paid back" }));

    await waitFor(() => expect(postCount(fetchMock)).toBe(1));
    expect(postBody(fetchMock)).toEqual({ resolution: "completed", confirmed: true, note: null });
  });

  it("its paid-back dialog says what the action records, never that it writes the refund into the ledger", async () => {
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, groupOrganiserHandBack: true }],
      viewerCanViewBookings: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /paid back/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/as repaid to the group organiser/);
    expect(dialog.textContent).toMatch(/joiners' refunds are already in the ledger/);
    expect(dialog.textContent).not.toMatch(/writes the refund into the payment ledger/);
  });

  it("a cancellation's hand-back does not print it", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });
    expect(screen.queryByTestId("manual-refund-task-group-organiser-intro")).not.toBeInTheDocument();
  });
});

describe("a real bank or cash hand-back offers no Dismiss for now (#4516, owner decisions 14 and 15 Nov 2026)", () => {
  it("prints the server's refusal where the Dismiss button would be, and keeps Mark paid back", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, journalHandBackDismissRefusal: JOURNAL_HAND_BACK_DISMISS_REFUSAL }], viewerCanViewBookings: true });

    expect(screen.queryByRole("button", { name: /^dismiss$/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("manual-refund-task-dismiss-unavailable").textContent).toBe(JOURNAL_HAND_BACK_DISMISS_REFUSAL);
    expect(screen.getByRole("button", { name: /paid back/i })).toBeInTheDocument();
  });

  it("CONTROL: a row whose dismissal is not refused keeps its Dismiss and prints no refusal", async () => {
    await renderQueue({ tasks: [HAND_BACK_TASK], viewerCanViewBookings: true });

    expect(screen.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(screen.queryByTestId("manual-refund-task-dismiss-unavailable")).not.toBeInTheDocument();
  });

  it("a card shortfall's part to check keeps Dismiss, and its dialog says to dismiss only once the card refund is confirmed", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, cardShortfallCheck: true, journalHandBackDismissRefusal: null }], viewerCanViewBookings: true });

    expect(screen.queryByTestId("manual-refund-task-dismiss-unavailable")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(await screen.findByText(/^Only dismiss this once you have confirmed in Stripe that the card refund reached the member\./)).toBeInTheDocument();
  });

  it("#4516: a disputed card payment's hand-back prints the dispute's own refusal while it is open", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, journalHandBackDismissRefusal: disputedHandBackDismissRefusal("OPEN") }], viewerCanViewBookings: true });

    expect(screen.queryByRole("button", { name: /^dismiss$/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("manual-refund-task-dismiss-unavailable").textContent).toBe(disputedHandBackDismissRefusal("OPEN"));
  });

  it("#4516 (owner decision, 15 Nov 2026, comment 6893252570): lost for part, it offers the reduction and the confirmation states was, reduced by and still owed", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, amountCents: 10_000, journalHandBackDismissRefusal: DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL, disputeReduction: { reducedByCents: 3_000, stillOwedCents: 7_000 } }], viewerCanViewBookings: true });

    expect(screen.queryByRole("button", { name: /^dismiss$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reduce by lost dispute/i }));
    expect((await screen.findByTestId("manual-refund-task-reduction-summary")).textContent).toMatch(/^Was \$100\.00\. Reduced by \$30\.00, the lost card dispute.*Still owed \$70\.00\.$/);
  });

  it("CONTROL: with no reduction offered there is no reduce button", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, journalHandBackDismissRefusal: JOURNAL_HAND_BACK_DISMISS_REFUSAL, disputeReduction: null }], viewerCanViewBookings: true });
    expect(screen.queryByRole("button", { name: /reduce by lost dispute/i })).not.toBeInTheDocument();
  });

  it.each([
    ["lost in full: Dismiss, never Mark paid", { journalHandBackDismissRefusal: null, disputedHandBackLost: true, markPaidRefusal: DISPUTED_HAND_BACK_LOST_NOT_PAYABLE }, true],
    ["lost in part: Reduce, never Mark paid", { journalHandBackDismissRefusal: DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL, disputeReduction: { reducedByCents: 3_000, stillOwedCents: 5_000 }, markPaidRefusal: DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING }, false],
  ])("#4516 (owner decision, 18 Nov 2026): a dispute-held edit's hand-back %s", async (_label, facts, dismissible) => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, kind: "CANCELLED_BOOKING_HAND_BACK", editRefundHandBack: true, ...facts }], viewerCanViewBookings: true });

    expect(screen.queryByRole("button", { name: /mark paid back/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^dismiss$/i }) !== null).toBe(dismissible);
  });

  it("CONTROL: a won dispute (no Mark paid refusal) keeps Mark paid back", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, kind: "CANCELLED_BOOKING_HAND_BACK", editRefundHandBack: true, journalHandBackDismissRefusal: disputedHandBackDismissRefusal("WON"), markPaidRefusal: null }], viewerCanViewBookings: true });
    expect(screen.getByRole("button", { name: /mark paid back/i })).toBeInTheDocument();
  });

  it("#4516: once its dispute is lost it keeps Dismiss, and the dialog says the cardholder already has the money", async () => {
    await renderQueue({ tasks: [{ ...HAND_BACK_TASK, journalHandBackDismissRefusal: null, disputedHandBackLost: true }], viewerCanViewBookings: true });

    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(await screen.findByText(DISPUTED_HAND_BACK_LOST_DISMISS_DESCRIPTION)).toBeInTheDocument();
  });
});


describe("a retired officer edit review is shown, never acted on (#4344)", () => {
  it("offers no control on a retired review, and says why", async () => {
    const queue = await renderQueue({
      tasks: [RETIRED_REVIEW_TASK],
      viewerCanViewBookings: true,
    });
    const row = within(queue).getByText(/Grace Hopper/).closest("li");
    expect(row).not.toBeNull();

    expect(within(row as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(row as HTMLElement).getByTestId("manual-refund-task-retired-review"),
    ).toHaveTextContent(RETIRED_EDIT_REVIEW_REFUSAL);
    // Its booking is still one click away, which is where its history lives.
    expect(within(row as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/bookings/booking-edit",
    );
  });

  it("does not describe a retired review as a cancelled cash booking, or as a settled zero", async () => {
    const queue = await renderQueue({
      tasks: [RETIRED_REVIEW_TASK],
      viewerCanViewBookings: true,
    });

    expect(
      screen.queryByTestId("manual-refund-task-hand-back-intro"),
    ).not.toBeInTheDocument();
    expect(queue).toHaveTextContent("Amount not known");
    expect(queue).not.toHaveTextContent("$0.00");
  });

  it("leaves the hand-back beside it fully actionable", async () => {
    const queue = await renderQueue({
      tasks: [HAND_BACK_TASK, RETIRED_REVIEW_TASK],
      viewerCanViewBookings: true,
    });
    const handBack = within(queue).getByText(/Ada Lovelace/).closest("li");

    expect(
      within(handBack as HTMLElement).getByRole("button", { name: "Mark paid back" }),
    ).toBeEnabled();
    expect(
      within(handBack as HTMLElement).getByRole("button", { name: "Dismiss" }),
    ).toBeEnabled();
    expect(
      screen.getByTestId("manual-refund-task-hand-back-intro"),
    ).toHaveTextContent(/Some of these bookings were paid in cash/);
    expect(screen.getAllByTestId("manual-refund-task-retired-review")).toHaveLength(1);
  });
});

describe("the booking link and the amount line (#3033)", () => {
  it("prints the identifier instead of a link the viewer cannot follow", async () => {
    // This card is gated on finance:view, which a Finance Viewer holds with no
    // bookings access at all. The route says which it is; absent, the card fails
    // closed.
    const queue = await renderQueue({ tasks: [HAND_BACK_TASK] });

    expect(queue.querySelectorAll("a")).toHaveLength(0);
    expect(queue).toHaveTextContent("booking-cash");
  });

  it("offers the link to an admin whose own booking this is", async () => {
    /*
      The card is gated on finance:view; opening a booking is a separate
      permission. But a finance-only admin who OWNS the booking reaches the same
      page as its member, so the identifier was a worse answer than a link. Both
      grants are read independently — here the global one is off.
    */
    const queue = await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, viewerOwnsBooking: true }],
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
      tasks: [HAND_BACK_TASK],
      viewerCanViewBookings: false,
    });

    expect(queue).not.toHaveTextContent(
      "View the booking's payment and rate history",
    );
    expect(queue).toHaveTextContent("booking-cash");
  });

  it("offers the payment and rate history link when the viewer may open it", async () => {
    const queue = await renderQueue({
      tasks: [HAND_BACK_TASK],
      viewerCanViewBookings: true,
    });

    const link = queue.querySelector("a");
    expect(link).toHaveAttribute("href", "/bookings/booking-cash");
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
    // A task raised with no amount has no raised figure to compare against, and
    // "raised at" nothing would read as a movement that never happened.
    await renderQueue({
      tasks: [{ ...HAND_BACK_TASK, amountCents: 4200, raisedAmountCents: null }],
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

  it("a dismissal on a hand-back keeps its own wording", async () => {
    const dialog = await openDialog(HAND_BACK_TASK, "Dismiss");

    expect(dialog).toHaveTextContent(/declined the refund/);
    expect(dialog).toHaveTextContent("Dismiss refund");
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

    expect(dialog).not.toHaveTextContent("Amount not known as paid back");
    expect(dialog).toHaveTextContent(
      "Record this refund as paid back to Ada Lovelace?",
    );
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
