import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere, type WhereRow } from "./support/prisma-where";

/*
  #3403 (owner decision 26 Oct 2026, "follow the money"; `INV-PAY-140`):
  A SUPERSEDED CARD CHANGE'S WAITING XERO INVOICE MOVES ONTO THE REQUEST THAT
  CARRIES ITS BALANCE.

  The real module runs over an in-memory store whose reads answer through the
  shared Prisma `where` evaluator; only the anchor lock, the receipt check and
  the late-capture release are doubled. The PostgreSQL proofs - the real
  writers, the capture, the reduction and the repair racing it - are
  `superseded-ask-invoice-carry.realdb.test.ts`.

  Frozen clock inherited; nothing here reads a date.
*/

const mocks = vi.hoisted(() => ({
  lockAnchor: vi.fn(),
  anchorCaptureHasReceipt: vi.fn(),
  releaseForCapture: vi.fn(),
  kick: vi.fn(),
  /** Runs just before an operation write, to model a writer landing between read and write. */
  beforeOperationWrite: { value: null as null | (() => void) },
}));

type Row = WhereRow & { id: string };
const store = {
  payments: [] as Row[],
  bookings: [] as Row[],
  transactions: [] as Row[],
  operations: [] as Row[],
  links: [] as Row[],
  recoveryOps: [] as Row[],
};

const where = (rows: Row[], filter: unknown) =>
  rows.filter((row) => matchesWhere(row, filter as Record<string, unknown>, { label: "carry test store" }));

vi.mock("@/lib/prisma", () => {
  const client = {
    payment: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const payment = store.payments.find((row) => row.id === id);
        if (!payment) return null;
        const booking = store.bookings.find((row) => row.id === payment.bookingId)!;
        return { bookingId: payment.bookingId, booking: { status: booking.status, deletedAt: booking.deletedAt } };
      },
    },
    booking: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const booking = store.bookings.find((row) => row.id === id);
        return booking ? { status: booking.status, deletedAt: booking.deletedAt } : null;
      },
    },
    paymentTransaction: {
      // Array order is ledger order (oldest first).
      findMany: async (args: { where: unknown }) => where(store.transactions, args.where).map((row) => ({ ...row })),
      findUnique: async ({ where }: { where: { id?: string; stripePaymentIntentId?: string } }) => {
        const row = store.transactions.find((candidate) =>
          where.id ? candidate.id === where.id : candidate.stripePaymentIntentId === where.stripePaymentIntentId,
        );
        return row ? { status: row.status, paymentId: row.paymentId } : null;
      },
    },
    paymentRecoveryOperation: {
      findMany: async (args: { where: unknown }) => where(store.recoveryOps, args.where).map((row) => ({ ...row })),
    },
    xeroSyncOperation: {
      findMany: async (args: { where: unknown }) => where(store.operations, args.where).map((row) => ({ ...row })),
      findFirst: async (args: { where: unknown }) => where(store.operations, args.where)[0] ?? null,
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        mocks.beforeOperationWrite.value?.();
        const matched = where(store.operations, args.where);
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
      },
    },
    xeroObjectLink: {
      findFirst: async (args: { where: unknown }) => where(store.links, args.where)[0] ?? null,
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  lockSupplementaryInvoiceAnchor: mocks.lockAnchor,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kick,
}));
vi.mock("@/lib/additional-capture-receipt-link", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/additional-capture-receipt-link")),
  anchorCaptureHasReceipt: mocks.anchorCaptureHasReceipt,
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: mocks.releaseForCapture,
}));

import {
  followSupersededAskInvoicesForIntentSafely,
  followSupersededAskInvoicesSafely,
  followSupersededAskInvoicesToCarrier,
  readAskInvoicesForCarry,
  supersededAskCarriers,
} from "@/lib/superseded-ask-invoice-carry";
import { prisma as storeClient } from "@/lib/prisma";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";
import { supplementaryInvoiceWaitedFirstOn } from "@/lib/supplementary-invoice-parked-from";

function ask(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id: `txn_${id}`,
    paymentId: "pay_1",
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "PENDING",
    amountCents: 5000,
    carriedAskCents: 0,
    stripePaymentIntentId: `pi_${id}`,
    withdrawnAt: null,
    bookingModificationId: `mod_${id}`,
    reason: null,
    ...overrides,
  };
}

function waitingInvoice(anchor: string, intent: string, cents: number, overrides: Partial<Row> = {}): Row {
  return {
    id: `op_${anchor}`,
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    queueType: "SUPPLEMENTARY_INVOICE",
    status: "WAITING_PAYMENT",
    localModel: "BookingModification",
    localId: anchor,
    manuallyResolvedAt: null,
    lastErrorCode: null,
    correlationKey: `key_${anchor}_${cents}`,
    requestPayload: {
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "booking_1",
      priceDiffCents: cents,
      changeFeeCents: 0,
      bookingModificationId: anchor,
      recordPayment: true,
      paymentIntentId: intent,
      waitForConfirmedAdditionalPayment: true,
    },
    ...overrides,
  };
}

const payloadOf = (id: string) => store.operations.find((row) => row.id === id)!.requestPayload as Record<string, unknown>;
const statusOf = (id: string) => store.operations.find((row) => row.id === id)!.status;

/** A $50 change A, unpaid and superseded by B, a $30 change carrying A's $50: an $80 request. */
function aSupersededByB(overrides: { a?: Partial<Row>; b?: Partial<Row> } = {}) {
  store.transactions.push(
    ask("a", { status: "FAILED", ...overrides.a }),
    ask("b", { amountCents: 8000, carriedAskCents: 5000, ...overrides.b }),
  );
  store.operations.push(waitingInvoice("mod_a", "pi_a", 5000), waitingInvoice("mod_b", "pi_b", 3000));
}

beforeEach(() => {
  store.payments = [{ id: "pay_1", bookingId: "booking_1" }];
  store.bookings = [{ id: "booking_1", status: "PAID", deletedAt: null }];
  store.transactions = [];
  store.operations = [];
  store.links = [];
  store.recoveryOps = [];
  mocks.beforeOperationWrite.value = null;
  mocks.kick.mockReset();
  mocks.kick.mockResolvedValue(null);
  mocks.lockAnchor.mockReset();
  mocks.anchorCaptureHasReceipt.mockReset();
  mocks.anchorCaptureHasReceipt.mockResolvedValue(false);
  mocks.releaseForCapture.mockReset();
  mocks.releaseForCapture.mockResolvedValue({ released: 2, queueOperationIds: [], outcome: "released" });
});

describe("which request carries which (`supersededAskCarriers`)", () => {
  const row = (id: string, status: string, overrides: Partial<Row> = {}) =>
    ask(id, { status, ...overrides }) as Parameters<typeof supersededAskCarriers>[0][number] & Row;
  const read = (rows: ReturnType<typeof row>[], supersededIntents: string[] = []) =>
    supersededAskCarriers(rows, new Set(supersededIntents)).map((chain) => [
      chain.carrier.id,
      chain.superseded.map((superseded) => superseded.id),
    ]);

  it("the first later row that can carry money carries the FAILED, unwithdrawn rows before it", () => {
    const rows = [row("paid", "SUCCEEDED"), row("a1", "FAILED"), row("a2", "FAILED"), row("b", "PENDING")];
    expect(read(rows)).toEqual([["txn_b", ["txn_a1", "txn_a2"]]]);
  });

  it("a captured carrier still carries", () => {
    expect(read([row("a", "FAILED"), row("b", "SUCCEEDED")])).toEqual([["txn_b", ["txn_a"]]]);
  });

  it.each(["PARTIALLY_REFUNDED", "REFUNDED"])("a %s carrier still carries: its capture happened (review M4)", (status) => {
    expect(read([row("a", "FAILED"), row("b", status)])).toEqual([["txn_b", ["txn_a"]]]);
  });

  it("a capture after the carried ask, then a newer request: the CAPTURE carried it, not the newest (review C4)", () => {
    const rows = [row("a", "FAILED"), row("b", "SUCCEEDED"), row("c", "PENDING")];
    expect(read(rows)).toEqual([["txn_b", ["txn_a"]]]);
  });

  it("two chains on one payment, each to its own carrier", () => {
    const rows = [row("a", "FAILED"), row("b", "SUCCEEDED"), row("c", "FAILED"), row("d", "PENDING")];
    expect(read(rows)).toEqual([
      ["txn_b", ["txn_a"]],
      ["txn_d", ["txn_c"]],
    ]);
  });

  it("a row a superseded-intent operation names, still being cancelled, passes it on and is not carried yet", () => {
    const rows = [row("a", "FAILED"), row("b", "PENDING"), row("c", "PENDING")];
    expect(read(rows, ["pi_b"])).toEqual([["txn_c", ["txn_a"]]]);
  });

  it.each(["SUCCEEDED", "REFUNDED"])(
    "a superseded row captured late (%s) is CARRIED with what moved onto it, never stranded (review 2, F1)",
    (status) => {
      const rows = [row("a", "FAILED"), row("b", status), row("c", "PENDING")];
      expect(read(rows, ["pi_b"])).toEqual([["txn_c", ["txn_a", "txn_b"]]]);
    },
  );

  it.each([
    ["FAILED (declined, or itself superseded)", "FAILED", {}],
    ["withdrawn by a reduction", "PENDING", { withdrawnAt: new Date() }],
  ])("nothing carries when the newest row is %s", (_label, status, overrides) => {
    expect(read([row("a", "FAILED"), row("b", status, overrides)])).toEqual([]);
  });

  it("a withdrawn row is a reduction's to account for: neither carried nor carrying", () => {
    const rows = [row("paid", "SUCCEEDED"), row("withdrawn", "FAILED", { withdrawnAt: new Date() }), row("b", "PENDING")];
    expect(read(rows)).toEqual([]);
  });
});

describe("the move (`followSupersededAskInvoicesToCarrier`)", () => {
  it("moves A's waiting invoice onto B, each for its own amount, recording where it first waited", async () => {
    aSupersededByB();

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toEqual({ carrierPaymentIntentIds: ["pi_b"], moved: 1, refusals: [], releasedOnCapturedCarrier: false });
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a", priceDiffCents: 5000, recordPayment: true });
    expect(statusOf("op_mod_a")).toBe("WAITING_PAYMENT");
    // B's own invoice is untouched: never folded together.
    expect(payloadOf("op_mod_b")).toMatchObject({ paymentIntentId: "pi_b", priceDiffCents: 3000 });
    expect(payloadOf("op_mod_b")).not.toHaveProperty("parkedFromPaymentIntentId");
    // The change's key and the carrier's, sorted (review C2, C3).
    expect(mocks.lockAnchor.mock.calls.map((call) => call[1])).toEqual(["mod_a", "mod_b"]);
    // B is not captured: nothing is released.
    expect(mocks.releaseForCapture).not.toHaveBeenCalled();
    // A reduction attributes it to A's own money.
    expect(supplementaryInvoiceWaitedFirstOn(payloadOf("op_mod_a"))).toBe("pi_a");
  });

  it("is idempotent: a replay finds nothing still waiting on a superseded intent", async () => {
    aSupersededByB();
    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    const before = JSON.stringify(store.operations);

    const again = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(again.moved).toBe(0);
    expect(again.refusals).toEqual([]);
    expect(JSON.stringify(store.operations)).toBe(before);
  });

  it("moves along a chain A -> B -> C, keeping where each invoice first waited", async () => {
    aSupersededByB();
    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    // C supersedes B, carrying B's whole $80 on top of its own $20.
    store.transactions.find((row) => row.id === "txn_b")!.status = "FAILED";
    store.transactions.push(ask("c", { amountCents: 10000, carriedAskCents: 8000 }));
    store.operations.push(waitingInvoice("mod_c", "pi_c", 2000));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(2);
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_c", parkedFromPaymentIntentId: "pi_a" });
    expect(payloadOf("op_mod_b")).toMatchObject({ paymentIntentId: "pi_c", parkedFromPaymentIntentId: "pi_b" });
    expect(payloadOf("op_mod_c")).toMatchObject({ paymentIntentId: "pi_c" });
  });

  it("moves a DECLINED ask's invoice too: carried, though no cancel step ever runs for it", async () => {
    aSupersededByB();
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_b" });
    expect(result.moved).toBe(1);
  });

  it("releases at once when the carrier was already captured", async () => {
    aSupersededByB({ b: { status: "SUCCEEDED" } });

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toMatchObject({ moved: 1, releasedOnCapturedCarrier: true });
    expect(mocks.releaseForCapture).toHaveBeenCalledWith("pi_b");
    // The capture's own receipt did not record it: the invoice still records its payment.
    expect(payloadOf("op_mod_a").recordPayment).toBe(true);
  });

  it("on a captured carrier whose own receipt records the capture, the moved invoice goes out unpaid (one recorder)", async () => {
    aSupersededByB({ b: { status: "SUCCEEDED" } });
    // No receipt of B's still to run (F6), but the change's captures have one.
    mocks.anchorCaptureHasReceipt.mockResolvedValueOnce(false).mockResolvedValue(true);

    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(mocks.anchorCaptureHasReceipt).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { bookingId: "booking_1", bookingModificationId: null, paymentIntentId: "pi_b" },
      { queuedCounts: true },
    );
    expect(mocks.anchorCaptureHasReceipt).toHaveBeenNthCalledWith(2, expect.anything(), {
      bookingId: "booking_1",
      bookingModificationId: "mod_a",
      paymentIntentId: "pi_b",
    });
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_b", recordPayment: false });
  });

  it("#3403 review 2 (F6): a receipt of the carrier's still to run - queued, or failed before deciding - makes the moved invoice unpaid", async () => {
    aSupersededByB({ b: { status: "SUCCEEDED" } });
    mocks.anchorCaptureHasReceipt.mockResolvedValueOnce(true).mockResolvedValue(false);

    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(mocks.anchorCaptureHasReceipt).toHaveBeenCalledTimes(1);
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_b", recordPayment: false });
  });

  it("a carrier captured AFTER the move's own read is still released, read after the move commits", async () => {
    aSupersededByB();
    mocks.beforeOperationWrite.value = () => {
      store.transactions.find((row) => row.id === "txn_b")!.status = "SUCCEEDED";
    };

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.releasedOnCapturedCarrier).toBe(true);
    expect(mocks.releaseForCapture).toHaveBeenCalledWith("pi_b");
  });

  it("a currency re-issue: the change's OWN invoice follows its new intent, within its amount", async () => {
    // The stale intent and its re-issue in the club's currency: same edit, same
    // $50, nothing carried.
    store.transactions.push(ask("stale", { status: "FAILED", bookingModificationId: "mod_x" }), ask("new", { bookingModificationId: "mod_x" }));
    store.operations.push(waitingInvoice("mod_x", "pi_stale", 5000));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_new" });

    expect(result.moved).toBe(1);
    expect(payloadOf("op_mod_x")).toMatchObject({ paymentIntentId: "pi_new", parkedFromPaymentIntentId: "pi_stale" });
  });

  it.each([
    ["ledger stamp before its reason", "mod_b", "mod_other"],
    ["review charge reason without a stamp", null, "mod_b"],
  ] as const)("the carrier locks its own change from its %s", async (_label, bookingModificationId, reasonChangeId) => {
    aSupersededByB({ b: { bookingModificationId, reason: buildEditFinancialReviewChargeReason(reasonChangeId) } });

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(1);
    expect(mocks.lockAnchor.mock.calls.map((call) => call[1])).toEqual(["mod_a", "mod_b"]);
  });

  it("the bank-transfer route is a no-op: no card ask, so not even the outbox is read", async () => {
    store.transactions.push(
      ask("ib1", { source: "INTERNET_BANKING", status: "FAILED", stripePaymentIntentId: null }),
      ask("ib2", { source: "INTERNET_BANKING", stripePaymentIntentId: null }),
    );
    // Each change's invoice was queued unpaid when it was priced.
    store.operations.push(
      waitingInvoice("mod_ib1", "none", 5000, { status: "PENDING" }),
      waitingInvoice("mod_ib2", "none", 3000, { status: "PENDING" }),
    );
    const before = JSON.stringify(store.operations);

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toEqual({ carrierPaymentIntentIds: [], moved: 0, refusals: [], releasedOnCapturedCarrier: false });
    expect(mocks.lockAnchor).not.toHaveBeenCalled();
    expect(JSON.stringify(store.operations)).toBe(before);
  });
});

describe("what it refuses, leaving the row exactly as it was", () => {
  async function refused(reason: string) {
    const before = JSON.stringify(payloadOf("op_mod_a"));
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result.moved).toBe(0);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([reason]);
    expect(JSON.stringify(payloadOf("op_mod_a"))).toBe(before);
    expect(statusOf("op_mod_a")).toBe("WAITING_PAYMENT");
    expect(mocks.releaseForCapture).not.toHaveBeenCalled();
  }

  it.each(["CANCELLED", "BUMPED"])("a %s booking: nothing is asked of it", async (status) => {
    aSupersededByB();
    store.bookings[0]!.status = status;
    await refused("booking-ended");
  });

  it("a booking cancelled while the move waited on the anchor's key: refused under the key", async () => {
    aSupersededByB();
    mocks.lockAnchor.mockImplementation(async () => {
      store.bookings[0]!.status = "CANCELLED";
    });
    await refused("booking-ended");
  });

  it("a newer request minted while the move waited on the key: the carrier changed, nothing moves", async () => {
    aSupersededByB();
    mocks.lockAnchor.mockImplementation(async () => {
      store.transactions.find((row) => row.id === "txn_b")!.status = "FAILED";
      store.transactions.push(ask("c", { amountCents: 10000, carriedAskCents: 8000 }));
    });
    await refused("changed-under-lock");
  });

  it("a deleted booking", async () => {
    aSupersededByB();
    store.bookings[0]!.deletedAt = new Date();
    await refused("booking-ended");
  });

  it("a minter naming an intent that is no longer the newest request", async () => {
    aSupersededByB();
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_older" });
    expect(result.refusals).toEqual([{ anchorId: null, reason: "not-the-carrier" }]);
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });

  it("no live carrier: the newest request was itself declined", async () => {
    aSupersededByB({ b: { status: "FAILED" } });
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result).toEqual({ carrierPaymentIntentIds: [], moved: 0, refusals: [], releasedOnCapturedCarrier: false });
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });

  it("a reduction already withdrew A and retired its invoice: nothing to move", async () => {
    aSupersededByB({ a: { withdrawnAt: new Date() } });
    store.operations[0]!.status = "CANCELLED";
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result.moved).toBe(0);
    expect(mocks.lockAnchor).not.toHaveBeenCalled();
  });

  it("A's change already has a supplementary invoice in Xero", async () => {
    aSupersededByB();
    store.links.push({
      id: "link_1",
      localModel: "BookingModification",
      localId: "mod_a",
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
      xeroObjectId: "inv_mod_a",
    });
    await refused("invoice-already-linked");
  });

  it("another invoice for A's change is queued (the repair raised one)", async () => {
    aSupersededByB();
    store.operations.push({ ...waitingInvoice("mod_a", "none", 5000, { status: "PENDING" }), id: "op_repair" });
    await refused("another-invoice-queued");
  });

  it("B would bill more than it asks for", async () => {
    aSupersededByB({ b: { amountCents: 7000, carriedAskCents: 5000 } });
    await refused("carrier-would-overbill");
  });

  it("A's invoice is more than B carried, even where B's amount would hold it", async () => {
    aSupersededByB({ b: { amountCents: 9000, carriedAskCents: 4000 } });
    await refused("carrier-would-overbill");
  });

  it("nothing carried at all: an invoice on another change cannot move", async () => {
    aSupersededByB({ b: { amountCents: 9000, carriedAskCents: 0 } });
    await refused("carrier-would-overbill");
  });

  it("an unreadable invoice", async () => {
    aSupersededByB();
    (payloadOf("op_mod_a") as Record<string, unknown>).priceDiffCents = "fifty";
    await refused("unreadable-invoice");
  });

  it("an invoice an officer marked resolved, or one carrying an error code, is not a candidate", async () => {
    aSupersededByB();
    store.operations[0]!.lastErrorCode = "PROVIDER_CAPTURED_UNRECORDED";
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result.moved).toBe(0);
    store.operations[0]!.lastErrorCode = null;
    store.operations[0]!.manuallyResolvedAt = new Date();
    expect((await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" })).moved).toBe(0);
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });

  it("THE STATUS GUARD: a row a capture released or the reaper retired between read and write is not rewritten", async () => {
    aSupersededByB();
    mocks.beforeOperationWrite.value = () => {
      store.operations.find((row) => row.id === "op_mod_a")!.status = "CANCELLED";
    };
    const before = JSON.stringify(payloadOf("op_mod_a"));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(0);
    expect(result.refusals).toEqual([{ anchorId: "mod_a", reason: "changed-under-lock" }]);
    expect(JSON.stringify(payloadOf("op_mod_a"))).toBe(before);
  });
});

describe("review round (db90565cb)", () => {
  it("C1: a restate raising the invoice between the move's read and its write is never written back over", async () => {
    aSupersededByB({ b: { amountCents: 9000, carriedAskCents: 6000 } });
    mocks.beforeOperationWrite.value = () => {
      const row = store.operations.find((candidate) => candidate.id === "op_mod_a")!;
      row.requestPayload = { ...(row.requestPayload as Record<string, unknown>), priceDiffCents: 6000 };
      row.correlationKey = "key_mod_a_6000";
    };

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(0);
    expect(result.refusals).toEqual([{ anchorId: "mod_a", reason: "changed-under-lock" }]);
    // The raise stands, on A, for the next move (or the reaper's) to decide afresh.
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_a", priceDiffCents: 6000 });
  });

  it("M3: a carrier naming no change (a credit-release ask) is held to what it CARRIED, summed over every change", async () => {
    // B carried $60 of A1 and A2; A1's $50 already moved onto it, so A2's $30 would make $80.
    store.transactions.push(
      ask("a1", { status: "FAILED" }),
      ask("a2", { status: "FAILED", bookingModificationId: "mod_a2" }),
      ask("b", { amountCents: 9000, carriedAskCents: 6000, bookingModificationId: null, reason: "credit_release" }),
    );
    store.operations.push(
      waitingInvoice("mod_a1", "pi_b", 5000, { requestPayload: { ...waitingInvoice("mod_a1", "pi_b", 5000).requestPayload as object, parkedFromPaymentIntentId: "pi_a1" } }),
      waitingInvoice("mod_a2", "pi_a2", 3000),
    );

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.refusals).toEqual([{ anchorId: "mod_a2", reason: "carrier-would-overbill" }]);
    expect(payloadOf("op_mod_a2").paymentIntentId).toBe("pi_a2");
  });

  it("C2: a carrier naming no change is keyed on the booking, taken BEFORE the change's key", async () => {
    // A booking id sorting AFTER the change's, so only the booking-first rule orders it first.
    store.payments = [{ id: "pay_1", bookingId: "zz_booking" }];
    store.bookings = [{ id: "zz_booking", status: "PAID", deletedAt: null }];
    aSupersededByB({ b: { bookingModificationId: null, reason: "credit_release" } });
    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(mocks.lockAnchor.mock.calls.map((call) => call[1])).toEqual(["zz_booking", "mod_a"]);
  });

  it("C4: the capture that absorbed A carries it, though a newer request exists - A's invoice is released on that capture", async () => {
    store.transactions.push(
      ask("a", { status: "FAILED" }),
      ask("b", { status: "SUCCEEDED", amountCents: 8000, carriedAskCents: 5000 }),
      ask("c", { bookingModificationId: "mod_c" }),
    );
    store.operations.push(waitingInvoice("mod_a", "pi_a", 5000));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toMatchObject({ carrierPaymentIntentIds: ["pi_b"], moved: 1, releasedOnCapturedCarrier: true });
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_b");
    expect(mocks.releaseForCapture).toHaveBeenCalledWith("pi_b");
  });

  it("nit: a release on a captured carrier kicks the outbox for what it released", async () => {
    aSupersededByB({ b: { status: "SUCCEEDED" } });
    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(mocks.kick).toHaveBeenCalledWith({ limit: 2 });
  });

  it("M5: an edit's Xero leg on an already-FAILED ask follows its carrier; on a live ask it does nothing", async () => {
    aSupersededByB();
    await followSupersededAskInvoicesForIntentSafely("pi_b");
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");

    await followSupersededAskInvoicesForIntentSafely("pi_a");
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a" });
  });
});

describe("the callers' spelling (`followSupersededAskInvoicesSafely`)", () => {
  it("never throws: a failure is logged and answers null", async () => {
    aSupersededByB();
    mocks.lockAnchor.mockRejectedValue(new Error("connection reset"));
    await expect(followSupersededAskInvoicesSafely({ paymentId: "pay_1" })).resolves.toBeNull();
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });
});

describe("#4491: what the move would take, read before a minter supersedes (`readAskInvoicesForCarry`)", () => {
  const read = (intents: string[]) => readAskInvoicesForCarry(storeClient as never, intents);

  it("a waiting invoice on a change with nothing else going out is carriable, with where its money was first asked", async () => {
    store.operations.push(waitingInvoice("mod_e", "pi_e", 3000));
    expect(await read(["pi_e"])).toEqual([{ anchorId: "mod_e", firstWaitedOn: "pi_e", carriable: true, refusal: null }]);
  });

  it("nothing is read for no intents, and an invoice naming another request is not returned", async () => {
    store.operations.push(waitingInvoice("mod_x", "pi_x", 3000));
    expect(await read([])).toEqual([]);
    expect(await read(["pi_e"])).toEqual([]);
  });

  it.each([
    ["already released to go out", { status: "PENDING" }],
    ["sent", { status: "SUCCEEDED" }],
    ["carrying an error code", { lastErrorCode: "SOMETHING" }],
    ["resolved by hand", { manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z") }],
  ])("an invoice naming the request that is %s is not carriable", async (_label, overrides) => {
    store.operations.push(waitingInvoice("mod_e", "pi_e", 3000, overrides));
    expect(await read(["pi_e"])).toEqual([{ anchorId: "mod_e", firstWaitedOn: "pi_e", carriable: false, refusal: expect.any(String) }]);
  });

  it("a cancelled invoice is not returned at all", async () => {
    store.operations.push(waitingInvoice("mod_e", "pi_e", 3000, { status: "CANCELLED" }));
    expect(await read(["pi_e"])).toEqual([]);
  });

  it("a change with an active invoice link, or another invoice going out, is not carriable", async () => {
    store.operations.push(waitingInvoice("mod_e", "pi_e", 3000));
    store.links.push({ id: "link_e", xeroObjectId: "inv_xero_e", localModel: "BookingModification", localId: "mod_e", xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true, createdAt: new Date(0) });
    expect((await read(["pi_e"]))[0]!.carriable).toBe(false);
    store.links = [];
    store.operations.push(waitingInvoice("mod_e", "pi_other", 3000, { id: "op_mod_e_repair", status: "PENDING" }));
    expect((await read(["pi_e"]))[0]!.carriable).toBe(false);
  });

  it("an invoice whose billed figure cannot be read is not carriable", async () => {
    store.operations.push(waitingInvoice("mod_e", "pi_e", 3000, { requestPayload: { paymentIntentId: "pi_e" } }));
    expect((await read(["pi_e"]))[0]!.carriable).toBe(false);
  });

  /*
    INV-SSOT: the pre-check and the move ask ONE test (`anchorInvoicesMoveRefusal`), so they cannot
    disagree. Each fixture runs through both: the minter's read of A's invoice, and the real move
    of it onto B after B supersedes A.
  */
  it.each([
    ["nothing in the way", () => {}, null],
    ["an active invoice link on the change", () => {
      store.links.push({ id: "link_a", xeroObjectId: "inv_xero_a", localModel: "BookingModification", localId: "mod_a", xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true, createdAt: new Date(0) });
    }, "invoice-already-linked"],
    ["another invoice of the change going out", () => {
      store.operations.push(waitingInvoice("mod_a", "pi_other", 5000, { id: "op_mod_a_repair", status: "PENDING" }));
    }, "another-invoice-queued"],
    ["an unreadable billed figure", () => {
      const row = store.operations.find((operation) => operation.id === "op_mod_a")!;
      row.requestPayload = { paymentIntentId: "pi_a" };
    }, "unreadable-invoice"],
    ["not waiting (already released)", () => {
      store.operations.find((operation) => operation.id === "op_mod_a")!.status = "PENDING";
    }, "not-waiting"],
  ] as const)("the pre-check and the move agree: %s", async (_label, arrange, refusal) => {
    aSupersededByB();
    arrange();
    const [readA] = (await read(["pi_a"])).filter((invoice) => invoice.anchorId === "mod_a" && invoice.firstWaitedOn === "pi_a");
    expect(readA).toMatchObject({ carriable: refusal === null, refusal });
    const moved = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_b" });
    const movedA = moved.refusals.find((entry) => entry.anchorId === "mod_a")?.reason ?? null;
    if (refusal === null) {
      expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_b");
      expect(movedA).toBeNull();
    } else {
      expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
      // A row that is not waiting is never read by the move, so it refuses nothing by name.
      expect(movedA).toBe(refusal === "not-waiting" ? null : refusal);
    }
  });

  it("a moved invoice reports the request it was first asked on", async () => {
    store.operations.push(
      waitingInvoice("mod_e", "pi_r", 3000, {
        requestPayload: { ...(waitingInvoice("mod_e", "pi_r", 3000).requestPayload as object), parkedFromPaymentIntentId: "pi_e" },
      }),
    );
    expect(await read(["pi_r"])).toEqual([{ anchorId: "mod_e", firstWaitedOn: "pi_e", carriable: true, refusal: null }]);
  });
});
