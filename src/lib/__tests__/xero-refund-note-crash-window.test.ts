/**
 * #3548: the crash window between saving `Payment.xeroRefundCreditNoteId` and
 * completing the refund credit note's operation.
 *
 * Drives the REAL `createXeroCreditNote` — with the outbox's dispatch
 * arguments and the retry leg's — over a stateful ledger and a stateful Xero
 * that honours idempotency keys, so a run can be stopped between the two
 * persists and re-run against exactly what it left behind. The acceptance: a
 * retry ends with the note AND its settling payment, or the skip flag, never
 * a SUCCEEDED row carrying neither; a payment that fails on the retry ends
 * PARTIAL and is repaired by the repair leg; and nothing ever records a second
 * payment against a note Xero already shows settled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource } from "@prisma/client";

type Row = Record<string, unknown>;
type XeroNote = {
  creditNoteID: string;
  creditNoteNumber: string;
  status: string;
  total: number;
  remainingCredit: number;
  payments: Array<{ paymentID: string; amount: number; status: string }>;
};

const state = vi.hoisted(() => ({
  payment: null as Row | null,
  links: [] as Row[],
  operations: [] as Row[],
  resolved: { coveredCents: 0, correlationKeys: [] as string[], operationIds: [] as string[], unreadableOperationIds: [] as string[] },
  bankTransferAccount: "090" as string | null,
  xero: {
    notes: new Map<string, XeroNote>(),
    noteKeys: new Map<string, string>(),
    paymentKeys: new Map<string, { paymentID: string; amount: number }>(),
    createPaymentsCalls: [] as Array<{ key: string; account?: string; amount: number; creditNoteId: string }>,
    failNextPayment: false,
  },
  crash: null as string | null,
}));

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("in" in expected) return (expected as { in: unknown[] }).in.includes(actual);
      if ("not" in expected) return actual !== (expected as { not: unknown }).not;
      return true;
    }
    return actual === expected;
  });
}

const CRASH = new Error("process died");

vi.mock("@/lib/prisma", () => ({
  prisma: {
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
      findMany: vi.fn(async ({ where }: { where?: Row }) => state.operations.filter((operation) => matches(operation, where))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.operations.find((operation) => operation.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  },
}));

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
        id: `op_${++nextId}`,
        status: input.status ?? "RUNNING",
        replayable: true,
        manuallyResolvedAt: null,
        xeroObjectId: null,
        responsePayload: null,
      };
      state.operations.push(row);
      return row;
    }),
    completeXeroSyncOperation: vi.fn(
      async (id: string, completion: { status?: string; responsePayload?: unknown; xeroObjectId?: string | null; xeroObjectNumber?: string | null; extraLinks?: Row[] }) => {
        if (state.crash === "before-complete") {
          state.crash = null;
          throw CRASH;
        }
        const row = state.operations.find((operation) => operation.id === id)!;
        Object.assign(row, {
          status: completion.status ?? "SUCCEEDED",
          responsePayload: JSON.parse(JSON.stringify(completion.responsePayload ?? null)),
          xeroObjectId: completion.xeroObjectId ?? null,
          xeroObjectNumber: completion.xeroObjectNumber ?? null,
        });
        for (const link of completion.extraLinks ?? []) {
          const existing = state.links.find(
            (candidate) =>
              candidate.xeroObjectId === link.xeroObjectId && candidate.role === link.role && candidate.localId === link.localId,
          );
          if (existing) {
            existing.metadata = { ...((existing.metadata as Row) ?? {}), ...((link.metadata as Row) ?? {}) };
          } else {
            state.links.push({ active: true, ...link });
          }
        }
      },
    ),
    failXeroSyncOperation: vi.fn(async (id: string) => {
      const row = state.operations.find((operation) => operation.id === id);
      if (row) row.status = "FAILED";
    }),
    upsertXeroObjectLink: vi.fn(async (link: Row) => {
      if (!state.links.some((candidate) => candidate.xeroObjectId === link.xeroObjectId && candidate.role === link.role)) {
        state.links.push({ active: true, ...link });
      }
    }),
    findCanonicalPaymentRefundCreditNote: vi.fn(async () => null),
    sumCoveredRefundCreditNoteCents: vi.fn(async () =>
      state.links
        .filter((link) => link.role === "REFUND_CREDIT_NOTE" && link.active)
        .reduce((sum, link) => sum + Number((link.metadata as Row | undefined)?.amountCents ?? 0), 0),
    ),
  };
});

vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  readResolvedRefundCreditNoteCoverage: vi.fn(async () => state.resolved),
  sumRefundCreditNoteCoverageCents: vi.fn(
    async (_paymentId: string, resolved: { coveredCents: number }) =>
      state.links
        .filter((link) => link.role === "REFUND_CREDIT_NOTE" && link.active)
        .reduce((sum, link) => sum + Number((link.metadata as Row | undefined)?.amountCents ?? 0), 0) +
      resolved.coveredCents,
  ),
}));

vi.mock("@/lib/refund-note-eligible-cash", () => ({
  resolveRefundNoteEligibleCash: vi.fn(async () => ({
    evidence: { cashRefundCents: 5000, source: "provider-ledger" },
    lateCaptureExcludedCents: 0,
    eligibleCashCents: 5000,
  })),
}));

vi.mock("@/lib/late-capture-xero-receipt", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-xero-receipt")),
  findLateCapturePaymentIntents: vi.fn(async () => new Set<string>()),
  findKeptLateCaptureInvoiceIdForPayment: vi.fn(async () => null),
}));

function xeroApi() {
  return {
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _a: unknown, _b: unknown, key: string) => {
      let id = state.xero.noteKeys.get(key);
      if (!id) {
        id = `cn_${state.xero.notes.size + 1}`;
        const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
        state.xero.notes.set(id, {
          creditNoteID: id,
          creditNoteNumber: `CN-${state.xero.notes.size + 1}`,
          status: "AUTHORISED",
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
      const note = state.xero.notes.get(id);
      return { body: { creditNotes: note ? [JSON.parse(JSON.stringify(note))] : [] } };
    },
    createPayments: async (
      _tenant: string,
      body: { payments: Array<{ creditNote: { creditNoteID: string }; account: { code: string }; amount: number }> },
      _a: unknown,
      key: string,
    ) => {
      const request = body.payments[0]!;
      state.xero.createPaymentsCalls.push({
        key,
        account: request.account.code,
        amount: request.amount,
        creditNoteId: request.creditNote.creditNoteID,
      });
      if (state.crash === "before-payment") {
        state.crash = null;
        throw CRASH;
      }
      if (state.xero.failNextPayment) {
        state.xero.failNextPayment = false;
        throw new Error("Xero 503");
      }
      const replayed = state.xero.paymentKeys.get(key);
      if (replayed) return { body: { payments: [replayed] } };
      const note = state.xero.notes.get(request.creditNote.creditNoteID)!;
      if (request.amount > note.remainingCredit) {
        throw new Error("Payment amount exceeds the amount outstanding on this document");
      }
      const payment = { paymentID: `pay_${state.xero.paymentKeys.size + 1}`, amount: request.amount };
      note.payments.push({ ...payment, status: "AUTHORISED" });
      note.remainingCredit -= request.amount;
      if (note.remainingCredit <= 0) note.status = "PAID";
      state.xero.paymentKeys.set(key, payment);
      return { body: { payments: [payment] } };
    },
  };
}

vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: xeroApi() }, tenantId: "tenant_1" })),
  callXeroApi: vi.fn((run: () => unknown) => run()),
}));

vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: vi.fn(async (key: string) =>
    key === "bankTransferRefundAccount"
      ? { code: state.bankTransferAccount, itemCode: null, codeExplicitlyConfigured: state.bankTransferAccount !== null }
      : { code: "200", itemCode: undefined, codeExplicitlyConfigured: false },
  ),
  getAccountMapping: vi.fn(async () => {
    // The first attempt dies here, after the note id is saved and before any
    // payment call: the settlement leg is the first thing it runs.
    if (state.crash === "before-payment-decision") {
      state.crash = null;
      throw CRASH;
    }
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
  REFUND_NOTE_RESOLVED_IN_XERO_REASON,
  REFUND_NOTE_SETTLED_IN_XERO_REASON,
} from "@/lib/xero-refund-note-settlement";
import { REFUND_UNSETTLED_NO_ACCOUNT_REASON } from "@/lib/xero-invoice-payments";
import { getXeroOperationRetryMeta, retryXeroSyncOperation } from "@/lib/xero-operation-retry";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const PAYMENT_ID = "cmpayment0001xyz";

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

/** The operation the outbox claimed for this refund. */
function queueOperation(): string {
  state.operations.push({
    id: "op_queued",
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
    requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5000 },
  });
  return "op_queued";
}

/** Run the first attempt and let it die between the two persists. */
async function firstAttemptDies(
  crash: "before-payment-decision" | "before-payment" | "before-complete",
  options: { refundMethod?: "card" | "internet-banking"; watermarkCents?: number } = { refundMethod: "card" },
) {
  const syncOperationId = queueOperation();
  state.crash = crash;
  await expect(createXeroCreditNote(PAYMENT_ID, 5000, { syncOperationId, ...options })).rejects.toBe(CRASH);
  // What the crash left: the note is in Xero and its id is saved; the row is
  // FAILED (as the stale-RUNNING reset leaves it) with no outcome recorded.
  expect(state.payment!.xeroRefundCreditNoteId).toBe("cn_1");
  expect(state.operations.find((operation) => operation.id === syncOperationId)!.status).toBe("FAILED");
}

function completedRows() {
  return state.operations.filter((operation) => operation.status === "SUCCEEDED" || operation.status === "PARTIAL");
}

/** The retry must never leave the shape #3548 found: SUCCEEDED with neither. */
function expectNoSucceededRowWithNeither() {
  for (const row of completedRows()) {
    if (row.status !== "SUCCEEDED") continue;
    const response = row.responsePayload as Row;
    expect(
      Boolean(response?.refundPayment) || response?.refundPaymentSkipped === true,
      `row ${row.id} is SUCCEEDED with neither a payment nor the skip flag`,
    ).toBe(true);
  }
}

beforeEach(() => {
  state.links = [];
  state.operations = [];
  state.resolved = { coveredCents: 0, correlationKeys: [], operationIds: [], unreadableOperationIds: [] };
  state.bankTransferAccount = "090";
  state.xero.notes = new Map();
  state.xero.noteKeys = new Map();
  state.xero.paymentKeys = new Map();
  state.xero.createPaymentsCalls = [];
  state.xero.failNextPayment = false;
  state.crash = null;
  seedPayment();
});

describe("a retry after a crash between saving the note id and completing (#3548)", () => {
  it("the retry leg's call records the settling payment and completes with the first attempt's payload", async () => {
    await firstAttemptDies("before-payment-decision");

    // The retry leg calls the builder without the row's id (xero-operation-retry).
    await expect(createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true })).resolves.toBe("cn_1");

    expect(state.xero.notes.size).toBe(1);
    expect(state.xero.createPaymentsCalls).toEqual([
      { key: "payment:cmpayment0001xyz:refund-payment:cn_1:v2", account: "606", amount: 50, creditNoteId: "cn_1" },
    ]);
    const [completed] = completedRows();
    expect(completed).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_1" });
    expect(completed!.responsePayload).toMatchObject({
      allocationSkipped: true,
      refundPayment: { paymentID: "pay_1" },
      refundPaymentError: null,
      refundPaymentSkipped: false,
      refundMethod: "card",
      interruptedAttemptCompleted: true,
    });
    // The row the repair leg reads carries the note's amount and invoice.
    expect(completed!.requestPayload).toMatchObject({ allocation: { invoiceId: "invoice_1", amount: 50 } });
    expect(state.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "REFUND_CREDIT_NOTE", xeroObjectId: "cn_1", metadata: expect.objectContaining({ amountCents: 5000 }) }),
        expect.objectContaining({ role: "REFUND_PAYMENT", xeroObjectId: "pay_1", metadata: expect.objectContaining({ creditNoteId: "cn_1" }) }),
      ]),
    );
    expectNoSucceededRowWithNeither();
  });

  it("the outbox re-dispatching the same row completes that row, not a new one", async () => {
    await firstAttemptDies("before-payment-decision");
    const row = state.operations.find((operation) => operation.id === "op_queued")!;
    row.status = "RUNNING";

    await createXeroCreditNote(PAYMENT_ID, 5000, { syncOperationId: "op_queued", refundMethod: "card" });

    expect(state.operations).toHaveLength(1);
    expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_1" });
    expect(row.responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" } });
    expectNoSucceededRowWithNeither();
  });

  it("sets the skip flag, and records no payment, when the settlement says none is due", async () => {
    seedPayment(PaymentSource.INTERNET_BANKING);
    state.bankTransferAccount = null;
    // A bank transfer's settlement reads no card mapping, so it dies at the
    // payment step's decision the same way: before any payment call.
    await firstAttemptDies("before-complete", { refundMethod: "internet-banking" });

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "internet-banking", repairExistingLink: true });

    expect(state.xero.createPaymentsCalls).toEqual([]);
    const [completed] = completedRows();
    expect(completed).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "cn_1" });
    expect(completed!.responsePayload).toMatchObject({
      refundPayment: null,
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_UNSETTLED_NO_ACCOUNT_REASON,
    });
    expectNoSucceededRowWithNeither();
  });

  it("never records a second payment when the first attempt's payment reached Xero but its link was never written", async () => {
    await firstAttemptDies("before-complete");
    expect(state.xero.notes.get("cn_1")!.status).toBe("PAID");
    // Days later: Xero no longer remembers the idempotency key.
    state.xero.paymentKeys.clear();

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true });

    expect(state.xero.createPaymentsCalls).toHaveLength(1); // the first attempt's only
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    const [completed] = completedRows();
    expect(completed).toMatchObject({ status: "SUCCEEDED" });
    expect(completed!.responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" }, refundPaymentSkipped: false });
    expect(state.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "REFUND_PAYMENT", xeroObjectId: "pay_1" })]),
    );
  });

  it("never pays a note an officer allocated by hand in Xero", async () => {
    await firstAttemptDies("before-payment-decision");
    const note = state.xero.notes.get("cn_1")!;
    note.remainingCredit = 0; // allocated against an invoice, no payment

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true });

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(completedRows()[0]!.responsePayload).toMatchObject({
      refundPayment: null,
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_NOTE_SETTLED_IN_XERO_REASON,
    });
  });

  it("never pays when an officer resolved a refund note on this payment by hand in Xero (INV-INT-025)", async () => {
    await firstAttemptDies("before-payment-decision");
    state.resolved = { coveredCents: 5000, correlationKeys: [], operationIds: ["op_resolved"], unreadableOperationIds: [] };

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true });

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(completedRows()[0]!.responsePayload).toMatchObject({
      refundPaymentSkipped: true,
      refundPaymentSkipReason: REFUND_NOTE_RESOLVED_IN_XERO_REASON,
    });
  });

  it("fails visibly, and pays nothing, when the saved note was voided in Xero", async () => {
    await firstAttemptDies("before-payment-decision");
    state.xero.notes.get("cn_1")!.status = "VOIDED";

    await expect(
      createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true }),
    ).rejects.toThrow(/VOIDED in Xero/);

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(completedRows()).toEqual([]);
  });

  it("a payment that fails on the retry ends PARTIAL, and the repair leg then records it", async () => {
    await firstAttemptDies("before-payment-decision");
    state.xero.failNextPayment = true;

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true });

    const partial = completedRows()[0]!;
    expect(partial).toMatchObject({ status: "PARTIAL", xeroObjectId: "cn_1" });
    expect(partial.responsePayload).toMatchObject({ refundPayment: null, refundPaymentSkipped: false });
    expect(getXeroOperationRetryMeta(partial as never)).toEqual({ supported: true, reason: null });

    await retryXeroSyncOperation(String(partial.id), CLUB_FORMAT_TEST);

    expect(partial.status).toBe("SUCCEEDED");
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    expect(state.xero.notes.get("cn_1")!.status).toBe("PAID");
  });

  it("an ordinary replay of a note whose outcome is on record stays a plain early return", async () => {
    // A bank-transfer note left unsettled BY DESIGN (`INV-PAY-101`) ...
    seedPayment(PaymentSource.INTERNET_BANKING);
    state.bankTransferAccount = null;
    queueOperation();
    await createXeroCreditNote(PAYMENT_ID, 5000, { syncOperationId: "op_queued", refundMethod: "internet-banking" });
    expect(state.operations[0]!.responsePayload).toMatchObject({ refundPaymentSkipped: true });
    // ... is never re-settled, even once an account is configured.
    state.bankTransferAccount = "090";

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "internet-banking", repairExistingLink: true });

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(state.operations).toHaveLength(1);
  });

  it("a note a REFUND_PAYMENT link already names is never paid again, whatever Xero now shows", async () => {
    await firstAttemptDies("before-payment-decision");
    // Inbound reconcile linked a payment, which an officer later deleted in Xero.
    state.links.push({
      localModel: "Payment",
      localId: PAYMENT_ID,
      xeroObjectType: "PAYMENT",
      xeroObjectId: "pay_by_hand",
      role: "REFUND_PAYMENT",
      active: true,
      metadata: { creditNoteId: "cn_1" },
    });

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", repairExistingLink: true });

    expect(state.xero.createPaymentsCalls).toEqual([]);
    expect(completedRows()).toEqual([]);
  });

  it("in per-delta mode the retry replays the same note by its key and settles it", async () => {
    await firstAttemptDies("before-payment-decision", { refundMethod: "card", watermarkCents: 5000 });

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card", watermarkCents: 0, repairExistingLink: true });

    expect(state.xero.notes.size).toBe(1);
    expect(state.xero.notes.get("cn_1")!.payments).toHaveLength(1);
    expect(completedRows()[0]!.responsePayload).toMatchObject({ refundPayment: { paymentID: "pay_1" } });
    expectNoSucceededRowWithNeither();
  });
});
