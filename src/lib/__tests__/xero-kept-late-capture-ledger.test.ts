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
 * The refund note's ENQUEUE is the real one (`enqueueXeroRefundCreditNoteOperation`,
 * with the real note-eligible cash, `resolveRefundNoteEligibleCash`), and so is
 * the nightly SELF-HEAL's reader (`getRefundsMissingXeroCreditNotes`, #3635
 * round-3 R1), so a case that must stay at zero is run on past the 24-hour grace.
 *
 * TWO SEAMS ARE MODELS, stated so nobody mistakes them for the code:
 *  - the refund credit note's worker (`createXeroCreditNote`): a note for
 *    min(asked, note-eligible cash - linked notes), naming the late capture's
 *    own receipt (skipped without one the app recorded, held while it is still
 *    on its way), else the payment's invoice, dated its `documentDate`, and
 *    settled from the Stripe account - the caps `xero-booking-invoice.test.ts`
 *    pins;
 *  - the change payment's supplementary invoice (case e2): released as the
 *    gross ask paid from Stripe, which `xero-supplementary-invoices.test.ts` pins.
 */

type Doc =
  | { kind: "invoice"; id: string; cents: number; date: string; existing?: boolean }
  | { kind: "payment"; invoiceId: string; cents: number; date: string }
  | { kind: "clearing-note"; invoiceId: string; cents: number; existing?: boolean }
  | { kind: "refund-note"; cents: number; date: string; paymentIntentId?: string };

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => {
  const state = {
    ledger: [] as Doc[],
    tables: {} as Record<string, Row[]>,
    seq: 0,
    stripeReadFails: false,
    duringInvoiceSend: null as null | (() => Promise<void>),
    failNextPayment: false,
    failNextInvoice: false,
  };
  const id = (prefix: string) => `${prefix}_${++state.seq}`;

  function valueAt(row: Row, key: string) {
    return row[key];
  }
  function matchValue(actual: unknown, expected: unknown): boolean {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const e = expected as Record<string, unknown>;
      if ("gt" in e) return (actual as number) > (e.gt as number);
      if ("lt" in e) return (actual as number) < (e.lt as number);
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
  function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, expected]) =>
      key === "OR"
        ? (expected as Record<string, unknown>[]).some((branch) => matches(row, branch))
        : matchValue(valueAt(row, key), expected),
    );
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
      // The one groupBy read here: the cash evidence's refunds by status.
      groupBy: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const byStatus = new Map<string, { sum: number; count: number }>();
        for (const row of table(name).filter((r) => matches(r, where))) {
          const bucket = byStatus.get(row.status as string) ?? { sum: 0, count: 0 };
          bucket.sum += row.amountCents as number;
          bucket.count += 1;
          byStatus.set(row.status as string, bucket);
        }
        return [...byStatus].map(([status, b]) => ({ status, _sum: { amountCents: b.sum }, _count: { _all: b.count } }));
      },
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
    paymentRefund: delegate("paymentRefund"),
    memberCredit: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
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
    const rest = { ...input };
    delete rest.store;
    // As the real writer does, the queue type is denormalised from the payload.
    const queueType = (rest.requestPayload as { queueType?: string } | undefined)?.queueType ?? null;
    const row = { id: h.id("op"), manuallyResolvedAt: null, queueType, ...rest } as Row;
    h.table("xeroSyncOperation").push(row);
    return row;
  },
  completeXeroSyncOperation: async (
    operationId: string,
    completion: {
      status?: string;
      extraLinks?: Array<Record<string, unknown>>;
      xeroObjectId?: string;
      responsePayload?: unknown;
    },
  ) => {
    const row = h.table("xeroSyncOperation").find((r) => r.id === operationId)!;
    row.status = completion.status ?? "SUCCEEDED";
    row.xeroObjectId = completion.xeroObjectId ?? row.xeroObjectId ?? null;
    row.responsePayload = completion.responsePayload ?? null;
    h.writeLinks(completion.extraLinks);
  },
  // The linked refund notes' recorded cents, as `sumCoveredRefundCreditNoteCents` reads them.
  sumCoveredRefundCreditNoteCents: async (paymentId: string) =>
    h
      .table("xeroObjectLink")
      .filter((l) => l.localModel === "Payment" && l.localId === paymentId && l.role === "REFUND_CREDIT_NOTE" && l.active)
      .reduce((sum, l) => sum + ((l.metadata as { amountCents: number }).amountCents ?? 0), 0),
  findCanonicalPaymentRefundCreditNote: async () => null,
  upsertXeroObjectLink: async () => undefined,
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
          if (h.state.failNextInvoice) {
            h.state.failNextInvoice = false;
            throw new Error("Xero rejected the contact");
          }
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
vi.mock("@/lib/xero-operation-outbox", async (importOriginal) => ({
  // The REAL enqueue; only the outbox kick is stubbed (the test runs it).
  ...((await importOriginal()) as typeof import("@/lib/xero-operation-outbox")),
  kickQueuedXeroOutboxOperationsIfConnected: async () => undefined,
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));
// The Stripe charge of the late capture: taken on CAPTURED_AT (round-3 R2).
vi.mock("@/lib/stripe", () => ({
  getPaymentIntent: async () => {
    if (h.state.stripeReadFails) throw new Error("Stripe is unavailable");
    return { created: 1781053200, latest_charge: { created: 1781053200 } };
  },
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
      xeroObjectId: invoiceId,
      manuallyResolvedAt: null,
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
import {
  creditBackLateCaptureRefunds,
  queueLateCaptureRefundCreditNote,
} from "@/lib/late-capture-refund-credit-note";
import {
  findLateCapturePaymentIntents,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { getRefundsMissingXeroCreditNotes } from "@/lib/xero-admin-health";
import { cancelledBookingPrimaryPaymentRefundReason } from "@/lib/deleted-booking-modification-payment";
import type { ClubTimeZone } from "@/lib/club-time";

const ZONE = "Pacific/Auckland" as ClubTimeZone;
const CAPTURED_AT = new Date("2026-06-10T01:00:00.000Z"); // 10 Jun at the club
const CAPTURE_DAY = "2026-06-10";
const INTENT = "pi_late";
const TASK = "task_late";
const PAYMENT = "payment_1";
const BOOKING = "booking_1";

const MEMBER = { firstName: "Ana", lastName: "Member", email: "ana@example.test" };

function seed(options: {
  kind?: "PRIMARY" | "ADDITIONAL";
  primaryInvoice?: { cents: number } | null;
  cents?: number;
  taskRaisedAt?: Date;
}) {
  const cents = options.cents ?? 24000;
  h.table("booking").push({ id: BOOKING, member: MEMBER, organisation: null, memberId: "m1" });
  const primary = options.primaryInvoice ?? null;
  h.table("payment").push({
    id: PAYMENT,
    bookingId: BOOKING,
    source: "STRIPE",
    refundedAmountCents: 0,
    xeroInvoiceId: primary ? "inv_primary" : null,
    xeroRefundCreditNoteId: null,
    updatedAt: CAPTURED_AT,
    booking: { member: MEMBER, organisation: null },
  });
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
    createdAt: options.taskRaisedAt ?? CAPTURED_AT,
  });
}

const task = () => h.table("manualRefundTask").find((r) => r.id === TASK)!;
const capture = () => h.table("paymentTransaction").find((r) => r.id === "txn_late")!;

/** A Stripe refund of the late capture, recorded in the refund ledger as every cash path does. */
function takeStripeRefund(cents: number, at: Date = new Date()) {
  const row = capture();
  row.refundedAmountCents = (row.refundedAmountCents as number) + cents;
  row.status = row.refundedAmountCents === row.amountCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
  const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
  payment.refundedAmountCents = (payment.refundedAmountCents as number) + cents;
  h.table("paymentRefund").push({
    id: h.id("re"),
    paymentId: PAYMENT,
    stripePaymentIntentId: INTENT,
    amountCents: cents,
    status: "succeeded",
    stripeCreatedAt: at,
    createdAt: at,
  });
}

/** A refund in the Stripe dashboard, synced by `charge.refunded` (a late capture's path). */
async function dashboardRefund(cents: number, at?: Date) {
  takeStripeRefund(cents, at);
  await queueLateCaptureRefundCreditNote({ paymentId: PAYMENT, paymentIntentId: INTENT });
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
  await queueLateCaptureRefundCreditNote({ paymentId: PAYMENT, paymentIntentId: INTENT });
}

/** The outbox: every PENDING kept-capture row, then the refund notes (model). */
async function runOutbox() {
  for (const row of h.table("xeroSyncOperation").filter(
    (r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE" && r.status === "PENDING",
  )) {
    row.status = "RUNNING";
    await createXeroKeptLateCaptureInvoice({ syncOperationId: row.id }).catch(() => undefined);
  }
  for (const note of h.table("xeroSyncOperation").filter(
    (r) => r.queueType === "REFUND_CREDIT_NOTE" && r.status === "PENDING",
  )) {
    await runRefundNoteModel(note);
  }
}

/** MODEL of the refund note's worker (`createXeroCreditNote`): see the file docblock. */
async function runRefundNoteModel(note: Row) {
  const payload = note.requestPayload as {
    refundAmountCents: number;
    paymentIntentId?: string;
    documentDate?: string;
  };
  const paymentId = note.localId as string;
  const intent = payload.paymentIntentId;
  let invoiceId: string | null;
  if (intent && (await findLateCapturePaymentIntents([intent])).has(intent)) {
    const receipt = await readLateCaptureXeroReceipt(intent);
    if (receipt.kind !== "recorded") {
      note.status = "SUCCEEDED"; // skipped: the app raises no note for it
      return;
    }
    if (!receipt.invoiceId) return; // FAILED for now: the receipt is on its way
    invoiceId = receipt.invoiceId;
  } else {
    invoiceId =
      (h.table("xeroObjectLink").find((l) => l.role === "KEPT_LATE_CAPTURE_INVOICE")?.xeroObjectId as string) ??
      (h.table("payment").find((p) => p.id === paymentId)?.xeroInvoiceId as string | null) ??
      null;
    if (!invoiceId) {
      note.status = "FAILED"; // "No Xero invoice linked"
      return;
    }
  }
  const payment = h.table("payment").find((p) => p.id === paymentId)!;
  const { eligibleCashCents } = await resolveRefundNoteEligibleCash(payment as never);
  const linked = h
    .table("xeroObjectLink")
    .filter((l) => l.localId === paymentId && l.role === "REFUND_CREDIT_NOTE")
    .reduce((sum, l) => sum + ((l.metadata as { amountCents: number }).amountCents ?? 0), 0);
  const cents = Math.min(payload.refundAmountCents, eligibleCashCents - linked);
  note.status = "SUCCEEDED";
  if (cents <= 0) return;
  const noteId = h.id("cn");
  note.xeroObjectId = noteId;
  h.state.ledger.push({ kind: "refund-note", cents, date: payload.documentDate ?? "today", paymentIntentId: intent });
  h.writeLinks([
    {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: noteId,
      role: "REFUND_CREDIT_NOTE",
      metadata: { amountCents: cents, paymentIntentId: intent, invoiceId },
    },
  ]);
}

/**
 * The nightly credit reconciliation's self-heal, a day and more later: the REAL
 * gap reader and the REAL enqueue, then the outbox (#3635 round-3 R1).
 */
async function selfHealAfterGrace() {
  const missing = await getRefundsMissingXeroCreditNotes({
    limit: 50,
    now: new Date(Date.now() + 72 * 60 * 60 * 1000),
  });
  for (const payment of missing.payments) {
    await enqueueXeroRefundCreditNoteOperation(payment.paymentId, payment.uncoveredCents);
  }
  await runOutbox();
  return missing.count;
}

const refundNotes = () =>
  h.state.ledger.filter((d): d is Extract<Doc, { kind: "refund-note" }> => d.kind === "refund-note");

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
  h.state.duringInvoiceSend = null;
  h.state.stripeReadFails = false;
  h.state.failNextInvoice = false;
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

  it("keep -> reopen -> the worker claims the row -> re-keep before its locked check: the re-keep reuses the row, which is sent once", async () => {
    seed({});
    await keep();
    reopen();
    const row = h.table("xeroSyncOperation").find((r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE")!;
    row.status = "RUNNING"; // claimed, not yet at its locked check
    await keep(); // the re-keep waits on the task row, then finds the live RUNNING row
    expect(h.table("xeroSyncOperation").filter((r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE")).toHaveLength(1);
    await createXeroKeptLateCaptureInvoice({ syncOperationId: row.id }); // its check now reads DISMISSED
    expect(books()).toEqual({ income: 24000, stripe: 24000, receivable: 0 });
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

/**
 * #3635 round-3 (reviews `3635x-round3-accounting.md`, `3635x-round3-concurrency.md`).
 */
describe("round 3: the nightly self-heal, one note per capture, and the days the documents carry", () => {
  it("R1 (g, b): kept, reopened and refunded before the send, then the self-heal a day later - still nothing posted", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await keep();
    reopen();
    await approve();
    await runOutbox();
    expect(await selfHealAfterGrace()).toBe(0);
    expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
    expect(refundNotes()).toHaveLength(0);
  });

  it("R1 (b): a plain approval of a capture Xero never received, then the self-heal - no phantom Stripe refund", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await approve();
    await runOutbox();
    expect(await selfHealAfterGrace()).toBe(0);
    expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
  });

  it("R1 (b): a capture the webhook refunded automatically, with no approval task, is not raised by the self-heal", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    // The setting is off: no approval task, only the automatic record whose
    // frozen reason names the intent.
    const row = task();
    row.lateCaptureApprovalIntentId = null;
    row.status = "DISMISSED";
    row.reason = cancelledBookingPrimaryPaymentRefundReason(INTENT);
    takeStripeRefund(24000);
    expect(await selfHealAfterGrace()).toBe(0);
    expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
  });

  it("R1 control: a refund of a RECORDED capture whose note failed is still healed, once", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await keep();
    await runOutbox();
    await dashboardRefund(4000);
    const note = h.table("xeroSyncOperation").find((r) => r.queueType === "REFUND_CREDIT_NOTE")!;
    note.status = "FAILED"; // Xero refused it; nobody pressed Retry
    expect(await selfHealAfterGrace()).toBe(1);
    expect(books()).toEqual({ income: 20000, stripe: 20000, receivable: 0 });
    expect(await selfHealAfterGrace()).toBe(0);
    expect(refundNotes()).toHaveLength(1);
  });

  it("R4: a capture's refunds are noted once per capture, however often it is credited back, while the payment has other uncovered cash", async () => {
    seed({});
    await keep();
    await runOutbox();
    await dashboardRefund(4000);
    await runOutbox();
    // Another refund on the same payment, of a different intent, whose note
    // never went out: uncovered cash the payment-wide cap alone would lend.
    const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
    payment.refundedAmountCents = (payment.refundedAmountCents as number) + 10000;
    h.table("paymentRefund").push({
      id: "re_other",
      paymentId: PAYMENT,
      stripePaymentIntentId: "pi_other",
      amountCents: 10000,
      status: "succeeded",
      stripeCreatedAt: new Date(),
      createdAt: new Date(),
    });
    // The worker's credit-back on a PARTIAL retry, and a second one.
    await creditBackLateCaptureRefunds(INTENT);
    await creditBackLateCaptureRefunds(INTENT);
    await runOutbox();
    expect(refundNotes().filter((d) => d.paymentIntentId === INTENT)).toEqual([
      expect.objectContaining({ cents: 4000 }),
    ]);
  });

  it("R3: a refund taken before the receipt is noted on the day it left Stripe, not the day it was credited back", async () => {
    seed({});
    await dashboardRefund(4000, new Date("2026-06-12T01:00:00.000Z")); // 12 Jun at the club
    await keep();
    await runOutbox();
    expect(refundNotes()).toEqual([expect.objectContaining({ cents: 4000, date: "2026-06-12" })]);
  });

  it("R2: the receipt is dated the day of the Stripe charge, not the day the task was raised, and the date is stored", async () => {
    seed({ taskRaisedAt: new Date("2026-06-11T02:00:00.000Z") }); // raised the next day
    await keep();
    await runOutbox();
    const sent = h.state.ledger.filter((d) => !("existing" in d && d.existing));
    expect(sent).toEqual([
      expect.objectContaining({ kind: "invoice", date: CAPTURE_DAY }),
      expect.objectContaining({ kind: "payment", date: CAPTURE_DAY }),
    ]);
    const row = h.table("xeroSyncOperation").find((r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE")!;
    expect(row.requestPayload).toMatchObject({ capturedOn: CAPTURE_DAY, capturedOnFromStripe: true });
  });

  it("R2: when Stripe cannot say, the receipt falls back to the task's raise day", async () => {
    seed({ taskRaisedAt: new Date("2026-06-11T02:00:00.000Z") });
    h.state.stripeReadFails = true;
    await keep();
    await runOutbox();
    expect(h.state.ledger.find((d) => d.kind === "invoice")).toMatchObject({ date: "2026-06-11" });
  });

  it("R5: a kept invoice an officer recorded by hand, then reopened and refunded - no note is raised, and none is healed", async () => {
    seed({});
    h.state.failNextInvoice = true;
    await keep();
    await runOutbox();
    const row = h.table("xeroSyncOperation").find((r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE")!;
    expect(row.status).toBe("FAILED");
    row.manuallyResolvedAt = new Date("2026-06-20T00:00:00.000Z"); // raised and paid by hand in Xero
    reopen();
    await approve();
    await runOutbox();
    expect(await selfHealAfterGrace()).toBe(0);
    expect(refundNotes()).toHaveLength(0);
    // The approval left the officer's record alone.
    expect(row.status).toBe("FAILED");
  });
});
