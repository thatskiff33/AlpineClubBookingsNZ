// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #2260 — the manual mark-paid confirmation is a real dialog with the club's
 * standard email choice, not a bare browser confirm()/prompt().
 */

import {
  ManualPaymentDialog,
  type ManualPaymentSubmission,
  type ManualPaymentTarget,
} from "@/app/(admin)/admin/finance/subscriptions/_components/manual-payment-dialog";

const paidTarget: ManualPaymentTarget = {
  subscriptionId: "sub-1",
  memberName: "Ada Lovelace",
  seasonYear: 2026,
  direction: "paid",
};

const unpaidTarget: ManualPaymentTarget = {
  ...paidTarget,
  direction: "unpaid",
};

function renderDialog(
  target: ManualPaymentTarget | null,
  overrides: {
    onSubmit?: (submission: ManualPaymentSubmission) => void;
    onCancel?: () => void;
  } = {},
) {
  const onSubmit = vi.fn(overrides.onSubmit ?? (() => {}));
  const onCancel = vi.fn(overrides.onCancel ?? (() => {}));
  render(
    <ManualPaymentDialog
      target={target}
      submitting={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onCancel };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ManualPaymentDialog (#2260)", () => {
  it("shows nothing until an admin picks a subscription to act on", () => {
    renderDialog(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers both email choices on the paid path and reports the send choice", () => {
    const { onSubmit } = renderDialog(paidTarget);

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Ada Lovelace");
    expect(dialog.textContent).toContain("2026");
    // The honest consequence: the money state changes either way; only the
    // member's email differs.
    expect(dialog.textContent).toContain("marked paid either way");

    fireEvent.click(
      screen.getByRole("button", { name: "Mark paid and email member" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({ note: null, notifyMember: true });
  });

  it("reports the decline choice explicitly rather than omitting it", () => {
    const { onSubmit } = renderDialog(paidTarget);

    fireEvent.click(
      screen.getByRole("button", { name: "Mark paid without emailing" }),
    );

    // notifyMember: false, not an absent field — the API rejects an ambiguous
    // mark-paid, and the audit log records the decline.
    expect(onSubmit).toHaveBeenCalledWith({ note: null, notifyMember: false });
  });

  it("carries the optional note, trimmed, with the choice", () => {
    const { onSubmit } = renderDialog(paidTarget);

    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "  cheque #123  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Mark paid and email member" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({
      note: "cheque #123",
      notifyMember: true,
    });
  });

  it("caps the note at the API's 500-character limit", () => {
    renderDialog(paidTarget);
    expect(
      screen.getByLabelText("Note (optional)").getAttribute("maxlength"),
    ).toBe("500");
  });

  it("offers no email choice on the reversal path, and sends no notify field", () => {
    const { onSubmit } = renderDialog(unpaidTarget);

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Reverse the manual payment");
    expect(dialog.textContent).toContain("The member is not emailed");
    expect(
      screen.queryByRole("button", { name: "Mark paid and email member" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Mark paid without emailing" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reverse payment" }));

    const submission = onSubmit.mock.calls[0][0];
    expect(submission).toEqual({ note: null });
    expect("notifyMember" in submission).toBe(false);
  });

  it("submits nothing when the admin cancels", () => {
    const { onSubmit, onCancel } = renderDialog(paidTarget);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
