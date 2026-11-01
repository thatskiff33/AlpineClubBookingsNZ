import { describe, expect, it, vi } from "vitest";

/**
 * #4159 review round 2 (F1, `INV-PAY-135`): a capacity race's part to check
 * whose record keeps a card note's cover is NOTED bank cash, with or without a
 * note row of its own - so the legacy-mirror cash keeps it, and the card note
 * already in Xero answers it rather than reading as over-coverage.
 */
vi.mock("@/lib/late-capture-paid-another-way", () => ({ paidAnotherWayCloseReceiptRecorded: vi.fn() }));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({ sumRefundCreditNoteCoverageOfRowsCents: vi.fn(async () => 0) }));
// #4315 item 2: what a re-confirmed follow-up's hand-made note covers, read through its link.
vi.mock("@/lib/xero-sync", () => ({ sumCoveredRefundCreditNoteCents: vi.fn(async (_p: string, _db: unknown, ids?: string[]) => (ids?.length ? 2_000 : 0)) }));

import { readPaidAnotherWayCash, readPaidAnotherWayCloseBankCashByPayment, readPaidAnotherWayCloseShare } from "@/lib/card-refund-paid-another-way-cash";
import { CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE } from "@/lib/manual-refund-task-settlement-rules";

const RACE_KEY = "cancel-card-shortfall:booking-1:capacity-race:pi_race:check";

function db(task: { reviewContext: unknown }, noteRows: number) {
  const row = { id: "task-race", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: RACE_KEY, amountCents: 20_000, ...task };
  return {
    manualRefundTask: { findMany: vi.fn(async () => [row]), findFirst: vi.fn(async () => row) },
    xeroSyncOperation: { count: vi.fn(async () => noteRows) },
    xeroObjectLink: {},
    paymentRecoveryOperation: {},
  } as never;
}

describe("a capacity race's part to check, as the note pipeline reads its bank cash (#4159 F1)", () => {
  it("MUTATION: covered by a card note and with no note row of its own, it is noted - and its own note owes nothing", async () => {
    const store = db({ reviewContext: { paidAnotherWayCardNoteCover: 20_000 } }, 0);
    await expect(readPaidAnotherWayCash(store, "payment-1")).resolves.toEqual({ notedCents: 20_000, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(store, "payment-1", "task-race")).resolves.toMatchObject({ cardNoteCoversCents: 20_000, uncoveredCents: 0 });
  });

  it("CONTROL: with no cover and no note row (a booking with no invoice), it stays un-noted", async () => {
    await expect(readPaidAnotherWayCash(db({ reviewContext: null }, 0), "payment-1")).resolves.toEqual({ notedCents: 0, unnotedCents: 20_000, awaitingReceiptCents: 0 });
  });
});

describe("a cancellation hand-back noted on its own record, as the note pipeline reads its bank cash (#4287, INV-ADDPAY-043)", () => {
  /** The hand-back, its own note rows, and the `bank-refund-void:` follow-ups whose undo named it. */
  function handBackDb(noteRows: number, undoneCents: number[] = []) {
    const row = { id: "task-hand-back", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null, amountCents: 3_000, reviewContext: null };
    const findMany = vi.fn(async (args: { where: { occurrenceKey?: unknown } }) =>
      args.where.occurrenceKey ? undoneCents.map((amountCents) => ({ amountCents })) : [row],
    );
    return {
      manualRefundTask: { findMany, findFirst: vi.fn(async () => row) },
      xeroSyncOperation: { count: vi.fn(async () => noteRows) },
      xeroObjectLink: {},
      paymentRecoveryOperation: {},
    } as never;
  }

  it("MUTATION: once a note row names it, it is noted bank cash - so a card note's coverage counts it beside its cash", async () => {
    await expect(readPaidAnotherWayCash(handBackDb(1), "payment-1")).resolves.toEqual({ notedCents: 3_000, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(handBackDb(1), "payment-1", "task-hand-back")).resolves.toMatchObject({ amountCents: 3_000, uncoveredCents: 3_000 });
  });

  it("CONTROL: with no note row of its own (the canonical note's, or one the old release absorbed) it is no record here at all - never un-noted", async () => {
    await expect(readPaidAnotherWayCash(handBackDb(0), "payment-1")).resolves.toEqual({ notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 });
  });

  it("MUTATION (review F1): once its note is voided and the nightly undo took its refund back, it counts for nothing, in both readers", async () => {
    await expect(readPaidAnotherWayCash(handBackDb(1, [3_000]), "payment-1")).resolves.toEqual({ notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(handBackDb(1, [3_000]), "payment-1", "task-hand-back")).resolves.toMatchObject({ amountCents: 0, uncoveredCents: 0 });
  });
});

describe("a re-confirmed bank refund (a completed void follow-up) as the note pipeline reads its bank cash (#4315 item 2, INV-ADDPAY-043)", () => {
  /** The follow-up, its own note rows, hand-made note links naming it, and later follow-ups whose undo named it. */
  function followUpDb(options: { noteRows?: number; handMadeLinks?: number; undoneCents?: number[] }) {
    const row = { id: "follow-up", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "bank-refund-void:payment-1:cn-1", amountCents: 2_000, reviewContext: null };
    const findMany = vi.fn(async (args: { where: { reviewContext?: unknown } }) =>
      args.where.reviewContext ? (options.undoneCents ?? []).map((amountCents) => ({ amountCents })) : [row],
    );
    return {
      manualRefundTask: { findMany, findFirst: vi.fn(async () => row) },
      xeroSyncOperation: { count: vi.fn(async () => options.noteRows ?? 0) },
      xeroObjectLink: { findMany: vi.fn(async () => Array.from({ length: options.handMadeLinks ?? 0 }, (_, i) => ({ xeroObjectId: `cn-hand-${i}` }))) },
      paymentRecoveryOperation: {},
    } as never;
  }

  it("MUTATION: re-confirmed with a fresh note keyed on it, it is noted bank cash at its amount", async () => {
    await expect(readPaidAnotherWayCash(followUpDb({ noteRows: 1 }), "payment-1")).resolves.toEqual({ notedCents: 2_000, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(followUpDb({ noteRows: 1 }), "payment-1", "follow-up")).resolves.toMatchObject({ amountCents: 2_000, uncoveredCents: 2_000 });
  });

  it("MUTATION: re-confirmed with a hand-made note, it is noted, and that note covers it", async () => {
    await expect(readPaidAnotherWayCash(followUpDb({ handMadeLinks: 1 }), "payment-1")).resolves.toEqual({ notedCents: 2_000, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(followUpDb({ handMadeLinks: 1 }), "payment-1", "follow-up")).resolves.toMatchObject({ amountCents: 2_000, uncoveredCents: 0 });
  });

  it("MUTATION: its own note voided and undone in turn, it counts for nothing, in both readers", async () => {
    await expect(readPaidAnotherWayCash(followUpDb({ noteRows: 1, undoneCents: [2_000] }), "payment-1")).resolves.toEqual({ notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(followUpDb({ noteRows: 1, undoneCents: [2_000] }), "payment-1", "follow-up")).resolves.toMatchObject({ amountCents: 0, uncoveredCents: 0 });
  });

  it("CONTROL: with no note of its own it is no record here", async () => {
    await expect(readPaidAnotherWayCash(followUpDb({}), "payment-1")).resolves.toEqual({ notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 });
  });
});

describe("the bank cash Paid another way closes recorded, per payment (#4280, INV-PAY-103)", () => {
  function groupedDb(groups: Array<{ paymentId: string | null; _sum: { amountCents: number | null } }>) {
    return { manualRefundTask: { groupBy: vi.fn(async () => groups) } };
  }

  it("reads the closes' own records only, at what each paid, for one payment or all", async () => {
    const store = groupedDb([{ paymentId: "payment-1", _sum: { amountCents: 12_000 } }]);
    await expect(readPaidAnotherWayCloseBankCashByPayment(store as never, { paymentId: "payment-1" })).resolves.toEqual(new Map([["payment-1", 12_000]]));
    expect(store.manualRefundTask.groupBy).toHaveBeenCalledWith({
      by: ["paymentId"],
      where: { ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, paymentId: "payment-1" },
      _sum: { amountCents: true },
    });

    const all = groupedDb([]);
    await readPaidAnotherWayCloseBankCashByPayment(all as never, "all");
    expect(all.manualRefundTask.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, paymentId: { not: null } } }),
    );
  });

  it("is the paid-another-way prefix alone: never a cancel's card refund shortfall or an ordinary bank hand-back (owner, 26 Oct 2026)", () => {
    expect(CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE).toEqual({
      kind: "CANCELLED_BOOKING_HAND_BACK",
      status: "COMPLETED",
      occurrenceKey: { startsWith: "card-refund-paid-another-way:" },
    });
  });

  it("drops a payment with nothing paid, and never reads below nothing", async () => {
    const store = groupedDb([
      { paymentId: "payment-1", _sum: { amountCents: null } },
      { paymentId: null, _sum: { amountCents: 5_000 } },
      { paymentId: "payment-2", _sum: { amountCents: -1 } },
      { paymentId: "payment-3", _sum: { amountCents: 7_000 } },
    ]);
    await expect(readPaidAnotherWayCloseBankCashByPayment(store as never, "all")).resolves.toEqual(new Map([["payment-3", 7_000]]));
  });
});
