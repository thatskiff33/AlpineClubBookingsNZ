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
 *  - the change payment's supplementary invoice (case e2): a WAITING one naming
 *    the capture, or one the reaper retired `STALE_WAITING_PAYMENT` (re-queued
 *    from that row), is released as the gross ask paid from Stripe, which
 *    `xero-supplementary-invoices.test.ts` pins. #4324: with none waiting the
 *    model releases NOTHING, as the real release then answers `none-queued`
 *    on a cancelled booking - it used to invent a paid invoice, which hid
 *    that a kept change capture went unrecorded;
 *  - (#3924 round 6) the "Paid another way" close's own writes - the money on
 *    the payment, its record, and the one Xero row it queues - whose order and
 *    locks `card-refund-paid-another-way.test.ts` pins. What it queues is the
 *    REAL enqueue, and the receipt's worker and the cash evidence are real.
 *
 * #4324 (`INV-PAY-144`): a kept change capture whose primary invoice bills the
 * change is recorded by the REAL receipt enqueue and worker
 * (`recordAdditionalCaptureReceipt`) against a fake Xero whose AmountDue is
 * read from the ledger (cases e3, e4).
 */

type Doc =
  | { kind: "invoice"; id: string; cents: number; date: string; existing?: boolean }
  | { kind: "payment"; invoiceId: string; cents: number; date: string }
  | { kind: "clearing-note"; invoiceId: string; cents: number; existing?: boolean }
  | { kind: "refund-note"; cents: number; date: string; paymentIntentId?: string; refundMethod?: string };

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
      if ("startsWith" in e) return typeof actual === "string" && actual.startsWith(e.startsWith as string);
      if ("not" in e) return e.not === null ? actual !== null && actual !== undefined : actual !== e.not;
      if ("path" in e) {
        const payload = (actual ?? {}) as Record<string, unknown>;
        const at = payload[(e.path as string[])[0]];
        if ("array_contains" in e) {
          return Array.isArray(at) && (e.array_contains as unknown[]).every((item) => at.includes(item));
        }
        return at === e.equals;
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
      // The automatic-refund record writer's create (#3635 C2).
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id(name), ...data } as Row;
        table(name).push(row);
        return row;
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
    paymentRecoveryOperation: delegate("paymentRecoveryOperation"),
    bookingModification: delegate("bookingModification"),
    $executeRaw: async () => 0,
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);

  // An upsert, as the real writer's: the same object under the same role is one link.
  function writeLinks(links: Array<Record<string, unknown>> | undefined) {
    for (const link of links ?? []) {
      const same = table("xeroObjectLink").find(
        (row) =>
          row.localModel === link.localModel &&
          row.localId === link.localId &&
          row.role === link.role &&
          row.xeroObjectId === link.xeroObjectId,
      );
      if (same) Object.assign(same, link);
      else table("xeroObjectLink").push({ id: id("link"), active: true, ...link } as Row);
    }
  }
  return { state, id, db, table, writeLinks };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: vi.fn() }));
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
    claim: { id: string },
    completion: {
      status?: string;
      extraLinks?: Array<Record<string, unknown>>;
      xeroObjectId?: string;
      responsePayload?: unknown;
    },
  ) => {
    const row = h.table("xeroSyncOperation").find((r) => r.id === claim.id)!;
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
  upsertXeroObjectLink: async (link: Record<string, unknown>) => {
    h.writeLinks([link]);
  },
  failXeroSyncOperation: async (claim: { id: string }) => {
    const row = h.table("xeroSyncOperation").find((r) => r.id === claim.id)!;
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
vi.mock("@/lib/xero-supplementary-invoice-late-capture", async (importOriginal) => ({
  // The REAL retired codes the keep's evidence reads (#4324).
  RETIRED_CODES_ANSWERING_CAPTURE: (
    (await importOriginal()) as typeof import("@/lib/xero-supplementary-invoice-late-capture")
  ).RETIRED_CODES_ANSWERING_CAPTURE,
  // The approval task decides (`decideLateCapture`'s task arm), as every late capture here has one.
  lateCaptureRefundState: async ({ paymentIntentId }: { paymentIntentId: string }) => {
    const task = h.table("manualRefundTask").find((r) => r.lateCaptureApprovalIntentId === paymentIntentId);
    return task?.status === "DISMISSED" ? "kept" : task?.status === "OPEN" ? "awaiting-decision" : "refunded";
  },
  // MODEL of the change's supplementary invoice (case e2): see the docblock.
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: async (paymentIntentId: string) => {
    const capture = h.table("paymentTransaction").find((r) => r.stripePaymentIntentId === paymentIntentId)!;
    // A waiting one is released; one the reaper retired (`STALE_WAITING_PAYMENT`) is re-queued from that row.
    const waiting = h
      .table("xeroSyncOperation")
      .find(
        (r) =>
          r.queueType === "SUPPLEMENTARY_INVOICE" &&
          (r.status === "WAITING_PAYMENT" || (r.status === "CANCELLED" && r.lastErrorCode === "STALE_WAITING_PAYMENT")) &&
          (r.requestPayload as { paymentIntentId?: string }).paymentIntentId === paymentIntentId,
      );
    if (!waiting) return { released: 0, queueOperationIds: [], outcome: "none-queued" };
    const invoiceId = h.id("inv");
    waiting.status = "SUCCEEDED";
    waiting.xeroObjectId = invoiceId;
    h.state.ledger.push({ kind: "invoice", id: invoiceId, cents: capture.amountCents as number, date: "today" });
    h.state.ledger.push({ kind: "payment", invoiceId, cents: capture.amountCents as number, date: "today" });
    return { released: 1, queueOperationIds: [waiting.id], outcome: "released" };
  },
}));

import { planKeptLateCaptureXeroRecord, finishKeptLateCaptureXeroRecord } from "@/lib/late-capture-kept-xero";
import {
  createXeroKeptLateCaptureInvoice,
  enqueueXeroKeptLateCaptureInvoiceOperation,
  settleKeptLateCaptureRecordOnApproval,
} from "@/lib/xero-kept-late-capture-invoice";
import { logAudit } from "@/lib/audit";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { buildLateCaptureApprovalRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import {
  creditBackLateCaptureRefunds,
  finishApprovedLateCaptureRefund,
  noteLateCaptureRefunds,
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
import { applyActionsForPass } from "@/lib/xero-booking-repair-passes";
import { planCardRefundFromLedger } from "@/lib/payment-transactions";
import { lateCaptureOwnChargeSlice } from "@/lib/late-capture-own-charge-refund";
import { recordAndNoteRepairedLateCaptureRefunds } from "@/lib/late-capture-repair-refund-record";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { recordAdditionalCaptureReceipt } from "@/lib/additional-capture-xero-receipt";
import { createXeroPaymentForInvoice } from "@/lib/xero-invoice-payments";
import type { ClubTimeZone } from "@/lib/club-time";
import { xeroClaim } from "@/lib/__tests__/helpers/xero-claim";

const ZONE = "Pacific/Auckland" as ClubTimeZone;
const CAPTURED_AT = new Date("2026-06-10T01:00:00.000Z"); // 10 Jun at the club
const CAPTURE_DAY = "2026-06-10";
const INTENT = "pi_late";
const TASK = "task_late";
const PAYMENT = "payment_1";
const BOOKING = "booking_1";

const MEMBER = { firstName: "Ana", lastName: "Member", email: "ana@example.test" };

const CHANGE = "mod_change";

function seed(options: {
  kind?: "PRIMARY" | "ADDITIONAL";
  primaryInvoice?: { cents: number } | null;
  /**
   * #4324: a PAID cancel's primary invoice - billed, part or fully paid, and
   * never cleared (`booking-cancel.ts` clears only a never-captured one).
   */
  paidPrimary?: { billedCents: number; paidCents: number };
  cents?: number;
  taskRaisedAt?: Date;
  /** #4324: the booking change the capture pays for, and what Xero shows of it. */
  change?: {
    settledAgainstPrimary?: boolean;
    invoice?: "waiting" | "withdrawn" | "retired";
    /** #4324: the reaper's stamp on a `retired` invoice naming this capture. */
    retiredCode?: string;
  };
}) {
  const cents = options.cents ?? 24000;
  const bookingRow = { id: BOOKING, status: "CANCELLED", member: MEMBER, organisation: null, memberId: "m1" };
  h.table("booking").push(bookingRow);
  const primary = options.primaryInvoice ?? null;
  const paidPrimary = options.paidPrimary ?? null;
  const paymentRow = {
    id: PAYMENT,
    bookingId: BOOKING,
    source: "STRIPE",
    status: paidPrimary ? "SUCCEEDED" : "PENDING",
    amountCents: paidPrimary?.paidCents ?? 0,
    creditAppliedCents: 0,
    refundedAmountCents: 0,
    xeroInvoiceId: primary || paidPrimary ? "inv_primary" : null,
    xeroRefundCreditNoteId: null,
    updatedAt: CAPTURED_AT,
    booking: { member: MEMBER, organisation: null },
  };
  h.table("payment").push(paymentRow);
  if (primary) {
    // The booking's own invoice and the cancellation's clearing note, already
    // in Xero before the late capture: the code must leave them alone.
    h.state.ledger.push({ kind: "invoice", id: "inv_primary", cents: primary.cents, date: "2026-05-01", existing: true });
    h.state.ledger.push({ kind: "clearing-note", invoiceId: "inv_primary", cents: primary.cents, existing: true });
  }
  if (paidPrimary) {
    h.state.ledger.push({ kind: "invoice", id: "inv_primary", cents: paidPrimary.billedCents, date: "2026-05-01", existing: true });
    h.state.ledger.push({ kind: "payment", invoiceId: "inv_primary", cents: paidPrimary.paidCents, date: "2026-05-01" });
  }
  const change = options.change ?? null;
  if (change) {
    h.table("bookingModification").push({
      id: CHANGE,
      bookingId: BOOKING,
      newData: change.settledAgainstPrimary ? { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } } : {},
    });
    if (change.invoice) {
      h.table("xeroSyncOperation").push({
        id: h.id("op"),
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        queueType: "SUPPLEMENTARY_INVOICE",
        localModel: "BookingModification",
        localId: CHANGE,
        status: change.invoice === "waiting" ? "WAITING_PAYMENT" : "CANCELLED",
        lastErrorCode:
          change.invoice === "waiting"
            ? null
            : change.invoice === "retired"
              ? (change.retiredCode ?? "STALE_WAITING_PAYMENT")
              : "WITHDRAWN_BY_OFFICER",
        manuallyResolvedAt: null,
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: BOOKING,
          bookingModificationId: CHANGE,
          // A withdrawn ask names an intent since superseded; a waiting or retired one names this capture.
          paymentIntentId: change.invoice === "withdrawn" ? "pi_superseded" : INTENT,
        },
      });
    }
  }
  const captureRow: Row = {
    id: "txn_late",
    paymentId: PAYMENT,
    kind: options.kind ?? "PRIMARY",
    source: "STRIPE",
    stripePaymentIntentId: INTENT,
    status: "SUCCEEDED",
    amountCents: cents,
    refundedAmountCents: 0,
    bookingModificationId: change ? CHANGE : null,
    reason: null,
  };
  // The ledger row's relation, as the receipt's selects read it.
  Object.defineProperty(captureRow, "payment", { get: () => ({ ...paymentRow, booking: bookingRow }), enumerable: false });
  h.table("paymentTransaction").push(captureRow);
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

/** #4324: what Xero shows due on an invoice, from the documents sent. */
function amountDueCents(invoiceId: string) {
  let due = 0;
  for (const doc of h.state.ledger) {
    if (doc.kind === "invoice" && doc.id === invoiceId) due += doc.cents;
    if ((doc.kind === "payment" || doc.kind === "clearing-note") && doc.invoiceId === invoiceId) due -= doc.cents;
  }
  return due;
}

/** #4324: the receipt worker's provider seam - a fake Xero reading the ledger, and the mocked payment writer. */
const receiptProviders = {
  getAuthenticatedXeroClient: async () => ({
    tenantId: "tenant",
    xero: {
      accountingApi: {
        getInvoice: async (_t: string, invoiceId: string) => ({
          body: { invoices: [{ invoiceID: invoiceId, status: "AUTHORISED", amountDue: amountDueCents(invoiceId) / 100, payments: [] }] },
        }),
      },
    },
  }),
  callXeroApi: (fn: () => unknown) => fn(),
  createXeroPaymentForInvoice,
  readStripeCaptureDocumentDate: async () => CAPTURE_DAY,
} as never;

/** The outbox: every PENDING kept-capture row and (#4324) receipt row, then the refund notes (model). */
async function runOutbox() {
  for (const row of h.table("xeroSyncOperation").filter(
    (r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE" && r.status === "PENDING",
  )) {
    row.status = "RUNNING";
    await createXeroKeptLateCaptureInvoice({ syncOperation: xeroClaim(row.id) }).catch(() => undefined);
  }
  for (const row of h.table("xeroSyncOperation").filter(
    (r) => r.queueType === "ADDITIONAL_CAPTURE_RECEIPT" && r.status === "PENDING",
  )) {
    row.status = "RUNNING";
    await recordAdditionalCaptureReceipt({ syncOperation: xeroClaim(row.id) }, receiptProviders).catch(() => undefined);
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
    refundMethod?: string;
    creditsInvoiceId?: string;
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
    // #3924 round 7 (M5): a caller that named the invoice is taken at its word.
    invoiceId =
      payload.creditsInvoiceId ??
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
  h.state.ledger.push({
    kind: "refund-note",
    cents,
    date: payload.documentDate ?? "today",
    paymentIntentId: intent,
    refundMethod: payload.refundMethod,
  });
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
    } else if (doc.refundMethod === "internet-banking") {
      // #3924 round 6: a bank-transfer note is settled from the bank account (`bankAccount`).
      income -= doc.cents;
    } else {
      // An unallocated refund note settled by a Stripe refund payment.
      income -= doc.cents;
      stripe -= doc.cents;
    }
  }
  return { income, stripe, receivable };
}

/** The club's bank account, from the documents sent: what bank-transfer refund notes paid out. */
function bankAccount() {
  return -h.state.ledger
    .filter((d): d is Extract<Doc, { kind: "refund-note" }> => d.kind === "refund-note" && d.refundMethod === "internet-banking")
    .reduce((sum, d) => sum + d.cents, 0);
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
    seed({ kind: "ADDITIONAL", cents: 2500, primaryInvoice: { cents: 30000 }, change: { invoice: "waiting" } });
    await dashboardRefund(500);
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 2000, stripe: 2000, receivable: 0 });
    expect(books().stripe).toBe(realStripe());
  });

  /**
   * #4324 (`INV-PAY-144`): a change invoice the reaper RETIRED still answers
   * the capture it names (`RETIRED_CODES_ANSWERING_CAPTURE`), though every row
   * the change has is CANCELLED - so the keep leaves it to the late-success
   * release and never raises the kept-capture invoice or a receipt beside it.
   */
  const keptRows = (queueType: string) => h.table("xeroSyncOperation").filter((r) => r.queueType === queueType);
  it("MUTATION (e2) a change invoice retired STALE_WAITING_PAYMENT is re-queued by the release and records the capture once", async () => {
    seed({ kind: "ADDITIONAL", cents: 2500, primaryInvoice: { cents: 30000 }, change: { invoice: "retired" } });
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 2500, stripe: 2500, receivable: 0 });
    expect(keptRows("KEPT_LATE_CAPTURE_INVOICE")).toHaveLength(0);
    expect(keptRows("ADDITIONAL_CAPTURE_RECEIPT")).toHaveLength(0);
    expect(keptRows("SUPPLEMENTARY_INVOICE")).toEqual([expect.objectContaining({ status: "SUCCEEDED" })]);
  });

  for (const retiredCode of ["STALE_WAITING_PAYMENT_CAPTURED", "STALE_WAITING_PAYMENT_COVERED"]) {
    it(`MUTATION (e2) a change invoice retired ${retiredCode} is left to the release: no kept invoice and no receipt beside it`, async () => {
      seed({ kind: "ADDITIONAL", cents: 2500, primaryInvoice: { cents: 30000 }, change: { invoice: "retired", retiredCode } });
      await keep();
      await runOutbox();
      expect(keptRows("KEPT_LATE_CAPTURE_INVOICE")).toHaveLength(0);
      expect(keptRows("ADDITIONAL_CAPTURE_RECEIPT")).toHaveLength(0);
      expect(keptRows("SUPPLEMENTARY_INVOICE")).toEqual([
        expect.objectContaining({ status: "CANCELLED", lastErrorCode: retiredCode }),
      ]);
    });
  }

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
    await createXeroKeptLateCaptureInvoice({ syncOperation: xeroClaim(row.id) }); // its check now reads DISMISSED
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
/**
 * #4324 (owner decision 25 Oct 2026, Q1 "split on the evidence";
 * `INV-PAY-144`): a kept CHANGE capture on a paid-cancelled booking whose
 * primary invoice exists. The paid cancel leaves the primary standing, so
 * where it bills the change it still shows the change owing; the capture is
 * then a payment on it (e3), never a second invoice. Where nothing bills the
 * change it is the kept-capture invoice (e4).
 */
describe("#4324: a kept change capture on an invoiced, paid-cancelled booking is counted once", () => {
  /** e3: $380 billed (the edit settled against the primary, #3980), $300 paid, $80 kept. */
  const e3 = () =>
    seed({ kind: "ADDITIONAL", cents: 8000, paidPrimary: { billedCents: 38000, paidCents: 30000 }, change: { settledAgainstPrimary: true } });
  /** e4: $300 billed and paid; the change's own $80 invoice was withdrawn, so nothing bills it. */
  const e4 = () =>
    seed({ kind: "ADDITIONAL", cents: 8000, paidPrimary: { billedCents: 30000, paidCents: 30000 }, change: { invoice: "withdrawn" } });
  const sent = () => h.state.ledger.filter((d) => !("existing" in d && d.existing) && !(d.kind === "payment" && d.date === "2026-05-01"));
  const rows = (queueType: string) => h.table("xeroSyncOperation").filter((r) => r.queueType === queueType);

  it("MUTATION (e3): pays the primary that bills the change - it is paid in full, and no kept invoice is raised", async () => {
    e3();
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 38000, stripe: 38000, receivable: 0 });
    expect(sent()).toEqual([expect.objectContaining({ kind: "payment", invoiceId: "inv_primary", cents: 8000, date: CAPTURE_DAY })]);
    expect(rows("KEPT_LATE_CAPTURE_INVOICE")).toHaveLength(0);
    expect(rows("ADDITIONAL_CAPTURE_RECEIPT")).toEqual([expect.objectContaining({ status: "SUCCEEDED" })]);
    expect(await readLateCaptureXeroReceipt(INTENT)).toEqual({ kind: "recorded", invoiceId: "inv_primary" });
  });

  it("(e3) a change that never had a supplementary invoice is billed by the primary too", async () => {
    seed({ kind: "ADDITIONAL", cents: 8000, paidPrimary: { billedCents: 38000, paidCents: 30000 }, change: {} });
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 38000, stripe: 38000, receivable: 0 });
  });

  it("(e3) a dashboard refund before the keep: the receipt, then its note - the Stripe account matches", async () => {
    e3();
    await dashboardRefund(8000);
    await keep();
    await runOutbox();
    await runOutbox();
    expect(books()).toEqual({ income: 30000, stripe: 30000, receivable: 0 });
    expect(books().stripe).toBe(30000 + realStripe());
    expect(refundNotes()).toEqual([expect.objectContaining({ cents: 8000, paymentIntentId: INTENT })]);
  });

  it("(e3) a dashboard refund after the receipt is in Xero is noted against it", async () => {
    e3();
    await keep();
    await runOutbox();
    await dashboardRefund(3000);
    await runOutbox();
    expect(books()).toEqual({ income: 35000, stripe: 35000, receivable: 0 });
    expect(books().stripe).toBe(30000 + realStripe());
  });

  it("MUTATION (e3) kept, reopened and refunded BEFORE the send: the receipt is withdrawn, nothing records the capture, no Stripe-account refund is posted", async () => {
    e3();
    await keep();
    reopen();
    await approve();
    await runOutbox();
    expect(rows("ADDITIONAL_CAPTURE_RECEIPT")).toEqual([
      expect.objectContaining({ status: "CANCELLED", lastErrorCode: "KEPT_LATE_CAPTURE_WITHDRAWN" }),
    ]);
    // Stripe holds the $300 the member paid; the primary still bills the
    // refunded change, as the paid cancel left it before the late capture.
    expect(books()).toEqual({ income: 38000, stripe: 30000, receivable: 8000 });
    expect(refundNotes()).toHaveLength(0);
    expect(await selfHealAfterGrace()).toBe(0);
  });

  it("(e3) kept, sent, then reopened and refunded AFTER the send: credited back by the refund note", async () => {
    e3();
    await keep();
    await runOutbox();
    reopen();
    await approve();
    await runOutbox();
    expect(books()).toEqual({ income: 30000, stripe: 30000, receivable: 0 });
    expect(books().stripe).toBe(30000 + realStripe());
  });

  it("MUTATION (e3) a re-keep after a reopen finds the receipt, and the capture is recorded once", async () => {
    e3();
    await keep();
    reopen();
    await keep();
    await runOutbox();
    expect(rows("ADDITIONAL_CAPTURE_RECEIPT")).toHaveLength(1);
    expect(books()).toEqual({ income: 38000, stripe: 38000, receivable: 0 });
  });

  it("MUTATION (e4): nothing bills the change, so the kept-capture invoice records it", async () => {
    e4();
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 38000, stripe: 38000, receivable: 0 });
    expect(rows("ADDITIONAL_CAPTURE_RECEIPT")).toHaveLength(0);
    expect(sent()).toEqual([
      expect.objectContaining({ kind: "invoice", cents: 8000, date: CAPTURE_DAY }),
      expect.objectContaining({ kind: "payment", cents: 8000, date: CAPTURE_DAY }),
    ]);
  });

  it("(e4) a dashboard refund nets it, and reopen then approve before the send records nothing", async () => {
    e4();
    await dashboardRefund(2000);
    await keep();
    await runOutbox();
    expect(books()).toEqual({ income: 36000, stripe: 36000, receivable: 0 });

    h.state.ledger = [];
    h.state.tables = {};
    e4();
    await keep();
    reopen();
    await approve();
    await runOutbox();
    expect(books()).toEqual({ income: 30000, stripe: 30000, receivable: 0 });
  });

  it("MUTATION (Q3): the repair tool records a historical keep once, however often it is applied", async () => {
    e3();
    task().status = "DISMISSED"; // kept before #4324: nothing was queued
    const action = () => ({
      key: `queue:kept-late-capture-record:${TASK}`,
      bookingId: BOOKING,
      type: "QUEUE_KEPT_LATE_CAPTURE_RECORD" as const,
      description: "",
      safeToAutoApply: true,
      payload: { manualRefundTaskId: TASK, bookingId: BOOKING, paymentIntentId: INTENT },
      status: "planned" as const,
      resultMessage: null,
    });
    const deps = { prisma: h.db, planKeptLateCaptureXeroRecord };
    for (let run = 0; run < 2; run += 1) {
      const planned = action();
      await applyActionsForPass([{ bookingId: BOOKING, actions: [planned] } as never], deps as never, false, CLUB_FORMAT_TEST, new Set());
      expect(planned.status).toBe("queued");
    }
    await runOutbox();
    expect(rows("ADDITIONAL_CAPTURE_RECEIPT")).toHaveLength(1);
    expect(books()).toEqual({ income: 38000, stripe: 38000, receivable: 0 });
  });
});

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

  it("R1 enqueue cap: asked for the payment's whole refunded total, the enqueue queues only the cash a note may answer", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await approve(); // a capture Xero never received, refunded: no note answers it
    const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
    payment.refundedAmountCents = (payment.refundedAmountCents as number) + 5000;
    h.table("paymentRefund").push({
      id: "re_ordinary",
      paymentId: PAYMENT,
      stripePaymentIntentId: "pi_ordinary",
      amountCents: 5000,
      status: "succeeded",
      stripeCreatedAt: new Date(),
      createdAt: new Date(),
    });
    const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT, 29000);
    const row = h.table("xeroSyncOperation").find((r) => r.id === queued.queueOperationId)!;
    expect((row.requestPayload as { refundAmountCents: number }).refundAmountCents).toBe(5000);
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

  it("N4: the note writer says whether it queued a note, so a caller claims none it did not queue", async () => {
    seed({});
    // No receipt in Xero yet: nothing to note.
    await expect(noteLateCaptureRefunds({ paymentId: PAYMENT, paymentIntentId: INTENT })).resolves.toBe(
      "nothing-owed",
    );
    await keep();
    await runOutbox();
    takeStripeRefund(4000);
    await expect(noteLateCaptureRefunds({ paymentId: PAYMENT, paymentIntentId: INTENT })).resolves.toBe(
      "queued",
    );
    // The same refund again: already noted, nothing queued.
    await expect(noteLateCaptureRefunds({ paymentId: PAYMENT, paymentIntentId: INTENT })).resolves.toBe(
      "nothing-owed",
    );
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

/**
 * #3635 composed review C2: the repair tool's late-capture refund arm, driven
 * for real (`applyActionsForPass` with the operator's forced key), with the
 * real record, the real per-capture note and the real enqueue.
 */
describe("C2: the repair tool's refund of a late capture Xero never received", () => {
  it("records it as the webhook does and posts no Stripe-account refund, then or at the self-heal", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    // The webhook never ran its late-capture handler: no task of either shape.
    h.state.tables.manualRefundTask = [];
    const action = {
      key: `late-capture-refund:${BOOKING}:${PAYMENT}:24000`,
      bookingId: BOOKING,
      type: "AUTO_REFUND_LATE_CAPTURED_PAYMENT" as const,
      description: "",
      safeToAutoApply: false,
      payload: {
        bookingId: BOOKING,
        paymentId: PAYMENT,
        refundAmountCents: 24000,
        allocation: [{ paymentTransactionId: "txn_late", amountCents: 24000 }],
        invoiceId: "inv_primary",
      },
      status: "planned" as const,
      resultMessage: null,
    };
    const deps = {
      refundPaymentTransactions: async () => {
        takeStripeRefund(24000);
        return {
          refunds: [{ paymentIntentId: INTENT, refundId: "re_repair", amountCents: 24000 }],
          totalRefundedAmountCents: 24000,
        };
      },
      recordAndNoteRepairedLateCaptureRefunds,
      enqueueXeroRefundCreditNoteOperation,
      // #4103: the repair reads the refunds recorded for each slice's key generation.
      prisma: h.db,
    };

    await applyActionsForPass(
      [{ bookingId: BOOKING, actions: [action] } as never],
      deps as never,
      false,
      CLUB_FORMAT_TEST,
      new Set([action.key]),
    );
    await runOutbox();

    expect(action.status).toBe("applied");
    expect(action.resultMessage).toMatch(/Xero never recorded pi_late/);
    // The webhook's own record names the intent, so it is a known late capture.
    expect(h.table("manualRefundTask")).toEqual([
      expect.objectContaining({ reason: cancelledBookingPrimaryPaymentRefundReason(INTENT), status: "DISMISSED" }),
    ]);
    expect(refundNotes()).toHaveLength(0);
    expect(await selfHealAfterGrace()).toBe(0);
    expect(refundNotes()).toHaveLength(0);
    // Only the pre-existing invoice and its clearing note: nothing moved in Xero,
    // as nothing net moved in Stripe.
    expect(books()).toEqual({ income: 0, stripe: 0, receivable: 0 });
    expect(books().stripe).toBe(realStripe());
  });
});

/**
 * #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit"; `INV-PAY-122`):
 * the treasurer approves refunding the late charge, every Stripe retry fails,
 * and they pay the member back by bank and close it as "Paid another way". The
 * charge never left the Stripe account, so Xero records it as a receipt, then a
 * bank-transfer refund note against it: the charge nets to nil, the Stripe
 * account shows the deposit and the bank account the payment.
 */
describe("round 6: a late charge's refund paid another way - record the receipt, then credit it", () => {
  const CLOSED_AT = new Date("2026-06-20T02:00:00.000Z"); // 20 Jun at the club
  const CLOSE = "close_1";

  /** "Refund to card", whose Stripe refund never goes through: its card refund row, retries spent. */
  async function approveButStripeGivesUp() {
    task().status = "COMPLETED";
    await settleKeptLateCaptureRecordOnApproval({ manualRefundTaskId: TASK, paymentIntentId: INTENT, store: h.db as never });
    h.table("paymentRecoveryOperation").push({
      id: "op_dead",
      idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(INTENT),
      status: "FAILED",
      attempts: 5,
    });
  }

  /** MODEL of the close's writes (see the file docblock), then the one Xero row it queues - the real enqueues. */
  async function closePaidAnotherWay(cents: number) {
    const recorded = (await readLateCaptureXeroReceipt(INTENT)).kind === "recorded";
    const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
    payment.refundedAmountCents = (payment.refundedAmountCents as number) + cents;
    h.table("manualRefundTask").push({
      id: CLOSE,
      bookingId: BOOKING,
      paymentId: PAYMENT,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      status: "COMPLETED",
      occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey("op_dead", {
        xeroRefundNote: recorded ? "now" : "after-receipt",
      }),
      amountCents: cents,
      completedAt: CLOSED_AT,
      completedByMemberId: "treasurer",
    });
    if (recorded) {
      await enqueueXeroRefundCreditNoteOperation(PAYMENT, cents, {
        refundMethod: "internet-banking",
        paidAnotherWayTaskId: CLOSE,
        store: h.db as never,
      });
    } else {
      const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
        manualRefundTaskId: TASK,
        bookingId: BOOKING,
        paymentIntentId: INTENT,
        capturedCents: capture().amountCents as number,
        capturedOn: CAPTURE_DAY,
        store: h.db as never,
      });
      expect(queued.queueOperationId).not.toBeNull();
    }
  }

  const noteRows = () => h.table("xeroSyncOperation").filter((r) => r.queueType === "REFUND_CREDIT_NOTE");
  const keptInvoices = () => h.state.ledger.filter((d) => d.kind === "invoice" && !d.existing);

  for (const primaryInvoice of [null, { cents: 30000 }]) {
    const label = primaryInvoice ? "(b) cleared invoice" : "(a) no invoice";

    it(`${label}: paid back in full - the receipt, then the note; nil income, the Stripe deposit and the bank payment`, async () => {
      seed({ primaryInvoice });
      await approveButStripeGivesUp();
      await closePaidAnotherWay(24000);

      // Before the receipt is in Xero: no note, and nothing may size one.
      expect(noteRows()).toHaveLength(0);
      const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
      expect((await resolveRefundNoteEligibleCash(payment as never)).eligibleCashCents).toBe(0);

      await runOutbox();

      expect(books()).toEqual({ income: 0, stripe: 24000, receivable: 0 });
      expect(books().stripe).toBe(realStripe());
      expect(bankAccount()).toBe(-24000);
      expect(keptInvoices()).toEqual([expect.objectContaining({ cents: 24000, date: CAPTURE_DAY })]);
      // Dated the day the treasurer closed it, and keyed on the close.
      expect(refundNotes()).toEqual([expect.objectContaining({ cents: 24000, date: "2026-06-20", refundMethod: "internet-banking" })]);
      expect(noteRows()).toEqual([expect.objectContaining({ correlationKey: expect.stringContaining(`paid-another-way:${CLOSE}`) })]);
      // Nothing is left for the nightly self-heal.
      expect(await selfHealAfterGrace()).toBe(0);
      expect(refundNotes()).toHaveLength(1);
    });

    it(`${label}: paid back in part - the GROSS receipt, a note for what was paid back, and the rest stays income`, async () => {
      seed({ primaryInvoice });
      await approveButStripeGivesUp();
      await closePaidAnotherWay(10000);
      await runOutbox();
      expect(books()).toEqual({ income: 14000, stripe: 24000, receivable: 0 });
      expect(bankAccount()).toBe(-10000);
      expect(await selfHealAfterGrace()).toBe(0);
    });

    it(`${label}: MUTATION - whatever order the outbox runs its rows in, the note never credits the booking's invoice`, async () => {
      seed({ primaryInvoice });
      await approveButStripeGivesUp();
      await closePaidAnotherWay(24000);
      // Notes first, then the receipt, then notes again.
      for (const note of noteRows().filter((r) => r.status === "PENDING")) await runRefundNoteModel(note);
      expect(refundNotes()).toHaveLength(0);
      await runOutbox();
      const noteLinks = h.table("xeroObjectLink").filter((l) => l.role === "REFUND_CREDIT_NOTE");
      const receipt = h.table("xeroObjectLink").find((l) => l.role === "KEPT_LATE_CAPTURE_INVOICE")!;
      expect(noteLinks).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ invoiceId: receipt.xeroObjectId }) }),
      ]);
      expect(books()).toEqual({ income: 0, stripe: 24000, receivable: 0 });
    });
  }

  it("(b) MUTATION: before the receipt is in Xero the nightly self-heal finds no gap, so it never raises a card note on the cleared invoice", async () => {
    seed({ primaryInvoice: { cents: 30000 } });
    await approveButStripeGivesUp();
    await closePaidAnotherWay(24000);
    const missing = await getRefundsMissingXeroCreditNotes({
      limit: 50,
      now: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });
    expect(missing.count).toBe(0);
  });

  it("a receipt already in Xero (kept and sent, then reopened and approved): the close's note is queued with it, and no second receipt", async () => {
    seed({});
    await keep();
    await runOutbox();
    reopen();
    await approveButStripeGivesUp();
    await closePaidAnotherWay(24000);
    expect(noteRows()).toHaveLength(1);
    await runOutbox();
    expect(books()).toEqual({ income: 0, stripe: 24000, receivable: 0 });
    expect(bankAccount()).toBe(-24000);
    expect(keptInvoices()).toHaveLength(1);
  });

  it("a receipt whose Stripe payment failed (PARTIAL) is retried: the payment is recorded, and the close's note is never queued twice", async () => {
    seed({});
    await approveButStripeGivesUp();
    await closePaidAnotherWay(24000);
    h.state.failNextPayment = true; // PARTIAL: the link is written, the payment is retried
    await runOutbox();
    expect(noteRows()).toHaveLength(1);
    const row = h.table("xeroSyncOperation").find((r) => r.queueType === "KEPT_LATE_CAPTURE_INVOICE")!;
    expect(row.status).toBe("PARTIAL");
    row.status = "RUNNING"; // the retry
    await createXeroKeptLateCaptureInvoice({ syncOperation: xeroClaim(row.id) });
    await runOutbox();
    // One note, never a second for the retry.
    expect(noteRows()).toHaveLength(1);
    expect(books()).toEqual({ income: 0, stripe: 24000, receivable: 0 });
    expect(bankAccount()).toBe(-24000);
  });
});


describe("#4131: a late capture is refunded from its own charge, never the fee the cancel kept on another", () => {
  // The booking was paid by a SECOND card charge after the first intent
  // stalled; the cancel kept a fee on it. The first intent then captures late.
  // Its row was attached at checkout, so it is OLDER than the charge that paid,
  // and a newest-first plan would take the fee first; the handler pins its own
  // charge instead (`lateCaptureOwnChargeSlice`).
  const OLDER = "pi_older";
  const CHARGED = 30000;
  const RETAINED = 5000;

  function seedFeeKeptOnAnotherCharge() {
    seed({});
    capture().createdAt = new Date("2026-05-01T00:00:00.000Z");
    h.table("paymentTransaction").push({
      id: "txn_older",
      paymentId: PAYMENT,
      kind: "PRIMARY",
      source: "STRIPE",
      stripePaymentIntentId: OLDER,
      status: "PARTIALLY_REFUNDED",
      amountCents: CHARGED,
      refundedAmountCents: CHARGED - RETAINED,
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
    });
    const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
    payment.xeroInvoiceId = "inv_primary";
    payment.refundedAmountCents = CHARGED - RETAINED;
    h.table("paymentRefund").push({
      id: "re_cancel",
      paymentId: PAYMENT,
      stripePaymentIntentId: OLDER,
      amountCents: CHARGED - RETAINED,
      status: "succeeded",
      stripeCreatedAt: new Date("2026-05-20T00:00:00.000Z"),
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
    });
    // In Xero before the late capture: the booking's invoice, its Stripe
    // payment, and the cancel's refund note for all but the kept fee.
    h.state.ledger.push({ kind: "invoice", id: "inv_primary", cents: CHARGED, date: "2026-05-02", existing: true });
    h.state.ledger.push({ kind: "payment", invoiceId: "inv_primary", cents: CHARGED, date: "2026-05-02" });
    h.state.ledger.push({ kind: "refund-note", cents: CHARGED - RETAINED, date: "2026-05-20" });
    h.writeLinks([
      {
        localModel: "Payment",
        localId: PAYMENT,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_cancel",
        role: "REFUND_CREDIT_NOTE",
        metadata: { amountCents: CHARGED - RETAINED, invoiceId: "inv_primary" },
      },
    ]);
  }

  /** One slice of the plan, recorded as `recordStripeRefundsAgainstTransaction` records it. */
  function refundSlice(transactionId: string, cents: number, status = "succeeded") {
    const row = h.table("paymentTransaction").find((r) => r.id === transactionId)!;
    if (status === "succeeded") {
      row.refundedAmountCents = (row.refundedAmountCents as number) + cents;
      const payment = h.table("payment").find((p) => p.id === PAYMENT)!;
      payment.refundedAmountCents = (payment.refundedAmountCents as number) + cents;
    }
    h.table("paymentRefund").push({
      id: h.id("re"),
      paymentId: PAYMENT,
      stripePaymentIntentId: row.stripePaymentIntentId,
      amountCents: cents,
      status,
      stripeCreatedAt: new Date(),
      createdAt: new Date(),
    });
  }

  /** The primary handler's slice for the capture's amount, from the REAL rule (`lateCaptureOwnChargeSlice`). */
  function automaticPlan() {
    return [lateCaptureOwnChargeSlice(capture() as never, capture().amountCents as number).slice];
  }

  /** What the Stripe account really holds from this booking, net of every refund. */
  function realStripeAllCharges() {
    return h
      .table("paymentTransaction")
      .reduce((sum, row) => sum + (row.amountCents as number) - (row.refundedAmountCents as number), 0);
  }

  function refundedAutomatically() {
    const row = task();
    row.lateCaptureApprovalIntentId = null;
    row.status = "DISMISSED";
    row.reason = cancelledBookingPrimaryPaymentRefundReason(INTENT);
  }

  it("the refund is one slice on the capture's own charge, where the old newest-first plan took the kept fee first", () => {
    seedFeeKeptOnAnotherCharge();
    // The hazard: the payment-wide planner the handler used before #4131.
    expect(planCardRefundFromLedger(h.table("paymentTransaction") as never, 24000).slices).toEqual([
      { paymentTransactionId: "txn_older", amountCents: RETAINED },
      { paymentTransactionId: "txn_late", amountCents: 24000 - RETAINED },
    ]);
    expect(automaticPlan()).toEqual([{ paymentTransactionId: "txn_late", amountCents: 24000 }]);
  });

  it("refunded automatically, no receipt: Xero still matches the Stripe account, and the self-heal raises nothing", async () => {
    seedFeeKeptOnAnotherCharge();
    refundedAutomatically();
    for (const slice of automaticPlan()) refundSlice(slice.paymentTransactionId, slice.amountCents);
    await expect(noteLateCaptureRefunds({ paymentId: PAYMENT, paymentIntentId: INTENT })).resolves.toBe("nothing-owed");
    await runOutbox();
    expect(realStripeAllCharges()).toBe(RETAINED);
    expect(books().stripe).toBe(realStripeAllCharges());
    expect(await selfHealAfterGrace()).toBe(0);
    expect(books()).toEqual({ income: RETAINED, stripe: RETAINED, receivable: 0 });
  });

  it("refused, then kept: nothing was made beside the refusal, and the receipt matches the Stripe account at once", async () => {
    seedFeeKeptOnAnotherCharge();
    const [late] = automaticPlan();
    refundSlice(late.paymentTransactionId, late.amountCents, "failed");
    await expect(noteLateCaptureRefunds({ paymentId: PAYMENT, paymentIntentId: INTENT })).resolves.toBe("nothing-owed");
    await keep();
    await runOutbox();
    expect(realStripeAllCharges()).toBe(RETAINED + 24000);
    expect(books().stripe).toBe(realStripeAllCharges());
    expect(await selfHealAfterGrace()).toBe(0);
  });

  it("a capture already part refunded in the dashboard: only what it holds is refunded, the fee is untouched, and the books agree", async () => {
    seedFeeKeptOnAnotherCharge();
    refundedAutomatically();
    takeStripeRefund(4000); // the dashboard, synced onto the capture's own row
    const { slice, shortCents } = lateCaptureOwnChargeSlice(capture() as never, 24000);
    expect(slice).toEqual({ paymentTransactionId: "txn_late", amountCents: 20000 });
    expect(shortCents).toBe(4000);
    refundSlice(slice.paymentTransactionId, slice.amountCents);
    await runOutbox();
    expect(h.table("paymentTransaction").find((r) => r.id === "txn_older")!.refundedAmountCents).toBe(CHARGED - RETAINED);
    expect(realStripeAllCharges()).toBe(RETAINED);
    expect(books().stripe).toBe(realStripeAllCharges());
    expect(await selfHealAfterGrace()).toBe(0);
  });
});

describe("#4078: approved late-capture refund audit wire compatibility", () => {
  it.each([
    ["modification", "modification_additional"],
    ["primary", "primary"],
    [null, null],
  ] as const)("preserves kind for %s captures", async (captureKind, kind) => {
    seed({});
    const refund = {
      bookingId: BOOKING,
      paymentId: PAYMENT,
      paymentIntentId: INTENT,
      amountCents: 2500,
      refundId: "re_4078",
      captureKind,
      approvedByMemberId: "treasurer_4078",
      manualRefundTaskId: "task_4078",
    };
    await finishApprovedLateCaptureRefund(refund);
    expect(logAudit).toHaveBeenCalledWith({
      action: "booking.payment.refunded_after_cancellation",
      category: "payment",
      memberId: refund.approvedByMemberId,
      entityType: "Booking",
      entityId: BOOKING,
      targetId: BOOKING,
      details: JSON.stringify({
        paymentIntentId: INTENT,
        refundId: refund.refundId,
        amountCents: refund.amountCents,
        kind,
        approvedByMemberId: refund.approvedByMemberId,
        manualRefundTaskId: refund.manualRefundTaskId,
      }),
    });
  });
});
