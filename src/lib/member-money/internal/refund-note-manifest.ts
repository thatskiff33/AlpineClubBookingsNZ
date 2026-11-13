import { Prisma, type MemberMoneyAccount, type MemberMoneyExportDocumentRole } from "@prisma/client";
import type { LineItem } from "xero-node";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { asRecord, readString } from "../../xero-json";
import type { CashRefundMethod } from "../../xero-refund-method";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { refundObligationChain } from "./refund-family";
import { planRefundNote, type RefundExportComponent, type RefundExportPlan, type RefundExportProblem } from "./refund-note-plan";
import { planRefundNotePayment } from "./refund-payment-plan";
import { writeExportManifest } from "./store";

/**
 * A REFUND NOTE'S AND ITS PAYMENT'S EXPORT MANIFESTS, FOR THE SENDERS (#4525,
 * Ledger M13). `createXeroCreditNote` records the note once it is recorded, and
 * the settlement leg records the payment once it is paid; each in a short
 * transaction of its own, on the one manifest ALP-218 added (no second manifest,
 * no delivery record). Nothing here changes what is sent or how the sync
 * operation ends: a failure is logged and swallowed.
 *
 * First write wins. The same role and legacy key keeps its first row; a
 * provider object already recorded under this booking is not recorded again
 * under another key; and a component an earlier document of the same role
 * already covers is recorded as CONFLICT `ALREADY_COVERED`, with no coverage,
 * so a reissue after a void never counts its debt twice. The unique
 * `(documentRole, account, chargeIdentity)` is the last word; a race that
 * loses to it (P2002) is swallowed.
 *
 * No advisory lock: the manifest changes no booking status, capacity or
 * settlement money, so it joins neither `pg_advisory_xact_lock(1)` nor the
 * lodge capacity lock (`INV-LOCK-001`); its unique keys are the exclusion.
 */

type Db = Prisma.TransactionClient;

/** The door a refund note answers, as its sync operation's payload records it. */
export interface RefundNoteDoor {
  cardRefundId?: string | null;
  paidAnotherWayTaskId?: string | null;
  handBackTaskId?: string | null;
  refundRequestId?: string | null;
  reviewTaskId?: string | null;
}

/** The door fields a stored refund-note payload carries (`recordedPayloadFields`). */
export function refundNoteDoorOfPayload(payload: unknown): RefundNoteDoor {
  const record = asRecord(payload);
  return {
    cardRefundId: readString(record?.cardRefundId),
    paidAnotherWayTaskId: readString(record?.paidAnotherWayTaskId),
    handBackTaskId: readString(record?.handBackTaskId),
    refundRequestId: readString(record?.refundRequestId),
    reviewTaskId: readString(record?.reviewTaskId),
  };
}

/** The bank-side cash event a door's note is paid by, if any: R12 (or its answer), R14, or a hand-back's payment. */
function cashEventKeys(door: RefundNoteDoor): { keys: MemberMoneyEventKey[]; account: "STRIPE_CLEARING" | "BANK" } | null {
  if (door.paidAnotherWayTaskId) return { keys: [memberMoneyEventKeys.paidAnotherWay(door.paidAnotherWayTaskId)], account: "BANK" };
  if (door.handBackTaskId) return { keys: [memberMoneyEventKeys.handBackPaid(door.handBackTaskId)], account: "BANK" };
  if (door.cardRefundId) {
    return { keys: [memberMoneyEventKeys.refund(door.cardRefundId), memberMoneyEventKeys.refundAnswer(door.cardRefundId)], account: "STRIPE_CLEARING" };
  }
  return null;
}

const OBLIGATION_SELECT = {
  obligationKey: true,
  kind: true,
  faceCents: true,
  journal: { select: { reversedBy: { select: { id: true } } } },
} as const;

type ObligationRow = Prisma.MemberMoneyObligationGetPayload<{ select: typeof OBLIGATION_SELECT }>;

function obligationComponent(obligation: ObligationRow | null | undefined, named: string): RefundExportComponent | RefundExportProblem {
  if (!obligation) return { problem: `no refund debt is posted for ${named}` };
  if (obligation.kind !== "REFUND") return { problem: `${obligation.obligationKey} is not a refund debt` };
  if (obligation.journal.reversedBy) return { problem: `refund debt ${obligation.obligationKey} was reversed` };
  return { account: "REFUND_PAYABLE", chargeIdentity: obligation.obligationKey, cents: obligation.faceCents };
}

/** The one live refund debt (R05) a note answers, read from its door; a watermark note names none. */
export async function resolveRefundNoteObligation(db: Db, door: RefundNoteDoor): Promise<RefundExportComponent | RefundExportProblem> {
  const cash = cashEventKeys(door);
  if (cash) {
    for (const eventKey of cash.keys) {
      const event = await db.memberMoneyEvent.findUnique({
        where: { eventKey },
        select: { journal: { select: { applications: { select: { obligation: { select: OBLIGATION_SELECT } } } } } },
      });
      if (!event) continue;
      const debts = [...new Map((event.journal?.applications ?? []).map((a) => [a.obligation.obligationKey, a.obligation])).values()];
      if (debts.length !== 1) return { problem: `cash event ${eventKey} pays ${debts.length} refund debts, not one` };
      return obligationComponent(debts[0], eventKey);
    }
    return { problem: `no cash event is posted for ${cash.keys.join(" or ")}` };
  }
  const chained = door.refundRequestId ? { scope: "refund-request" as const, id: door.refundRequestId }
    : door.reviewTaskId ? { scope: "review" as const, id: door.reviewTaskId } : null;
  if (!chained) return { problem: "a note sized on the payment's watermark answers no one refund debt" };
  const { live } = await refundObligationChain(db, chained.scope, chained.id);
  if (!live) return { problem: `no live refund debt is posted for ${chained.scope} ${chained.id}` };
  return obligationComponent(await db.memberMoneyObligation.findUnique({ where: { obligationKey: live }, select: OBLIGATION_SELECT }), live);
}

/** The cash slice a note's payment records: the whole of its R12 on clearing, or its R14 or hand-back on BANK. */
export async function resolveRefundNoteCash(db: Db, door: RefundNoteDoor): Promise<RefundExportComponent | RefundExportProblem> {
  const cash = cashEventKeys(door);
  if (!cash) return { problem: "the note answers no recorded cash event" };
  // The R12 itself is the slice; an answer applies it later and moves no cash.
  const eventKey = cash.keys[0]!;
  const event = await db.memberMoneyEvent.findUnique({
    where: { eventKey },
    select: { journal: { select: { lines: { select: { account: true, side: true, amountCents: true } } } } },
  });
  if (!event?.journal) return { problem: `no cash event is posted for ${eventKey}` };
  const credits = event.journal.lines.filter((line) => line.account === cash.account && line.side === "CREDIT");
  if (credits.length === 0) return { problem: `cash event ${eventKey} moves nothing on ${cash.account}` };
  return { account: cash.account, chargeIdentity: eventKey, cents: credits.reduce((sum, line) => sum + line.amountCents, 0) };
}

/**
 * Write a plan under `role`, first write wins, in the caller's transaction:
 * a provider object this booking already recorded under the role is left; a
 * component already covered becomes CONFLICT `ALREADY_COVERED`.
 */
async function writeRefundExportManifest(db: Db, input: {
  role: MemberMoneyExportDocumentRole;
  bookingId: string;
  providerObjectId: string;
  plan: RefundExportPlan;
}): Promise<{ result: "WRITTEN" | "SAME" | "KEPT_FIRST" | "RECORDED_UNDER_ANOTHER_KEY"; plan: RefundExportPlan }> {
  const { role, bookingId, providerObjectId } = input;
  let plan = input.plan;
  const recorded = await db.memberMoneyExportManifest.findFirst({
    where: { bookingId, documentRole: role, providerInvoiceId: providerObjectId, NOT: { legacyKey: plan.legacyKey } },
    select: { id: true },
  });
  if (recorded) return { result: "RECORDED_UNDER_ANOTHER_KEY", plan };
  if (plan.outcome === "COVERED") {
    const taken = await db.memberMoneyExportCoverage.findFirst({
      where: { documentRole: role, OR: plan.coverage.map((c) => ({ account: c.account as MemberMoneyAccount, chargeIdentity: c.chargeIdentity })) },
      select: { chargeIdentity: true },
    });
    if (taken) {
      plan = {
        legacyKey: plan.legacyKey, payloadHash: plan.payloadHash, frozenMapping: plan.frozenMapping, lineTotalCents: plan.lineTotalCents,
        outcome: "CONFLICT", reason: "ALREADY_COVERED", problem: `${taken.chargeIdentity} is already covered by an earlier ${role}`,
      };
    }
  }
  const settled = plan;
  const result = await writeExportManifest(db, {
    documentRole: role,
    legacyKey: settled.legacyKey,
    bookingId,
    outcome: settled.outcome,
    reason: settled.outcome === "CONFLICT" ? settled.reason : null,
    payloadHash: settled.payloadHash,
    frozenMapping: settled.frozenMapping as Prisma.InputJsonObject,
    lineTotalCents: settled.lineTotalCents,
    providerInvoiceId: providerObjectId,
    coverage: settled.outcome === "COVERED" ? settled.coverage : [],
  });
  return { result, plan: settled };
}

/** Run one recording, logging and swallowing every failure (a P2002 race lost is the first row standing). */
async function recordSafely(role: MemberMoneyExportDocumentRole, context: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      logger.info({ ...context, role }, "Another run recorded this refund document's manifest first; the first row stands");
      return;
    }
    logger.error({ err: error, ...context, role }, "Could not record a refund document's export manifest; the send is unchanged");
  }
}

function logOutcome(role: MemberMoneyExportDocumentRole, context: Record<string, unknown>, written: Awaited<ReturnType<typeof writeRefundExportManifest>>) {
  if (written.plan.outcome === "CONFLICT" && written.result === "WRITTEN") {
    logger.warn({ ...context, role, reason: written.plan.reason, problem: written.plan.problem },
      "A refund document does not match the journal; its manifest records a conflict and the document still sent");
  } else if (written.result === "KEPT_FIRST") {
    logger.info({ ...context, role }, "A refund document's manifest was already recorded differently; the first row stands");
  }
}

export type RefundNoteManifestSource =
  /** The note this run built and Xero just returned: its lines, its key and its door. */
  | { kind: "BUILT"; lines: LineItem[]; legacyKey: string; door: RefundNoteDoor }
  /** A note an earlier operation raised: its stored request is read, never rebuilt. Null finds the row by the note. */
  | { kind: "REPLAY"; operationId: string | null };

/** Read a replay's stored note lines, key and door, or null when no row stores them. */
async function readStoredRefundNote(paymentId: string, creditNoteId: string, operationId: string | null) {
  const rows = await prisma.xeroSyncOperation.findMany({
    where: operationId ? { id: operationId }
      : { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, xeroObjectId: creditNoteId },
    orderBy: { createdAt: "asc" },
    select: { idempotencyKey: true, correlationKey: true, requestPayload: true },
  });
  for (const row of rows) {
    const note = asRecord(asRecord(row.requestPayload)?.creditNotes && (asRecord(row.requestPayload)!.creditNotes as unknown[])[0]);
    const lines = Array.isArray(note?.lineItems) ? (note!.lineItems as LineItem[]) : null;
    const legacyKey = row.idempotencyKey ?? row.correlationKey;
    if (lines && lines.length > 0 && legacyKey) return { lines, legacyKey, door: refundNoteDoorOfPayload(row.requestPayload) };
  }
  return null;
}

/** Record the REFUND_NOTE manifest for a note Xero holds. Never throws. */
export async function recordRefundNoteManifest(input: {
  paymentId: string;
  bookingId: string;
  creditNoteId: string;
  source: RefundNoteManifestSource;
}): Promise<void> {
  const context = { paymentId: input.paymentId, bookingId: input.bookingId, creditNoteId: input.creditNoteId };
  await recordSafely("REFUND_NOTE", context, async () => {
    const stored = input.source.kind === "BUILT"
      ? { lines: input.source.lines, legacyKey: input.source.legacyKey, door: input.source.door }
      : await readStoredRefundNote(input.paymentId, input.creditNoteId, input.source.operationId);
    if (!stored) return;
    const source = input.source.kind === "BUILT" ? "BUILT" : "STORED_REQUEST";
    const written = await prisma.$transaction(async (tx) => writeRefundExportManifest(tx, {
      role: "REFUND_NOTE",
      bookingId: input.bookingId,
      providerObjectId: input.creditNoteId,
      plan: planRefundNote({ lines: stored.lines, legacyKey: stored.legacyKey, source, obligation: await resolveRefundNoteObligation(tx, stored.door) }),
    }));
    logOutcome("REFUND_NOTE", context, written);
  });
}

/** The payment one settlement leg just sent and Xero accepted, as `settleRefundCreditNote` reports it. */
export interface SentRefundNotePayment {
  xeroPaymentId: string;
  amountCents: number;
  bankCode: string;
  paymentDate: string;
}

/**
 * Record the REFUND_NOTE_PAYMENT manifest for a payment this leg made. The door
 * is read from the operation that raised the note. Never throws.
 */
export async function recordRefundNotePaymentManifest(input: {
  paymentId: string;
  creditNoteId: string;
  operationId: string;
  refundMethod: CashRefundMethod;
  /** `refundCreditNotePaymentIdempotencyKey(paymentId, creditNoteId)`. */
  legacyKey: string;
  sent: SentRefundNotePayment;
}): Promise<void> {
  const context = { paymentId: input.paymentId, creditNoteId: input.creditNoteId, xeroPaymentId: input.sent.xeroPaymentId };
  await recordSafely("REFUND_NOTE_PAYMENT", context, async () => {
    const [payment, operation] = await Promise.all([
      prisma.payment.findUnique({ where: { id: input.paymentId }, select: { bookingId: true } }),
      prisma.xeroSyncOperation.findUnique({ where: { id: input.operationId }, select: { requestPayload: true } }),
    ]);
    if (!payment) return;
    const door = refundNoteDoorOfPayload(operation?.requestPayload);
    const written = await prisma.$transaction(async (tx) => writeRefundExportManifest(tx, {
      role: "REFUND_NOTE_PAYMENT",
      bookingId: payment.bookingId,
      providerObjectId: input.sent.xeroPaymentId,
      plan: planRefundNotePayment({
        paymentId: input.paymentId,
        creditNoteId: input.creditNoteId,
        amountCents: input.sent.amountCents,
        bankCode: input.sent.bankCode,
        paymentDate: input.sent.paymentDate,
        refundMethod: input.refundMethod,
        legacyKey: input.legacyKey,
        cash: await resolveRefundNoteCash(tx, door),
      }),
    }));
    logOutcome("REFUND_NOTE_PAYMENT", context, written);
  });
}
