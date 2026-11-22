/**
 * ALP-718 (`INV-MCP-006`): `expectActionContract` itself. A fixture that
 * leaves a nested shape null, or a list the shape describes empty, would let
 * any field inside it through unseen, so the helper must refuse it rather
 * than pass. The handlers here are stubs answering a fixed body; the actions
 * are real catalogue entries with a nested object (`preview_cancel_booking`'s
 * `cardShortfall`) and a list of objects (`list_lodges`' `lodges`).
 */
import { describe, expect, it } from "vitest";

import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";

function answering(body: unknown) {
  return async () => Response.json(body);
}

const PAID_PREVIEW = {
  refundAmountCents: 8000,
  keptAmountCents: 2000,
  changeFeeCents: 0,
  refundPercentage: 80,
  creditRefundAmountCents: 0,
  creditRefundPercentage: 0,
  creditRestoredCents: 0,
  totalPaidCents: 10000,
  hasPayment: true,
  manualRefund: false,
  paymentSettledByHand: false,
  groupCancellationRefundCents: 0,
  groupCancellationRefundNote: "",
  cardShortfall: { cardCents: 8000, bankCents: 0, checkCents: 0 },
  refundDisputed: false,
  refundMethodForced: null,
};

describe("expectActionContract", () => {
  it("passes an answer that fills every nested shape", async () => {
    await expect(
      expectActionContract({
        actionId: "preview_cancel_booking",
        handler: answering(PAID_PREVIEW),
        args: { id: "b1" },
      }),
    ).resolves.toBeDefined();
    await expect(
      expectActionContract({
        actionId: "list_lodges",
        handler: answering({ lodges: [{ id: "lodge-1", name: "Main lodge", travelNote: null }] }),
      }),
    ).resolves.toBeDefined();
  });

  it("throws when a nested shape is null", async () => {
    await expect(
      expectActionContract({
        actionId: "preview_cancel_booking",
        handler: answering({ ...PAID_PREVIEW, cardShortfall: null }),
        args: { id: "b1" },
      }),
    ).rejects.toThrow(/cardShortfall carries a value the shape can be checked against/);
  });

  it("throws when a list is empty but its entries have a shape", async () => {
    await expect(
      expectActionContract({ actionId: "list_lodges", handler: answering({ lodges: [] }) }),
    ).rejects.toThrow(/lodges carries at least one entry the shape can be checked against/);
  });
});
