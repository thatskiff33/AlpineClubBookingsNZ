// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canEdit: true as boolean | undefined,
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => mocks.canEdit,
}));

import {
  CardRefundsPaidTwiceList,
  DeadCardRefundsPanel,
  STRIPE_MAY_HAVE_REFUNDED_WARNING,
  type DeadCardRefundPanelRow,
} from "@/components/admin/dead-card-refunds-panel";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { describeRefundMethod } from "@/lib/xero-refund-method";

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"; #3924 round 4, U6):
 * the "Paid another way" dialog on the stuck-states page. The close's rules are
 * the server's (`card-refund-paid-another-way.test.ts`); this pins what the
 * treasurer sees and sends.
 */

function row(overrides: Partial<DeadCardRefundPanelRow> = {}): DeadCardRefundPanelRow {
  return {
    operationId: "op-1",
    bookingId: "b-1",
    bookingReference: "BK-0001",
    raisedAt: "2026-06-20T00:00:00.000Z",
    owedCents: 15_000,
    wholeAmountOnly: false,
    xeroRefundNote: "now",
    cardNoteCoversCents: 0,
    stripeMayHaveRefunded: false,
    laterStripeRefunds: [],
    tryCardAgainRefusal: null,
    ...overrides,
  };
}

function respond(status: number, body: unknown) {
  mocks.fetch.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** The bank-transfer note's own wording, which the server page passes (`describeRefundMethod`). */
const BANK_NOTE_WORDING = describeRefundMethod("internet-banking");

function openDialog(subject = row()) {
  const view = render(<DeadCardRefundsPanel rows={[subject]} bankNoteWording={BANK_NOTE_WORDING} />);
  fireEvent.click(
    screen.getByRole("button", { name: `Close the card refund for booking ${subject.bookingReference} as paid another way` }),
  );
  return view;
}

const fullChoice = () => screen.getByRole("radio", { name: "Paid back in full" });
const partChoice = () => screen.getByRole("radio", { name: "Paid back part of it" });
// #4516 (owner, 2 Nov 2026): a part close's rest, asked exactly.
const keepsChoice = () => screen.getByRole("button", { name: "The club keeps the rest" });
const owedChoice = () => screen.getByRole("button", { name: "The rest is still owed to the member" });
const amountBox = () => screen.getByLabelText("Amount paid back") as HTMLInputElement;
const noteBox = () => screen.getByLabelText("How was it paid back? (required)") as HTMLTextAreaElement;
const closeButton = () => screen.getByRole("button", { name: "Close as paid another way" });

beforeEach(() => {
  mocks.canEdit = true;
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("the Paid another way dialog", () => {
  it("says up front what the close does and what is owed", () => {
    openDialog();

    expect(screen.getByText("$150.00 is still owed.")).toBeInTheDocument();
    // Round 7 (SSOT): the note's wording is the one home's, never spelled here.
    expect(
      screen.getByText(`A Xero refund credit note for the amount, worded "${BANK_NOTE_WORDING}", is queued when you close it.`),
    ).toBeInTheDocument();
    // #4368 (decision 7): settled here, never with a new Stripe dashboard refund; the old "wait for it" is gone.
    expect(screen.getByText("Settle it here, not with a new refund in the Stripe dashboard.")).toBeInTheDocument();
    expect(screen.queryByText(/wait for that refund/i)).not.toBeInTheDocument();
  });

  it("says no Xero note is queued where the app has no invoice it can credit - without claiming none is on its way", () => {
    openDialog(row({ xeroRefundNote: "none" }));
    expect(
      screen.getByText(/No Xero refund credit note is queued: the app has no Xero invoice it can credit for this money yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/there is no Xero invoice/)).not.toBeInTheDocument();
  });

  // #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit").
  it("MUTATION: says a late card charge Xero has no record of is recorded as a receipt first, then credited", () => {
    openDialog(row({ xeroRefundNote: "after-receipt" }));
    expect(
      screen.getByText(
        `Xero has no record of this late card charge yet. Closing it records the charge in Xero as a payment received into the Stripe account, then queues a Xero refund credit note for the amount, worded "${BANK_NOTE_WORDING}", against it.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No Xero refund credit note is queued/)).not.toBeInTheDocument();
  });

  it("MUTATION: after a receipt-first close, the message says the note follows the receipt", async () => {
    openDialog(row({ xeroRefundNote: "after-receipt" }));
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "receipt-then-refund-note" });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      `Closed. $150.00 recorded as paid back in full. The late card charge is queued to be recorded in Xero as a payment received into the Stripe account; its refund credit note, worded "${BANK_NOTE_WORDING}", follows once it is.`,
    );
  });

  it("MUTATION: makes the treasurer choose full or part - nothing is chosen for them, and no amount is shown until they do", () => {
    openDialog();
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });

    expect(fullChoice()).not.toBeChecked();
    expect(partChoice()).not.toBeChecked();
    expect(screen.queryByLabelText("Amount paid back")).not.toBeInTheDocument();
    expect(closeButton()).toBeDisabled();
    const hint = screen.getByText("Choose whether it was paid back in full or in part.");
    expect(closeButton()).toHaveAttribute("aria-describedby", hint.id);
  });

  it("'Paid back in full' fixes the amount at what is owed", () => {
    openDialog();
    fireEvent.click(fullChoice());
    expect(amountBox().value).toBe("150.00");
    expect(amountBox()).toBeDisabled();
  });

  it("requires the note: marked required, the button disabled with the reason beside it", () => {
    openDialog();
    fireEvent.click(fullChoice());

    expect(noteBox()).toHaveAttribute("aria-required", "true");
    expect(closeButton()).toBeDisabled();
    const hint = screen.getByText("Say how the member was paid back to close it.");
    expect(closeButton()).toHaveAttribute("aria-describedby", hint.id);

    fireEvent.change(noteBox(), { target: { value: "Bank transfer, ref 123" } });
    expect(closeButton()).toBeEnabled();
  });

  it("'Paid back part of it' asks for the amount, and warns - as a status the field names - what stops being owed", () => {
    openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });

    expect(amountBox().value).toBe("");
    expect(amountBox()).toHaveAttribute("aria-required", "true");
    expect(closeButton()).toBeDisabled();

    fireEvent.change(amountBox(), { target: { value: "100.00" } });
    fireEvent.click(keepsChoice());
    const warning = screen.getByText("$50.00 will no longer be owed to the member: the club keeps it, as this close records.");
    expect(warning).toHaveAttribute("role", "status");
    expect(amountBox().getAttribute("aria-describedby")).toContain(warning.id);
    expect(closeButton()).toBeEnabled();
  });

  it("MUTATION (#4516): a part close asks what happens to the rest, with nothing chosen, and cannot close until it is answered", () => {
    openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    fireEvent.change(amountBox(), { target: { value: "100.00" } });
    expect(screen.getByRole("group", { name: "What happens to the rest?" })).toBeInTheDocument();
    expect(keepsChoice()).toHaveAttribute("aria-pressed", "false");
    expect(owedChoice()).toHaveAttribute("aria-pressed", "false");
    expect(closeButton()).toBeDisabled();
    const hint = screen.getByText("Choose whether the club keeps the rest or it is still owed to the member.");
    expect(closeButton()).toHaveAttribute("aria-describedby", hint.id);
    fireEvent.click(owedChoice());
    expect(owedChoice()).toHaveAttribute("aria-pressed", "true");
    expect(keepsChoice()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("$50.00 stays owed to the member, on this list, until it is closed.")).toHaveAttribute("role", "status");
    expect(closeButton()).toBeEnabled();
  });

  it("a full close asks nothing about a rest", () => {
    openDialog();
    fireEvent.click(fullChoice());
    expect(screen.queryByRole("button", { name: "The club keeps the rest" })).not.toBeInTheDocument();
  });

  it("MUTATION: never infers part from the amount: part of it must be less than is owed", () => {
    openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    fireEvent.change(amountBox(), { target: { value: "150.00" } });
    expect(closeButton()).toBeDisabled();
    expect(screen.getAllByText(/Part of it must be less than the \$150\.00 still owed/).length).toBeGreaterThan(0);
  });

  it("closes a superseded payment's refund in full only, and the disabled part choice names why", () => {
    openDialog(row({ wholeAmountOnly: true }));
    expect(fullChoice()).toBeChecked();
    expect(partChoice()).toBeDisabled();
    expect(amountBox()).toBeDisabled();
    const why = screen.getByText(/closes for the whole amount/);
    // Round 7 (UX): linked to the disabled radio, so a screen reader hears it there.
    expect(partChoice()).toHaveAttribute("aria-describedby", why.id);
  });

  it("MUTATION: round 7 (UX): choosing part raises no alert before the treasurer has typed or left the box", () => {
    openDialog();
    fireEvent.click(partChoice());
    const amountAlerts = () =>
      screen.queryAllByRole("alert").filter((alert) => alert.textContent?.includes("Enter the amount paid back"));
    expect(amountAlerts()).toHaveLength(0);
    expect(amountBox()).not.toHaveAttribute("aria-invalid");
    // The disabled button still says why, beside it - as a hint, not an alert.
    const hint = screen.getByText("Enter the amount paid back, in dollars and cents.");
    expect(closeButton()).toHaveAttribute("aria-describedby", hint.id);

    fireEvent.blur(amountBox());
    expect(amountBox()).toHaveAttribute("aria-invalid", "true");
    expect(amountAlerts()).toHaveLength(1);
  });

  it("flags a refund Stripe may have made after all, on its row and in its dialog", () => {
    openDialog(row({ stripeMayHaveRefunded: true }));
    expect(screen.getAllByText(STRIPE_MAY_HAVE_REFUNDED_WARNING)).toHaveLength(2);
  });

  it("MUTATION: sends 'full' with the whole amount, then thanks with the Xero outcome and refreshes", async () => {
    openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer, ref 123" } });
    respond(200, { success: true, xeroQueued: "refund-note" });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/payments/card-refunds/op-1/paid-another-way",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          amountCents: 15_000,
          paidBack: "full",
          expectedOwedCents: 15_000,
          note: "Bank transfer, ref 123",
          confirmed: true,
        }),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      `Closed. $150.00 recorded as paid back in full. Its Xero refund credit note, worded "${BANK_NOTE_WORDING}", is queued.`,
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: sends 'partial' with the amount typed, and says what is no longer owed", async () => {
    openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(amountBox(), { target: { value: "100.00" } });
    fireEvent.click(keepsChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "nothing" });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/payments/card-refunds/op-1/paid-another-way",
      expect.objectContaining({
        body: JSON.stringify({
          amountCents: 10_000,
          paidBack: "partial",
          rest: "club-keeps",
          expectedOwedCents: 15_000,
          note: "Bank transfer",
          confirmed: true,
        }),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Closed. $100.00 recorded as paid back; the other $50.00 is kept by the club and no longer owed. No Xero refund credit note was queued: check the refund is recorded in Xero.",
    );
  });

  // #3924 round 8 (UX): the row is gone after a close, so focus goes to the
  // list's status line, which says what was done.
  it("MUTATION: after a close, focus moves to the list's status line, which says what was done", async () => {
    openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "refund-note" });
    fireEvent.click(closeButton());

    const notice = await screen.findByText("The card refund for booking BK-0001 was closed as paid another way.");
    expect(notice).toHaveAttribute("role", "status");
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  // #4104 delta review (D4, D8): a refund Stripe failed later, whose card note
  // is still in Xero - the dialog says how much it covers, for a close of any
  // amount, and the list says why the app will not ask Stripe again.
  it("a refund whose card note Xero still holds: the dialog says how much it covers and what a part close leaves", async () => {
    openDialog(row({ xeroRefundNote: "covered-by-card-note", cardNoteCoversCents: 4_000 }));
    expect(screen.getByText(/later reported it failed - a retry that failed again/)).toBeInTheDocument();
    expect(
      screen.getByText(
        `Xero already holds a card refund credit note for $40.00 of this refund, raised when the card provider first accepted it. Up to that much of what you pay back needs no new note; for anything beyond it, a Xero refund credit note worded "${BANK_NOTE_WORDING}" is queued when you close it. If you pay back less than $40.00, Xero's note credits more than went back: the Xero reconciliation report lists the difference as refund coverage above the refunded total, for you to correct in Xero.`,
      ),
    ).toBeInTheDocument();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "refund-note-beyond-card-note" });
    fireEvent.click(closeButton());
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        `Closed. $150.00 recorded as paid back in full. A card refund credit note already in Xero records part of what you paid back; a Xero refund credit note worded "${BANK_NOTE_WORDING}" is queued for the rest.`,
      ),
    );
  });

  // #3924 round 8 (owner, 8 Oct 2026: "Raise a refund note for all").
  it("a late charge whose invoice is on its way to Xero: the dialog and the message say its note follows that invoice", async () => {
    openDialog(row({ xeroRefundNote: "after-receipt-on-its-way" }));
    expect(
      screen.getByText(
        `This late card charge's invoice is on its way to Xero but is not there yet. Once it is, a Xero refund credit note for the amount, worded "${BANK_NOTE_WORDING}", is queued against it.`,
      ),
    ).toBeInTheDocument();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "refund-note-after-receipt" });
    fireEvent.click(closeButton());
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        `Closed. $150.00 recorded as paid back in full. Its Xero refund credit note, worded "${BANK_NOTE_WORDING}", follows once the late card charge's invoice reaches Xero.`,
      ),
    );
  });

  // #3924 round 9: a receipt only an officer's retry sends is never said to
  // be on its way, before or after the close. Round 10: a record that may
  // already be in Xero is checked first, and if it is there it is marked
  // resolved and this refund recorded by hand - never retried blind.
  const HELD =
    "This late card charge's Xero record (its change invoice or its own receipt) failed and may already be in Xero, so check Xero first. If it is not there, retry it from the Xero operations list, and ";
  const HELD_END = ". If it is already in Xero, mark it resolved as fixed in Xero and record this refund by hand.";
  const FAILED = "This late card charge's invoice failed before it reached Xero. Retry it from the Xero operations list, and ";
  it.each([
    ["after-receipt-held-for-officer", "receipt-held-for-officer", HELD, HELD_END],
    ["after-receipt-failed", "refund-note-after-failed-receipt", FAILED, "."],
  ] as const)("MUTATION: rounds 9-10: %s - the dialog and the message say what the officer does, and the note follows a retry", async (promise, queued, instruction, end) => {
    openDialog(row({ xeroRefundNote: promise }));
    expect(
      screen.getByText(
        `Closing this does not send the late card charge's Xero record. ${instruction}once it is in Xero a Xero refund credit note for the amount, worded "${BANK_NOTE_WORDING}", is queued against it${end}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/on its way/)).not.toBeInTheDocument();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: queued });
    fireEvent.click(closeButton());
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        `Closed. $150.00 recorded as paid back in full. ${instruction}its refund credit note, worded "${BANK_NOTE_WORDING}", follows${end}`,
      ),
    );
  });

  // #3924 round 9 (UX): the card stays when its last row closes, so focus
  // still lands on its status line, and it says the list is empty.
  it("MUTATION: round 9: closing the last row keeps the card, its status line and focus, and says the list is empty", async () => {
    const { rerender } = openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "refund-note" });
    fireEvent.click(closeButton());
    const notice = await screen.findByText("The card refund for booking BK-0001 was closed as paid another way.");
    rerender(<DeadCardRefundsPanel rows={[]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(screen.getByText("Card refunds Stripe gave up on")).toBeInTheDocument();
    expect(screen.getByText("No card refunds are waiting to be closed.")).toBeInTheDocument();
    expect(notice).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("a list that never had a row renders nothing", () => {
    const { container } = render(<DeadCardRefundsPanel rows={[]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a 409 in the dialog as a focused alert, and refreshes the list beneath it", async () => {
    openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(409, { error: "This card refund changed while you were closing it - refresh and try again." });
    fireEvent.click(closeButton());

    const alert = await screen.findByText(/This card refund changed while you were closing it/);
    await expectRecoveryAlertToHoldFocus(alert.closest("[role=alert]"));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // The dialog stays open on the refusal.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows any other refusal without refreshing", async () => {
    openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(400, { error: "Say how the member was paid back - a note is required." });
    fireEvent.click(closeButton());

    await screen.findByText("Say how the member was paid back - a note is required.");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("#3924 round 5 (UX F1): the dialog reads its refund from the list, so a refresh cannot leave it stale", () => {
  it("MUTATION: what is owed moved: the typed amount resets, and the dialog says so", () => {
    const { rerender } = openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(amountBox(), { target: { value: "100.00" } });
    const statusesBefore = within(screen.getByRole("dialog")).getAllByRole("status");

    rerender(<DeadCardRefundsPanel rows={[row({ owedCents: 9_000 })]} bankNoteWording={BANK_NOTE_WORDING} />);

    expect(amountBox().value).toBe("");
    expect(screen.getByText("$90.00 is still owed.")).toBeInTheDocument();
    // Round 7 (UX): the notice lands in a live region that was already there.
    expect(statusesBefore).toContain(
      screen.getByText("What is still owed changed to $90.00 since you opened this. Check the amount before closing it."),
    );
    expect(
      screen.getByText("What is still owed changed to $90.00 since you opened this. Check the amount before closing it."),
    ).toHaveAttribute("role", "status");
  });

  it("'full' follows what is owed now, never the figure the dialog opened with", async () => {
    const { rerender } = openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    rerender(<DeadCardRefundsPanel rows={[row({ owedCents: 9_000 })]} bankNoteWording={BANK_NOTE_WORDING} />);

    expect(amountBox().value).toBe("90.00");
    respond(200, { success: true, xeroQueued: "refund-note" });
    fireEvent.click(closeButton());
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.any(String),
      // Round 7 (C7): with the owed figure the dialog now shows.
      expect.objectContaining({
        body: expect.stringContaining('"amountCents":9000,"paidBack":"full","expectedOwedCents":9000'),
      }),
    );
  });

  it("MUTATION: the refund left the list: the dialog closes, the page says why, and focus moves to that status line", async () => {
    const { rerender } = openDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<DeadCardRefundsPanel rows={[]} bankNoteWording={BANK_NOTE_WORDING} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const notice = screen.getByText(/That card refund is no longer waiting to be closed/);
    expect(notice).toHaveAttribute("role", "status");
    // Round 10: never left on a vanished dialog's button.
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });
});

describe("the closes Stripe paid as well", () => {
  it("names the booking, both amounts and when it was closed", () => {
    render(
      <CardRefundsPaidTwiceList
        rows={[
          {
            operationId: "op-2",
            bookingId: "b-2",
            bookingReference: "BK-0002",
            closedAt: "2026-06-25T00:00:00.000Z",
            paidAnotherWayCents: 9_000,
            refundedByCardCents: 9_000,
          },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Booking BK-0002" })).toHaveAttribute("href", "/admin/bookings/b-2");
    expect(screen.getByText(/\$90\.00 refunded to the card after \$90\.00 was paid back another way/)).toBeInTheDocument();
    expect(screen.getByText(/so the member was paid back twice/)).toBeInTheDocument();
  });
});

// #3372 (owner, 9 Oct 2026: "Add a 'Resolved' button").
describe("marking a paid-twice row Resolved", () => {
  const twice = {
    operationId: "op-2",
    bookingId: "b-2",
    bookingReference: "BK-0002",
    closedAt: "2026-06-25T00:00:00.000Z",
    paidAnotherWayCents: 9_000,
    refundedByCardCents: 9_000,
  };
  const resolveButton = () => screen.getByRole("button", { name: "Mark resolved" });
  const resolveNote = () => screen.getByLabelText("How was it sorted out? (required)") as HTMLTextAreaElement;

  function openResolve(rows = [twice]) {
    const view = render(<CardRefundsPaidTwiceList rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: `Mark booking ${rows[0]!.bookingReference} resolved` }));
    return view;
  }

  it("MUTATION: requires a note on how it was sorted out, with the reason beside the disabled button", () => {
    openResolve();
    expect(resolveNote()).toHaveAttribute("aria-required", "true");
    expect(resolveButton()).toBeDisabled();
    const hint = screen.getByText("Say how it was sorted out to mark it resolved.");
    expect(resolveButton()).toHaveAttribute("aria-describedby", hint.id);
    expect(screen.getByText(/Nothing is refunded or charged, and nothing is sent to Xero/)).toBeInTheDocument();
    fireEvent.change(resolveNote(), { target: { value: "Member paid the extra back" } });
    expect(resolveButton()).toBeEnabled();
  });

  it("MUTATION: sends the note for that row, then says it left the list and refreshes", async () => {
    openResolve();
    fireEvent.change(resolveNote(), { target: { value: "Member paid the extra back, ref 9" } });
    respond(200, { success: true });
    fireEvent.click(resolveButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/payments/card-refunds/op-2/paid-twice-resolved",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          note: "Member paid the extra back, ref 9",
          expectedRefundedByCardCents: 9_000,
          confirmed: true,
        }),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Marked resolved. Booking BK-0002 has left the list, and your note is in the audit log.",
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("names the row plainly in the dialog's title", () => {
    openResolve();
    expect(screen.getByRole("dialog", { name: "Mark this card refund, paid back twice, as resolved?" })).toBeInTheDocument();
  });

  // #3924 round 8 (concurrency): a Stripe refund recorded while the dialog is
  // open is said, and the figure sent is the one now shown.
  it("MUTATION: a further card refund while it is open is said, and the figure sent is the one shown", async () => {
    const { rerender } = openResolve();
    rerender(<CardRefundsPaidTwiceList rows={[{ ...twice, refundedByCardCents: 12_000 }]} />);
    expect(
      screen.getByText("Stripe has now refunded $120.00 to the card. Check it is sorted out before marking it resolved."),
    ).toHaveAttribute("role", "status");
    fireEvent.change(resolveNote(), { target: { value: "Sorted" } });
    respond(200, { success: true });
    fireEvent.click(resolveButton());
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body)).toMatchObject({ expectedRefundedByCardCents: 12_000 });
  });

  it("MUTATION: after Resolved, focus moves to the list's status line, which says what was done", async () => {
    openResolve();
    fireEvent.change(resolveNote(), { target: { value: "Sorted" } });
    respond(200, { success: true });
    fireEvent.click(resolveButton());
    const notice = await screen.findByText("Booking BK-0002 was marked resolved.");
    expect(notice).toHaveAttribute("role", "status");
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("MUTATION: round 9: resolving the last row keeps the card, its status line and focus, and says the list is empty", async () => {
    const { rerender } = openResolve();
    fireEvent.change(resolveNote(), { target: { value: "Sorted" } });
    respond(200, { success: true });
    fireEvent.click(resolveButton());
    const notice = await screen.findByText("Booking BK-0002 was marked resolved.");
    rerender(<CardRefundsPaidTwiceList rows={[]} />);
    expect(screen.getByText("Card refunds paid back twice")).toBeInTheDocument();
    expect(screen.getByText("No card refunds paid back twice are left to resolve.")).toBeInTheDocument();
    expect(notice).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("a paid-twice list that never had a row renders nothing", () => {
    const { container } = render(<CardRefundsPaidTwiceList rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a 409 in the dialog as a focused alert and refreshes; the refresh dropping the row closes it and says why", async () => {
    const { rerender } = openResolve();
    fireEvent.change(resolveNote(), { target: { value: "Sorted" } });
    respond(409, { error: "This card refund is no longer on the paid-twice list. The list has been refreshed." });
    fireEvent.click(resolveButton());

    const alert = await screen.findByText(/no longer on the paid-twice list/);
    await expectRecoveryAlertToHoldFocus(alert.closest("[role=alert]"));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    rerender(<CardRefundsPaidTwiceList rows={[]} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const notice = screen.getByText(/That card refund is no longer on this list/);
    expect(notice).toHaveAttribute("role", "status");
    // Round 10: focus moves to the status line that says why.
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("a finance viewer without edit sees the row and the banner, and cannot open it", () => {
    mocks.canEdit = false;
    render(<CardRefundsPaidTwiceList rows={[twice]} />);
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(/view-only access/i);
    const button = screen.getByRole("button", { name: "Mark booking BK-0002 resolved" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("view-only", () => {
  it("a finance viewer without edit sees the list and the banner, and cannot open the close", () => {
    mocks.canEdit = false;
    render(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);

    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(/view-only access/i);
    expect(screen.getByText(/\$150\.00 still owed/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Close the card refund for booking BK-0001 as paid another way" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

/**
 * #4368 (owner decision, 25 Oct 2026: "build as shown in the mock-up"): beside
 * "Paid another way", "Try the card again", and on a row with nothing left
 * owed, "Nothing left owed". Their rules are the server's
 * (`card-refund-dead-row-actions.test.ts`); this pins what the treasurer sees
 * and sends, and that both are view-only exactly as the close is.
 */
const COVERING = { stripeRefundId: "re_later_1", amountCents: 15_000, madeAt: "2026-06-25T00:00:00.000Z" };
const settledRow = (overrides: Partial<DeadCardRefundPanelRow> = {}) =>
  row({ owedCents: 0, laterStripeRefunds: [COVERING], tryCardAgainRefusal: "Nothing is left owed on this card refund, so there is nothing to send to the card.", ...overrides });
const tryAgainButton = () => screen.getByRole("button", { name: "Try the card again for the card refund on booking BK-0001" });
const nothingLeftButton = () => screen.getByRole("button", { name: "Close the card refund for booking BK-0001 with nothing left owed" });

describe("#4368: the list's guidance (decision 7)", () => {
  it("MUTATION: says to settle each refund here - Paid another way, Try the card again or Nothing left owed - never with a new dashboard refund", () => {
    render(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);
    const card = screen.getByRole("list", { name: "Card refunds Stripe gave up on" }).parentElement!;
    expect(card).toHaveTextContent("close it with Paid another way");
    expect(card).toHaveTextContent("use Try the card again");
    expect(card).toHaveTextContent("close it with Nothing left owed");
    expect(card).toHaveTextContent("Do not settle one with a new refund in the Stripe dashboard.");
    expect(card).not.toHaveTextContent(/wait for that refund/i);
  });
});

describe("#4368: Try the card again (decision 5)", () => {
  it("MUTATION: asks for confirmation first - nothing is sent until the treasurer confirms", () => {
    render(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);
    fireEvent.click(tryAgainButton());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Try the card again?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("The app will ask Stripe to refund $150.00 to the member's card again.");
    expect(dialog).toHaveTextContent("checks the refunds Stripe already holds on the charge");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("MUTATION: sends the figure it showed, confirmed, then says what happens and refreshes", async () => {
    render(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);
    fireEvent.click(tryAgainButton());
    respond(200, { success: true });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try the card again" }));

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/payments/card-refunds/op-1/try-card-again",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedOwedCents: 15_000, confirmed: true }) }),
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("The card will be asked for $150.00 again shortly."));
    expect(mocks.refresh).toHaveBeenCalled();
    const notice = await screen.findByText("The card refund for booking BK-0001 will be tried on the card again.");
    expect(notice).toHaveAttribute("role", "status");
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("shows a 409 in the dialog and refreshes the list beneath it", async () => {
    render(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);
    fireEvent.click(tryAgainButton());
    respond(409, { error: "What is still owed on this card refund changed since you opened it." });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try the card again" }));

    expect(await within(screen.getByRole("dialog")).findByText(/changed since you opened it/)).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("MUTATION: where the re-arm would refuse, the row says why and offers no button", () => {
    const refusal = "A refund Stripe failed later is still open on this payment, and it may be the same money as this one.";
    render(<DeadCardRefundsPanel rows={[row({ tryCardAgainRefusal: refusal })]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(screen.getByText(refusal)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try the card again/ })).not.toBeInTheDocument();
    // "Paid another way" stays offered.
    expect(screen.getByRole("button", { name: "Close the card refund for booking BK-0001 as paid another way" })).toBeEnabled();
  });
});

describe("#4368: Nothing left owed", () => {
  it("MUTATION: a row whose owed figure reads $0 stays on the list, says so, and offers only Nothing left owed", () => {
    render(<DeadCardRefundsPanel rows={[settledRow()]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(screen.getByText(/nothing left owed/)).toBeInTheDocument();
    expect(nothingLeftButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: /as paid another way/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try the card again/ })).not.toBeInTheDocument();
  });

  it("MUTATION: names the later Stripe refund that covers it, and says nothing moves", () => {
    render(<DeadCardRefundsPanel rows={[settledRow()]} bankNoteWording={BANK_NOTE_WORDING} />);
    fireEvent.click(nothingLeftButton());
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("re_later_1 ($150.00, 25 Jun 2026)");
    expect(dialog).toHaveTextContent("moves no money, sends nothing to Stripe and changes nothing in Xero");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("MUTATION: sends the refunds it named, confirmed, then says it closed and refreshes", async () => {
    render(<DeadCardRefundsPanel rows={[settledRow()]} bankNoteWording={BANK_NOTE_WORDING} />);
    fireEvent.click(nothingLeftButton());
    respond(200, { success: true });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close with nothing left owed" }));

    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/api/admin/payments/card-refunds/op-1/nothing-left-owed",
        expect.objectContaining({ body: JSON.stringify({ expectedStripeRefundIds: ["re_later_1"], confirmed: true }) }),
      ),
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(await screen.findByText("The card refund for booking BK-0001 was closed with nothing left owed.")).toHaveAttribute("role", "status");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("a refresh that puts money owed back on the row closes its open dialog and says why", () => {
    const view = render(<DeadCardRefundsPanel rows={[settledRow()]} bankNoteWording={BANK_NOTE_WORDING} />);
    fireEvent.click(nothingLeftButton());
    view.rerender(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("That card refund changed, so its dialog was closed. The list is up to date.")).toBeInTheDocument();
  });
});

describe("#4368: both new buttons are view-only without edit rights, as Paid another way is", () => {
  it("MUTATION: Try the card again is disabled for a finance viewer without edit, and opens nothing", () => {
    mocks.canEdit = false;
    render(<DeadCardRefundsPanel rows={[row()]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(screen.getByTestId("admin-view-only-banner")).toBeInTheDocument();
    expect(tryAgainButton()).toBeDisabled();
    fireEvent.click(tryAgainButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("MUTATION: Nothing left owed is disabled for a finance viewer without edit, and opens nothing", () => {
    mocks.canEdit = false;
    render(<DeadCardRefundsPanel rows={[settledRow()]} bankNoteWording={BANK_NOTE_WORDING} />);
    expect(nothingLeftButton()).toBeDisabled();
    fireEvent.click(nothingLeftButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
