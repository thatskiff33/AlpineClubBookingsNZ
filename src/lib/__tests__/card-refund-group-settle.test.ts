// #4851: a dead refund out of the group organiser's card is settled on Stuck
// States without a new Stripe dashboard refund. Paid another way records a
// refund Stripe already holds, or a bank payment. Try the card again re-arms
// only the newer per-joiner row. The transaction client records every write,
// so a path that should move no money is a path whose lists stay empty.
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHILD_KEY = "organiser_child_refund_cancel_settle_child-1";
const APPEAL_KEY = "organiser_card_appeal_refund_req-1";
const LEGACY_KEY = "group_settlement_refund_recovery_settle1";
const CHARGE_KEY = "booking_cancel_refund_recovery_b-1";
const FROZEN = new Date("2026-07-01T00:00:00.000Z");

const state = vi.hoisted(() => ({
  operation: null as Record<string, unknown> | null,
  operations: [] as Record<string, unknown>[],
  settlement: null as Record<string, unknown> | null,
  settlements: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  combined: null as Record<string, unknown> | null,
  refundedBefore: 0,
  claimsAllowed: 1,
  cancelInProgress: false,
  listThrows: false,
  claims: [] as unknown[],
  tasks: [] as { occurrenceKey?: string; amountCents?: number }[],
  events: [] as { type?: string; bookingId?: string }[],
  audits: [] as { action?: string }[],
  ledger: [] as { kind?: string; unitCents?: number }[][],
  enqueues: [] as unknown[],
  alerts: [] as { bookingId?: string; refundCents?: number }[],
  processRefunds: 0,
  paymentUpdates: [] as { data?: { refundedAmountCents?: number } }[],
  paymentUpdateMany: [] as unknown[],
  settlementUpdates: [] as { data?: { status?: string } }[],
  paymentRefundCreates: 0,
  refundRecords: [] as { refund?: { id?: string } }[],
}));

function reset() {
  state.operation = null;
  state.operations = [];
  state.settlement = null;
  state.settlements = [];
  state.refunds = [];
  state.combined = null;
  state.refundedBefore = 0;
  state.claimsAllowed = 1;
  state.cancelInProgress = false;
  state.listThrows = false;
  state.claims = [];
  state.tasks = [];
  state.events = [];
  state.audits = [];
  state.ledger = [];
  state.enqueues = [];
  state.alerts = [];
  state.processRefunds = 0;
  state.paymentUpdates = [];
  state.paymentUpdateMany = [];
  state.settlementUpdates = [];
  state.paymentRefundCreates = 0;
  state.refundRecords = [];
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/stripe");
  return {
    ...actual,
    listRefundsForPaymentIntent: () => {
      if (state.listThrows) return Promise.reject(new Error("stripe down"));
      return Promise.resolve(state.refunds);
    },
    processRefund: () => {
      state.processRefunds += 1;
      return Promise.resolve({ id: "re_sent", amount: 4_500, status: "succeeded" });
    },
  };
});

vi.mock("@/lib/payment-transactions", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/payment-transactions");
  return {
    ...actual,
    lockPaymentForRefundedTotal: () => Promise.resolve(),
    recordStripeRefundLedgerEntry: (input: { refund?: { id?: string } }) => {
      state.refundRecords.push(input);
      return Promise.resolve({ created: true });
    },
  };
});

vi.mock("@/lib/organiser-child-refund", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/organiser-child-refund");
  return {
    ...actual,
    findCombinedCardSettlementForChild: () => Promise.resolve(state.combined),
    organiserChildRefundedCents: () => Promise.resolve(state.refundedBefore),
  };
});

vi.mock("@/lib/xero-operation-outbox", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-operation-outbox");
  return {
    ...actual,
    enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) => {
      state.enqueues.push(args);
      return Promise.resolve({ queueOperationId: "note-1" });
    },
    kickQueuedXeroOutboxOperationsIfConnected: () => Promise.resolve(),
  };
});

vi.mock("@/lib/booking-ledger-settlement-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-ledger-settlement-sync");
  return { ...actual, syncBookingLedgerSettlements: () => Promise.resolve() };
});

vi.mock("@/lib/booking-ledger-write", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-ledger-write");
  return {
    ...actual,
    writeBookingLedgerRows: (_tx: unknown, rows: { kind?: string; unitCents?: number }[]) => {
      state.ledger.push(rows);
      return Promise.resolve(rows.length);
    },
  };
});

vi.mock("@/lib/group-settlement-mirror-hand-back", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/group-settlement-mirror-hand-back");
  return {
    ...actual,
    alertGroupMirrorRefundXeroByHand: (input: { bookingId?: string; refundCents?: number }) => {
      state.alerts.push(input);
      return Promise.resolve();
    },
  };
});

vi.mock("@/lib/group-cancel-in-progress", () => ({
  groupCancelInProgress: () => Promise.resolve(state.cancelInProgress),
}));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/audit");
  return {
    ...actual,
    createAuditLog: (entry: { action?: string }) => {
      state.audits.push(entry);
      return Promise.resolve();
    },
    logAudit: (entry: { action?: string }) => {
      state.audits.push(entry);
    },
  };
});

vi.mock("@/lib/xero", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero");
  return { ...actual, isXeroConnected: () => Promise.resolve(false) };
});

vi.mock("@/lib/club-format-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/club-format-settings");
  return { ...actual, getClubFormat: async () => ({ currencyCode: "NZD", locale: "en-NZ" }) };
});

const holders = vi.hoisted(() => ({ tx: null as Tx | null }));

type Tx = {
  paymentRecoveryOperation: { findUnique: () => Promise<unknown>; updateMany: (args: unknown) => Promise<{ count: number }> };
};

function paymentRow(id: string) {
  return {
    id,
    bookingId: state.operation?.bookingId ?? id,
    booking: {
      id: (state.operation?.bookingId as string | undefined) ?? id,
      organiserSettled: true,
      parentBookingId: "org-booking",
      memberId: "mem-1",
    },
    amountCents: 9_000,
    refundedAmountCents: 0,
    status: "SUCCEEDED",
    xeroInvoiceId: null,
  };
}

vi.mock("@/lib/prisma", () => {
  const claim = (args: unknown) => {
    state.claims.push(args);
    const count = state.claimsAllowed > 0 ? 1 : 0;
    if (count === 1) state.claimsAllowed -= 1;
    return Promise.resolve({ count });
  };
  const recordEvent = ({ data }: { data: { type?: string; bookingId?: string } }) => {
    state.events.push(data);
    return Promise.resolve({});
  };
  const tx = {
    $executeRaw: () => Promise.resolve(1),
    paymentRecoveryOperation: {
      findUnique: () => Promise.resolve(state.operation),
      updateMany: claim,
    },
    payment: {
      findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(paymentRow(where.id)),
      findUniqueOrThrow: ({ where }: { where: { id: string } }) =>
        Promise.resolve({ ...paymentRow(where.id), amountCents: where.id === "pay-joiner-a" ? 4_500 : 9_000 }),
      update: (args: { data?: { refundedAmountCents?: number } }) => {
        state.paymentUpdates.push(args);
        return Promise.resolve({});
      },
      updateMany: (args: unknown) => {
        state.paymentUpdateMany.push(args);
        return Promise.resolve({ count: 1 });
      },
    },
    booking: {
      findUnique: ({ where }: { where: { id: string } }) => {
        if (where.id === "joiner-a") {
          return Promise.resolve({
            id: where.id,
            status: "CANCELLED",
            memberId: "joiner-member",
            lodgeId: "lodge-1",
            organiserSettled: true,
            parentBookingId: "org-booking",
            payment: { id: "pay-joiner-a" },
          });
        }
        return Promise.resolve({
          id: where.id,
          lodgeId: "lodge-1",
          memberId: "mem-1",
          status: "CANCELLED",
          organiserSettled: where.id === "child-1",
          parentBookingId: "org-booking",
          payment: { id: "pay-1" },
        });
      },
    },
    groupBookingSettlement: {
      findUnique: () => Promise.resolve(state.settlement),
      updateMany: (args: { data?: { status?: string } }) => {
        state.settlementUpdates.push(args);
        return Promise.resolve({ count: 1 });
      },
    },
    manualRefundTask: {
      create: ({ data }: { data: { occurrenceKey?: string; amountCents?: number } }) => {
        state.tasks.push(data);
        return Promise.resolve({ id: "task-1" });
      },
      findMany: () => Promise.resolve([]),
    },
    bookingEvent: {
      create: recordEvent,
      findFirst: () => Promise.resolve(null),
    },
    bookingLedgerLine: { findFirst: () => Promise.resolve(null) },
    paymentRefund: {
      aggregate: () => Promise.resolve({ _sum: { amountCents: 4_500 } }),
      create: () => {
        state.paymentRefundCreates += 1;
        return Promise.resolve({ id: "pr-should-not" });
      },
      findUnique: () => Promise.resolve(null),
    },
  };
  holders.tx = tx;
  return {
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      paymentRecoveryOperation: {
        findUnique: () => Promise.resolve(state.operation),
        findMany: () => Promise.resolve(state.operations),
      },
      payment: { findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(paymentRow(where.id)) },
      groupBookingSettlement: {
        findUnique: () => Promise.resolve(state.settlement),
        findMany: () => Promise.resolve(state.settlements),
      },
      bookingEvent: { create: recordEvent },
    },
  };
});

import { DeadCardRefundActionError } from "@/lib/card-refund-dead-row";
import { lockDeadCardRefundRow, type DeadCardRefundRowRefusals } from "@/lib/card-refund-dead-row-lock";
import {
  GROUP_CARD_REFUND_ALREADY_ON_STRIPE,
  GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT,
  LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL,
} from "@/lib/card-refund-group-copy";
import { classifyLegacyGroupIntentRefunds, classifyOrganiserChildIntentRefunds, organiserChildRearmAt } from "@/lib/card-refund-group-intent";
import { closeGroupCardRefundPaidAnotherWay } from "@/lib/card-refund-group-paid-another-way";
import { tryOrganiserChildCardRefundAgain } from "@/lib/card-refund-group-try-again";
import { listDeadCardRefunds, PAID_ANOTHER_WAY_MARKER } from "@/lib/card-refund-paid-another-way";
import { findUnbackedOrganiserChildRefundMirrors } from "@/lib/organiser-child-refund-audit";
import { processOrganiserChildRefundOperation } from "@/lib/organiser-child-refund-executor";
import type { PaymentRecoveryOperation } from "@prisma/client";

const REFUSALS: DeadCardRefundRowRefusals = {
  notOwedKind: "not this kind",
  organiserChild: "child refused",
  closed: "closed",
  notGivenUp: "not given up",
  otherBooking: "other booking",
};

function dead(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "FAILED",
    attempts: 5,
    idempotencyKey: CHILD_KEY,
    bookingId: "child-1",
    paymentId: "pay-1",
    paymentIntentId: "pi_1",
    paymentTransactionId: null,
    allocationPlan: [{ paymentTransactionId: "organiser-child", amountCents: 4_500 }],
    amountCents: 4_500,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    lastError: null,
    stripeKeyPrefix: null,
    ...overrides,
  };
}

function settlement(overrides: Record<string, unknown> = {}) {
  return {
    id: "settle1",
    status: "SUCCEEDED",
    amountCents: 9_000,
    source: "STRIPE",
    stripePaymentIntentId: "pi_1",
    refundPlan: { "joiner-a": 4_500 },
    groupBookingId: "group-1",
    ...overrides,
  };
}

function liveRefund(overrides: Record<string, unknown> = {}) {
  return { id: "re_1", amount: 4_500, status: "succeeded", created: 1_782_000_000, metadata: {}, ...overrides };
}

const closeInput = {
  operationId: "op-1",
  amountCents: 4_500,
  paidBack: "full" as const,
  expectedOwedCents: 4_500,
  note: "Paid the organiser by bank transfer.",
  actingMemberId: "officer-1",
};

beforeEach(() => {
  reset();
  state.operation = dead();
  state.combined = settlement();
  state.settlement = settlement();
});

describe("classifying the organiser's PaymentIntent", () => {
  it("records a live refund carrying this row's key and ignores another joiner", () => {
    const refunds = [
      liveRefund({ metadata: { organiserChildRefundKey: "organiser_child_refund_other" } }),
      liveRefund({ id: "re_mine", metadata: { organiserChildRefundKey: CHILD_KEY } }),
    ];
    expect(classifyOrganiserChildIntentRefunds(refunds, CHILD_KEY, 4_500)).toBe("keyed");
  });

  it("cannot tell an unkeyed refund of this amount apart from this refund", () => {
    expect(classifyOrganiserChildIntentRefunds([liveRefund()], CHILD_KEY, 4_500)).toBe("unkeyed-same-amount");
    expect(classifyOrganiserChildIntentRefunds([liveRefund({ status: "failed" })], CHILD_KEY, 4_500)).toBe("none");
  });

  it("matches the old whole-group refund only when it is the one live refund of the plan total", () => {
    expect(classifyLegacyGroupIntentRefunds([liveRefund()], 4_500)).toBe("match");
    expect(classifyLegacyGroupIntentRefunds([liveRefund(), liveRefund({ id: "re_2", amount: 100 })], 4_500)).toBe("other");
    expect(classifyLegacyGroupIntentRefunds([liveRefund({ metadata: { organiserChildRefundKey: CHILD_KEY } })], 4_500)).toBe("other");
  });
});

describe("lock modes", () => {
  const lock = (accept: "charge-backed" | "organiser-child" | "either-group") =>
    lockDeadCardRefundRow(holders.tx as never, "op-1", REFUSALS, accept);

  it("charge-backed still refuses both group keys", async () => {
    state.operation = dead();
    await expect(lock("charge-backed")).rejects.toMatchObject({ status: 409, message: "child refused" });
    state.operation = dead({ idempotencyKey: LEGACY_KEY, bookingId: "org-booking" });
    await expect(lock("charge-backed")).rejects.toMatchObject({ status: 409, message: "not this kind" });
  });

  it("organiser-child accepts only the per-joiner key", async () => {
    await expect(lock("organiser-child")).resolves.toMatchObject({ operation: { id: "op-1" } });
    state.operation = dead({ idempotencyKey: LEGACY_KEY, bookingId: "org-booking" });
    await expect(lock("organiser-child")).rejects.toMatchObject({ status: 409 });
    state.operation = dead({ idempotencyKey: CHARGE_KEY });
    await expect(lock("organiser-child")).rejects.toMatchObject({ status: 409 });
  });

  it("either-group accepts both group keys and still requires a dead row", async () => {
    await expect(lock("either-group")).resolves.toMatchObject({ operation: { idempotencyKey: CHILD_KEY } });
    state.operation = dead({ idempotencyKey: LEGACY_KEY, bookingId: "org-booking" });
    await expect(lock("either-group")).resolves.toMatchObject({ operation: { idempotencyKey: LEGACY_KEY } });
    state.operation = dead({ idempotencyKey: CHARGE_KEY });
    await expect(lock("either-group")).rejects.toMatchObject({ status: 409, message: "not this kind" });
    state.operation = dead({ attempts: 1 });
    await expect(lock("either-group")).rejects.toMatchObject({ status: 409, message: "not given up" });
    state.operation = dead({ status: "SUCCEEDED" });
    await expect(lock("either-group")).rejects.toMatchObject({ status: 409, message: "closed" });
  });
});

describe("paid another way for a per-joiner refund", () => {
  it("records a keyed live refund and does not send another", async () => {
    state.refunds = [liveRefund({ metadata: { organiserChildRefundKey: CHILD_KEY } })];
    const result = await closeGroupCardRefundPaidAnotherWay(closeInput);
    expect(result.outcome).toBe("recorded-stripe");
    expect(state.processRefunds).toBe(0);
    expect(state.refundRecords.map((row) => row.refund?.id)).toEqual(["re_1"]);
    expect(state.enqueues).toHaveLength(1);
    expect(state.tasks).toHaveLength(0);
    expect(state.alerts).toHaveLength(0);
    expect(state.events.map((event) => event.type)).toEqual(["REFUNDED"]);
  });

  it("a bank payment raises the mirror and the no-Xero hand-back, and writes no card refund", async () => {
    const result = await closeGroupCardRefundPaidAnotherWay(closeInput);
    expect(result.outcome).toBe("bank");
    expect(state.processRefunds).toBe(0);
    expect(state.paymentRefundCreates).toBe(0);
    expect(state.enqueues).toHaveLength(0);
    expect(state.paymentUpdates[0]?.data?.refundedAmountCents).toBe(4_500);
    expect(state.tasks[0]?.occurrenceKey).toBe("card-refund-paid-another-way:op-1:no-xero-note");
    expect(state.ledger.flat().some((row) => row.kind === "BANK_REFUND" && row.unitCents === 4_500)).toBe(true);
    expect(state.alerts).toEqual([expect.objectContaining({ bookingId: "child-1", refundCents: 4_500 })]);
    expect(state.claims[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ lastError: PAID_ANOTHER_WAY_MARKER }) }));
  });

  it("an appeal writes no REFUNDED booking event", async () => {
    state.operation = dead({ idempotencyKey: APPEAL_KEY });
    await closeGroupCardRefundPaidAnotherWay(closeInput);
    expect(state.events).toHaveLength(0);
    expect(state.tasks).toHaveLength(1);
  });

  it("refuses a same-amount refund that carries no joiner key", async () => {
    state.refunds = [liveRefund()];
    await expect(closeGroupCardRefundPaidAnotherWay(closeInput)).rejects.toMatchObject({
      status: 409,
      message: GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT,
    });
    expect(state.tasks).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
  });
});

describe("paid another way for an old whole-group refund", () => {
  beforeEach(() => {
    state.operation = dead({ idempotencyKey: LEGACY_KEY, bookingId: "org-booking", paymentId: "pay-org" });
  });

  it("a matching unkeyed refund flips the settlement, mirrors, and enqueues the card note", async () => {
    state.refunds = [liveRefund()];
    const result = await closeGroupCardRefundPaidAnotherWay(closeInput);
    expect(result.outcome).toBe("recorded-stripe");
    expect(state.processRefunds).toBe(0);
    expect(state.settlementUpdates[0]?.data?.status).toBe("PARTIALLY_REFUNDED");
    expect(state.paymentUpdateMany).toHaveLength(1);
    expect(state.enqueues).toHaveLength(1);
    expect(state.alerts).toHaveLength(0);
    expect(state.paymentRefundCreates).toBe(0);
  });

  it("with no such refund, flips and mirrors, sends no card note, and alerts by hand", async () => {
    const result = await closeGroupCardRefundPaidAnotherWay(closeInput);
    expect(result.outcome).toBe("bank");
    expect(state.settlementUpdates).toHaveLength(1);
    expect(state.paymentUpdateMany).toHaveLength(1);
    expect(state.enqueues).toHaveLength(0);
    expect(state.alerts).toEqual([expect.objectContaining({ bookingId: "joiner-a", refundCents: 4_500 })]);
    expect(state.claims[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ lastError: PAID_ANOTHER_WAY_MARKER }) }));
  });

  it("an already-refunded settlement only finishes the mirrors", async () => {
    state.settlement = settlement({ status: "REFUNDED" });
    const result = await closeGroupCardRefundPaidAnotherWay({ ...closeInput, amountCents: 0, expectedOwedCents: 0 });
    expect(result.outcome).toBe("mirrors");
    expect(state.settlementUpdates).toHaveLength(0);
    expect(state.paymentUpdateMany).toHaveLength(1);
    expect(state.alerts).toHaveLength(0);
    expect(state.tasks).toHaveLength(0);
  });

  it("refuses any other live refund", async () => {
    state.refunds = [liveRefund({ amount: 100 })];
    await expect(closeGroupCardRefundPaidAnotherWay(closeInput)).rejects.toBeInstanceOf(DeadCardRefundActionError);
    expect(state.settlementUpdates).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
  });
});

describe("try the card again", () => {
  const again = (expectedOwedCents = 4_500) =>
    tryOrganiserChildCardRefundAgain({ operationId: "op-1", expectedOwedCents, actingMemberId: "officer-1" });

  it("re-arms a row Stripe has not refunded, due now, attempts back to 0", async () => {
    const result = await again();
    expect(result.nextRetryAt).toBe(FROZEN.toISOString());
    expect(state.claims[0]).toEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", attempts: 0, nextRetryAt: FROZEN }) }),
    );
    expect(state.audits[0]?.action).toBe("booking-payment.card-refund.try-card-again");
    expect(state.processRefunds).toBe(0);
  });

  it("does not re-arm when Stripe already has this refund", async () => {
    state.refunds = [liveRefund({ metadata: { organiserChildRefundKey: CHILD_KEY } })];
    await expect(again()).rejects.toMatchObject({ status: 409, message: GROUP_CARD_REFUND_ALREADY_ON_STRIPE });
    expect(state.claims).toHaveLength(0);
  });

  it("a refusal still inside Stripe's replay window is re-armed due then, not now", async () => {
    const created = Math.floor(FROZEN.getTime() / 1000);
    state.refunds = [liveRefund({ status: "failed", created, metadata: { organiserChildRefundKey: CHILD_KEY } })];
    const result = await again();
    const due = organiserChildRearmAt(state.refunds, CHILD_KEY, FROZEN);
    expect(due.getTime()).toBeGreaterThan(FROZEN.getTime());
    expect(result.nextRetryAt).toBe(due.toISOString());
  });

  it("refuses the old whole-group key", async () => {
    state.operation = dead({ idempotencyKey: LEGACY_KEY, bookingId: "org-booking" });
    await expect(again()).rejects.toMatchObject({ status: 409, message: LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL });
    expect(state.claims).toHaveLength(0);
  });
});

describe("the executor reads Stripe before every send", () => {
  const seam = {
    listRefundsForPaymentIntent: async () => state.refunds,
    processRefund: async () => {
      state.processRefunds += 1;
      return { id: "re_sent", amount: 4_500, status: "succeeded", metadata: { organiserChildRefundKey: CHILD_KEY } };
    },
  };

  it("an attempt counted as 1 records a live refund for the key and does not call processRefund", async () => {
    state.operation = dead({ attempts: 1 });
    state.refunds = [liveRefund({ metadata: { organiserChildRefundKey: CHILD_KEY } })];
    await processOrganiserChildRefundOperation(state.operation as unknown as PaymentRecoveryOperation, { currencyCode: "NZD", locale: "en-NZ" }, seam as never);
    expect(state.processRefunds).toBe(0);
    expect(state.refundRecords).toHaveLength(1);
  });

  it("the first attempt, finding no refund for the key, still sends", async () => {
    state.operation = dead({ attempts: 1 });
    state.refunds = [];
    await processOrganiserChildRefundOperation(state.operation as unknown as PaymentRecoveryOperation, { currencyCode: "NZD", locale: "en-NZ" }, seam as never);
    expect(state.processRefunds).toBe(1);
  });
});

describe("one row, one winner", () => {
  it("a bank close that commits leaves the re-arm matching nothing", async () => {
    await closeGroupCardRefundPaidAnotherWay(closeInput);
    await expect(
      tryOrganiserChildCardRefundAgain({ operationId: "op-1", expectedOwedCents: 4_500, actingMemberId: "officer-1" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.claims).toHaveLength(2);
    expect(state.tasks).toHaveLength(1);
  });
});

describe("the list", () => {
  it("lists a per-joiner row and a legacy row, including one with nothing unsent", async () => {
    const child = dead();
    const legacyOpen = dead({ id: "op-legacy", idempotencyKey: LEGACY_KEY, bookingId: "org-booking" });
    const legacyDone = dead({ id: "op-done", idempotencyKey: "group_settlement_refund_recovery_settle-done", bookingId: "org-booking" });
    state.operations = [child, legacyOpen, legacyDone];
    state.settlements = [
      settlement(),
      settlement({ id: "settle-done", status: "REFUNDED" }),
    ];
    const rows = await listDeadCardRefunds();
    const byId = new Map(rows.map((row) => [row.operationId, row]));
    expect(byId.get("op-1")).toMatchObject({
      settleKind: "organiser-child",
      owedCents: 4_500,
      wholeAmountOnly: true,
      xeroRefundNote: "none",
      tryCardAgainRefusal: null,
      laterStripeRefunds: [],
    });
    expect(byId.get("op-legacy")).toMatchObject({
      settleKind: "legacy-group",
      owedCents: 4_500,
      tryCardAgainRefusal: LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL,
    });
    expect(byId.get("op-done")).toMatchObject({ settleKind: "legacy-group", owedCents: 0 });
  });
});

describe("the mirror audit", () => {
  it("does not call a bank close's mirror unbacked", async () => {
    const db = {
      payment: {
        findMany: async () => [
          {
            id: "pay-1",
            refundedAmountCents: 4_500,
            booking: { id: "child-1", status: "CANCELLED", parentBookingId: "org-booking" },
          },
        ],
      },
      groupBooking: {
        findUnique: async () => ({ id: "group-1", settlement: { refundPlan: null, stripePaymentIntentId: "pi_1" } }),
      },
      paymentRefund: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
      memberCredit: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
      manualRefundTask: { aggregate: async () => ({ _sum: { amountCents: 4_500 } }) },
    };
    await expect(findUnbackedOrganiserChildRefundMirrors(db as never)).resolves.toEqual([]);
  });
});
