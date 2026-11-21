import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #3924 round 11 (`INV-PAY-110`, `INV-PAY-122`): TWO VERDICTS OF ONE RECEIPT.
 * A late capture's receipt row an officer resolved by hand is the officer's
 * record for every card-refund path - the refund note's eligible cash, the
 * card-note gap, the late-capture refund repair - exactly as before #3924, so
 * none of them raises or counts a card note for it. Only a refund closed as
 * paid another way reads the wider verdict, where a row resolved after the app
 * sent it, or a change linked in Xero, is the app's own invoice and the close's
 * note follows it. The real reader runs here over an in-memory store; the
 * callers around it are real too, with only their other reads stubbed.
 */
const state = vi.hoisted(() => ({
  keptResolved: [] as Array<{ xeroObjectId: string | null }>,
  change: [] as Array<{
    status: string;
    xeroObjectId: string | null;
    manuallyResolvedAt: Date | null;
    localModel: string;
    localId: string;
    requestPayload: Record<string, unknown>;
  }>,
  changeLink: null as { xeroObjectId: string } | null,
  keptLink: null as { xeroObjectId: string } | null,
  note: vi.fn(),
  cardByHand: vi.fn(),
  cardMayBeInXero: 0,
  cardAboveRecorded: 0,
}));

const RESOLVED_AT = new Date("2026-06-20T00:00:00.000Z");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      findUnique: async () => ({ id: "task_late" }),
      findMany: async () => [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }],
    },
    xeroObjectLink: {
      findFirst: async ({ where }: { where: { role?: string } }) =>
        where.role === "SUPPLEMENTARY_INVOICE" ? state.changeLink : state.keptLink,
    },
    xeroSyncOperation: {
      findMany: async ({ where }: { where: { queueType?: string } }) =>
        where.queueType === "KEPT_LATE_CAPTURE_INVOICE" ? state.keptResolved : state.change,
    },
    paymentRefund: {
      findMany: async () => [
        { stripePaymentIntentId: "pi_ordinary", amountCents: 10000, status: "succeeded" },
        { stripePaymentIntentId: "pi_late", amountCents: 24000, status: "succeeded" },
      ],
    },
    booking: {
      findUnique: async () => ({
        memberId: "member_1",
        member: { firstName: "Ann", lastName: "Lee" },
        organisation: null,
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        deletedAt: null,
      }),
    },
    // #4170: the note-eligible cash also asks whether the booking is cancelled
    // (it reads which captures landed after the cancel only then); not here.
    paymentTransaction: {
      findFirst: async () => ({ kind: "PRIMARY" }),
      findMany: async () => [],
      // #4383: the capture's gross, which a receipt other than its own records whole.
      findUnique: async () => ({ amountCents: 24000 }),
    },
    payment: { findUnique: async () => null },
  },
}));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: async () => ({ source: "provider-ledger", cashRefundCents: 34000 }),
}));
vi.mock("@/lib/xero-resolved-in-xero-fences", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-resolved-in-xero-fences")),
  readResolvedRefundCreditNoteCoverage: async () => ({ coveredCents: 0 }),
  sumRefundCreditNoteCoverageCents: async () => 0,
}));
vi.mock("@/lib/card-refund-paid-another-way-cash", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/card-refund-paid-another-way-cash")),
  readPaidAnotherWayUncoveredCents: async () => 0,
}));
vi.mock("@/lib/cancelled-booking-late-capture", () => ({
  recordAutomaticLateCaptureRefund: async () => ({ bookingDeleted: false, recorded: true, handCompletedAfterRefund: false }),
  announceAutomaticLateCaptureRefund: async () => undefined,
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  noteLateCaptureRefunds: (...a: unknown[]) => state.note(...a),
  // Round 14: the record-by-hand share is `cardByHand`, the share a note sent
  // without a reply may answer is `cardMayBeInXero`.
  readUnnotedLateCaptureCardRefunds: async (...a: unknown[]) => ({
    byHandCents: await state.cardByHand(...a),
    mayBeInXeroCents: state.cardMayBeInXero,
    notesCanStillLand: false,
    notedLaterCents: 0,
    aboveRecordedCents: state.cardAboveRecorded,
  }),
}));

import {
  readLateCaptureXeroReceipt,
  readPaidAnotherWayLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { readRefundCreditNoteGap } from "@/lib/xero-admin-health";
import { recordAndNoteRepairedLateCaptureRefunds } from "@/lib/late-capture-repair-refund-record";
import { readLateCaptureCardRefundsByHand } from "@/lib/late-capture-card-refund-by-hand";

const PAYMENT = { id: "payment_1", bookingId: "booking_1", refundedAmountCents: 34000 };

/** A change's invoice the app sent, whose payment failed (PARTIAL), then resolved by hand. */
const resolvedPartialChange = {
  status: "PARTIAL",
  xeroObjectId: "inv_change",
  manuallyResolvedAt: RESOLVED_AT,
  localModel: "BookingModification",
  localId: "mod_1",
  requestPayload: { paymentIntentId: "pi_late" },
};

/** Each shape of a resolved row the round-10 widening reads as the app's receipt. */
const RESOLVED_ROWS: Array<[string, () => void, string]> = [
  ["the kept receipt's PARTIAL row, resolved after the app sent it", () => {
    state.keptResolved = [{ xeroObjectId: "inv_kept" }];
  }, "inv_kept"],
  ["a change's PARTIAL row, resolved after the app sent it", () => {
    state.change = [resolvedPartialChange];
  }, "inv_change"],
  ["a change's row resolved by hand while its change is linked in Xero", () => {
    state.change = [{ ...resolvedPartialChange, status: "FAILED", xeroObjectId: null }];
    state.changeLink = { xeroObjectId: "inv_linked" };
  }, "inv_linked"],
];

beforeEach(() => {
  state.keptResolved = [];
  state.change = [];
  state.changeLink = null;
  state.keptLink = null;
  state.note.mockReset();
  state.note.mockResolvedValue("queued");
  state.cardByHand.mockReset();
  state.cardByHand.mockResolvedValue(24000);
  state.cardMayBeInXero = 0;
  state.cardAboveRecorded = 0;
});

describe.each(RESOLVED_ROWS)("round 11: %s", (_label, arrange, invoiceId) => {
  beforeEach(arrange);

  it("MUTATION: is resolved by hand for every card-refund path, as before #3924", async () => {
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
  });

  it("MUTATION: is recorded against that invoice only for a refund closed as paid another way", async () => {
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId, recordedCents: 24000 });
  });

  it("leaves the capture's refund out of the cash a refund note may answer", async () => {
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      lateCaptureExcludedCents: 24000,
      eligibleCashCents: 10000,
    });
  });

  it("leaves it out of the card-note gap the nightly self-heal fills", async () => {
    await expect(readRefundCreditNoteGap(PAYMENT)).resolves.toMatchObject({
      cashRefundCents: 10000,
      uncoveredCents: 10000,
    });
  });

  it("is reported by hand by the late-capture refund repair, and never noted", async () => {
    const outcome = await recordAndNoteRepairedLateCaptureRefunds({
      bookingId: "booking_1",
      paymentId: "payment_1",
      refunds: [{ paymentIntentId: "pi_late", amountCents: 24000 }],
      format: CLUB_FORMAT_TEST,
    });
    expect(outcome.byHand).toEqual(["pi_late"]);
    expect(outcome.noted).toEqual([]);
    expect(state.note).not.toHaveBeenCalled();
  });

  // #3924 round 12 (F1): the verdicts part, so the app's invoice is in Xero
  // and no card note will ever answer the capture's card refunds.
  it("MUTATION: round 12: names the capture's card refunds no note answers, for the repair tool to ask by hand", async () => {
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late", "pi_ordinary"])).resolves.toEqual(
      new Map([["pi_late", { byHandCents: 24000, mayBeInXeroCents: 0, aboveRecordedCents: 0 }]]),
    );
    expect(state.cardByHand).toHaveBeenCalledWith("payment_1", "pi_late");
    expect(state.cardByHand).toHaveBeenCalledTimes(1);
  });

  it("round 12: names nothing once notes answer every card refund", async () => {
    state.cardByHand.mockResolvedValue(0);
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(new Map());
  });

  // Round 14: a card note sent without a reply leaves nothing to record by
  // hand yet, but the capture is still named, for Xero to be checked first.
  it("MUTATION: round 14: names a capture whose only card refunds a note sent without a reply may answer", async () => {
    state.cardByHand.mockResolvedValue(0);
    state.cardMayBeInXero = 24000;
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(
      new Map([["pi_late", { byHandCents: 0, mayBeInXeroCents: 24000, aboveRecordedCents: 0 }]]),
    );
  });
});

describe("round 12: card refunds a card note answers are never named; round 13: the card verdict alone decides", () => {
  it("MUTATION: a linked change whose row is still FAILED, unresolved: the card path still notes it", async () => {
    state.change = [{ ...resolvedPartialChange, status: "FAILED", xeroObjectId: null, manuallyResolvedAt: null }];
    state.changeLink = { xeroObjectId: "inv_linked" };
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(new Map());
  });

  // #3924 round 13 (#4038, F2b): the card verdict alone decides - both
  // verdicts say by hand here, the close's finding (when there is one, with
  // no note row) names it first, and otherwise this one does.
  it("MUTATION: round 13: a change resolved before the app sent it, with no link, is named on the card verdict alone (#4038)", async () => {
    state.change = [{ ...resolvedPartialChange, status: "FAILED", xeroObjectId: null }];
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(new Map([["pi_late", { byHandCents: 24000, mayBeInXeroCents: 0, aboveRecordedCents: 0 }]]));
    expect(state.cardByHand).toHaveBeenCalledWith("payment_1", "pi_late");
  });

  // #3924 round 13 (#4039): a kept PARTIAL row resolved by hand whose
  // invoice link stays active is the app's receipt for every card-refund
  // path, so the app raises the card note and nothing is named by hand.
  it("MUTATION: round 13: a resolved PARTIAL kept row whose link stays active names nothing (#4039)", async () => {
    state.keptResolved = [{ xeroObjectId: "inv_kept" }];
    state.keptLink = { xeroObjectId: "inv_kept" };
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: "inv_kept", recordedCents: 24000 });
    // The app raises the card note: what is left for it is never named by hand.
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(new Map());
  });

  // #4383: a receipt the app recorded for only part of the capture names the
  // refunds above that part, and only them - never the card note's share.
  it("MUTATION: #4383: a recorded capture refunded above what its receipt recorded is named for that part alone", async () => {
    state.keptLink = { xeroObjectId: "inv_kept" };
    state.cardAboveRecorded = 3000;
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(
      new Map([["pi_late", { byHandCents: 0, mayBeInXeroCents: 0, aboveRecordedCents: 3000 }]]),
    );
    // A resolved-by-hand receipt keeps its by-hand figures, and capped nothing.
    state.keptLink = null;
    state.keptResolved = [{ xeroObjectId: null }];
    await expect(readLateCaptureCardRefundsByHand("payment_1", ["pi_late"])).resolves.toEqual(
      new Map([["pi_late", { byHandCents: 24000, mayBeInXeroCents: 0, aboveRecordedCents: 0 }]]),
    );
  });
});

describe("round 11: a change linked in Xero whose row FAILED after the link", () => {
  it("keeps the card-refund verdict (no id, failed) and names the link only when paid another way", async () => {
    state.change = [{ ...resolvedPartialChange, status: "FAILED", xeroObjectId: null, manuallyResolvedAt: null }];
    state.changeLink = { xeroObjectId: "inv_linked" };
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: null,
      recordedCents: 24000,
      invoiceFailed: true,
    });
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: "inv_linked",
      recordedCents: 24000,
    });
  });
});
