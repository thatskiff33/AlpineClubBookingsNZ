import { Prisma, type MemberMoneyAccount, type MemberMoneyExportDocumentRole } from "@prisma/client";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";
import type { LineItem } from "xero-node";
import { prisma } from "../../prisma";
import logger from "../../logger";
import { asRecord, readString, storedInvoiceRequestLines } from "../../xero-json";
import type { CashRefundMethod } from "../../xero-refund-method";
import { CARD_REFUND_STILL_OWED_ORIGIN_SELECT, cardRefundStillOwedOrigin } from "../../card-refund-still-owed-origin";
import { paymentRecoveryOperationIdOfPaidAnotherWay } from "../../manual-refund-task-settlement-rules";
import { cardRefundRowFailedRefundIds } from "../../open-card-refund-owed";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { eventPosted } from "./booking-journal-read";
import { memberMoneyChainTip, refundObligationChain } from "./refund-family";
import { appliedObligationsOfEvents, cardRefundAppliedObligations } from "./refund-obligation-map";
import { planFailedLaterRefundReversal, planRefundNote, type RefundExportComponent, type RefundExportPlan, type RefundExportProblem } from "./refund-note-plan";
import { planRefundNotePayment } from "./refund-payment-plan";
import type { XeroTaxRendering } from "../../xero-tax-rendering";
import { writeExportManifest } from "./store";

/**
 * A REFUND NOTE'S, ITS PAYMENT'S AND A FAILED-LATER REFUND REVERSAL'S EXPORT
 * MANIFESTS, FOR THE SENDERS (#4525, Ledger M13). `createXeroCreditNote` records
 * the note once it is recorded, the settlement leg records the payment once it
 * is paid, and `createXeroCardRefundReversalInvoice` records the reversal
 * invoice once its operation completes; each in a short
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

/**
 * The cash event a door's note is paid by: a card refund's R12 (or the answer that applied it) on STRIPE_CLEARING,
 * or an R14 on BANK. Bank keys are read from what is posted, not from which field is set: a cancellation hand-back
 * noted on its own record names `paidAnotherWayTaskId` (and often `handBackTaskId`) but posts its R14 under
 * `handBackPaid(task)`, and a close posts under `paidAnotherWay(record)`. Each base key is walked to its live chain
 * tip, so an R14 reversed and re-posted resolves to its successor, never the reversed one.
 */
type CashEvent =
  | { kind: "CARD"; stripeRefundId: string; keys: MemberMoneyEventKey[]; account: "STRIPE_CLEARING" }
  | { kind: "BANK"; keys: MemberMoneyEventKey[]; account: "BANK" };

/** The R14 base keys a door may have posted under, most specific first. */
function bankCashKeys(door: RefundNoteDoor): MemberMoneyEventKey[] {
  const keys: MemberMoneyEventKey[] = [];
  if (door.handBackTaskId) keys.push(memberMoneyEventKeys.handBackPaid(door.handBackTaskId));
  if (door.paidAnotherWayTaskId) {
    keys.push(memberMoneyEventKeys.paidAnotherWay(door.paidAnotherWayTaskId), memberMoneyEventKeys.handBackPaid(door.paidAnotherWayTaskId));
  }
  return [...new Set(keys)];
}

/** The first of `bases` whose live tip is posted, else every tip (for the problem message); null when none is posted and `onlyIfPosted`. */
async function postedBankCash(db: Db, bases: MemberMoneyEventKey[], onlyIfPosted: boolean): Promise<CashEvent | null> {
  const tips: MemberMoneyEventKey[] = [];
  for (const base of bases) {
    const tip = await memberMoneyChainTip(db, base);
    if (await eventPosted(db, tip)) return { kind: "BANK", keys: [tip], account: "BANK" };
    tips.push(tip);
  }
  return onlyIfPosted || tips.length === 0 ? null : { kind: "BANK", keys: tips, account: "BANK" };
}

/**
 * `reviewHandBack`: a review's note that names no other door is paid by the hand-back the review closed by hand
 * (`postHandBackCompletion` posts its R14 under `handBackPaid(reviewTaskId)`), when one is posted.
 */
async function cashEventOf(db: Db, door: RefundNoteDoor, options: { reviewHandBack: boolean }): Promise<CashEvent | null> {
  const bank = bankCashKeys(door);
  if (bank.length > 0) return postedBankCash(db, bank, false);
  if (door.cardRefundId) {
    return { kind: "CARD", stripeRefundId: door.cardRefundId, account: "STRIPE_CLEARING",
      keys: [memberMoneyEventKeys.refund(door.cardRefundId), memberMoneyEventKeys.refundAnswer(door.cardRefundId)] };
  }
  if (options.reviewHandBack && door.reviewTaskId) return postedBankCash(db, [memberMoneyEventKeys.handBackPaid(door.reviewTaskId)], true);
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

/** The debts a cash event applied, with the event that applied them, through the one reader in `refund-obligation-map.ts`. */
async function appliedByCash(db: Db, cash: CashEvent): Promise<{ eventKey: string; obligationKeys: string[] } | null> {
  // An R12 posted unapplied pays no debt itself; its answer (Dr RP, Cr AR) names the debt later.
  if (cash.kind === "CARD") return cardRefundAppliedObligations(db, cash.stripeRefundId);
  return appliedObligationsOfEvents(db, cash.keys);
}

/** The one live refund debt (R05) a note answers, read from its door; a watermark note names none. */
export async function resolveRefundNoteObligation(db: Db, door: RefundNoteDoor): Promise<RefundExportComponent | RefundExportProblem> {
  const cash = await cashEventOf(db, door, { reviewHandBack: false });
  if (cash) {
    const applied = await appliedByCash(db, cash);
    if (!applied) return { problem: `no cash event posted for ${cash.keys.join(" or ")} pays a refund debt` };
    if (applied.obligationKeys.length !== 1) return { problem: `cash event ${applied.eventKey} pays ${applied.obligationKeys.length} refund debts, not one` };
    const [key] = applied.obligationKeys as [string];
    return obligationComponent(await db.memberMoneyObligation.findUnique({ where: { obligationKey: key }, select: OBLIGATION_SELECT }), applied.eventKey);
  }
  const chained = door.refundRequestId ? { scope: "refund-request" as const, id: door.refundRequestId }
    : door.reviewTaskId ? { scope: "review" as const, id: door.reviewTaskId } : null;
  if (!chained) return { problem: "a note sized on the payment's watermark answers no one refund debt" };
  const { live } = await refundObligationChain(db, chained.scope, chained.id);
  if (!live) return { problem: `no live refund debt is posted for ${chained.scope} ${chained.id}` };
  return obligationComponent(await db.memberMoneyObligation.findUnique({ where: { obligationKey: live }, select: OBLIGATION_SELECT }), live);
}

/**
 * The cash slice a note's payment records: the whole of its R12 on clearing, or its R14 on BANK. A reversed cash
 * journal is no live slice. A hand-back paid "In cash" posts its R14 on CASH while its Xero payment settles to the
 * bank code, so it moves nothing on BANK and is a known COMPONENT_UNUSABLE conflict (member-money-ledger.md).
 */
export async function resolveRefundNoteCash(db: Db, door: RefundNoteDoor): Promise<RefundExportComponent | RefundExportProblem> {
  const cash = await cashEventOf(db, door, { reviewHandBack: true });
  if (!cash) return { problem: "the note answers no recorded cash event" };
  // The R12 itself is the slice; an answer applies it later and moves no cash.
  const eventKey = cash.keys[0]!;
  const event = await db.memberMoneyEvent.findUnique({
    where: { eventKey },
    select: { journal: { select: { reversedBy: { select: { id: true } }, lines: { select: { account: true, side: true, amountCents: true } } } } },
  });
  if (!event?.journal) return { problem: `no cash event is posted for ${cash.keys.join(" or ")}` };
  if (event.journal.reversedBy) return { problem: `cash event ${eventKey} was reversed` };
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
    if (isPrismaKnownUniqueConstraintError(error)) {
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
  /** The note this run built and Xero just returned: its lines, its key, its door and the booking's tax rendering it was sent with (#4632). */
  | { kind: "BUILT"; lines: LineItem[]; legacyKey: string; door: RefundNoteDoor; taxRendering: XeroTaxRendering }
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
    // #4632: the basis the stored note was raised under, frozen beside its lines.
    const lineAmountTypes = typeof note?.lineAmountTypes === "string" ? note.lineAmountTypes : null;
    if (lines && lines.length > 0 && legacyKey) return { lines, legacyKey, lineAmountTypes, door: refundNoteDoorOfPayload(row.requestPayload) };
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
      ? { lines: input.source.lines, legacyKey: input.source.legacyKey, lineAmountTypes: input.source.taxRendering.lineAmountTypes, door: input.source.door }
      : await readStoredRefundNote(input.paymentId, input.creditNoteId, input.source.operationId);
    if (!stored) return;
    const source = input.source.kind === "BUILT" ? "BUILT" : "STORED_REQUEST";
    const written = await prisma.$transaction(async (tx) => writeRefundExportManifest(tx, {
      role: "REFUND_NOTE",
      bookingId: input.bookingId,
      providerObjectId: input.creditNoteId,
      plan: planRefundNote({ lines: stored.lines, legacyKey: stored.legacyKey, source, lineAmountTypes: stored.lineAmountTypes, obligation: await resolveRefundNoteObligation(tx, stored.door) }),
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

/**
 * The R13 a paid-another-way close's reversal invoice answers: the close's
 * record names the card refund row it closed, that row (or, for a still-owed
 * rest, the row it was first owed on) names the refund Stripe failed later, and
 * that refund's R12 names the reversal batch (`reversal:<journalId>`) whose
 * Stripe-clearing debit put the cash back. A row naming no failed refund, or
 * several, answers no one R13.
 */
async function resolveFailedLaterRefundReversal(db: Db, closeTaskId: string): Promise<RefundExportComponent | RefundExportProblem> {
  const close = await db.manualRefundTask.findUnique({ where: { id: closeTaskId }, select: { kind: true, occurrenceKey: true } });
  const operationId = close ? paymentRecoveryOperationIdOfPaidAnotherWay(close) : null;
  if (!operationId) return { problem: `close ${closeTaskId} is not a card refund's paid-another-way close` };
  const closed = await db.paymentRecoveryOperation.findUnique({ where: { id: operationId }, select: CARD_REFUND_STILL_OWED_ORIGIN_SELECT });
  if (!closed) return { problem: `the card refund row ${operationId} close ${closeTaskId} names is gone` };
  const row = (await cardRefundStillOwedOrigin(db, closed.idempotencyKey)) ?? closed;
  const failed = cardRefundRowFailedRefundIds(row);
  if (failed.length !== 1) return { problem: `card refund row ${row.id} is owed for ${failed.length} failed refunds, not one` };
  const r12Key = memberMoneyEventKeys.refund(failed[0]!);
  const r12 = await db.memberMoneyEvent.findUnique({ where: { eventKey: r12Key }, select: { journal: { select: { id: true } } } });
  if (!r12?.journal) return { problem: `no card refund cash is posted for ${r12Key}` };
  const eventKey = memberMoneyEventKeys.reversal(r12.journal.id);
  const reversal = await db.memberMoneyEvent.findUnique({
    where: { eventKey },
    select: { journal: { select: { reversedBy: { select: { id: true } }, lines: { select: { account: true, side: true, amountCents: true } } } } },
  });
  if (!reversal?.journal) return { problem: `${r12Key} is not reversed: no ${eventKey} is posted` };
  // As for a note's cash (`resolveRefundNoteCash`): an undone R13 is no live slice.
  if (reversal.journal.reversedBy) return { problem: `${eventKey} was itself reversed` };
  const debits = reversal.journal.lines.filter((line) => line.account === "STRIPE_CLEARING" && line.side === "DEBIT");
  if (debits.length === 0) return { problem: `${eventKey} moves nothing back onto STRIPE_CLEARING` };
  return { account: "STRIPE_CLEARING", chargeIdentity: eventKey, cents: debits.reduce((sum, line) => sum + line.amountCents, 0) };
}

export type FailedLaterRefundReversalManifestSource =
  /** The line this run built and Xero just accepted, and the booking's tax rendering it was sent with (#4632). */
  | { kind: "BUILT"; lines: LineItem[]; taxRendering: XeroTaxRendering }
  /** An invoice an earlier attempt raised: the operation's stored request is read, never rebuilt. */
  | { kind: "REPLAY"; operationId: string };

/**
 * A replay's stored invoice lines and the basis that stored invoice was raised
 * under (`storedInvoiceRequestLines`, #4632), or null when the row stores no lines.
 */
async function readStoredReversal(operationId: string): Promise<{ lines: LineItem[]; lineAmountTypes: string | null } | null> {
  const row = await prisma.xeroSyncOperation.findUnique({ where: { id: operationId }, select: { requestPayload: true } });
  const { storedLines, storedLineAmountTypes } = storedInvoiceRequestLines(row?.requestPayload);
  return storedLines ? { lines: storedLines, lineAmountTypes: storedLineAmountTypes } : null;
}

/**
 * Record the FAILED_LATER_REFUND_REVERSAL manifest for a reversal invoice Xero
 * holds, under the key it was sent with. Never throws.
 */
export async function recordFailedLaterRefundReversalManifest(input: {
  paymentId: string;
  bookingId: string;
  closeTaskId: string;
  invoiceId: string;
  /** `cardRefundReversalInvoiceKey(paymentId, closeTaskId)`. */
  legacyKey: string;
  source: FailedLaterRefundReversalManifestSource;
}): Promise<void> {
  const context = { paymentId: input.paymentId, bookingId: input.bookingId, closeTaskId: input.closeTaskId, invoiceId: input.invoiceId };
  await recordSafely("FAILED_LATER_REFUND_REVERSAL", context, async () => {
    const stored = input.source.kind === "BUILT"
      ? { lines: input.source.lines, lineAmountTypes: input.source.taxRendering.lineAmountTypes }
      : await readStoredReversal(input.source.operationId);
    if (!stored) return;
    const source = input.source.kind === "BUILT" ? "BUILT" : "STORED_REQUEST";
    const written = await prisma.$transaction(async (tx) => writeRefundExportManifest(tx, {
      role: "FAILED_LATER_REFUND_REVERSAL",
      bookingId: input.bookingId,
      providerObjectId: input.invoiceId,
      plan: planFailedLaterRefundReversal({
        lines: stored.lines,
        legacyKey: input.legacyKey,
        source,
        lineAmountTypes: stored.lineAmountTypes,
        reversal: await resolveFailedLaterRefundReversal(tx, input.closeTaskId),
      }),
    }));
    logOutcome("FAILED_LATER_REFUND_REVERSAL", context, written);
  });
}
