// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClubFormatProvider } from "@/components/club-format-provider";
import { ClubTimeProvider } from "@/components/club-time-provider";
import {
  expectRecoveryAlertToHoldFocus,
  expectToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

import { FoodOrderRow, type FoodOrderHistoryItem } from "../food-order-row";

/**
 * PR #5143 review, finding 4: the row announces what its actions did. A
 * failure takes focus; a success is said in a permanently mounted status
 * region; and when the last tick closes the order, the checklist unmounts and
 * focus moves to that status region rather than falling to the page body.
 */

const OPEN_ORDER: FoodOrderHistoryItem = {
  id: "order-1",
  lodgeName: "Lodge A",
  orderedBy: "Mia Member",
  isOwn: false,
  neededBy: "2026-07-05",
  notes: null,
  status: "OPEN",
  items: [
    { id: "item-1", description: "Bread", quantity: "2", unit: "LOAVES", receivedAt: null, receivedBy: null },
    { id: "item-2", description: "Milk", quantity: "1", unit: "LITERS", receivedAt: null, receivedBy: null },
  ],
  receivedAt: null,
  receivedBy: null,
  priceCents: null,
  priceUpdatedBy: null,
  canManage: true,
};

const RECEIVED_ORDER: FoodOrderHistoryItem = {
  ...OPEN_ORDER,
  status: "RECEIVED",
  receivedAt: "2026-07-01T02:00:00.000Z",
  receivedBy: "Hana Leader",
  items: OPEN_ORDER.items.map((item) => ({
    ...item,
    receivedAt: "2026-07-01T02:00:00.000Z",
    receivedBy: "Hana Leader",
  })),
};

/** The row as the history renders it: `onChanged` reloads the order. */
function Harness({ reloaded }: { reloaded: FoodOrderHistoryItem }) {
  const [order, setOrder] = useState(OPEN_ORDER);
  return (
    <FoodOrderRow
      order={order}
      showOrderedBy
      highlighted={false}
      onChanged={() => setOrder(reloaded)}
    />
  );
}

function renderRow(reloaded: FoodOrderHistoryItem) {
  return render(
    <ClubFormatProvider currencyCode="NZD" locale="en-NZ">
      <ClubTimeProvider zone="Pacific/Auckland" locale="en-NZ">
        <Harness reloaded={reloaded} />
      </ClubTimeProvider>
    </ClubFormatProvider>,
  );
}

function respond(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  installScrollIntoViewSpy();
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeScrollIntoViewSpy();
});

describe("FoodOrderRow announcements", () => {
  it("says how many items were received, while the order stays open", async () => {
    const partly: FoodOrderHistoryItem = {
      ...OPEN_ORDER,
      items: [RECEIVED_ORDER.items[0]!, OPEN_ORDER.items[1]!],
    };
    respond(200, { ok: true });
    renderRow(partly);
    fireEvent.click(screen.getByLabelText(/Bread/));
    fireEvent.click(screen.getByRole("button", { name: "Mark selected received" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 item received."));
    expect(screen.getByRole("button", { name: "Mark selected received" })).toBeTruthy();
  });

  it("moves focus to the status when the last tick closes the order", async () => {
    respond(200, { ok: true });
    renderRow(RECEIVED_ORDER);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark selected received" }));
    const status = await screen.findByText("All items received. The order is closed.");
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: "Mark selected received" })).toBeNull();
    await expectToHoldFocus(status, "the row's status");
  });

  it("says the price was saved", async () => {
    respond(200, { ok: true });
    renderRow({ ...OPEN_ORDER, priceCents: 4250 });
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "42.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Price saved."));
  });

  it("puts a failure in a focused alert that was mounted before it", async () => {
    renderRow(OPEN_ORDER);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("");
    respond(409, { error: "This order changed. It has been reloaded." });
    fireEvent.click(screen.getByLabelText(/Bread/));
    fireEvent.click(screen.getByRole("button", { name: "Mark selected received" }));
    await waitFor(() => expect(alert.textContent).toContain("This order changed."));
    expect(screen.getByRole("status").textContent).toBe("");
    await expectRecoveryAlertToHoldFocus(alert);
  });
});
