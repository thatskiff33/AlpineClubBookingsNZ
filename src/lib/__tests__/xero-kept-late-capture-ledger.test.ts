import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3635 (owner decision and orchestrator decision 29 Sep 2026, `INV-PAY-110`):
 * A KEPT LATE CAPTURE IS COUNTED ONCE IN XERO, whatever else happened to it.
 *
 * Drives the REAL decision (`decideLateCapture`), the real dismissal plan, the
 * real kept-capture enqueue and worker, the real approval settlement, the real
 * refund-note need (`hasXeroReceiptForLateCapture`, `stripeRefundNeedsXeroNoteNow`,
 * `queueLateCaptureRefundCreditNote`, `creditBackLateCaptureRefunds`) against an
 * in-memory store and a fake Xero that keeps a ledger of every document sent.
 * Each case then sums income, the Stripe bank account and receivables from
 * those documents and compares them with the money that really moved.
 *
 * TWO SEAMS ARE MODELS, stated so nobody mistakes them for the code:
 *  - the refund credit note's enqueue and worker (`enqueueXeroRefundCreditNoteOperation`
 *    + `createXeroCreditNote`): a note for min(asked, cash refunded - already
 *    noted), refused while the payment has neither a kept nor a primary
 *    invoice, and settled from the Stripe account - the delta cap those two
 *    pin in `xero-operation-outbox.test.ts` and `xero-refund-method-documents.test.ts`;
 *  - the change payment's supplementary invoice (case e2): released as the
 *    gross ask paid from Stripe, which `xero-supplementary-invoices.test.ts` pins.
 */

type Doc =
  | { kind: "invoice"; id: string; cents: number; date: string; existing?: boolean }
  | { kind: "payment"; invoiceId: string; cents: number; date: string }
  | { kind: "clearing-note"; invoiceId: string; cents: number; existing?: boolean }
  | { kind: "refund-note"; cents: number };

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => {
  const state = {
    ledger: [] as Doc[],
    tables: {} as Record<string, Row[]>,
    cashRefundedByPayment: {} as Record<string, number>,
    pendingNotes: [] as { paymentId: string; cents: number }[],
    seq: 0,
    duringInvoiceSend: null as null | (() => Promise<void>),
    failNextPayment: false,
  };
  const id = (prefix: string) => `${prefix}_${++state.seq}`;

  function valueAt(row: Row, key: string) {
    return row[key];
  }
  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const e = expected as Record<string, unknown>;
      if ("in" in e) return (e.in as unknown[]).includes(actual);
      if ("notIn" in e) return !(e.notIn as unknown[]).includes(actual);
      if ("not" in e) return e.not === null ? actual !== null && actual !== undefined : actual !== e.not;
      if ("path" in e) {
        const payload = (actual ?? {}) as Record<string, unknown>;
        return payload[(e.path as string[])[0]] === e.equals;
      }
    }
    return actual === expected;
  }
  function matches(row: Row, where: Record<string, unknown> = {}) {
    return Object.entries(where).every(([key, expected]) => matchValue(valueAt(row, key), expected));
  }
  function table(name: string) {
    return (state.tables[name] ??= []);
  }
  function delegate(name: string) {
    return {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        table(name).find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        table(name).find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        table(name).filter((row) => matches(row, where)),
      count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        table(name).filter((row) => matches(row, where)).length,
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = table(name).find((r) => matches(r, where))!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = table(name).filter((r) => matches(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    };
  }
  const db: Record<string, unknown> = {
    paymentTransaction: delegate("paymentTransaction"),
    manualRefundTask: delegate("manualRefundTask"),
    payment: delegate("payment"),
    booking: delegate("booking"),
    xeroObjectLink: delegate("xeroObjectLink"),
    xeroSyncOperation: delegate("xeroSyncOperation"),
    $executeRaw: async () => 0,
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);

  function writeLinks(links: Array<Record<string, unknown>> | undefined) {
    for (const link of links ?? []) {
      table("xeroObjectLink").push({ id: id("link"), active: true, ...link } as Row);
    }
  }
  return { state, id, db, table, writeLinks };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: async () => false }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: async (input: Record<string, unknown>) => {
    const { store: _store, ...rest } = input;
    const row = { id: h.id("op"), manuallyResolvedAt: null, ...rest } as Row;
    h.table("xeroSyncOperation").push(row);
    return row;
  },
  completeXeroSyncOperation: async (
    operationId: string,
    completion: { status?: string; extraLinks?: Array<Record<string, unknown>> },
  ) => {
    const row = h.table("xeroSyncOperation").find((r) => r.id === operationId)!;
    row.status = completion.status ?? "SUCCEEDED";
    h.writeLinks(completion.extraLinks);
  },
  failXeroSyncOperation: async (operationId: string) => {
    const row = h.table("xeroSyncOperation").find((r) => r.id === operationId)!;
    row.status = "FAILED";
  },
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    tenantId: "tenant",
    xero: {
      accountingApi: {
        createInvoices: async (_t: string, body: { invoices: Array<Record<string, any>> }) => {
          const invoice = body.invoices[0];
          const cents = Math.round(
            invoice.lineItems.reduce(
              (sum: number, line: { unitAmount: number; quantity: number }) =>
                sum + line.unitAmount * line.quantity * 100,
              0,
            ),
          );
          const invoiceId = h.id("inv");
          h.state.ledger.push({ kind: "invoice", id: invoiceId, cents, date: invoice.date });
          // A decision that lands while the invoice is on its way to Xero.
          const during = h.state.duringInvoiceSend;
          h.state.duringInvoiceSend = null;
          if (during) await during();
          return { body: { invoices: [{ invoiceID: invoiceId, invoiceNumber: invoiceId }] } };
        },
      },
    },
  }),
  callXeroApi: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/xero-contacts", () => ({
  retryXeroWriteWithContactRepair: (options: { run: (args: { contactId: string }) => unknown }) =>
    options.run({ contactId: "contact" }),
}));
vi.mock("@/lib/organisation-xero-contacts", () => ({
  findOrCreateXeroContactForInvoicedParty: async () => "contact",
  invoicedPartyContactRepair: () => undefined,
}));
vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: async () => ({ code: "200", itemCode: null, codeExplicitlyConfigured: false }),
  getAccountMapping: async () => "606",
}));
vi.mock("@/lib/xero-invoice-payments", () => ({
  createXeroPaymentForInvoice: async (params: {
    localModel: string;
    localId: string;
    invoiceId: string;
    amountCents: number;
    role: string;
    date?: string;
  }) => {
    if (h.state.failNextPayment) {
      h.state.failNextPayment = false;
      throw new Error("Xero refused the payment");
    }
    h.state.ledger.push({
      kind: "payment",
      invoiceId: params.invoiceId,
      cents: params.amountCents,
      date: params.date ?? "today",
    });
    const paymentId = h.id("pay");
    h.writeLinks([
      {
        localModel: params.localModel,
        localId: params.localId,
        xeroObjectType: "PAYMENT",
        xeroObjectId: paymentId,
        role: params.role,
      },
    ]);
    return paymentId;
  },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  // MODEL of the refund note's enqueue: see the file docblock.
  enqueueXeroRefundCreditNoteOperation: async (paymentId: string, cents: number) => {
    h.state.pendingNotes.push({ paymentId, cents });
    return { queueOperationId: h.id("note"), message: "queued" };
  },
  kickQueuedXeroOutboxOperationsIfConnected: async () => undefined,
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  // MODEL of the change's supplementary invoice (case e2): see the docblock.
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: async (paymentIntentId: string) => {
    const capture = h.table("paymentTransaction").find((r) => r.stripePaymentIntentId === paymentIntentId)!;
    const invoiceId = h.id("inv");
    h.table("xeroSyncOperation").push({
      id: h.id("op"),
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      queueType: "SUPPLEMENTARY_INVOICE",
      status: "SUCCEEDED",
      requestPayload: { paymentIntentId },
    });
    h.state.ledger.push({ kind: "invoice", id: invoiceId, cents: capture.amountCents as number, date: "today" });
    h.state.ledger.push({ kind: "payment", invoiceId, cents: capture.amountCents as number, date: "today" });
    return { released: 1, queueOperationIds: ["op"], outcome: "released" };
  },
}));

import { planKeptLateCaptureXeroRecord, finishKeptLateCaptureXeroRecord } from "@/lib/late-capture-kept-xero";
import {
  createXeroKeptLateCaptureInvoice,
  settleKeptLateCaptureRecordOnApproval,
} from "@/lib/xero-kept-late-capture-invoice";
import { queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import { stripeRefundNeedsXeroNoteNow } from "@/lib/late-capture-xero-receipt";
import type { ClubTimeZone } from "@/lib/club-time";

const ZONE = "Pacific/Auckland" as ClubTimeZone;
const CAPTURED_AT = new Date("2026-06-10T01:00:00.000Z"); // 10 Jun at the club
const CAPTURE_DAY = "2026-06-10";
const INTENT = "pi_late";
const TASK = "task_late";
const PAYMENT = "payment_1";
const BOOKING = "booking_1";

function seed(options: {
  kind?: "PRIMARY" | "ADDITIONAL";
  primaryInvoice?: { cents: number } | null;
  cents?: number;
}) {
  const cents = options.cents ?? 24000;
  h.table("booking").push({ id: BOOKING, member: {}, organisation: null, memberId: "m1" });
  const primary = options.primaryInvoice ?? null;
  h.table("payment").push({ id: PAYMENT, xeroInvoiceId: primary ? "inv_primary" : null });
  if (primary) {
    // The booking's own invoice and the cancellation's clearing note, already
    // in Xero before the late capture: the code must leave them alone.
    h.state.ledger.push({ kind: "invoice", id: "inv_primary", cents: primary.cents, date: "2026-05-01", existing: true });
    h.state.ledger.push({ kind: "clearing-note", invoiceId: "inv_primary", cents: primary.cents, existing: true });
  }
  h.table("paymentTransaction").push({
    id: "txn_late",
    paymentId: PAYMENT,
    kind: options.kind ?? "PRIMARY",
    source: "STRIPE",
    stripePaymentIntentId: INTENT,
    status: "SUCCEEDED",
    amountCents: cents,
    refundedAmountCents: 0,
  });
  h.table("manualRefundTask").push({
    id: TASK,
    bookingId: BOOKING,
    paymentId: PAYMENT,
    lateCaptureApprovalIntentId: INTENT,
    status: "OPEN",
    createdAt: CAPTURED_AT,
  });
}

const task = () => h.table("manualRefundTask").find((r) => r.id === TASK)!;
const capture = () => h.table("paymentTransaction").find((r) => r.id === "txn_late")!;

function takeStripeRefund(cents: number) {
  const row = capture();
  row.refundedAmountCents = (row.refundedAmountCents as number) + cents;
  row.status = row.refundedAmountCents === row.amountCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
  h.state.cashRefundedByPayment[PAYMENT] = (h.state.cashRefundedByPayment[PAYMENT] ?? 0) + cents;
}

/** A refund in the Stripe dashboard, synced by `charge.refunded`. */
async function dashboardRefund(cents: number) {
  takeStripeRefund(cents);
  if (await stripeRefundNeedsXeroNoteNow(INTENT)) {
    h.state.pendingNotes.push({ paymentId: PAYMENT, cents });
  }
}

/** "Close without refunding": the dismissal's claim, then its two halves. */
async function keep() {
  task().status = "DISMISSED";
  const plan = await planKeptLateCaptureXeroRecord({
    manualRefundTaskId: TASK,
    bookingId: BOOKING,
    paymentIntentId: INTENT,
    actingMemberId: "treasurer",
    clubZone: ZONE,
    store: h.db as never,
  });
  await finishKeptLateCaptureXeroRecord(plan);
}

function reopen() {
  task().status = "OPEN";
}

/** "Refund to card": the claim, its settlement, the Stripe refund, the note. */
async function approve() {
  task().status = "COMPLETED";
  await settleKeptLateCaptureRecordOnApproval({
    manualRefundTaskId: TASK,
    paymentIntentId: INTENT,
    store: h.db as never,
  });
  const remaining = (capture().amountCents as number) - (capture().refundedAmountCents as number);
  takeStripeRefund(remaining);
  await queueLateCaptureRefundCreditNote({ paymentId: PAYMENT, paymentIntentId: INTENT, amountCents: remaining });
}

/** The outbox: every PENDING kept-capture row, then the refund notes (model). */
async function runOutbox() {
  for (const row of h.table("xeroSyncOperation").filter(
    (r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE" && r.status === "PENDING",
  )) {
    row.status = "RUNNING";
    await createXeroKeptLateCaptureInvoice({ syncOperationId: row.id }).catch(() => undefined);
  }
  const notes = h.state.pendingNotes.splice(0);
  for (const note of notes) {
    const noted = h.state.ledger
      .filter((d): d is Extract<Doc, { kind: "refund-note" }> => d.kind === "refund-note")
      .reduce((s, d) => s + d.cents, 0);
    const cents = Math.min(note.cents, (h.state.cashRefundedByPayment[note.paymentId] ?? 0) - noted);
    const hasInvoice =
      h.table("xeroObjectLink").some((l) => l.role === "KEPT_LATE_CAPTURE_INVOICE") ||
      Boolean(h.table("payment").find((p) => p.id === note.paymentId)?.xeroInvoiceId);
    if (cents <= 0) continue;
    if (!hasInvoice) {
      h.state.pendingNotes.push(note); // FAILED: "No Xero invoice linked"; retried later
      continue;
    }
    h.state.ledger.push({ kind: "refund-note", cents });
  }
}

/** Income, the Stripe bank account and receivables, from the documents sent. */
function books() {
  let income = 0;
  let stripe = 0;
  let receivable = 0;
  for (const doc of h.state.ledger) {
    if (doc.kind === "invoice") {
      income += doc.cents;
      receivable += doc.cents;
    } else if (doc.kind === "payment") {
      stripe += doc.cents;
      receivable -= doc.cents;
    } else if (doc.kind === "clearing-note") {
      income -= doc.cents;
      receivable -= doc.cents;
    } else {
      // An unallocated refund note settled by a Stripe refund payment.
      income -= doc.cents;
      stripe -= doc.cents;
    }
  }
  return { income, stripe, receivable };
}

/** What really happened: the capture, net of every refund Stripe paid. */
function realStripe() {
  return (capture().amountCents as number) - (capture().refundedAmountCents as number);
}

beforeEach(() => {
  h.state.ledger = [];
  h.state.tables = {};
  h.state.cashRefundedByPayment = {};
  h.state.pendingNotes = [];
  h.state.duringInvoiceSend = null;
  h.state.failNextPayment = false;
});

describe("a kept late capture is counted once in Xero", () => {
  it("(a) no booking invoice was ever raised: the gross capture, dated the capture day", async () => {
    seed({});
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 24000, stripe: 24000, receivable: 0 });
    const sent = h.state.ledger.filter((d) => !("existing" in d && d.existing));
    expect(sent).toEqual([
      expect.objectContaining({ kind: "invoice", cents: 24000, date: CAPTURE_DAY }),
      expect.objectContaining({ kind: "payment", cents: 24000, date: CAPTURE_DAY }),
    ]);
  });

  it("(b) the booking's invoice was cleared at cancel: that pair nets to zero and is left alone", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 24000, stripe: 24000, receivable: 0 });
  });

  it("(c) account credit was used on the booking and restored at cancel (no document moved it)", async () => {
    seed({ cents: 18000 });
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 18000, stripe: 18000, receivable: 0 });
  });

  it("(d) the booking was re-priced after the payment was asked for", async () => {
    seed({ primaryInvoice: { cents: 26000 } });
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 24000, stripe: 24000, receivable: 0 });
  });

  it("(e1) a change payment on a booking Xero never invoiced gets the kept invoice", async () => {
    seed({ kind: "ADDITIONAL", cents: 2500 });
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 2500, stripe: 2500, receivable: 0 });
  });

  it("(e2) a change payment on an invoiced booking keeps its own supplementary invoice, and a dashboard refund nets it", async () => {
    seed({ kind: "ADDITIONAL", cents: 2500, primaryInvoice: { cents: 30000 } });
    await dashboardRefund(500);
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 2000, stripe: 2000, receivable: 0 });
    expect(books().stripe).toBe(realStripe());
  });

  for (const primaryInvoice of [null, { cents: 30000 }]) {
    const label = primaryInvoice ? "(f, b) cleared invoice" : "(f, a) no invoice";
    it(`${label}: a partial dashboard refund before the keep is subtracted once, by its note`, async () => {
      seed({ primaryInvoice });
      await dashboardRefund(4000);
      await keep();
      await runOutbox();
      expect(books()).toEqual({ income: 20000, stripe: 20000, receivable: 0 });
      expect(books().stripe).toBe(realStripe());
    });
  }

  it("(f) refunded in full in the dashboard, then closed without refunding: receipt and note net to zero", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await dashboardRefund(24000);
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
  });

  for (const primaryInvoice of [null, { cents: 30000 }]) {
    const label = primaryInvoice ? "(g, b)" : "(g, a)";
    it(`${label} kept, reopened and refunded BEFORE the send: withdrawn, and no Stripe-account refund is posted`, async () => {
      seed({ primaryInvoice });
      await keep();
      reopen();
      await approve();
      await runOutbox();
      expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
      expect(h.table("xeroSyncOperation").find((r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE")?.status).toBe(
        "CANCELLED",
      );
    });

    it(`${label} kept, reopened and refunded DURING the send: the receipt goes out, and its worker credits it back`, async () => {
      seed({ primaryInvoice });
      await keep();
      reopen();
      task().status = "DISMISSED"; // re-kept, then approved while the invoice is on its way
      h.state.duringInvoiceSend = approve;
      await runOutbox();
      await runOutbox();
      expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
    });

    it(`${label} kept, sent, then reopened and refunded AFTER the send: credited back by the refund note`, async () => {
      seed({ primaryInvoice });
      await keep();
      await runOutbox();
      reopen();
      await approve();
      await runOutbox();
      expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
    });
  }

  it("(g) a raised invoice whose payment failed, then reopened and refunded: the payment is still recorded, and the note answers it", async () => {
    seed({});
    h.state.failNextPayment = true;
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 24000, stripe: 0, receivable: 24000 });
    reopen();
    await approve();
    await runOutbox();
    expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
  });

  it("(h) Stripe fees: none are recorded, here or for any card receipt, so the bank line is the gross capture", async () => {
    seed({});
    await keep();
    await runOutbox();
    expect(h.state.ledger.every((d) => d.kind === "invoice" || d.kind === "payment")).toBe(true);
    expect(books().stripe).toBe(24000);
  });

  it("a replayed keep, and a re-keep after the worker withdrew a reopened row, each leave exactly one receipt", async () => {
    seed({});
    await keep();
    reopen();
    await runOutbox(); // the worker, under the task lock, finds it OPEN and withdraws it
    await keep(); // the re-keep queues a new row
    await keep(); // a replay finds the live row
    await runOutbox();
    expect(books()).toEqual({ income: 24000, stripe: 24000, receivable: 0 });
    expect(h.state.ledger.filter((d) => d.kind === "invoice")).toHaveLength(1);
  });
});
