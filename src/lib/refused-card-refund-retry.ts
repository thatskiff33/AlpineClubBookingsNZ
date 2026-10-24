/**
 * #4083, #4096, #4102, #4103 (`INV-PAY-130`): A CARD REFUND STRIPE REFUSES IS
 * STILL OWED, AND IS ASKED FOR AGAIN UNDER A KEY STRIPE HAS NEVER SEEN.
 *
 * Stripe can answer a refund with `failed` or `canceled` instead of throwing.
 * `refundPaymentTransactions` records that refund (the ledger does not count
 * it, `isRecordedRefundStatus`) and returns normally, so before this a booking
 * edit's refund queued nothing, a cancellation closed its pre-persisted debt as
 * paid, and the recovery runner closed any refund row whose replay read one.
 *
 * Stripe answers a repeated idempotency key with its ORIGINAL response for 24
 * hours, so a refused slice asked for again under its own key only reads the
 * refusal back. Whoever READS a refusal therefore moves that slice to its next
 * key generation (`nextRefusedRefundKeySuffix`), a key never sent before:
 *
 * - The edit's door queues the refused slices already moved, as its recovery
 *   row's plan, so "Refunds owed" counts them (`openCardRefundOwedByOperation`).
 * - A door whose row was written before its attempt - the cancellation, the edit
 *   review, the late-capture approval, the duplicate capture and the capacity
 *   race (#4103) - moves its row's plan the same way, only while no worker has
 *   touched it (PENDING, no attempt yet; `keepRefusedPrePersistedRefundOwed`).
 * - The late-capture webhook, which writes no row before its attempt, holds a
 *   refusal for a treasurer instead (`holdLateCaptureRefusedByStripe`, #4103),
 *   whose approval asks on the key its recorded refusals count to
 *   (`sliceAfterRecordedRefusals`).
 * - An approved refund request queues its attempt's plan with refused slices
 *   already moved and made ones marked (`inlineRefundAfterAttempt`, #4102).
 * - The runner, on the attempt it holds, does the same and fails the attempt,
 *   so the backoff asks again.
 *
 * The runner, the pre-persisted doors and the refund request keep every slice in the
 * plan and the row's amount as the plan's total (`planAfterAttempt`,
 * `inlineRefundAfterAttempt`): a slice Stripe made beside a refusal is marked
 * with its refund and never sent again - so a replay past Stripe's 24-hour
 * window cannot make it twice - and the owed figure fills it with exactly that
 * refund (`attributeRecordedRefunds`). A slice that threw keeps its key: it
 * may have been made at Stripe, and must be replayed under it.
 *
 * The officers are alerted once per refused slice, by whoever moves it off the
 * key it was first planned under (or, when no row could be written, by the
 * door that met it), and again if the retries run out; the row then dies owed,
 * for the treasurer's "Paid another way" (#3372).
 */
import { PaymentRecoveryOperationStatus, Prisma, type PaymentRecoveryOperation } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { cardRefundSliceFailedRefundIds, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import { UNTOUCHED_PRE_PERSISTED_ROW } from "@/lib/payment-recovery-constants";
import { buildBookingCancellationRefundIdempotencyKey, nextRefusedRefundKeySuffix } from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { PartialRefundError, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/** One slice's answer from `refundPaymentTransactions`: the refund Stripe gave, with the slice as sent. */
type AnsweredRefund = { status: string | null; slice: RefundAllocationSlice; refundId: string; paymentIntentId: string };

/** The answers that were refusals. */
export function refusedAnswers<T extends { status: string | null }>(refunds: ReadonlyArray<T>): T[] {
  return refunds.filter((refund) => isRefusedRefundStatus(refund.status));
}

/** The slices Stripe answered but refused, as `refundPaymentTransactions` sent them. */
export function refusedRefundSlices(
  refunds: ReadonlyArray<{ status: string | null; slice: RefundAllocationSlice }>,
): RefundAllocationSlice[] {
  return refusedAnswers(refunds).map((refund) => refund.slice);
}

export function refusedRefundCents(slices: ReadonlyArray<RefundAllocationSlice>): number {
  return slices.reduce((sum, slice) => sum + slice.amountCents, 0);
}

/** What the officers read as the row's last error: a part of a split refund may have been made. */
export function refusedRefundMessage(cents: number, format: ClubFormat): string {
  const amount = formatCents(cents, format);
  return `Stripe refused ${amount} of this card refund (failed or cancelled), so that ${amount} did not go back and is still owed.`;
}

/** What the officers read on the refusal's alert, raised when it is queued for retry. */
export function refusedRefundAlertMessage(cents: number, format: ClubFormat): string {
  return `${refusedRefundMessage(cents, format).slice(0, -1)}; it will be retried automatically.`;
}

/** One Stripe request: the same slice under the same key (`refundSliceStripeIdempotencyKey`). */
function sameRequest(left: RefundAllocationSlice, right: RefundAllocationSlice): boolean {
  return (
    left.paymentTransactionId === right.paymentTransactionId &&
    left.amountCents === right.amountCents &&
    (left.stripeKeySuffix ?? "") === (right.stripeKeySuffix ?? "")
  );
}

/** The plan with each slice Stripe refused moved to its next key generation, the rest untouched. */
export function planAfterRefusals(
  plan: ReadonlyArray<RefundAllocationSlice>,
  refused: ReadonlyArray<RefundAllocationSlice>,
): RefundAllocationSlice[] {
  return plan.map((slice) =>
    refused.some((each) => sameRequest(each, slice))
      ? { ...slice, stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix) }
      : slice,
  );
}

/**
 * The plan after an attempt Stripe answered (#4083 review): each slice it
 * refused moves to its next key; each it made is marked with its refund
 * (`madeRefundId`), so it is never sent again yet stays this row's - the
 * owed figure still fills it with that refund, and the row's amount stays the
 * plan's total. A slice with no answer (it threw, or was not reached) keeps its
 * key: it may have been made at Stripe, and must be replayed under it.
 */
export function planAfterAttempt(
  plan: ReadonlyArray<RefundAllocationSlice>,
  answered: ReadonlyArray<Pick<AnsweredRefund, "status" | "slice" | "refundId">>,
): RefundAllocationSlice[] {
  return plan.map((slice) => {
    if (slice.madeRefundId) return slice;
    const answer = answered.find((each) => sameRequest(each.slice, slice));
    if (!answer) return slice;
    return isRefusedRefundStatus(answer.status)
      ? { ...slice, stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix) }
      : { ...slice, madeRefundId: answer.refundId };
  });
}

/**
 * #4103 (`INV-PAY-130`): a slice's key generation for a door with no row to
 * carry one (the Xero repair pass), read from the refusals already recorded on
 * the payment for that slice - the same transaction and amount, answered
 * `failed` or `canceled`. Each refusal read and recorded moves the slice on, so
 * a retry after a refusal is a request Stripe has never seen; an answer that
 * was lost records nothing, so a replay of it keeps its key and is answered with
 * the original. A refusal from another writer of the same slice only moves it
 * further on, to a key still never sent.
 */
export function sliceAfterRecordedRefusals(
  slice: RefundAllocationSlice,
  recorded: ReadonlyArray<{ paymentTransactionId: string | null; amountCents: number; status: string }>,
): RefundAllocationSlice {
  let stripeKeySuffix: string | undefined;
  for (const refund of recorded) {
    const same = refund.paymentTransactionId === slice.paymentTransactionId && refund.amountCents === slice.amountCents;
    if (same && isRefusedRefundStatus(refund.status)) stripeKeySuffix = nextRefusedRefundKeySuffix(stripeKeySuffix);
  }
  return stripeKeySuffix ? { ...slice, stripeKeySuffix } : slice;
}

/**
 * #4103 review C3: the Stripe key of a refund that has one fixed key and no
 * plan to carry a generation - the legacy group settlement refund's replay and
 * the superseded group intent's webhook refund. Moved on once for each refusal
 * Stripe itself holds on the intent for the same amount and exactly the same
 * metadata (`listRefundsForPaymentIntent`, read before the ask, outside any
 * transaction), so a retry inside Stripe's 24 hours is a request it has never
 * seen, while a refund made - or one whose answer was lost - keeps its key and
 * is answered with the original. Exact metadata, not just the reason: another
 * writer's refusal on the same intent (an organiser child refund carries its
 * own `bookingId` and `organiserChildRefundKey`) must never move this key, or a
 * refund already made under it could be asked for again.
 */
export function keyAfterStripeRefusals(
  baseKey: string,
  onIntent: ReadonlyArray<{ status: string | null; amount: number; metadata?: Record<string, string> | null }>,
  match: { amountCents: number; metadata: Readonly<Record<string, string>> },
): string {
  const wanted = Object.entries(match.metadata);
  let suffix: string | undefined;
  for (const refund of onIntent) {
    const metadata = refund.metadata ?? {};
    const same =
      refund.amount === match.amountCents &&
      Object.keys(metadata).length === wanted.length &&
      wanted.every(([key, value]) => metadata[key] === value);
    if (same && isRefusedRefundStatus(refund.status)) suffix = nextRefusedRefundKeySuffix(suffix);
  }
  return suffix ? `${baseKey}_${suffix}` : baseKey;
}

/** A refusal, with the intent it was asked of: the alert names it. */
type RefusedAnswer = { slice: RefundAllocationSlice; paymentIntentId: string };

/** An inline attempt, read (`inlineRefundAfterAttempt`). */
export type InlineRefundRead = {
  plan: RefundAllocationSlice[];
  refused: RefusedAnswer[];
  /** What is still owed: `refusedCents` (certainly not made) plus `unansweredCents` (it threw or was never sent: may have been made). */
  unmadeCents: number;
  refusedCents: number;
  unansweredCents: number;
  reachedStripe: boolean;
};

/**
 * #4102, #4117: an inline attempt over a frozen plan, read, for a door that
 * raises its recovery row AFTER the attempt (an approved refund request).
 * `refundPaymentTransactions` sends the plan in order and stops at the first
 * slice that throws, wrapping any throw after a Stripe call in
 * `PartialRefundError` with the slices answered before it, so the first
 * answers are the plan's first slices. The plan comes back whole:
 *
 * - each slice Stripe refused moves to its next key, as it was read refused;
 * - each made is marked with its refund (`madeRefundId`): never sent again,
 *   and filled by exactly that refund in "Refunds owed", though it was made
 *   before the row existed;
 * - each with no answer (it threw, or was never sent) keeps its key: it may
 *   have been made at Stripe, and must be replayed under it.
 *
 * `unmadeCents` is what is still owed, split into the refused slices
 * (`refusedCents`: certainly not made) and the unanswered ones
 * (`unansweredCents`: Stripe may have made them, unrecorded).
 * `reachedStripe` is false only for a throw that is not a `PartialRefundError`,
 * which came before any Stripe call: then nothing was asked, and the plan is
 * returned as frozen.
 */
export function inlineRefundAfterAttempt(
  plan: RefundAllocationSlice[],
  attempt: { refunds: ReadonlyArray<{ status: string | null; refundId: string; paymentIntentId: string }> } | { error: unknown },
): InlineRefundRead {
  const cents = (slices: ReadonlyArray<RefundAllocationSlice>) => slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  if ("error" in attempt && !(attempt.error instanceof PartialRefundError)) {
    return { plan, refused: [], unmadeCents: cents(plan), refusedCents: 0, unansweredCents: cents(plan), reachedStripe: false };
  }
  const answers =
    "error" in attempt
      ? (attempt.error as PartialRefundError).refunds.map((answer, index) => ({
          ...answer,
          refused: (attempt.error as PartialRefundError).refusedSlices.some((each) => plan[index] && sameRequest(each, plan[index])),
        }))
      : attempt.refunds.map((answer) => ({ ...answer, refused: isRefusedRefundStatus(answer.status) }));
  const refused: RefusedAnswer[] = [];
  const after = plan.map((slice, index) => {
    const answer = answers[index];
    if (!answer) return slice;
    if (!answer.refused) return { ...slice, madeRefundId: answer.refundId };
    refused.push({ slice, paymentIntentId: answer.paymentIntentId });
    return { ...slice, stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix) };
  });
  const refusedCents = cents(refused.map((answer) => answer.slice));
  const unansweredCents = cents(plan.slice(answers.length));
  return { plan: after, refused, unmadeCents: refusedCents + unansweredCents, refusedCents, unansweredCents, reachedStripe: true };
}

/**
 * The refusals worth an alert: slices refused on the key they were first
 * planned under. A slice already moved was alerted when it first moved, so the
 * officers hear once per refused slice, however many retries follow - and a
 * slice queued on its own key (it threw) is alerted when it is first refused.
 */
export function firstRefusals<T extends { slice: RefundAllocationSlice }>(refused: ReadonlyArray<T>): T[] {
  return refused.filter((answer) => !answer.slice.stripeKeySuffix);
}

/**
 * The officers' alert for a refusal, raised by whoever moves a slice off the
 * key it was first planned under (`firstRefusals`) - once per refused slice,
 * however many attempts follow. Never throws: the refusal is already recorded
 * on the row.
 */
export async function alertRefusedCardRefund(
  alert: { bookingId: string; operationId?: string; paymentIntentId: string; refusedCents: number },
  format: ClubFormat,
): Promise<void> {
  try {
    await alertPaymentRecoveryOfficers(
      {
        bookingId: alert.bookingId,
        operationId: alert.operationId,
        amountCents: alert.refusedCents,
        paymentIntentId: alert.paymentIntentId,
        errorMessage: refusedRefundAlertMessage(alert.refusedCents, format),
      },
      format,
    );
  } catch (err) {
    logger.error({ err, bookingId: alert.bookingId }, "Could not alert the officers to a refused card refund (#4083)");
  }
}

/**
 * The slices Stripe answered before a later one threw (`PartialRefundError`
 * carries them, each with its status and the slice as sent); none for any
 * other throw, which came before a Stripe call or carries no answers.
 */
export function answersBeforeFailure(err: unknown): AnsweredRefund[] {
  return ((err as { refunds?: AnsweredRefund[] } | null)?.refunds ?? []).filter((answer) => answer?.slice);
}

/**
 * A refusal a pre-persisted door met (`keepRefusedPrePersistedRefundOwed`):
 * its message is what the door records, and `replanned` says whether this
 * write moved the row. When it did not, a worker holds the row and alerts as
 * it moves the slice itself, so a door with its own failure alert stays quiet.
 */
export class RefusedCardRefundError extends Error {
  constructor(
    message: string,
    readonly replanned: boolean,
  ) {
    super(message);
    this.name = "RefusedCardRefundError";
  }
}

/** An inline attempt as its door met it: Stripe's answers, or what it threw. */
export type RefundAttempt = { refunds: ReadonlyArray<AnsweredRefund> } | { error: unknown };

type PrePersistedRow = { id: string; paymentIntentId: string; allocationPlan?: Prisma.JsonValue };

/**
 * #4126, #4144 (`INV-SSOT`): a pre-persisted row still on `plan` - the plan its
 * door read or sent. Null or empty is a row raised with none, as the enqueue
 * stores it (`enqueueLedgerRefundRecovery`).
 */
export function onPlanWhere(plan: Prisma.JsonValue | ReadonlyArray<RefundAllocationSlice> | null): Prisma.PaymentRecoveryOperationWhereInput {
  const none = plan === null || (Array.isArray(plan) && plan.length === 0);
  return { allocationPlan: none ? { equals: Prisma.DbNull } : { equals: plan as Prisma.InputJsonValue } };
}

/**
 * #4126 (`INV-SSOT`): the one compare-and-set a door writes its own
 * pre-persisted row under - untouched (`UNTOUCHED_PRE_PERSISTED_ROW`) and still
 * on `plan`, the plan the door read or sent (null: a row raised with none). A
 * claim, an attempt or a re-plan in between fails it.
 */
export function untouchedPrePersistedRowWhere(
  idempotencyKey: string,
  plan: Prisma.JsonValue | ReadonlyArray<RefundAllocationSlice> | null,
): Prisma.PaymentRecoveryOperationWhereInput {
  return { idempotencyKey, ...UNTOUCHED_PRE_PERSISTED_ROW, ...onPlanWhere(plan) };
}

/**
 * #4144 (`INV-SSOT`): the row a door may close after its inline refund was made
 * - open, and still on the plan the door sent. The runner may hold it: it
 * replays these same keys, Stripe answers with the door's refunds, and its own
 * close then matches nothing, so the record is written once. A row another
 * writer re-planned is not on that plan and is left open: one moved after a
 * refusal, or after Stripe's later report that a refund failed
 * (`card-refund-failed-later.ts`), is still owed; one re-planned only by the
 * runner marking a slice made is left to the runner, whose replay closes it
 * without moving money.
 */
export function sentPlanRowWhere(
  idempotencyKey: string,
  plan: ReadonlyArray<RefundAllocationSlice>,
): Prisma.PaymentRecoveryOperationWhereInput {
  return { idempotencyKey, status: { not: PaymentRecoveryOperationStatus.SUCCEEDED }, ...onPlanWhere(plan) };
}

/**
 * The one re-plan write of a pre-persisted door's row (#4103 review C2, #4104):
 * from the plan the row holds, compare-and-set on it, while no worker has
 * touched it (PENDING, no attempt). Says whether it moved the row.
 */
async function replanPrePersistedRow({
  idempotencyKey,
  plan,
  answered,
  lastError,
}: {
  idempotencyKey: string;
  plan?: ReadonlyArray<RefundAllocationSlice>;
  answered: ReadonlyArray<AnsweredRefund>;
  lastError?: string;
}): Promise<{ moved: boolean; row: PrePersistedRow | null }> {
  const row = await prisma.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey },
    select: { id: true, paymentIntentId: true, allocationPlan: true },
  });
  const held = row?.allocationPlan ?? null;
  const base = parseRefundAllocationPlan(held) ?? plan ?? answered.map((answer) => answer.slice);
  const next = planAfterAttempt(base, answered);
  if (JSON.stringify(next) === JSON.stringify(base)) return { moved: false, row };
  const written = await prisma.paymentRecoveryOperation.updateMany({
    where: untouchedPrePersistedRowWhere(idempotencyKey, held),
    data: { allocationPlan: next as unknown as Prisma.InputJsonValue, ...(lastError ? { lastError } : {}) },
  });
  return { moved: written.count === 1, row };
}

/**
 * #4096, #4103: a card refund whose recovery row was written BEFORE its inline
 * attempt - a cancellation, an edit review's, a treasurer-approved late
 * capture's, a duplicate capture's, a capacity race's - and that Stripe refused
 * in part or whole. Its row is re-planned (`planAfterAttempt`): refused slices
 * on their next key, made ones marked, and a slice with no answer (a later one
 * threw) on its own key - only while no worker has touched it (PENDING, no
 * attempt), as the runner owns it after that and reads the refusal itself. Its
 * amount stays the plan's total.
 *
 * Once per refusal (#4103 review C2): the re-plan starts from the plan the row
 * holds and is written compare-and-set on it, so a refusal moves only a slice
 * still on the key it was read under. A second delivery that read the same
 * refusal finds the slice already moved, writes nothing and alerts nobody.
 *
 * Takes the attempt as the door met it: its answers, or what it threw (only a
 * `PartialRefundError` carries answers). Returns null when nothing was refused,
 * so a door may call it on every outcome; otherwise the error the door records
 * on the row - the refusal is never a refund, so the door must not close it.
 *
 * The officers are alerted for the slices refused on their first key when this
 * write moved the row (a row that cannot be read is not moved: the runner
 * moves it and alerts) - unless the door raises its own failure alert (`alertOfficers: false`), which
 * then carries the refusal, and is raised only when this write moved the row
 * (`RefusedCardRefundError.replanned`), so it is heard once.
 */
export async function keepRefusedPrePersistedRefundOwed({
  bookingId,
  idempotencyKey,
  plan,
  attempt,
  format,
  alertOfficers = true,
}: {
  bookingId: string;
  /** The pre-persisted row's own key. */
  idempotencyKey: string;
  /** The plan the attempt sent; omitted, the slices it answered (every slice, when nothing threw). */
  plan?: ReadonlyArray<RefundAllocationSlice>;
  attempt: RefundAttempt;
  format: ClubFormat;
  alertOfficers?: boolean;
}): Promise<RefusedCardRefundError | null> {
  const answered = "error" in attempt ? answersBeforeFailure(attempt.error) : attempt.refunds;
  const refused = refusedAnswers(answered);
  if (refused.length === 0) return null;
  const refusedCents = refusedRefundCents(refused.map((answer) => answer.slice));
  const message = refusedRefundMessage(refusedCents, format);
  let moved = false;
  let row: PrePersistedRow | null = null;
  try {
    ({ moved, row } = await replanPrePersistedRow({ idempotencyKey, plan, answered, lastError: message }));
  } catch (err) {
    // The row stays open either way; the runner reads the refusal itself, and alerts as it moves it.
    logger.error({ err, bookingId, idempotencyKey }, "Could not re-plan a refused card refund's pre-persisted row (#4096, #4103)");
  }
  const first = firstRefusals(refused);
  if (moved && alertOfficers && first.length > 0) {
    await alertRefusedCardRefund(
      {
        bookingId,
        operationId: row?.id,
        paymentIntentId: first[0]?.paymentIntentId || row?.paymentIntentId || "",
        refusedCents: refusedRefundCents(first.map((answer) => answer.slice)),
      },
      format,
    );
  }
  return new RefusedCardRefundError(message, moved);
}

/**
 * #4104: a cancellation's inline refund that failed partway (`PartialRefundError`)
 * with nothing refused (a refusal is `keepRefusedPrePersistedRefundOwed`'s): its
 * pre-persisted row is re-planned as the runner would (`replanPrePersistedRow`) -
 * each slice made marked with its refund, so a failure Stripe reports later is
 * owed by this row by its refund id. Best effort: unmarked, the runner replays a
 * made slice's key and Stripe answers with the original refund.
 */
export async function markCancellationAttempt({
  bookingId,
  plan,
  error,
}: {
  bookingId: string;
  plan: ReadonlyArray<RefundAllocationSlice>;
  error: unknown;
}): Promise<void> {
  const answered = answersBeforeFailure(error);
  if (answered.length === 0) return;
  try {
    await replanPrePersistedRow({ idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId), plan, answered });
  } catch (err) {
    logger.error({ err, bookingId }, "Could not mark a cancellation refund's made slices (#4104)");
  }
}

/**
 * Written only on the attempt this worker holds - fenced on PROCESSING and its
 * own `processingStartedAt` - and never a status: the attempt's failure is the
 * runner's own write. A lost fence moves nothing, and the next attempt replays
 * the old key, reads the same refusal back and moves it then. Says whether it
 * moved the row.
 */
async function moveRefusedSlices(
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt">,
  plan: RefundAllocationSlice[],
): Promise<boolean> {
  const moved = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: operation.processingStartedAt,
    },
    data: { allocationPlan: plan as unknown as Prisma.InputJsonValue },
  });
  return moved.count === 1;
}

/**
 * #4312 rounds 7-8 (#4104, `INV-ADDPAY-047`): EACH SLICE SENT FOR A REFUND
 * STRIPE FAILED LATER (`cardRefundSliceFailedRefundIds`) THAT STRIPE MADE ON
 * THIS ATTEMPT IS MARKED WITH THE REFUND IT MADE (`madeRefundId`) - the one
 * record that pairs a re-send with its failures (`cardRefundFailuresAnsweredBy`),
 * so it never depends on which refund of the same amount happens to be recorded
 * first. Only the mark is written: any other slice, and a refused slice's key,
 * stay as read.
 *
 * WHAT THE MARK CHANGES IN THE OWED FIGURE (F4). A marked slice takes its own
 * refund before the newest-row-first matching (`attributeRecordedRefunds`), so
 * the re-send fills the row that sent it - never a newer row's unsent slice of
 * the same charge and amount, which now reads as owed, as it is. That is a
 * correction. Every other slice is matched as before, from a pool without the
 * re-send.
 *
 * Compare-and-set on the plan this attempt sent from (`onPlanWhere`), never on
 * its hold of the row (round 8). Stripe's answer under the slice's key is a
 * fact whoever holds the row now: a reaper that moved a stalled attempt to
 * FAILED - due again or dead - leaves the plan as it was, so the late attempt's
 * mark still lands, and its replay's notes (`replayNotingEachRefund`) read it.
 * A plan written in between - a failure that re-planned the slice onto its next
 * key, or another attempt that read the same answer and marked it first - fails
 * the write: the plan there is the record then, and a re-planned slice is
 * marked by the replay that sends it next (or, on a dead row, paid by the
 * treasurer). Never a status, and no lock: one guarded single-row write, as the
 * failed-later re-plan's own (`INV-LOCK-001`).
 */
async function markResentSlices(
  operation: Pick<PaymentRecoveryOperation, "id" | "idempotencyKey">,
  plan: ReadonlyArray<RefundAllocationSlice>,
  answered: ReadonlyArray<AnsweredRefund>,
): Promise<void> {
  const resent = plan.map((slice) => !slice.madeRefundId && cardRefundSliceFailedRefundIds(operation, slice).length > 0);
  if (!resent.includes(true)) return; // nothing re-sent: not even the answers are read
  const made = planAfterAttempt(plan, answered);
  const marked = plan.map((slice, index) => {
    const madeRefundId = made[index]?.madeRefundId;
    return resent[index] && madeRefundId ? { ...slice, madeRefundId } : slice;
  });
  if (marked.every((slice, index) => slice === plan[index])) return;
  const written = await prisma.paymentRecoveryOperation.updateMany({
    where: { id: operation.id, ...onPlanWhere(plan) },
    data: { allocationPlan: marked as unknown as Prisma.InputJsonValue },
  });
  if (written.count !== 1) {
    logger.warn(
      { operationId: operation.id },
      "A card refund re-send's slice was not marked made: the row's plan changed since this attempt read it - another attempt marked it, or a failure re-planned it for its next replay to mark (#4312)",
    );
  }
}

/**
 * A refusal's re-plan (`moveRefusedSlices`) that lost its fence - a reaper took
 * the row from this attempt - still marks the re-sends Stripe made beside it
 * (`markResentSlices`, round 8): the move is the holder's to write again, the
 * mark is a fact.
 */
async function moveRefusedSlicesOrMarkResent(
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt" | "idempotencyKey">,
  plan: ReadonlyArray<RefundAllocationSlice>,
  answered: ReadonlyArray<AnsweredRefund>,
): Promise<boolean> {
  const moved = await moveRefusedSlices(operation, planAfterAttempt(plan, answered));
  if (!moved) await markResentSlices(operation, plan, answered);
  return moved;
}

/**
 * The recovery runner's refund of a frozen plan. Returns when Stripe made every
 * slice, each slice sent for a failed refund marked with the refund it made
 * (`markResentSlices`); otherwise moves what it refused to fresh keys and throws, so the
 * attempt fails and is retried (or, retries spent, dies owed).
 *
 * Returns the refund of the plan's first slice - one made beside an earlier
 * refusal (`madeRefundId`), or the one Stripe answered now - as the inline
 * doors read theirs (`refunds[0]`), so a record the runner writes names it
 * (#4126).
 */
export async function refundPlanOrRetryRefusals({
  operation,
  plan,
  format,
  refund,
}: {
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt" | "bookingId" | "paymentIntentId" | "idempotencyKey">;
  plan: ReadonlyArray<RefundAllocationSlice>;
  format: ClubFormat;
  /** Sends the slices still to send (`refundPaymentTransactions` with them as the allocation). */
  refund: (plan: RefundAllocationSlice[]) => Promise<{ refunds: ReadonlyArray<AnsweredRefund> }>;
}): Promise<string | null> {
  // Alerted for each slice refused on its first key, once this attempt moved it.
  const alertIfFirst = async (moved: boolean, answers: ReadonlyArray<AnsweredRefund>) => {
    const first = firstRefusals(refusedAnswers(answers));
    if (!moved || first.length === 0) return;
    await alertRefusedCardRefund(
      {
        bookingId: operation.bookingId,
        operationId: operation.id,
        paymentIntentId: first[0]?.paymentIntentId || operation.paymentIntentId,
        refusedCents: refusedRefundCents(first.map((answer) => answer.slice)),
      },
      format,
    );
  };
  let answered: ReadonlyArray<AnsweredRefund>;
  try {
    // A slice already made beside a refusal is never sent again.
    answered = (await refund(plan.filter((slice) => !slice.madeRefundId))).refunds;
  } catch (err) {
    // The slices answered before a later one threw (`PartialRefundError`) re-plan
    // the row - a refusal on its next key, and (#4104) a made one marked, so a
    // failure Stripe reports later is owed by this row by its refund id - while
    // the slice that threw keeps its key.
    const before = answersBeforeFailure(err);
    if (before.length > 0) await alertIfFirst(await moveRefusedSlicesOrMarkResent(operation, plan, before), before);
    throw err;
  }
  const refused = refusedRefundSlices(answered);
  if (refused.length === 0) {
    await markResentSlices(operation, plan, answered);
    return plan[0]?.madeRefundId ?? answered[0]?.refundId ?? null;
  }
  await alertIfFirst(await moveRefusedSlicesOrMarkResent(operation, plan, answered), answered);
  throw new Error(refusedRefundMessage(refusedRefundCents(refused), format));
}
