/**
 * The settling payment of a cash refund credit note, and the completion that
 * records it (`INV-PAY-101`, `INV-PAY-111`) — one path for the first attempt,
 * the retry and repair legs, and the operator's repair tool (#3548).
 *
 * `createXeroCreditNote` raises the note, then records its id, its link and
 * the operation's `xeroObjectId` in one transaction, then records the
 * settling payment and completes the operation. A process that dies after that
 * transaction leaves an operation that names its note and records no outcome.
 * Before #3548 nothing named the note, so a retry either minted a second note
 * (per-delta mode, once Xero forgot the key) or took the idempotency
 * early-return and closed the row SUCCEEDED with neither the payment nor
 * `refundPaymentSkipped`.
 *
 * Now every leg that finishes a note goes through
 * `finishRefundCreditNoteSettlement`: it reads the note back from Xero
 * (`settleRefundNoteFromXero`), records what Xero already shows, or pays it
 * through the first attempt's own `settleRefundCreditNote` under the one
 * note-keyed payment key, and completes the operation through the one
 * `refundCreditNoteCompletion`. A payment call that fails completes the row
 * PARTIAL for the repair leg. Nothing records a second payment against a note
 * Xero shows paid, part-paid or allocated.
 */
import type { Prisma } from "@prisma/client";
import type { CreditNote as XeroCreditNote, Payment as XeroPayment } from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import {
  buildRefundCreditNotePayment,
  REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
  resolveRefundSettlement,
  type CashRefundMethod,
} from "@/lib/xero-invoice-payments";
import { xeroCalendarDateText } from "@/lib/xero-provider-dates";
import { readResolvedRefundCreditNoteCoverage } from "@/lib/xero-resolved-in-xero-fences";
import { REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  type XeroObjectLinkInput,
  type XeroSyncOperationCompletion,
} from "@/lib/xero-sync";

type XeroClient = Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"];

/** Recorded when the note already carries payments or allocations covering it in Xero. */
export const REFUND_NOTE_SETTLED_IN_XERO_REASON =
  "The credit note was already settled or allocated in Xero when the interrupted attempt was finished, so no second payment was recorded.";
/** Recorded when an officer resolved this very note's operation by hand in Xero. */
export const REFUND_NOTE_RESOLVED_IN_XERO_REASON =
  "An officer resolved this refund credit note by hand in Xero, so the app records no payment against it; settle it in Xero if it is still outstanding.";
/** Recorded, with `refundPaymentRemainingCents`, when the note is part-paid in Xero. */
export const REFUND_NOTE_PART_SETTLED_IN_XERO_REASON =
  "The credit note is part-settled in Xero, so the app records no payment against it; settle the remainder in Xero.";
const REFUND_NOTE_SKIP_RECORDED_EARLIER_REASON =
  "The settling payment was recorded as not due by an earlier attempt.";

/**
 * THE key of a refund credit note's settling payment (#1162, #3548): one per
 * note, so equal-amount refunds never collide, and every leg that pays a note
 * — first attempt, retry, repair, repair tool — sends the same key, so a
 * payment Xero already holds under it is replayed, never duplicated.
 */
export function refundCreditNotePaymentIdempotencyKey(paymentId: string, creditNoteId: string): string {
  return buildXeroIdempotencyKey("payment", paymentId, "refund-payment", creditNoteId, "v2");
}

type RefundPaymentBody = {
  paymentID?: string;
  invoiceNumber?: string;
  creditNoteNumber?: string;
  amount?: number;
};

/** A payment settling the note, with the amount it PAID (not the amount asked). */
export interface RefundNotePaymentRecord {
  paymentID: string;
  amountCents: number;
  number: string | null;
}

export interface RefundNoteSettlementOutcome {
  refundPaymentResponseBody: RefundPaymentBody | null;
  /**
   * Every live payment settling the note; each gets a `REFUND_PAYMENT` link.
   * Those links are single-active per payment by design
   * (`normalizePaymentRefundLinkWithClient`), so only the latest stays active;
   * every reader of "is this note's payment on record" reads them active or not
   * (`refundPaymentLinkWhere`).
   */
  payments: RefundNotePaymentRecord[];
  refundPaymentErr: unknown;
  /** Set when no payment is due: the note is complete, never a leg to repair. */
  refundPaymentSkipReason: string | null;
  /** A note part-settled in Xero: what is still outstanding on it. */
  refundPaymentRemainingCents?: number;
}

function paymentRecord(body: RefundPaymentBody | XeroPayment, fallbackCents: number): RefundNotePaymentRecord | null {
  if (!body.paymentID) return null;
  const numbered = body as RefundPaymentBody;
  return {
    paymentID: body.paymentID,
    amountCents: providerAmountToCents(body.amount) ?? fallbackCents,
    number: numbered.creditNoteNumber ?? numbered.invoiceNumber ?? null,
  };
}

/**
 * `INV-PAY-101` (owner decision, 20 Sep 2026): Xero records a payment only
 * where the money verifiably moved. A card refund settles from the Stripe
 * account; a bank-transfer refund from the club's configured account, and is
 * otherwise left UNSETTLED — visibly outstanding for the bank-feed match —
 * never marked paid from the Stripe account it did not come from. A failed
 * payment call is returned, not thrown, so the caller completes PARTIAL.
 */
export async function settleRefundCreditNote(input: {
  xero: XeroClient;
  tenantId: string;
  paymentId: string;
  creditNoteId: string;
  amountCents: number;
  refundMethod: CashRefundMethod;
  refundMethodRecorded: boolean;
  paymentDate: string;
}): Promise<RefundNoteSettlementOutcome> {
  const { xero, tenantId, paymentId, creditNoteId, refundMethod } = input;
  const settlement = await resolveRefundSettlement({
    method: refundMethod,
    methodRecorded: input.refundMethodRecorded,
  });
  if (settlement.kind === "unsettled") {
    logger.info(
      { paymentId, creditNoteId, refundMethod, reason: settlement.reason },
      "Xero refund credit note left unsettled: no verifiable settlement account for this refund"
    );
    return { refundPaymentResponseBody: null, payments: [], refundPaymentErr: null, refundPaymentSkipReason: settlement.reason };
  }
  try {
    const bankCode = settlement.bankCode;
    const refundPayment = buildRefundCreditNotePayment({
      paymentId,
      creditNoteId,
      refundAmountCents: input.amountCents,
      bankCode,
      // The note's own day (CT-5, #2869; #3548): the first attempt dates the
      // note and its payment alike, and a later leg dates it from the note.
      paymentDate: input.paymentDate,
      refundMethod,
    });
    const refundPaymentResponse = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [refundPayment] },
          undefined,
          refundCreditNotePaymentIdempotencyKey(paymentId, creditNoteId)
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroCreditNote",
        context: `createPayments(refund credit note ${paymentId})`,
      }
    );
    logger.info(
      { paymentId, creditNoteId, refundMethod, bankCode },
      "Xero refund payment created against the refund settlement bank account via credit note"
    );
    const body = refundPaymentResponse.body.payments?.[0] ?? null;
    const record = body ? paymentRecord(body, input.amountCents) : null;
    return {
      refundPaymentResponseBody: body,
      payments: record ? [record] : [],
      refundPaymentErr: null,
      refundPaymentSkipReason: null,
    };
  } catch (error) {
    logger.error(
      { err: error, paymentId, creditNoteId, refundMethod },
      "Failed to create Xero refund payment against the refund settlement bank account via credit note"
    );
    return { refundPaymentResponseBody: null, payments: [], refundPaymentErr: error, refundPaymentSkipReason: null };
  }
}

/**
 * The completion a refund credit note's operation is closed with: PARTIAL
 * exactly when the settling payment failed, the payload the repair leg reads
 * (`refundPayment`, `refundPaymentSkipped`), and one `REFUND_PAYMENT` link per
 * settling payment at the amount it paid.
 */
export function refundCreditNoteCompletion(input: {
  paymentId: string;
  /** The note as Xero returned it; omitted, the prior payload's is kept. */
  creditNoteBody?: unknown;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The note link's metadata; omitted where the link already carries its own. */
  noteLinkMetadata?: Record<string, unknown>;
  originalInvoiceId: string;
  refundMethod: CashRefundMethod;
  outcome: RefundNoteSettlementOutcome;
  /** The row's earlier response, kept beneath the fields written here. */
  priorResponse?: Record<string, unknown> | null;
  extraResponse?: Record<string, unknown>;
  /**
   * #3827 (D-3813-8): the refund request this note is that request's own note
   * for, read off the row's payload (`readRefundRequestIdFromPayload`). It is
   * linked under its own role, so the one-refund-note machinery never treats
   * it as this payment's single note. Absent for every other refund note.
   */
  refundRequestId?: string | null;
}): XeroSyncOperationCompletion {
  const { paymentId, creditNoteId, creditNoteNumber, outcome } = input;
  const paymentLinks: XeroObjectLinkInput[] = outcome.payments.map((payment) => ({
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "PAYMENT",
    xeroObjectId: payment.paymentID,
    xeroObjectNumber: payment.number,
    role: "REFUND_PAYMENT",
    metadata: {
      creditNoteId,
      invoiceId: input.originalInvoiceId,
      amountCents: payment.amountCents,
    },
  }));
  // A refresh that finds the note fully settled drops the remainder an earlier
  // part-settled read recorded, so the row stops reading as part-settled.
  const prior: Record<string, unknown> = { ...(input.priorResponse ?? {}) };
  delete prior.refundPaymentRemainingCents;
  return {
    status: outcome.refundPaymentErr ? "PARTIAL" : "SUCCEEDED",
    responsePayload: {
      ...prior,
      creditNote: input.creditNoteBody ?? input.priorResponse?.creditNote ?? null,
      allocation: null,
      allocationSkipped: true,
      allocationSkipReason: REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
      refundPayment: outcome.refundPaymentResponseBody,
      refundPaymentError: outcome.refundPaymentErr,
      // Read by the repair leg (`INV-PAY-101`): an unsettled-by-design note
      // is complete, not a payment leg waiting to be repaired.
      refundPaymentSkipped: outcome.refundPaymentSkipReason !== null,
      refundPaymentSkipReason: outcome.refundPaymentSkipReason,
      ...(outcome.refundPaymentRemainingCents !== undefined
        ? { refundPaymentRemainingCents: outcome.refundPaymentRemainingCents }
        : {}),
      refundMethod: input.refundMethod,
      ...(input.extraResponse ?? {}),
    },
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: creditNoteId,
    xeroObjectNumber: creditNoteNumber,
    extraLinks: [
      {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: creditNoteId,
        xeroObjectNumber: creditNoteNumber,
        role: input.refundRequestId ? REFUND_REQUEST_CREDIT_NOTE_ROLE : "REFUND_CREDIT_NOTE",
        ...(input.noteLinkMetadata ? { metadata: input.noteLinkMetadata } : {}),
      },
      ...paymentLinks,
    ],
  };
}

/** What a stored response says about its note's payment, for a leg that does not pay. */
export function recordedRefundNoteOutcome(response: Record<string, unknown> | null): RefundNoteSettlementOutcome {
  const skipped = response?.refundPaymentSkipped === true;
  const remaining = readNumber(response?.refundPaymentRemainingCents);
  return {
    refundPaymentResponseBody: (asRecord(response?.refundPayment) as RefundPaymentBody | null) ?? null,
    payments: [],
    refundPaymentErr: null,
    refundPaymentSkipReason: skipped
      ? readString(response?.refundPaymentSkipReason) ?? REFUND_NOTE_SKIP_RECORDED_EARLIER_REASON
      : null,
    ...(remaining !== null ? { refundPaymentRemainingCents: remaining } : {}),
  };
}

export type EvidenceLink = { role: string; xeroObjectType: string; metadata: unknown };

/**
 * The payments' `REFUND_PAYMENT` links, ACTIVE OR NOT, deliberately (#3548
 * round 3): the links are single-active per payment
 * (`normalizePaymentRefundLinkWithClient`), so on a per-delta Stripe payment
 * every note's payment link but the latest is inactive and still records that
 * note's payment. The builder, the hardening report and the repair tool load
 * `refundNoteSettlementOnRecord`'s links through this one filter.
 */
export function refundPaymentLinkWhere(paymentIds: string[]) {
  return {
    localModel: "Payment",
    localId: { in: paymentIds },
    xeroObjectType: "PAYMENT",
    role: "REFUND_PAYMENT",
  } satisfies Prisma.XeroObjectLinkWhereInput;
}
export type EvidenceOperation = {
  id: string;
  entityType: string;
  operationType: string;
  status: string;
  xeroObjectId: string | null;
  responsePayload: unknown;
  manuallyResolvedAt: Date | null;
};

/**
 * THE predicate (#3548, `INV-PAY-111`): whether a refund note's payment outcome
 * is on record — a `REFUND_PAYMENT` link names it, or a create operation for it
 * completed PARTIAL (the repair leg owns it), was resolved in Xero
 * (`INV-INT-025`), or recorded a payment or a skip by design (`INV-PAY-101`:
 * never re-repaired). Pure, over evidence the caller loaded, so the builder,
 * the hardening report and the repair tool ask one question. The links are
 * read active or not (`refundPaymentLinkWhere`).
 */
export function refundNoteSettlementOnRecord(
  creditNoteId: string,
  evidence: { paymentLinks: EvidenceLink[]; noteOperations: EvidenceOperation[] },
  options?: { ignoreOperationId?: string },
): boolean {
  if (
    evidence.paymentLinks.some(
      (link) =>
        link.role === "REFUND_PAYMENT" &&
        link.xeroObjectType === "PAYMENT" &&
        readString(asRecord(link.metadata)?.creditNoteId) === creditNoteId,
    )
  ) {
    return true;
  }
  return evidence.noteOperations.some((operation) => {
    if (
      operation.id === options?.ignoreOperationId ||
      operation.entityType !== "CREDIT_NOTE" ||
      operation.operationType !== "CREATE" ||
      operation.xeroObjectId !== creditNoteId
    ) {
      return false;
    }
    const response = asRecord(operation.responsePayload);
    return (
      operation.status === "PARTIAL" ||
      operation.manuallyResolvedAt !== null ||
      asRecord(response?.refundPayment) !== null ||
      response?.refundPaymentSkipped === true
    );
  });
}

async function loadRefundNoteEvidence(paymentId: string) {
  const paymentLinks = await prisma.xeroObjectLink.findMany({
    where: refundPaymentLinkWhere([paymentId]),
    select: { role: true, xeroObjectType: true, metadata: true, xeroObjectId: true },
  });
  const noteOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      xeroObjectId: { not: null },
    },
    select: {
      id: true,
      entityType: true,
      operationType: true,
      status: true,
      xeroObjectId: true,
      responsePayload: true,
      manuallyResolvedAt: true,
    },
  });
  return { paymentLinks: paymentLinks ?? [], noteOperations: noteOperations ?? [] };
}

/** `refundNoteSettlementOnRecord`, over the payment's evidence read now. */
export async function refundNoteSettlementInterrupted(
  paymentId: string,
  creditNoteId: string,
  options?: { ignoreOperationId?: string },
): Promise<boolean> {
  return !refundNoteSettlementOnRecord(creditNoteId, await loadRefundNoteEvidence(paymentId), options);
}

function isLivePayment(payment: XeroPayment): boolean {
  return Boolean(payment.paymentID) && String(payment.status ?? "") !== "DELETED";
}

function readSettledState(note: XeroCreditNote, totalCents: number) {
  const remainingCents = providerAmountToCents(note.remainingCredit);
  const livePayments = (note.payments ?? []).filter(isLivePayment);
  const payments = livePayments.flatMap((payment) => {
    const record = paymentRecord(payment, 0);
    return record ? [record] : [];
  });
  const status = String(note.status ?? "");
  const fullySettled = status === "PAID" || remainingCents === 0;
  const partSettled = !fullySettled && remainingCents !== null && remainingCents < totalCents;
  const anySettlement = fullySettled || partSettled || payments.length > 0;
  return { remainingCents, payments, fullySettled, partSettled, anySettlement };
}

async function readRefundNote(xero: XeroClient, tenantId: string, paymentId: string, creditNoteId: string) {
  const response = await callXeroApi(
    () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
    {
      operation: "getCreditNote",
      resourceType: "CREDIT_NOTE",
      workflow: "createXeroCreditNote",
      context: `getCreditNote(refund settlement of ${paymentId})`,
    }
  );
  const note: XeroCreditNote | undefined = response.body.creditNotes?.[0];
  const status = String(note?.status ?? "");
  const totalCents = providerAmountToCents(note?.total);
  if (!note?.creditNoteID || totalCents === null || status === "VOIDED" || status === "DELETED") {
    throw new Error(
      `Refund credit note ${creditNoteId} for payment ${paymentId} is ${status || "missing"} in Xero, so its settling payment cannot be recorded (#3548). Check the refund in Xero; if it was handled there, mark this operation resolved in Xero.`
    );
  }
  return { body: response.body, note, totalCents };
}

function settledOutcome(state: ReturnType<typeof readSettledState>): RefundNoteSettlementOutcome {
  const first = state.payments[0];
  const body = first ? { paymentID: first.paymentID, amount: first.amountCents / 100 } : null;
  if (state.partSettled) {
    return {
      refundPaymentResponseBody: body,
      payments: state.payments,
      refundPaymentErr: null,
      refundPaymentSkipReason: REFUND_NOTE_PART_SETTLED_IN_XERO_REASON,
      refundPaymentRemainingCents: state.remainingCents ?? 0,
    };
  }
  return {
    refundPaymentResponseBody: body,
    payments: state.payments,
    refundPaymentErr: null,
    refundPaymentSkipReason: first ? null : REFUND_NOTE_SETTLED_IN_XERO_REASON,
  };
}

/**
 * Read the note back from Xero and settle it only if nothing does yet (#3548).
 *
 * - A `REFUND_PAYMENT` link already naming it, or a note Xero shows paid,
 *   part-paid or allocated: recorded as it stands, never a second payment.
 * - This very note resolved by hand in Xero (`INV-INT-025`: matched by the
 *   note's creation keys or its Xero id, never "any note on the payment"):
 *   skipped. An unreadable resolved row refuses loudly, as the execution cap does.
 * - Otherwise the first attempt's own leg pays it, dated the note's own day,
 *   under the one note-keyed key. If that call fails, the note is read again:
 *   a concurrent leg that paid it first is recorded, not reported as a failure.
 * - A voided or missing note throws.
 */
export async function settleRefundNoteFromXero(input: {
  paymentId: string;
  creditNoteId: string;
  /** The keys the note was raised under: its operation's correlation and idempotency keys. */
  creationKeys: Array<string | null | undefined>;
  refundMethod: CashRefundMethod;
  refundMethodRecorded: boolean;
  /** Used only when Xero returns no readable date for the note. */
  fallbackPaymentDate: () => Promise<string>;
  /**
   * Record what Xero shows and never pay (#3548 round 3): the repair tool's
   * refresh of a part-settled note. A note Xero shows no settlement on throws.
   */
  recordOnly?: boolean;
}): Promise<{ outcome: RefundNoteSettlementOutcome; creditNoteBody: unknown; creditNoteNumber: string | null; totalCents: number }> {
  const { paymentId, creditNoteId } = input;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const read = await readRefundNote(xero, tenantId, paymentId, creditNoteId);
  const creditNoteNumber = read.note.creditNoteNumber ?? null;
  const result = (outcome: RefundNoteSettlementOutcome, body: unknown = read.body) => ({
    outcome,
    creditNoteBody: body,
    creditNoteNumber,
    totalCents: read.totalCents,
  });

  const evidence = await loadRefundNoteEvidence(paymentId);
  const linkedPayment = evidence.paymentLinks.find(
    (link) => readString(asRecord(link.metadata)?.creditNoteId) === creditNoteId,
  );
  const state = readSettledState(read.note, read.totalCents);
  if (state.anySettlement) {
    logger.warn(
      { paymentId, creditNoteId, payments: state.payments.length, remainingCents: state.remainingCents },
      "Xero refund credit note already carries a settlement in Xero; recording it without a second payment (#3548)"
    );
    return result(settledOutcome(state));
  }
  if (input.recordOnly) {
    throw new Error(
      `Refund credit note ${creditNoteId} for payment ${paymentId} shows no settlement in Xero now, so nothing was recorded and nothing was paid (#3548). Check the note in Xero.`
    );
  }
  if (linkedPayment) {
    // The app recorded a payment for this note that Xero no longer shows (an
    // officer removed it): never re-paid behind their back.
    return result({
      refundPaymentResponseBody: { paymentID: linkedPayment.xeroObjectId },
      payments: [],
      refundPaymentErr: null,
      refundPaymentSkipReason: null,
    });
  }

  const resolved = await readResolvedRefundCreditNoteCoverage(paymentId);
  if (resolved.unreadableOperationIds.length > 0) {
    throw new Error(
      `Refusing to settle Xero refund credit note ${creditNoteId} for payment ${paymentId}: a note resolved by hand in Xero on this payment has no readable amount (operation ${resolved.unreadableOperationIds.join(", ")}). Check the notes in Xero by hand.`
    );
  }
  const creationKeys = input.creationKeys.filter((key): key is string => Boolean(key));
  const resolvedThisNote =
    resolved.correlationKeys.some((key) => creationKeys.includes(key)) ||
    (await prisma.xeroSyncOperation.findFirst({
      where: {
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: paymentId,
        xeroObjectId: creditNoteId,
        manuallyResolvedAt: { not: null },
      },
      select: { id: true },
    })) !== null;
  if (resolvedThisNote) {
    logger.warn(
      { paymentId, creditNoteId },
      "Xero refund credit note left unsettled: an officer resolved this note by hand in Xero (#3548, INV-INT-025)"
    );
    return result({
      refundPaymentResponseBody: null,
      payments: [],
      refundPaymentErr: null,
      refundPaymentSkipReason: REFUND_NOTE_RESOLVED_IN_XERO_REASON,
    });
  }

  const outcome = await settleRefundCreditNote({
    xero,
    tenantId,
    paymentId,
    creditNoteId,
    amountCents: state.remainingCents ?? read.totalCents,
    refundMethod: input.refundMethod,
    refundMethodRecorded: input.refundMethodRecorded,
    paymentDate: xeroCalendarDateText(read.note.date) ?? (await input.fallbackPaymentDate()),
  });
  if (!outcome.refundPaymentErr) return result(outcome);

  // A concurrent leg may have paid it first (the loser of two simultaneous
  // retries sees Xero refuse the overpayment): read again before failing.
  const again = await readRefundNote(xero, tenantId, paymentId, creditNoteId);
  const afterState = readSettledState(again.note, again.totalCents);
  return afterState.anySettlement ? result(settledOutcome(afterState), again.body) : result(outcome);
}

/**
 * Finish a refund note's settlement on the operation that raised it, and
 * complete that row with the first attempt's payload shape (#3548). Used by
 * the builder for its own row, by the retry/repair leg, and by the repair
 * tool's operator-applied action. Throws for a voided or missing note; a
 * failed payment completes PARTIAL and is returned in the outcome. The PARTIAL
 * write never lands over a row a concurrent leg already completed SUCCEEDED
 * (`keepSucceeded`): the loser of two simultaneous retries is a no-op.
 */
export async function finishRefundCreditNoteSettlement(input: {
  operationId: string;
  paymentId: string;
  creditNoteId: string;
  creationKeys: Array<string | null | undefined>;
  originalInvoiceId: string;
  refundMethod: CashRefundMethod;
  refundMethodRecorded: boolean;
  fallbackPaymentDate: () => Promise<string>;
  priorResponse?: Record<string, unknown> | null;
  recordOnly?: boolean;
  /** #3827 (D-3813-8): see `refundCreditNoteCompletion`. */
  refundRequestId?: string | null;
}): Promise<RefundNoteSettlementOutcome> {
  const settled = await settleRefundNoteFromXero(input);
  await completeXeroSyncOperation(
    input.operationId,
    refundCreditNoteCompletion({
      paymentId: input.paymentId,
      creditNoteBody: settled.creditNoteBody,
      creditNoteId: input.creditNoteId,
      creditNoteNumber: settled.creditNoteNumber,
      originalInvoiceId: input.originalInvoiceId,
      refundMethod: input.refundMethod,
      outcome: settled.outcome,
      priorResponse: input.priorResponse,
      extraResponse: { interruptedAttemptCompleted: true },
      refundRequestId: input.refundRequestId,
    }),
    settled.outcome.refundPaymentErr ? { keepSucceeded: true } : undefined,
  );
  return settled.outcome;
}
