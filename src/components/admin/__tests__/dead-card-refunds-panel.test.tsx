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
    takesXeroRefundNote: true,
    stripeMayHaveRefunded: false,
    ...overrides,
  };
}

function respond(status: number, body: unknown) {
  mocks.fetch.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function openDialog(subject = row()) {
  render(<DeadCardRefundsPanel rows={[subject]} />);
  fireEvent.click(screen.getByRole("button", { name: "Paid another way" }));
  return screen.getByRole("dialog");
}

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
  it("defaults the amount to what is still owed, and says up front what the close does", () => {
    openDialog();

    expect(amountBox().value).toBe("150.00");
    expect(screen.getByText(/A Xero refund credit note for the amount, as a bank transfer, is queued/)).toBeInTheDocument();
    expect(screen.getByText(/Refunded it in the Stripe dashboard instead\? Do not close it here/)).toBeInTheDocument();
    expect(screen.getByText(/Paying back less than is owed ends the refund/)).toBeInTheDocument();
  });

  it("says no Xero note is raised for a refund that takes none", () => {
    openDialog(row({ takesXeroRefundNote: false }));
    expect(screen.getByText(/No Xero refund credit note is raised/)).toBeInTheDocument();
  });

  it("requires the note: marked required, the button disabled with the reason beside it", () => {
    openDialog();

    expect(noteBox()).toHaveAttribute("aria-required", "true");
    expect(closeButton()).toBeDisabled();
    const hint = screen.getByText("Say how the member was paid back to close it.");
    expect(closeButton()).toHaveAttribute("aria-describedby", hint.id);

    fireEvent.change(noteBox(), { target: { value: "Bank transfer, ref 123" } });
    expect(closeButton()).toBeEnabled();
    expect(screen.queryByText("Say how the member was paid back to close it.")).not.toBeInTheDocument();
  });

  it("warns what a partial close gives up", () => {
    openDialog();
    fireEvent.change(amountBox(), { target: { value: "100.00" } });
    expect(screen.getByText("$50.00 will no longer be owed or tracked.")).toBeInTheDocument();
  });

  it("refuses more than is owed before anything is sent", () => {
    openDialog();
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    fireEvent.change(amountBox(), { target: { value: "150.01" } });
    expect(closeButton()).toBeDisabled();
    expect(screen.getAllByText(/That is more than the \$150\.00 still owed\./).length).toBeGreaterThan(0);
  });

  it("closes a superseded payment's refund for the whole amount only", () => {
    openDialog(row({ wholeAmountOnly: true }));
    expect(amountBox()).toBeDisabled();
    expect(screen.getByText(/closes for the whole amount/)).toBeInTheDocument();
  });

  it("flags a refund Stripe may have made after all, on its row and in its dialog", () => {
    openDialog(row({ stripeMayHaveRefunded: true }));
    expect(screen.getAllByText(STRIPE_MAY_HAVE_REFUNDED_WARNING)).toHaveLength(2);
  });

  it("sends the amount, the note and the confirmation, then thanks with the Xero outcome and refreshes", async () => {
    openDialog();
    fireEvent.change(noteBox(), { target: { value: "Bank transfer, ref 123" } });
    respond(200, { success: true, xeroRefundNoteQueued: true });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/payments/card-refunds/op-1/paid-another-way",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ amountCents: 15_000, note: "Bank transfer, ref 123", confirmed: true }) }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("its Xero refund credit note is queued"));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("tells the treasurer to check Xero when no note was queued", async () => {
    openDialog();
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(200, { success: true, xeroRefundNoteQueued: false });
    fireEvent.click(closeButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Check the refund is recorded in Xero"));
  });

  it("shows a 409 in the dialog as a focused alert, and refreshes the list beneath it", async () => {
    openDialog();
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
    fireEvent.change(noteBox(), { target: { value: "Bank transfer" } });
    respond(400, { error: "Say how the member was paid back - a note is required." });
    fireEvent.click(closeButton());

    await screen.findByText("Say how the member was paid back - a note is required.");
    expect(mocks.refresh).not.toHaveBeenCalled();
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
