// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { toast } from "sonner";
import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

const TASK = {
  id: "task-1",
  bookingId: "booking-1",
  amountCents: 12000,
  reason: "Cancelled after a cash payment",
  createdAt: "2026-08-01T00:00:00Z",
  memberName: "Ada Lovelace",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * #2668 — the cash hand-back queue may not claim the ledger stood still.
 *
 * "Record as paid back" writes the refund allocation and the REFUNDED booking
 * event: it is the moment the ledger says the money went back. This control
 * used to answer a rejected `fetch` with "Could not reach the server. Nothing
 * was changed." `fetch` also rejects once the POST has landed and only its
 * answer is lost, in which case the refund IS recorded — and an officer told
 * nothing changed closes the task again, or worse, hands the money over twice.
 */
describe("ManualRefundTaskQueue — an outcome the browser never read (#2668)", () => {
  const UNVERIFIED = unverifiedWriteMessage(
    "this refund task was closed",
    "Reload the page and check the queue before trying again.",
  );

  /** Loads the queue, opens "Mark paid back", and loses the POST's answer. */
  async function failTheClose() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The queue's own initial load, which must succeed for there to be a task
      // to close in the first place.
      if (!init || init.method !== "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tasks: [TASK] }),
        } as unknown as Response;
      }
      expect(String(input)).toContain("/api/admin/payments/manual-refund-tasks/");
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ManualRefundTaskQueue />);

    fireEvent.click(await screen.findByRole("button", { name: "Mark paid back" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Record as paid back" }),
    );
    return fetchMock;
  }

  it("says what it could not verify rather than that nothing changed", async () => {
    await failTheClose();

    const notice = await screen.findByText(UNVERIFIED);
    expect(notice.textContent).toBe(UNVERIFIED);
    expect(notice.textContent).not.toContain("Nothing was changed");
  });

  /**
   * Review SF-5. A toast fades; the operator's next press does not wait for it,
   * and on this queue that press is either a second refund allocation attempt or
   * the dismissal of a task that may already be closed. So the sentence is HELD
   * in the open dialog with the action disarmed behind it, and the way out is
   * named "Close" — after an unread outcome there may be nothing to cancel.
   */
  it("holds the message in the dialog and disarms the close action behind it", async () => {
    const fetchMock = await failTheClose();

    const notice = await screen.findByText(UNVERIFIED);

    // The house recovery alert rather than a toast: it stays, and it takes focus
    // — the button just pressed is disabled behind it, and a control disabled in
    // the same turn cannot hold focus, so the operator would otherwise be
    // dropped to <body> with the explanation out of reach.
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(UNVERIFIED);
    await expectRecoveryAlertToHoldFocus(notice);
    // The dialog is still open, over the amount it was about.
    expect(
      screen.getByText(/Record \$120\.00 as paid back to Ada Lovelace\?/),
    ).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Record as paid back" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close and check" })).toBeInTheDocument();

    // The POST count is the load plus exactly one attempt: a reflexive second
    // press cannot put a second refund allocation on the ledger from here.
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    fireEvent.click(confirm);
    await Promise.resolve();
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("clears the notice when the dialog is closed and another task is opened", async () => {
    await failTheClose();
    await screen.findByText(UNVERIFIED);

    fireEvent.click(screen.getByRole("button", { name: "Close and check" }));
    await waitFor(() => expect(screen.queryByText(UNVERIFIED)).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // A stale notice over the next task would read as that task's outcome.
    expect(screen.queryByText(UNVERIFIED)).toBeNull();
  });
});
