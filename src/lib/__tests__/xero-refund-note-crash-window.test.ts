/**
 * #3548 (`INV-PAY-111`): the crash window between raising a refund credit note
 * in Xero and completing its operation.
 *
 * Drives the REAL builder with the outbox's own dispatch arguments (a queued
 * row, its watermark) and the REAL retry leg (`retryXeroSyncOperation` on the
 * FAILED row the stale-RUNNING reset leaves), over a stateful ledger and a
 * stateful Xero whose idempotency memory can be FORGOTTEN, as it is days later.
 * The acceptance: exactly one note per refund and exactly one payment per note,
 * the note settled (or its skip recorded), never a SUCCEEDED row with neither,
 * and nothing ever paid twice — not after a lost response, not by two retries
 * at once, not over an officer's own settlement in Xero.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource } from "@prisma/client";

type Row = Record<string, unknown>;
type XeroNote = {
  creditNoteID: string;
  creditNoteNumber: string;
  status: string;
  date: string;
  total: number;
  remainingCredit: number;
  payments: Array<{ paymentID: string; amount: number; status: string }>;
};

const state = vi.hoisted(() => ({
  payment: null as Row | null,
  links: [] as Row[],
  operations: [] as Row[],
  eligibleCents: 5000,
  resolved: { coveredCents: 0, correlationKeys: [] as string[], operationIds: [] as string[], unreadableOperationIds: [] as string[] },
  /** Read the officer's resolved rows off the ledger through the real reader. */
  realResolved: false,
  /** Runs when a payment call fails, before it throws: a concurrent winner. */
  onFailedPayment: null as null | (() => void),
  bankTransferAccount: "090" as string | null,
  crash: null as null | "at-settlement" | "at-completion",
  xero: {
    notes: new Map<string, XeroNote>(),
    noteKeys: new Map<string, string>(),
    paymentKeys: new Map<string, { paymentID: string; amount: number }>(),
    replayPaymentKeys: true,
    createPaymentsCalls: [] as Array<{ key: string; account?: string; amount: number; creditNoteId: string; date: string }>,
    failNextPayment: null as null | "before-commit" | "after-commit",
    readBarrier: null as null | { waiting: Array<() => void>; size: number },
  },
}));

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    const actual = row[key] ?? null;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("in" in expected) return (expected as { in: unknown[] }).in.includes(actual);
      if ("not" in expected) return actual !== (expected as { not: unknown }).not;
      return true;
    }
    return actual === expected;
  });
}

function linkKey(link: Row) {
  return `${link.localId}|${link.role}|${link.xeroObjectId}`;
}

function upsertLink(link: Row) {
  const existing = state.links.find((candidate) => linkKey(candidate) === linkKey(link));
  if (existing) {
    existing.metadata = { ...((existing.metadata as Row) ?? {}), ...((link.metadata as Row) ?? {}) };
  } else {
    state.links.push({ active: true, ...link });
  }
}

const CRASH = new Error("process died");

vi.mock("@/lib/prisma", () => {
  const prisma = {
    payment: {
      findUnique: vi.fn(async () => (state.payment ? { ...state.payment } : null)),
      update: vi.fn(async ({ data }: { data: Row }) => {
        state.payment = { ...state.payment!, ...data };
        return state.payment;
      }),
    },
    manualRefundTask: { findMany: vi.fn(async () => []) },
    xeroObjectLink: {
      findMany: vi.fn(async ({ where }: { where?: Row }) => state.links.filter((link) => matches(link, where))),
      findFirst: vi.fn(async ({ where }: { where?: Row }) => state.links.find((link) => matches(link, where)) ?? null),
    },
    xeroSyncOperation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = state.operations.find((operation) => operation.id === where.id);
        return row ? { ...row } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where?: Row }) => state.operations.find((operation) => matches(operation, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where?: Row }) => state.operations.filter((operation) => matches(operation, where))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.operations.find((operation) => operation.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  let nextId = 0;
  return {
    ...actual,
    startXeroSyncOperation: vi.fn(async (input: Row) => {
      const row = {
        ...input,
        id: `op_started_${++nextId}`,
        status: input.status ?? "RUNNING",
        replayable: true,
        manuallyResolvedAt: null,
        xeroObjectId: null,
        responsePayload: null,
        createdAt: new Date(),
      };
      state.operations.push(row);
      return row;
    }),
    completeXeroSyncOperation: vi.fn(
      async (
        id: string,
        completion: { status?: string; responsePayload?: unknown; xeroObjectId?: string | null; xeroObjectNumber?: string | null; extraLinks?: Row[] },
        options?: { keepSucceeded?: boolean },
      ) => {
        if (state.crash === "at-completion") {
          state.crash = null;
          throw CRASH;
        }
        const row = state.operations.find((operation) => operation.id === id)!;
        if (options?.keepSucceeded && row.status === "SUCCEEDED") return null;
        Object.assign(row, {
          status: completion.status ?? "SUCCEEDED",
          responsePayload: JSON.parse(JSON.stringify(completion.responsePayload ?? null)),
          xeroObjectId: completion.xeroObjectId ?? null,
          xeroObjectNumber: completion.xeroObjectNumber ?? null,
        });
        for (const link of completion.extraLinks ?? []) upsertLink(link);
      },
    ),
    failXeroSyncOperation: vi.fn(async (id: string) => {
      const row = state.operations.find((operation) => operation.id === id);
      if (row) Object.assign(row, { status: "FAILED", responsePayload: { error: "failed" } });
    }),
    upsertXeroObjectLink: vi.fn(async (link: Row) => upsertLink(link)),
    findCanonicalPaymentRefundCreditNote: vi.fn(async () => null),
    sumCoveredRefundCreditNoteCents: vi.fn(async () => coveredCents()),
  };
});

function coveredCents() {
  return state.links
    .filter((link) => link.role === "REFUND_CREDIT_NOTE" && link.active)
    .reduce((sum, link) => sum + Number((link.metadata as Row | undefined)?.amountCents ?? 0), 0);
}

vi.mock("@/lib/xero-resolved-in-xero-fences", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-resolved-in-xero-fences");
  return {
    readResolvedRefundCreditNoteCoverage: vi.fn(async (paymentId: string) =>
      state.realResolved ? actual.readResolvedRefundCreditNoteCoverage(paymentId) : state.resolved,
    ),
    sumRefundCreditNoteCoverageCents: vi.fn(
      async (_paymentId: string, resolved: { coveredCents: number }) => coveredCents() + resolved.coveredCents,
    ),
  };
});

vi.mock("@/lib/refund-note-eligible-cash", () => ({
  resolveRefundNoteEligibleCash: vi.fn(async () => ({
    evidence: { cashRefundCents: state.eligibleCents, source: "provider-ledger" },
    lateCaptureExcludedCents: 0,
    eligibleCashCents: state.eligibleCents,
  })),
}));

vi.mock("@/lib/late-capture-xero-receipt", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-xero-receipt")),
  findLateCapturePaymentIntents: vi.fn(async () => new Set<string>()),
  findKeptLateCaptureInvoiceIdForPayment: vi.fn(async () => null),
}));

async function passReadBarrier() {
  const barrier = state.xero.readBarrier;
  if (!barrier) return;
  await new Promise<void>((resolve) => {
    barrier.waiting.push(resolve);
    if (barrier.waiting.length >= barrier.size) {
      state.xero.readBarrier = null;
      for (const release of barrier.waiting) release();
    }
  });
}

function xeroApi() {
  return {
    createCreditNotes: async (
      _tenant: string,
      body: { creditNotes: Array<{ date: string; lineItems: Array<{ unitAmount: number }> }> },
      _a: unknown,
      _b: unknown,
      key: string,
    ) => {
      let id = state.xero.noteKeys.get(key);
      if (!id) {
        id = `cn_${state.xero.notes.size + 1}`;
        const request = body.creditNotes[0]!;
        const total = request.lineItems[0]!.unitAmount;
        state.xero.notes.set(id, {
          creditNoteID: id,
          creditNoteNumber: `CN-${state.xero.notes.size + 1}`,
          status: "AUTHORISED",
          date: request.date,
          total,
          remainingCredit: total,
          payments: [],
        });
        state.xero.noteKeys.set(key, id);
      }
      const note = state.xero.notes.get(id)!;
      return { body: { creditNotes: [{ creditNoteID: note.creditNoteID, creditNoteNumber: note.creditNoteNumber }] } };
    },
    getCreditNote: async (_tenant: string, id: string) => {
      const snapshot = state.xero.notes.get(id);
      const copy = snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
      await passReadBarrier();
      return { body: { creditNotes: copy ? [copy] : [] } };
    },
    createPayments: async (
      _tenant: string,
      body: { payments: Array<{ creditNote: { creditNoteID: string }; account: { code: string }; amount: number; date: string }> },
      _a: unknown,
      key: string,
    ) => {
      const request = body.payments[0]!;
      state.xero.createPaymentsCalls.push({
        key,
        account: request.account.code,
        amount: request.amount,
        creditNoteId: request.creditNote.creditNoteID,
        date: request.date,
      });
      const mode = state.xero.failNextPayment;
      if (mode === "before-commit") {
        state.xero.failNextPayment = null;
        state.onFailedPayment?.();
        throw new Error("Xero 503");
      }
      const replayed = state.xero.replayPaymentKeys ? state.xero.paymentKeys.get(key) : undefined;
      if (replayed) return { body: { payments: [replayed] } };
      const note = state.xero.notes.get(request.creditNote.creditNoteID)!;
      if (Math.round(request.amount * 100) > Math.round(note.remainingCredit * 100)) {
        throw new Error("Payment amount exceeds the amount outstanding on this document");
      }
      const payment = { paymentID: `pay_${state.xero.createPaymentsCalls.length}`, amount: request.amount };
      note.payments.push({ ...payment, status: "AUTHORISED" });
      note.remainingCredit = Math.round((note.remainingCredit - request.amount) * 100) / 100;
      if (note.remainingCredit <= 0) note.status = "PAID";
      state.xero.paymentKeys.set(key, payment);
      if (mode === "after-commit") {
        state.xero.failNextPayment = null;
        throw new Error("Xero response lost after commit");
      }
      return { body: { payments: [payment] } };
    },
  };
}

vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: xeroApi() }, tenantId: "tenant_1" })),
  callXeroApi: vi.fn((run: () => unknown) => run()),
}));

function crashAtSettlement() {
  // The first attempt dies here: after the note is recorded, before any
  // payment call, since the settlement decision is the first thing it runs.
  if (state.crash === "at-settlement") {
    state.crash = null;
    throw CRASH;
  }
}

vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: vi.fn(async (key: string) => {
    if (key === "bankTransferRefundAccount") {
      crashAtSettlement();
      return { code: state.bankTransferAccount, itemCode: null, codeExplicitlyConfigured: state.bankTransferAccount !== null };
    }
    return { code: "200", itemCode: undefined, codeExplicitlyConfigured: false };
  }),
  getAccountMapping: vi.fn(async () => {
    crashAtSettlement();
    return "606";
  }),
}));

vi.mock("@/lib/xero-contacts", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-contacts")),
  retryXeroWriteWithContactRepair: vi.fn((options: { run: (input: { contactId: string }) => unknown }) =>
    options.run({ contactId: "contact_1" }),
  ),
}));

vi.mock("@/lib/organisation-xero-contacts", () => ({
  findOrCreateXeroContactForInvoicedParty: vi.fn(async () => "contact_1"),
  invoicedPartyContactRepair: () => async () => "contact_1",
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));

import { createXeroCreditNote } from "@/lib/xero-credit-notes";
import {
  REFUND_NOTE_PART_SETTLED_IN_XERO_REASON,
  REFUND_NOTE_RESOLVED_IN_XERO_REASON,
  REFUND_NOTE_SETTLED_IN_XERO_REASON,
  refundCreditNotePaymentIdempotencyKey,
  refundPaymentLinkWhere,
} from "@/lib/xero-refund-note-settlement";
import {
  applyRefundNoteSettlementRepair,
  findUnsettledRefundNoteRows,
} from "@/lib/xero-refund-note-unsettled";
import { REFUND_UNSETTLED_NO_ACCOUNT_REASON } from "@/lib/xero-invoice-payments";
import { retryXeroSyncOperation } from "@/lib/xero-operation-retry";
import { addUnsettledRefundCreditNoteFindings } from "@/lib/xero-booking-repair-findings";
import type { BookingXeroRepairAction, MutableFinding } from "@/lib/xero-booking-repair-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const PAYMENT_ID = "cmpayment0001xyz";
const NOTE_KEY_5000 = "payment:cmpayment0001xyz:refund-credit-note:5000:v2";

function seedPayment(source: PaymentSource = PaymentSource.STRIPE) {
  state.payment = {
    id: PAYMENT_ID,
    bookingId: "cmbooking0001xyz",
    source,
    xeroInvoiceId: "invoice_1",
    xeroRefundCreditNoteId: null,
    refundedAmountCents: 5000,
    booking: {
      id: "cmbooking0001xyz",
      memberId: "member_1",
      organisationId: null,
      checkIn: new Date("2026-08-16T00:00:00.000Z"),
      checkOut: new Date("2026-08-18T00:00:00.000Z"),
      member: { id: "member_1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
      organisation: null,
      guests: [],
    },
  };
}

/** A row exactly as `enqueueXeroRefundCreditNoteOperation` writes it, claimed. */
function queueRefundNote(id: string, refundAmountCents: number, watermarkCents: number, refundMethod = "card") {
  state.operations.push({
    id,
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: PAYMENT_ID,
    status: "RUNNING",
    replayable: true,
    manuallyResolvedAt: null,
    xeroObjectId: null,
    responsePayload: null,
    queueType: "REFUND_CREDIT_NOTE",
    idempotencyKey: `payment:${PAYMENT_ID}:refund-credit-note:${watermarkCents}:v2`,
    correlationKey: `payment:${PAYMENT_ID}:refund-credit-note:${watermarkCents}:v2`,
    createdAt: new Date(),
    requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents, watermarkCents, refundMethod },
  });
}

/** The outbox's own call for a queued row (`xero-operation-outbox.ts`, REFUND_CREDIT_NOTE). */
function dispatch(id: string) {
  const row = state.operations.find((operation) => operation.id === id)!;
  const payload = row.requestPayload as { refundAmountCents: number; watermarkCents: number; refundMethod: "card" | "internet-banking" };
  return createXeroCreditNote(PAYMENT_ID, payload.refundAmountCents, {
    syncOperationId: id,
    watermarkCents: payload.watermarkCents,
    refundMethod: payload.refundMethod,
  });
}

/** Queue and dispatch a refund, and let the process die between the two persists. */
async function firstAttemptDies(crash: "at-settlement" | "at-completion", refundMethod = "card") {
  queueRefundNote("op_crashed", 5000, 5000, refundMethod);
  state.crash = crash;
  await expect(dispatch("op_crashed")).rejects.toBe(CRASH);
  // The builder's catch writes FAILED, the same end state as a real process
  // death followed by the stale-RUNNING reset (which writes FAILED, not PENDING).
  const row = state.operations.find((operation) => operation.id === "op_crashed")!;
  expect(row.status).toBe("FAILED");
  expect(row.xeroObjectId).toBe("cn_1");
  return row;
}

/** Days later: Xero remembers neither the note's key nor the payment's. */
function xeroForgetsKeys() {
  state.xero.noteKeys.clear();
  state.xero.paymentKeys.clear();
}

function retry(id = "op_crashed") {
  return retryXeroSyncOperation(id, CLUB_FORMAT_TEST);
}

function row(id = "op_crashed") {
  return state.operations.find((operation) => operation.id === id)!;
}

function expectNoSucceededRowWithNeither() {
  for (const operation of state.operations) {
    if (operation.status !== "SUCCEEDED") continue;
    const response = operation.responsePayload as Row;
    expect(
      Boolean(response?.refundPayment) || response?.refundPaymentSkipped === true || response?.coveredByExistingNote === true,
      `row ${operation.id} is SUCCEEDED with neither a payment, the skip flag, nor a covering note`,
    ).toBe(true);
  }
}

beforeEach(() => {
  state.links = [];
  state.operations = [];
  state.eligibleCents = 5000;
  state.resolved = { coveredCents: 0, correlationKeys: [], operationIds: [], unreadableOperationIds: [] };
  state.realResolved = false;
  state.onFailedPayment = null;
  state.bankTransferAccount = "090";
  state.crash = null;
  state.xero.notes = new Map();
  state.xero.noteKeys = new Map();
  state.xero.paymentKeys = new Map();
  state.xero.replayPaymentKeys = true;
  state.xero.createPaymentsCalls = [];
  state.xero.failNextPayment = null;
  state.xero.readBarrier = null;
  seedPayment();
});

describe("a refund note interrupted between the two persists (#3548)", () => {
  it("the retry leg settles that note days later: one note, one payment, the row completed on it", async () => {
    await firstAttemptDies("at-settlement");
    xeroForgetsKeys();

    await retry();

    expect(state.xero.notes.size).toBe(1);
    expect(state.xero.createPaymentsCalls).toEqual([
      expect.objectContaining({ key: refundCreditNotePaymentIdempotencyKey(PAYMENT_ID, "cn_1"), account: "606", amount: 50, creditNoteId: "cn_1" }),
    ]);
    expect(row()).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_1" });
    expect(row().responsePayload).toMatchObject({
      allocationSkipped: true,
      refundPayment: { paymentID: "pay_1" },
      refundPaymentError: null,
      refundPaymentSkipped: false,
      refundMethod: "card",
      interruptedAttemptCompleted: true,
    });
    expect(state.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "REFUND_CREDIT_NOTE", xeroObjectId: "cn_1", metadata: expect.objectContaining({ amountCents: 5000, watermarkCents: 5000 }) }),
        expect.objectContaining({ role: "REFUND_PAYMENT", xeroObjectId: "pay_1", metadata: expect.objectContaining({ creditNoteId: "cn_1", amountCents: 5000 }) }),
      ]),
    );
    expectNoSucceededRowWithNeither();
  });

  it("a second refund landing between the crash and the retry gets its own note, and the retry settles the first", async () => {
    await firstAttemptDies("at-settlement");
    // $30 more is refunded; its row runs before anyone retries the $50.
    state.eligibleCents = 8000;
    queueRefundNote("op_second", 3000, 8000);
    await dispatch("op_second");
    xeroForgetsKeys();

    await retry();

    expect([...state.xero.notes.values()].map((note) => note.total).sort()).toEqual([30, 50]);
    for (const note of state.xero.notes.values()) expect(note.payments).toHaveLength(1);
    expect(state.xero.createPaymentsCalls).toHaveLength(2);
    expect(row()).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_1" });
    expect(row().responsePayload).toMatchObject({ interruptedAttemptCompleted: true });
    expect(row("op_second")).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_2" });
    expectNoSucceededRowWithNeither();
  });

  it("a replayed enqueue of the crashed refund, run before the retry, is covered by the recorded note", async () => {
    await firstAttemptDies("at-settlement");
    // A webhook replay enqueues the same $50 again: the FAILED row is not
    // PENDING or RUNNING, so the enqueue's dedupe does not absorb it.
    queueRefundNote("op_replayed", 5000, 5000);
    xeroForgetsKeys();

    await dispatch("op_replayed");
    await retry();

    expect(state.xero.notes.size).toBe(1);
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    expect(row("op_replayed").responsePayload).toMatchObject({ coveredByExistingNote: true });
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
  });

  it("links the first attempt's payment at the amount it paid, not the amount the row asked for", async () => {
    state.eligibleCents = 3000; // $50 asked, only $30 of cash evidence uncovered
    queueRefundNote("op_capped", 5000, 5000);

    await dispatch("op_capped");

    expect(state.xero.createPaymentsCalls).toEqual([expect.objectContaining({ amount: 30 })]);
    expect(state.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "REFUND_PAYMENT", metadata: expect.objectContaining({ amountCents: 3000 }) })]),
    );
  });

  it("dates the healed payment on the note's own day, read back from Xero", async () => {
    await firstAttemptDies("at-settlement");
    state.xero.notes.get("cn_1")!.date = "2026-06-20";

    await retry();

    expect(state.xero.createPaymentsCalls[0]!.date).toBe("2026-06-20");
  });

  it("records the skip, and no payment, when the settlement says none is due", async () => {
    seedPayment(PaymentSource.INTERNET_BANKING);
    state.bankTransferAccount = null;
    await firstAttemptDies("at-settlement", "internet-banking");

    await retry();

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(row().responsePayload).toMatchObject({
      refundPayment: null,
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_UNSETTLED_NO_ACCOUNT_REASON,
    });
  });

  it("never pays twice when the first attempt's payment reached Xero and only its completion was lost", async () => {
    await firstAttemptDies("at-completion");
    expect(state.xero.notes.get("cn_1")!.status).toBe("PAID");
    xeroForgetsKeys();

    await retry();

    expect(state.xero.createPaymentsCalls).toHaveLength(1);
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(row().responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" }, refundPaymentSkipped: false });
    expect(state.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "REFUND_PAYMENT", xeroObjectId: "pay_1", metadata: expect.objectContaining({ amountCents: 5000 }) })]),
    );
  });

  it("a payment committed in Xero whose response was lost ends PARTIAL, and the repair leg records it rather than paying again", async () => {
    queueRefundNote("op_crashed", 5000, 5000);
    state.xero.failNextPayment = "after-commit";
    await dispatch("op_crashed");
    expect(row()).toMatchObject({ status: "PARTIAL", xeroObjectId: "cn_1" });
    xeroForgetsKeys();

    await retry();

    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(row().responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" }, refundPaymentError: null });
  });

  it("a payment that fails on the retry ends PARTIAL under the one note key, and the next repair records it", async () => {
    await firstAttemptDies("at-settlement");
    state.xero.failNextPayment = "before-commit";

    await expect(retry()).rejects.toThrow("Xero 503");
    expect(row()).toMatchObject({ status: "PARTIAL", xeroObjectId: "cn_1" });
    expect(row().responsePayload).toMatchObject({ refundPayment: null, refundPaymentSkipped: false });

    await retry();

    const key = refundCreditNotePaymentIdempotencyKey(PAYMENT_ID, "cn_1");
    expect(key).toBe("payment:cmpayment0001xyz:refund-payment:cn_1:v2");
    expect(state.xero.createPaymentsCalls.map((call) => call.key)).toEqual([key, key]);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
  });

  it("two simultaneous retries of the row leave one payment and a completed row", async () => {
    await firstAttemptDies("at-settlement");
    xeroForgetsKeys();
    state.xero.replayPaymentKeys = false; // Xero dedups neither: only the read-back can
    state.xero.readBarrier = { waiting: [], size: 2 }; // both read the note unpaid

    const results = await Promise.allSettled([retry(), retry()]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(row().responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" } });
  });

  it("never pays a note an officer allocated by hand in Xero", async () => {
    await firstAttemptDies("at-settlement");
    state.xero.notes.get("cn_1")!.remainingCredit = 0;

    await retry();

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row().responsePayload).toMatchObject({
      refundPayment: null,
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_NOTE_SETTLED_IN_XERO_REASON,
    });
  });

  it("records every payment of a note part-paid by hand, at the amount paid, and the remainder, never PARTIAL", async () => {
    await firstAttemptDies("at-settlement");
    const note = state.xero.notes.get("cn_1")!;
    note.payments.push({ paymentID: "pay_hand", amount: 20, status: "AUTHORISED" });
    note.remainingCredit = 30;

    await retry();

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(row().responsePayload).toMatchObject({
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_NOTE_PART_SETTLED_IN_XERO_REASON,
      refundPaymentRemainingCents: 3000,
    });
    expect(state.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "REFUND_PAYMENT", xeroObjectId: "pay_hand", metadata: expect.objectContaining({ amountCents: 2000 }) })]),
    );
    expect(await findUnsettledRefundNoteRows()).toEqual([
      expect.objectContaining({ creditNoteId: "cn_1", kind: "part-settled", remainingCents: 3000 }),
    ]);
  });

  it("still pays when an officer resolved a DIFFERENT refund note on this payment by hand (INV-INT-025 is amount-based)", async () => {
    await firstAttemptDies("at-settlement");
    state.resolved = { coveredCents: 2000, correlationKeys: ["payment:cmpayment0001xyz:refund-credit-note:2000:v2"], operationIds: ["op_other"], unreadableOperationIds: [] };

    await retry();

    expect(state.xero.createPaymentsCalls).toHaveLength(1);
    expect(row().responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" } });
  });

  it("leaves unpaid a note whose own operation an officer resolved by hand in Xero", async () => {
    await firstAttemptDies("at-settlement");
    state.resolved = { coveredCents: 5000, correlationKeys: [NOTE_KEY_5000], operationIds: ["op_sibling"], unreadableOperationIds: [] };

    await retry();

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row().responsePayload).toMatchObject({
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_NOTE_RESOLVED_IN_XERO_REASON,
    });
  });

  it("refuses loudly, and pays nothing, when a resolved note on the payment has no readable amount", async () => {
    await firstAttemptDies("at-settlement");
    state.resolved = { coveredCents: 0, correlationKeys: [], operationIds: [], unreadableOperationIds: ["op_unreadable"] };

    await expect(retry()).rejects.toThrow(/no readable amount/);
    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row().status).toBe("FAILED");
  });

  it("fails visibly, and pays nothing, when the note was voided in Xero", async () => {
    await firstAttemptDies("at-settlement");
    state.xero.notes.get("cn_1")!.status = "VOIDED";

    await expect(retry()).rejects.toThrow(/VOIDED in Xero/);
    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row().status).toBe("FAILED");
  });

  it("a replay the recorded note covers closes as covered by it, and pays nothing", async () => {
    queueRefundNote("op_first", 5000, 5000);
    await dispatch("op_first");
    queueRefundNote("op_replay", 5000, 5000);

    await dispatch("op_replay");

    expect(state.xero.notes.size).toBe(1);
    expect(state.xero.createPaymentsCalls).toHaveLength(1);
    expect(row("op_replay")).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_1" });
    expect(row("op_replay").responsePayload).toEqual({ existingCreditNoteId: "cn_1", coveredByExistingNote: true });
    expectNoSucceededRowWithNeither();
  });

  it("the loser of two retries whose payment call fails never writes PARTIAL over the winner's SUCCEEDED (round 3 R2-6)", async () => {
    await firstAttemptDies("at-settlement");
    state.xero.failNextPayment = "before-commit";
    // While the loser's call is failing, the winner completes the row; its own
    // payment is still in flight, so the loser's re-read sees the note unpaid.
    state.onFailedPayment = () => {
      Object.assign(row(), { status: "SUCCEEDED", responsePayload: { refundPayment: { paymentID: "pay_winner" }, refundPaymentSkipped: false } });
    };

    await expect(retry()).rejects.toThrow("Xero 503");

    expect(row()).toMatchObject({ status: "SUCCEEDED", responsePayload: { refundPayment: { paymentID: "pay_winner" } } });
  });

  it.each([
    ["crashed after the note was recorded", "crash"],
    ["completed PARTIAL", "partial"],
  ])("a note %s and resolved by hand counts once, so a later refund still gets its own note (round 3 R2-2)", async (_label, how) => {
    if (how === "crash") {
      await firstAttemptDies("at-settlement");
    } else {
      queueRefundNote("op_crashed", 5000, 5000);
      state.xero.failNextPayment = "before-commit";
      await dispatch("op_crashed");
      expect(row()).toMatchObject({ status: "PARTIAL", xeroObjectId: "cn_1" });
    }
    row().manuallyResolvedAt = new Date("2026-07-01T00:00:00.000Z");
    state.realResolved = true;
    // A genuine $30 refund on the same payment, later.
    state.eligibleCents = 8000;
    queueRefundNote("op_later", 3000, 8000);

    await dispatch("op_later");

    expect(state.xero.notes.size).toBe(2);
    expect(state.xero.notes.get("cn_2")!.total).toBe(30);
    expect(row("op_later")).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_2" });
  });

  it("the builder never mints over its own row's recorded note (defence; no live path re-dispatches such a row)", async () => {
    await firstAttemptDies("at-settlement");
    // Coverage alone would read the delta as covered and close the row bare;
    // the row's own note is what says it still owes its payment.
    row().status = "RUNNING";
    xeroForgetsKeys();

    await dispatch("op_crashed");

    expect(state.xero.notes.size).toBe(1);
    expect(row()).toMatchObject({ status: "SUCCEEDED" });
    expect(row().responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" }, interruptedAttemptCompleted: true });
  });
});

describe("rows the pre-#3548 early return closed with neither (report and repair tool)", () => {
  function seedHistoricBareRow() {
    state.xero.notes.set("cn_9", {
      creditNoteID: "cn_9",
      creditNoteNumber: "CN-9",
      status: "AUTHORISED",
      date: "2026-05-02",
      total: 50,
      remainingCredit: 50,
      payments: [],
    });
    state.links.push({ localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_9", role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 5000 } });
    state.operations.push({
      id: "op_bare",
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: PAYMENT_ID,
      status: "SUCCEEDED",
      manuallyResolvedAt: null,
      xeroObjectId: "cn_9",
      xeroObjectNumber: "CN-9",
      correlationKey: "payment:cmpayment0001xyz:refund-credit-note:5000:v1",
      idempotencyKey: "payment:cmpayment0001xyz:refund-credit-note:5000:v1",
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      requestPayload: { allocation: { invoiceId: "invoice_1", amount: 50 }, refundMethod: "card" },
      responsePayload: { existingCreditNoteId: "cn_9" },
    });
  }

  it("lists the row, and the operator-applied settle pays it once on the note's day and clears it", async () => {
    seedHistoricBareRow();

    expect(await findUnsettledRefundNoteRows()).toEqual([
      expect.objectContaining({ operationId: "op_bare", creditNoteId: "cn_9", kind: "unsettled" }),
    ]);

    await expect(
      applyRefundNoteSettlementRepair({ operationId: "op_bare", paymentId: PAYMENT_ID, creditNoteId: "cn_9" }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      applyRefundNoteSettlementRepair({ operationId: "op_bare", paymentId: PAYMENT_ID, creditNoteId: "cn_9" }),
    ).resolves.toMatchObject({ status: "skipped" });

    expect(state.xero.createPaymentsCalls).toEqual([expect.objectContaining({ creditNoteId: "cn_9", date: "2026-05-02" })]);
    expect(await findUnsettledRefundNoteRows()).toEqual([]);
  });

  it("the repair tool raises the finding with a settle action that is never auto-applied", () => {
    seedHistoricBareRow();
    const findings: MutableFinding[] = [];
    const actions = new Map<string, BookingXeroRepairAction>();

    addUnsettledRefundCreditNoteFindings(findings, actions, "cmbooking0001xyz", state.links as never, state.operations as never);

    expect(findings).toEqual([
      expect.objectContaining({ code: "REFUND_CREDIT_NOTE_UNSETTLED", safeToAutoApply: false }),
    ]);
    expect([...actions.values()]).toEqual([
      expect.objectContaining({
        type: "SETTLE_REFUND_CREDIT_NOTE",
        safeToAutoApply: false,
        payload: { operationId: "op_bare", paymentId: PAYMENT_ID, creditNoteId: "cn_9" },
      }),
    ]);
  });

  it("does not list a note whose outcome another row recorded, or a skip by design", async () => {
    seedHistoricBareRow();
    state.operations.push({
      ...row("op_bare"),
      id: "op_raised",
      responsePayload: { refundPaymentSkipped: true, refundPaymentSkipReason: "unsettled by design" },
    });

    expect(await findUnsettledRefundNoteRows()).toEqual([]);
  });

  function seedAccountCreditRow() {
    // A cancellation taken as account credit: an unapplied note on the payment,
    // the same entity, operation and model as a refund note, never paid.
    state.xero.notes.set("cn_acct", {
      creditNoteID: "cn_acct",
      creditNoteNumber: "CN-ACCT",
      status: "AUTHORISED",
      date: "2026-05-02",
      total: 50,
      remainingCredit: 50,
      payments: [],
    });
    state.operations.push({
      id: "op_account_credit",
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: PAYMENT_ID,
      status: "SUCCEEDED",
      manuallyResolvedAt: null,
      xeroObjectId: "cn_acct",
      xeroObjectNumber: "CN-ACCT",
      queueType: "ACCOUNT_CREDIT_NOTE",
      correlationKey: "payment:cmpayment0001xyz:unapplied-credit-note:5000:v1",
      idempotencyKey: "payment:cmpayment0001xyz:unapplied-credit-note:5000:v1",
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      requestPayload: { creditNotes: [{ lineItems: [{ unitAmount: 50 }] }] },
      responsePayload: { creditNotes: [{ creditNoteID: "cn_acct" }] },
    });
  }

  it("never lists, flags or settles an account-credit note (round 3 R2-1)", async () => {
    seedAccountCreditRow();
    const findings: MutableFinding[] = [];
    const actions = new Map<string, BookingXeroRepairAction>();

    addUnsettledRefundCreditNoteFindings(findings, actions, "cmbooking0001xyz", state.links as never, state.operations as never);

    expect(await findUnsettledRefundNoteRows()).toEqual([]);
    expect(findings).toEqual([]);
    await expect(
      applyRefundNoteSettlementRepair({ operationId: "op_account_credit", paymentId: PAYMENT_ID, creditNoteId: "cn_acct" }),
    ).resolves.toMatchObject({ status: "failed", message: expect.stringContaining("not a refund credit note") });
    expect(state.xero.createPaymentsCalls).toEqual([]);
  });

  it("the report and the repair tool agree on a note whose payment link a later delta deactivated (round 3 R2-3)", async () => {
    seedHistoricBareRow();
    // The old repair leg completed with only the link recording the payment;
    // a later delta's payment link then deactivated it (single-active per payment).
    state.links.push({ localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "PAYMENT", xeroObjectId: "pay_9", role: "REFUND_PAYMENT", active: false, metadata: { creditNoteId: "cn_9", amountCents: 5000 } });
    const findings: MutableFinding[] = [];

    addUnsettledRefundCreditNoteFindings(findings, new Map(), "cmbooking0001xyz", state.links as never, state.operations as never);

    expect(await findUnsettledRefundNoteRows()).toEqual([]);
    expect(findings).toEqual([]);
    expect(refundPaymentLinkWhere([PAYMENT_ID])).not.toHaveProperty("active");
  });

  function partSettleByHand() {
    const note = state.xero.notes.get("cn_1")!;
    note.payments.push({ paymentID: "pay_hand", amount: 20, status: "AUTHORISED" });
    note.remainingCredit = 30;
  }

  it("a part-settled note clears once the officer settles the remainder in Xero and the action reads it back (round 3 R2-4)", async () => {
    await firstAttemptDies("at-settlement");
    partSettleByHand();
    await retry();
    expect(await findUnsettledRefundNoteRows()).toEqual([expect.objectContaining({ kind: "part-settled" })]);
    const findings: MutableFinding[] = [];
    const actions = new Map<string, BookingXeroRepairAction>();
    addUnsettledRefundCreditNoteFindings(findings, actions, "cmbooking0001xyz", state.links as never, state.operations as never);
    expect([...actions.values()]).toEqual([
      expect.objectContaining({ type: "SETTLE_REFUND_CREDIT_NOTE", safeToAutoApply: false, payload: { operationId: "op_crashed", paymentId: PAYMENT_ID, creditNoteId: "cn_1" } }),
    ]);
    // The officer settles the $30 remainder in Xero by hand.
    const note = state.xero.notes.get("cn_1")!;
    note.payments.push({ paymentID: "pay_hand_2", amount: 30, status: "AUTHORISED" });
    note.remainingCredit = 0;
    note.status = "PAID";

    await expect(
      applyRefundNoteSettlementRepair({ operationId: "op_crashed", paymentId: PAYMENT_ID, creditNoteId: "cn_1" }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(row().responsePayload).not.toHaveProperty("refundPaymentRemainingCents");
    expect(state.links).toEqual(expect.arrayContaining([expect.objectContaining({ role: "REFUND_PAYMENT", xeroObjectId: "pay_hand_2" })]));
    expect(await findUnsettledRefundNoteRows()).toEqual([]);
  });

  it("reading a part-settled note back never pays, even when Xero no longer shows any settlement on it", async () => {
    await firstAttemptDies("at-settlement");
    partSettleByHand();
    await retry();
    const note = state.xero.notes.get("cn_1")!;
    note.payments = [];
    note.remainingCredit = 50;

    await expect(
      applyRefundNoteSettlementRepair({ operationId: "op_crashed", paymentId: PAYMENT_ID, creditNoteId: "cn_1" }),
    ).rejects.toThrow(/shows no settlement in Xero now/);
    expect(state.xero.createPaymentsCalls).toEqual([]);
  });
});
