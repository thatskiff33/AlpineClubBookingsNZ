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
 * THE LEGACY WORDING IS PINNED BYTE FOR BYTE wherever it is still true. The
 * DISMISSAL half is a new arm and not a rewrite: every kind that really is a
 * refund must read exactly as it always has, or #3213 has quietly restated four
 * years of audit rows.
 *
 * THE COMPLETION HALF IS A CORRECTION, and the last block below is where that is
 * pinned. Its single sentence asserted a hand-back over routes that were a card
 * refund, an account credit, or - since #3170 - the member being asked to pay the
 * CLUB. Only the hand-back wording survives byte-identical, because only the
 * hand-back was true.
 */

const mocks = vi.hoisted(() => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));

import { recordManualRefundTaskClosureAudit } from "@/lib/manual-refund-task-audit";
import { completionMessage, dismissalMessage } from "@/lib/manual-refund-task-copy";

const WITHHELD_SHARE = "UNCOLLECTED_EDIT_REVIEW_SHARE";

const LEGACY_TOAST = "Refund task dismissed.";
const LEGACY_SUMMARY = "Manual booking refund task dismissed";

beforeEach(() => {
  vi.clearAllMocks();
});

async function summaryFor(
  kind: string | null,
  resolution: "completed" | "dismissed",
  settlementRoute: { kind: string; collectVia?: "stripe" | "invoice" } | null = null,
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
    settlementRoute: settlementRoute as never,
    settlementDirection: (settlementRoute?.kind === "additional-charge"
      ? "CHARGE_TO_MEMBER"
      : null) as never,
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

  it("leaves a hand-back completion alone on every kind, withheld share included", async () => {
    // A withheld share can never REACH this arm - the completion door refuses it
    // (`INV-PAY-051`) - so the assertion is that #3213 did not reword the arm it
    // was not about, rather than that the combination is reachable. With no
    // settlement route this is the legacy hand-back, which is the one completion
    // wording the fix round below leaves byte-identical.
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

describe("#3213 fix round: the durable summary names the money's direction", () => {
  /*
    THE RECORD WAS LESS TRUTHFUL THAN THE TOAST, which is the wrong way round.
    Since #3170 an EDIT_FINANCIAL_REVIEW completion can go down the
    additional-charge route - the member is asked to pay the CLUB - and the audit
    summary still wrote "Manual booking refund paid back by hand" over it. The
    toast has distinguished all four routes since #3170; the permanent,
    member-adjacent row did not.

    The route is classified in ONE place and both sentences read it, so the pair
    can no longer drift. These cases assert the pairing directly rather than the
    strings alone: whatever each says, they must agree about which way the money
    went.
  */
  const CARD = { kind: "stripe-refund" };
  const CREDIT = { kind: "account-credit" };
  const CHARGE_CARD = { kind: "additional-charge", collectVia: "stripe" as const };
  const CHARGE_INVOICE = { kind: "additional-charge", collectVia: "invoice" as const };

  it("never says the club paid a member back when the member was asked to pay", async () => {
    for (const route of [CHARGE_CARD, CHARGE_INVOICE]) {
      vi.clearAllMocks();
      const summary = await summaryFor("EDIT_FINANCIAL_REVIEW", "completed", route);
      expect(summary.toLowerCase()).not.toContain("refund");
      expect(summary.toLowerCase()).not.toContain("paid back");
      expect(summary).toContain("owed by the member");
    }
  });

  it("writes one summary per settlement route", async () => {
    const cases: [
      { kind: string; collectVia?: "stripe" | "invoice" } | null,
      string,
    ][] = [
      [CARD, "Manual booking refund settled as a card refund"],
      [CREDIT, "Manual booking refund settled as account credit"],
      [
        CHARGE_INVOICE,
        "Booking amount owed by the member added to the booking invoice",
      ],
      [
        CHARGE_CARD,
        "Booking amount owed by the member requested as an additional payment",
      ],
      [{ kind: "local-allocation" }, "Manual booking refund paid back by hand"],
      [null, "Manual booking refund paid back by hand"],
    ];
    for (const [route, expected] of cases) {
      vi.clearAllMocks();
      expect(await summaryFor("EDIT_FINANCIAL_REVIEW", "completed", route)).toBe(
        expected,
      );
    }
  });

  it("agrees with the toast about the direction, route by route", async () => {
    for (const route of [CARD, CREDIT, CHARGE_CARD, CHARGE_INVOICE, null]) {
      vi.clearAllMocks();
      const summary = await summaryFor("EDIT_FINANCIAL_REVIEW", "completed", route);
      const toast = completionMessage({
        amountAmended: false,
        settlementRoute: route,
        stripeRefundId: "re_1",
        additionalPaymentIntentId: "pi_1",
      });
      const asksTheMember = (sentence: string) =>
        /asked to pay|to pay|owed by the member/i.test(sentence) &&
        !/refund|paid back|credit issued/i.test(sentence);
      expect(asksTheMember(summary)).toBe(asksTheMember(toast));
    }
  });

  it("makes no claim the provider call succeeded, because it is written before it", async () => {
    // The audit entry is composed INSIDE the completion transaction; the Stripe
    // refund and the payment request happen after the commit. "sent" or
    // "received" here would be a durable claim the row cannot back when the call
    // then fails and the recovery operation retries it.
    for (const route of [CARD, CHARGE_CARD]) {
      vi.clearAllMocks();
      const summary = await summaryFor("EDIT_FINANCIAL_REVIEW", "completed", route);
      expect(summary.toLowerCase()).not.toContain("sent");
      expect(summary.toLowerCase()).not.toContain("received");
    }
  });
});
