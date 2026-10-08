// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
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
    stripeMayHaveRefunded: false,
    ...overrides,
  };
}

function respond(status: number, body: unknown) {
  mocks.fetch.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function openDialog(subject = row()) {
  const view = render(<DeadCardRefundsPanel rows={[subject]} />);
  fireEvent.click(screen.getByRole("button", { name: "Paid another way" }));
  return view;
}

const fullChoice = () => screen.getByRole("radio", { name: "Paid back in full" });
const partChoice = () => screen.getByRole("radio", { name: /Paid back part of it - the rest will no longer be owed/ });
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
    expect(screen.getByText(/A Xero refund credit note for the amount, as a bank transfer, is queued/)).toBeInTheDocument();
    expect(screen.getByText(/Refunded it in the Stripe dashboard instead\? Do not close it here/)).toBeInTheDocument();
  });

  it("says no Xero note is raised where there is no invoice to credit", () => {
    openDialog(row({ xeroRefundNote: "none" }));
    expect(screen.getByText(/No Xero refund credit note is raised: there is no Xero invoice/)).toBeInTheDocument();
  });

  // #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit").
  it("MUTATION: says a late card charge Xero has no record of is recorded as a receipt first, then credited", () => {
    openDialog(row({ xeroRefundNote: "after-receipt" }));
    expect(
      screen.getByText(
        "Xero has no record of this late card charge yet. Closing it records the charge in Xero as a payment received into the Stripe account, then queues a Xero refund credit note for the amount, as a bank transfer, against it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No Xero refund credit note is raised/)).not.toBeInTheDocument();
  });

  it("MUTATION: after a receipt-first close, the message says the note follows the receipt", async () => {
    openDialog(row({ xeroRefundNote: "after-receipt" }));
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "receipt-then-refund-note" });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Closed. $150.00 recorded as paid back in full. The late card charge is queued to be recorded in Xero as a payment received into the Stripe account; its refund credit note, as a bank transfer, follows once it is.",
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
    const warning = screen.getByText("$50.00 will no longer be owed to the member, and will not be tracked anywhere.");
    expect(warning).toHaveAttribute("role", "status");
    expect(amountBox().getAttribute("aria-describedby")).toContain(warning.id);
    expect(closeButton()).toBeEnabled();
  });

  it("MUTATION: never infers part from the amount: part of it must be less than is owed", () => {
    openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    fireEvent.change(amountBox(), { target: { value: "150.00" } });
    expect(closeButton()).toBeDisabled();
    expect(screen.getAllByText(/Part of it must be less than the \$150\.00 still owed/).length).toBeGreaterThan(0);
  });

  it("closes a superseded payment's refund in full only", () => {
    openDialog(row({ wholeAmountOnly: true }));
    expect(fullChoice()).toBeChecked();
    expect(partChoice()).toBeDisabled();
    expect(amountBox()).toBeDisabled();
    expect(screen.getByText(/closes for the whole amount/)).toBeInTheDocument();
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
        body: JSON.stringify({ amountCents: 15_000, paidBack: "full", note: "Bank transfer, ref 123", confirmed: true }),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Closed. $150.00 recorded as paid back in full. Its Xero refund credit note, as a bank transfer, is queued.",
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: sends 'partial' with the amount typed, and says what is no longer owed", async () => {
    openDialog();
    fireEvent.click(partChoice());
    fireEvent.change(amountBox(), { target: { value: "100.00" } });
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroQueued: "nothing" });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/payments/card-refunds/op-1/paid-another-way",
      expect.objectContaining({
        body: JSON.stringify({ amountCents: 10_000, paidBack: "partial", note: "Bank transfer", confirmed: true }),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Closed. $100.00 recorded as paid back; the other $50.00 is no longer owed. No Xero refund credit note was queued: check the refund is recorded in Xero.",
    );
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

    rerender(<DeadCardRefundsPanel rows={[row({ owedCents: 9_000 })]} />);

    expect(amountBox().value).toBe("");
    expect(screen.getByText("$90.00 is still owed.")).toBeInTheDocument();
    expect(
      screen.getByText("What is still owed changed to $90.00 since you opened this. Check the amount before closing it."),
    ).toHaveAttribute("role", "status");
  });

  it("'full' follows what is owed now, never the figure the dialog opened with", async () => {
    const { rerender } = openDialog();
    fireEvent.click(fullChoice());
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    rerender(<DeadCardRefundsPanel rows={[row({ owedCents: 9_000 })]} />);

    expect(amountBox().value).toBe("90.00");
    respond(200, { success: true, xeroQueued: "refund-note" });
    fireEvent.click(closeButton());
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"amountCents":9000,"paidBack":"full"') }),
    );
  });

  it("MUTATION: the refund left the list: the dialog closes and the page says why", () => {
    const { rerender } = openDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<DeadCardRefundsPanel rows={[]} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/That card refund is no longer waiting to be closed/)).toHaveAttribute("role", "status");
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
    expect(screen.getByText(/paid back twice/)).toBeInTheDocument();
  });
});

describe("view-only", () => {
  it("a finance viewer without edit sees the list and the banner, and cannot open the close", () => {
    mocks.canEdit = false;
    render(<DeadCardRefundsPanel rows={[row()]} />);

    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(/view-only access/i);
    expect(screen.getByText(/\$150\.00 still owed/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Paid another way" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
