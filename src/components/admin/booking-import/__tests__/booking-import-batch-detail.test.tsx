// @vitest-environment jsdom
// #5005 (child C): the batch page's Reverse runs the reversal in slices and
// must hand each slice's cursor to the next. Without it a batch whose first
// slice is all kept bookings would retry those same bookings for ever and
// never reach the untouched ones (the review finding the cursor fixed).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BookingImportBatchDetail } from "@/components/admin/booking-import/booking-import-batch-detail";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";

const TOTALS = { bookings: 0, guests: 0, guestNights: 0, amountCents: 0 };
const DETAIL = {
  batch: {
    id: "batch-1",
    lodgeId: "lodge-1",
    lodgeName: "Ruapehu Lodge",
    status: "COMPLETED",
    confirmedAt: "2026-06-30T22:00:00.000Z",
    confirmedByName: "Oli Officer",
    completedAt: "2026-06-30T22:01:00.000Z",
    reversedAt: null,
    reversedByName: null,
    file: { bookings: 2, guests: 2, guestNights: 4, amountCents: 20_000 },
    imported: { bookings: 2, guests: 2, guestNights: 4, amountCents: 20_000 },
    refused: TOTALS,
    reversed: TOTALS,
    pending: 0,
  },
  reversal: {
    batchId: "batch-1",
    lodgeId: "lodge-1",
    status: "COMPLETED",
    rows: [
      { bookingRef: "B1", firstLineNumber: 2, bookingId: "b1", state: "TOUCHED", reasons: ["It has been edited since the import"], refusals: [], cancelPending: false, amountCents: 10_000, guestCount: 1, guestNightCount: 2 },
      { bookingRef: "B2", firstLineNumber: 3, bookingId: "b2", state: "UNTOUCHED", reasons: [], refusals: [], cancelPending: false, amountCents: 10_000, guestCount: 1, guestNightCount: 2 },
    ],
    totals: {
      UNTOUCHED: { bookings: 1, guests: 1, guestNights: 2, amountCents: 10_000 },
      TOUCHED: { bookings: 1, guests: 1, guestNights: 2, amountCents: 10_000 },
      REVERSED: TOTALS,
      NOT_IMPORTED: TOTALS,
    },
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let reverseBodies: unknown[];

beforeEach(() => {
  reverseBodies = [];
  const slices = [
    { outcome: "reversed", batchId: "batch-1", rows: [{ bookingRef: "B1", outcome: "KEPT" }], remaining: 1, nextAfterLineNumber: 2 },
    { outcome: "reversed", batchId: "batch-1", rows: [{ bookingRef: "B2", outcome: "REVERSED" }], remaining: 0, nextAfterLineNumber: 3 },
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/reverse")) {
      reverseBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return json(slices.shift());
    }
    return json(DETAIL);
  }));
});

describe("BookingImportBatchDetail", () => {
  it("shows what Reverse keeps and why before it runs, then passes each slice's cursor to the next", async () => {
    render(<BookingImportBatchDetail batchId="batch-1" canReverse />);
    expect(await screen.findByText("It has been edited since the import")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reverse batch" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("1 untouched booking");
    expect(dialog.textContent).toContain("Nobody is emailed");
    fireEvent.click(screen.getAllByRole("button", { name: "Reverse batch" }).at(-1)!);
    await waitFor(() => expect(reverseBodies).toEqual([{}, { afterLineNumber: 2 }]));
  });

  it("offers no Reverse to an officer without both permissions", async () => {
    render(<BookingImportBatchDetail batchId="batch-1" canReverse={false} />);
    const button = await screen.findByRole("button", { name: "Reverse batch" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
