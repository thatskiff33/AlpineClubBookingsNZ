/**
 * The hand-back poster (#3599): which completions post a `BANK_REFUND`, and
 * which deliberately do not.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: log }));

import { postHandBackLedgerLine } from "@/lib/booking-ledger-hand-back";

function args(over: Partial<Parameters<typeof postHandBackLedgerLine>[0]> = {}) {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  return {
    createMany,
    input: {
      bookingId: "b1",
      lodgeId: "l1",
      manualRefundTaskId: "t1",
      amountCents: 3_500,
      refundMethod: "internet-banking" as const,
      paymentSource: "INTERNET_BANKING" as const,
      officerMemberId: "officer-1",
      store: { bookingLedgerLine: { createMany } } as never,
      ...over,
    },
  };
}

describe("postHandBackLedgerLine", () => {
  it("posts one BANK_REFUND by internet banking for money the club handed back", async () => {
    const { input, createMany } = args();
    await postHandBackLedgerLine(input);
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: [expect.objectContaining({ kind: "BANK_REFUND", amountCents: -3_500, settlementMethod: "INTERNET_BANKING", postingKey: "handback:t1" })],
    });
  });

  it("posts nothing for a task on a CARD payment — its refund posts from the PaymentRefund row (review of #3609)", async () => {
    const { input, createMany } = args({ paymentSource: "STRIPE" });
    await postHandBackLedgerLine(input);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("refuses, in pure code, a hand-back routed as a card refund or account credit", async () => {
    log.error.mockClear();
    const { input, createMany } = args({ refundMethod: "card" });
    await expect(postHandBackLedgerLine(input)).resolves.toBeUndefined();
    expect(createMany).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
