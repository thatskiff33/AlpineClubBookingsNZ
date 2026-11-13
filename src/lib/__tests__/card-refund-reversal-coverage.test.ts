/**
 * #4369 (`INV-PAY-151`): refund-note coverage is net of a reversal that has
 * reached Xero. A voided one, and one still only queued, change nothing.
 *
 * Card note $80. The figures beside the sum are the close's own arithmetic:
 * eligible cash and the excess the reconciliation report lists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  grossLinkedCents: 0,
  links: [] as Array<{ role?: string; metadata: unknown }>,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: {
      findMany: async () => state.links,
    },
  },
}));
vi.mock("@/lib/xero-sync", () => ({
  sumCoveredRefundCreditNoteCents: async () => state.grossLinkedCents,
}));

import {
  CARD_REFUND_REVERSAL_INVOICE_ROLE,
  liveCardRefundReversalCents,
  readPendingCardRefundReversalCents,
} from "@/lib/xero-card-refund-reversal-outbox";
import { sumRefundCreditNoteCoverageCents } from "@/lib/xero-resolved-in-xero-fences";

const resolved = { coveredCents: 0, correlationKeys: [], operationIds: [], unreadableOperationIds: [] };

beforeEach(() => {
  state.grossLinkedCents = 0;
  state.links = [];
});

describe("net refund-note coverage after a Stripe reversal (#4369)", () => {
  it("a full $80 close: card note and bank note, less the $80 reversal, leaves $80", async () => {
    state.grossLinkedCents = 16_000;
    state.links = [{ role: CARD_REFUND_REVERSAL_INVOICE_ROLE, metadata: { amountCents: 8_000, closeTaskId: "close-1" } }];
    const net = await sumRefundCreditNoteCoverageCents("pay-1", resolved);
    const eligible = 8_000;
    expect(net).toBe(8_000);
    expect(Math.max(0, net - eligible)).toBe(0);
  });

  it("a $50 close of an $80 note: the reversal is $50, so $30 of the card note is still excess", async () => {
    state.grossLinkedCents = 8_000 + 5_000;
    state.links = [{ role: CARD_REFUND_REVERSAL_INVOICE_ROLE, metadata: { amountCents: 5_000, closeTaskId: "close-1" } }];
    const net = await sumRefundCreditNoteCoverageCents("pay-1", resolved);
    const eligible = 5_000;
    expect(net).toBe(8_000);
    expect(Math.max(0, net - eligible)).toBe(3_000);
  });

  it("a $40 close of which $15 is covered: coverage is the card notes less $15 plus the $40 bank note", async () => {
    const cardNotes = 8_000;
    state.grossLinkedCents = cardNotes + 4_000;
    state.links = [{ role: CARD_REFUND_REVERSAL_INVOICE_ROLE, metadata: { amountCents: 1_500, closeTaskId: "close-1" } }];
    const net = await sumRefundCreditNoteCoverageCents("pay-1", resolved);
    expect(net).toBe(cardNotes - 1_500 + 4_000);
  });

  it("MUTATION: a voided or deleted reversal is not subtracted, and a pending one has no link to subtract", async () => {
    state.grossLinkedCents = 8_000;
    state.links = [{ role: CARD_REFUND_REVERSAL_INVOICE_ROLE, metadata: { amountCents: 8_000, status: "VOIDED" } }];
    expect(await sumRefundCreditNoteCoverageCents("pay-1", resolved)).toBe(8_000);
    state.links = [{ role: CARD_REFUND_REVERSAL_INVOICE_ROLE, metadata: { amountCents: 8_000, status: "DELETED" } }];
    expect(await sumRefundCreditNoteCoverageCents("pay-1", resolved)).toBe(8_000);
    state.links = [];
    expect(await sumRefundCreditNoteCoverageCents("pay-1", resolved)).toBe(8_000);
    state.links = [{ role: "REFUND_CREDIT_NOTE", metadata: { amountCents: 8_000, status: "AUTHORISED" } }];
    expect(await sumRefundCreditNoteCoverageCents("pay-1", resolved)).toBe(8_000);
    expect(liveCardRefundReversalCents({ amountCents: 8_000, status: "VOIDED" })).toBe(0);
    expect(liveCardRefundReversalCents({ status: "AUTHORISED" })).toBe(0);
  });

  it("reversal linked and the bank note only queued: the gap is the close, and no Stripe note is asked for", () => {
    const cardNote = 8_000;
    const reversal = 8_000;
    const net = cardNote - reversal;
    const eligible = 8_000;
    const uncovered = Math.max(0, eligible - net);
    const closeUncovered = 8_000;
    const cardAsk = uncovered - Math.min(uncovered, closeUncovered);
    expect(uncovered).toBe(closeUncovered);
    expect(cardAsk).toBe(0);
  });
});

// #5017 review (money M1): what a later close's cover takes off for reversals
// queued but not yet in Xero. Coverage counts only a linked one, so these are
// the rest.
describe("reversals queued but not yet in Xero (#5017 M1)", () => {
  const payload = (closeTaskId: string, amountCents: number) => ({
    queueType: "CARD_REFUND_REVERSAL_INVOICE",
    bookingId: "b-1",
    paymentId: "pay-1",
    closeTaskId,
    amountCents,
    closedOn: "2026-07-01",
  });
  const store = (rows: unknown[], links: unknown[]) => {
    const calls: unknown[] = [];
    return {
      calls,
      db: {
        xeroSyncOperation: { findMany: async (args: unknown) => (calls.push(args), rows) },
        xeroObjectLink: { findMany: async () => links },
      } as never,
    };
  };

  it("MUTATION: counts each unlinked reversal's queued cents, and none whose close already has a link, active or voided", async () => {
    const { db } = store(
      [
        { requestPayload: payload("close-1", 3_000) },
        { requestPayload: payload("close-2", 2_000) },
        { requestPayload: payload("close-3", 1_000) },
      ],
      [
        { metadata: { closeTaskId: "close-2", amountCents: 2_000 } },
        { metadata: { closeTaskId: "close-3", amountCents: 1_000, status: "VOIDED" } },
      ],
    );
    expect(await readPendingCardRefundReversalCents(db, "pay-1")).toBe(3_000);
  });

  it("MUTATION: reads only this payment's live reversal creates, and an unreadable payload counts nothing", async () => {
    const { db, calls } = store([{ requestPayload: { queueType: "CARD_REFUND_REVERSAL_INVOICE" } }], []);
    expect(await readPendingCardRefundReversalCents(db, "pay-1")).toBe(0);
    expect(calls[0]).toMatchObject({
      where: {
        localModel: "Payment",
        localId: "pay-1",
        entityType: "INVOICE",
        operationType: "CREATE",
        queueType: "CARD_REFUND_REVERSAL_INVOICE",
        status: { not: "CANCELLED" },
      },
    });
    expect(await readPendingCardRefundReversalCents(store([], []).db, "pay-1")).toBe(0);
  });
});
