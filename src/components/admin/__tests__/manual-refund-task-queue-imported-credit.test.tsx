// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { waitForManualRefundQueueLoaded } from "@/lib/__tests__/support/manual-refund-task-queue-loaded";

/**
 * #5005 child D (owner decision O1): a cancelled imported booking's refund task offers "Give as account credit"
 * beside "Mark paid back", exactly where the server's rule says it may (`importedRefundCredit` in the payload), and
 * the request names the amount the card showed so a stale screen credits nothing the officer did not see.
 *
 * MUTATION PROOF. Render the button whatever the payload says and "an ordinary cash booking's refund offers no
 * credit" fails. Drop the amount from the request and "posts the amount the card showed" fails.
 */

const IMPORTED_TASK = {
  id: "task-imported",
  bookingId: "booking-imported",
  amountCents: 43_200,
  raisedAmountCents: 43_200,
  kind: "CANCELLED_BOOKING_HAND_BACK",
  reason: "Cash/manual settlement cancelled 30 day(s) before check-in (80% under the policy in effect at the time).",
  createdAt: "2026-06-20T00:00:00Z",
  memberName: "Ada Lovelace",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
  importedRefundCredit: true,
};

type FetchCall = [url: string, init?: { body: string }];

function stubLoad(body: unknown) {
  const fetchMock = vi.fn<(...call: FetchCall) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
    async () => ({ ok: true, status: 200, json: async () => body }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("giving an imported booking's refund as account credit (#5005 child D)", () => {
  it("offers it beside Mark paid back on a cancelled imported booking's refund", async () => {
    stubLoad({ tasks: [IMPORTED_TASK], viewerCanViewBookings: true });
    render(<ManualRefundTaskQueue />);
    await waitForManualRefundQueueLoaded();

    expect(screen.getByRole("button", { name: "Mark paid back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give as account credit" })).toBeInTheDocument();
  });

  it("an ordinary cash booking's refund offers no credit: it is paid back by hand as before", async () => {
    stubLoad({ tasks: [{ ...IMPORTED_TASK, importedRefundCredit: false }], viewerCanViewBookings: true });
    render(<ManualRefundTaskQueue />);
    await waitForManualRefundQueueLoaded();

    expect(screen.getByRole("button", { name: "Mark paid back" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Give as account credit" })).not.toBeInTheDocument();
  });

  it("confirms the amount and the member, then posts the amount the card showed", async () => {
    const fetchMock = stubLoad({ tasks: [IMPORTED_TASK], viewerCanViewBookings: true });
    render(<ManualRefundTaskQueue />);
    await waitForManualRefundQueueLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Give as account credit" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Give \$432\.00 to Ada Lovelace as account credit\?/);
    expect(dialog.textContent).toMatch(/nothing is paid to their bank/);
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "Rebooking in winter" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Give as account credit" }));

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/account-credit"))).toBe(true));
    const post = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/account-credit"))!;
    expect(String(post[0])).toBe("/api/admin/payments/manual-refund-tasks/task-imported/account-credit");
    expect(JSON.parse(post[1]!.body)).toEqual({ confirmed: true, expectedAmountCents: 43_200, note: "Rebooking in winter" });
  });
});
