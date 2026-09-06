import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3213: what an officer is told, and what the booking's history records, when a
 * withheld share is closed.
 *
 * WHY THIS IS A SUITE OF ITS OWN. The two sentences live in different modules on
 * purpose - the toast is officer copy (`manual-refund-task-copy.ts`), the summary
 * is the durable record of what the closure did (`manual-refund-task-audit.ts`) -
 * but they are one correction and they must not drift apart. Before #3213 both
 * said "refund" on a row where an officer had just BILLED a member by hand in
 * Xero, which is the wrong act in the wrong direction, and the audit half of it
 * landed in the booking's permanent history rather than in a toast that goes
 * away. Pinning them together is what stops one being fixed and the other not.
 *
 * THE LEGACY WORDING IS PINNED BYTE FOR BYTE, in both places. This change is a
 * new arm, not a rewrite: every kind that really is a refund must read exactly as
 * it always has, or #3213 has quietly restated four years of audit rows.
 */

const mocks = vi.hoisted(() => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));

import { recordManualRefundTaskClosureAudit } from "@/lib/manual-refund-task-audit";
import { dismissalMessage } from "@/lib/manual-refund-task-copy";

const WITHHELD_SHARE = "UNCOLLECTED_EDIT_REVIEW_SHARE";

const LEGACY_TOAST = "Refund task dismissed.";
const LEGACY_SUMMARY = "Manual booking refund task dismissed";

beforeEach(() => {
  vi.clearAllMocks();
});

async function summaryFor(
  kind: string | null,
  resolution: "completed" | "dismissed",
): Promise<string> {
  await recordManualRefundTaskClosureAudit({
    task: {
      id: "task-1",
      bookingId: "booking-1",
      paymentId: null,
      amountCents: 4_500,
      raisedAmountCents: 4_500,
      kind: kind as never,
      booking: { memberId: "member-1" },
    },
    resolution,
    actingMemberId: "admin-1",
    note: "Checked Xero, billed the shortfall.",
    settlement: resolution === "completed" ? { amountCents: 4_500, amended: false } : null,
    settlementRoute: null,
    settlementDirection: null as never,
    store: {} as never,
  });
  const [entry] = mocks.createAuditLog.mock.calls[0] as [{ summary: string }];
  return entry.summary;
}

describe("#3213: closing a withheld share is not dismissing a refund", () => {
  it("tells the officer what they actually did, and names no refund", async () => {
    const toast = dismissalMessage(WITHHELD_SHARE);
    expect(toast).toBe(
      "Item closed. It moved no money and raised no invoice — your note is the only record of what the booking's Xero invoices showed and what you billed by hand.",
    );
    // THE POINT OF THE CHANGE, asserted as the absence it is: an officer who has
    // just billed a member must not be told they dismissed a refund.
    expect(toast.toLowerCase()).not.toContain("refund");
    expect(toast.toLowerCase()).not.toContain("dismiss");
  });

  it("writes a durable summary that says no money moved", async () => {
    const summary = await summaryFor(WITHHELD_SHARE, "dismissed");
    expect(summary).toBe(
      "Uncollected booking amount closed as dealt with, no money moved",
    );
    expect(summary.toLowerCase()).not.toContain("refund");
  });
});

describe("#3213: every other kind reads exactly as it always has", () => {
  it("keeps the legacy toast for a hand-back, a late capture and a financial review", () => {
    for (const kind of [
      "CANCELLED_BOOKING_HAND_BACK",
      "DELETED_BOOKING_LATE_CAPTURE",
      "AUTOMATIC_LATE_CAPTURE_RECORD",
      "EDIT_FINANCIAL_REVIEW",
    ]) {
      expect(dismissalMessage(kind)).toBe(LEGACY_TOAST);
    }
  });

  it("keeps the legacy summary for a hand-back and a financial review", async () => {
    expect(await summaryFor("CANCELLED_BOOKING_HAND_BACK", "dismissed")).toBe(
      LEGACY_SUMMARY,
    );
    vi.clearAllMocks();
    expect(await summaryFor("EDIT_FINANCIAL_REVIEW", "dismissed")).toBe(
      LEGACY_SUMMARY,
    );
  });

  it("leaves the completion arm alone on every kind, withheld share included", async () => {
    // A withheld share can never REACH this arm - the completion door refuses it
    // (`INV-PAY-051`) - so the assertion is that #3213 did not reword the arm it
    // was not about, rather than that the combination is reachable.
    expect(await summaryFor("CANCELLED_BOOKING_HAND_BACK", "completed")).toBe(
      "Manual booking refund paid back by hand",
    );
    vi.clearAllMocks();
    expect(await summaryFor(WITHHELD_SHARE, "completed")).toBe(
      "Manual booking refund paid back by hand",
    );
  });
});

describe("#3213: a kind this build does not recognise reads as it always has", () => {
  /*
    THE SAFE WAY ROUND, and it is the same one the settlement rule takes. A
    cached client bundle or a row written before the column existed carries a
    kind this code cannot classify; answering with the legacy sentence gives it
    the wording every row has always had, rather than a claim about an item type
    it does not know. Both sentences ask the SHARED rule, so neither can drift
    from the door that refuses the close.
  */
  it("falls back to the legacy wording for null, undefined and an unknown label", async () => {
    expect(dismissalMessage(null)).toBe(LEGACY_TOAST);
    expect(dismissalMessage(undefined)).toBe(LEGACY_TOAST);
    expect(dismissalMessage("SOME_FUTURE_KIND")).toBe(LEGACY_TOAST);
    expect(await summaryFor(null, "dismissed")).toBe(LEGACY_SUMMARY);
  });
});
