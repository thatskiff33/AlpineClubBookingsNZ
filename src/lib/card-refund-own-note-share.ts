import { PaymentSource, type Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { readMigrationFinishedAt } from "@/lib/migration-finished-at";
import { buildRefundRequestRefundMetadata } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { refundNoteKeyAfterVoidParts } from "@/lib/xero-refund-note-status";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";
import { cardRefundNoteKeyTag, cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { readFailedRefundsAnsweredBy } from "@/lib/card-refund-resend-answer";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/**
 * #4312 (owner decision 24 Oct 2026, `INV-ADDPAY-047`): A CARD REFUND ON A
 * BANK-TRANSFER PAYMENT IS NOTED ON ITS OWN RECORD.
 *
 * An `INTERNET_BANKING` payment keeps one canonical refund note, for its first
 * refund (`INV-PAY-101`). A card refund on it - an edit's card capture refunded
 * by an approved refund request, by the Stripe dashboard, or a late capture's
 * refund - used to reach the single-note branch of
 * `enqueueXeroRefundCreditNoteOperation` and fold into that note, so Xero
 * showed less credit than the card paid back. Now each such refund's note is
 * keyed and sized on its `PaymentRefund` row (`cardRefundId`, its
 * `stripeRefundId`): its amount less what its own notes already cover, never
 * the payment-wide cash less all coverage, which a bank hand-back's note would
 * squeeze. The per-record route a hand-back takes (`paidAnotherWayTaskId`,
 * #4287) is the model: one row per refund, a `perDelta` link, the
 * after-void key (`INV-ADDPAY-041`).
 *
 * This module is the record's side - which refunds qualify and what each
 * still asks for - read by the enqueue and by the note's execution alike, so
 * the two size it one way. It imports nothing that queues.
 */

/** The marker migration: a refund Stripe created before it finished on this install never gets a note of its own. */
export const CARD_REFUND_NOTE_CUTOVER_MIGRATION = "20261122010000_bt_card_refund_notes_cutover";

/**
 * When the cutover marker finished here, in whole seconds (Stripe dates a
 * refund in seconds). Null where there is no migration history at all (a
 * `prisma db push` database never ran an older release, so nothing on it was
 * folded). Fail-safe: with a history that has no finished marker - rolled
 * back, or not run - every refund reads as made before it.
 */
export async function cardRefundNoteCutoverSeconds(db: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<number | null> {
  const marker = await readMigrationFinishedAt(db, CARD_REFUND_NOTE_CUTOVER_MIGRATION);
  if (!marker.history) return null;
  if (marker.finishedAtSeconds === null) {
    logger.warn(
      { migration: CARD_REFUND_NOTE_CUTOVER_MIGRATION },
      "The bank-transfer card refund note cutover has not finished here: no card refund on a bank transfer gets a note of its own (#4312)",
    );
    return Number.POSITIVE_INFINITY;
  }
  return marker.finishedAtSeconds;
}

/**
 * Whether a refund was made since the cutover: Stripe's own creation time, or
 * - a row recorded without one - when the ledger recorded it. A refund made
 * before the cutover keeps whatever an older release gave it: the canonical
 * note, a fold, or the officer's hand-made note (#4287 comment, 22 Oct 2026).
 */
export function madeSinceCardRefundNoteCutover(
  refund: { stripeCreatedAt: Date | null; createdAt: Date },
  cutoverSeconds: number | null,
): boolean {
  if (cutoverSeconds === null) return true;
  const madeAt = refund.stripeCreatedAt ?? refund.createdAt;
  return Math.floor(madeAt.getTime() / 1000) >= cutoverSeconds;
}

/**
 * THE key of a card refund's own note - its outbox row's correlation key and
 * the note's Xero idempotency key alike: the refund and what its own notes
 * already cover, so a replay under any other note is the same key and two
 * writers asking at once collide on one row; and, once one of its own notes
 * is voided, the parts naming them (`INV-ADDPAY-041`), so Xero never hands
 * a voided note back.
 */
export async function cardRefundNoteKey(
  paymentId: string,
  stripeRefundId: string,
  ownCoveredCents: number,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">,
): Promise<string> {
  const afterVoid = await refundNoteKeyAfterVoidParts(paymentId, { closeRowsWhere: cardRefundNoteRowsWhere(paymentId, stripeRefundId) }, db);
  return buildXeroIdempotencyKey("payment", paymentId, "refund-credit-note", "card-refund", stripeRefundId, ownCoveredCents, "v3", ...afterVoid);
}

/**
 * `INV-SSOT`: the key tag read back, built from `cardRefundNoteKeyTag`'s own
 * spelling - what it puts either side of the refund id - so the format has one
 * source. The id is what lies between the two, never crossing the closing part.
 * Built on first use, never at import, so a module that mocks the tag's home
 * can still import this one.
 */
let keyTagPatternCache: RegExp | null = null;
function cardRefundKeyTagPattern(): RegExp {
  if (keyTagPatternCache) return keyTagPatternCache;
  const marker = "\u0000";
  const [before, after] = cardRefundNoteKeyTag(marker).split(marker);
  if (!before || !after) throw new Error("cardRefundNoteKeyTag must put text either side of the refund id");
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (keyTagPatternCache = new RegExp(`${escape(before)}((?:(?!${escape(after)}).)+)${escape(after)}`));
}

/**
 * The card refund a refund-note row answers, or null: its payload's
 * `cardRefundId`, read the one way a note row's fields are
 * (`parsePaymentCreditNoteRetryInput`), else its key (`cardRefundNoteKeyTag`),
 * which a previous release's worker keeps when it rewrites the payload.
 */
export function cardRefundIdOfNoteRow(row: { requestPayload: unknown; correlationKey?: string | null }): string | null {
  return parsePaymentCreditNoteRetryInput(row)?.cardRefundId ?? cardRefundKeyTagPattern().exec(row.correlationKey ?? "")?.[1] ?? null;
}

export interface CardRefundNoteShare {
  /** What the refund paid back and a note of its own may answer: 0 unless it qualifies (below). */
  amountCents: number;
  /** What its own notes already cover, counted as the payment's coverage counts them. */
  coveredCents: number;
  /** #4104: what the own notes of the failed refunds the recovery replay sent it again for cover (`readFailedRefundsAnsweredBy`). */
  answeredCents: number;
  uncoveredCents: number;
}

type ShareReader = Pick<
  Prisma.TransactionClient,
  "payment" | "paymentRefund" | "paymentRecoveryOperation" | "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation" | "$queryRaw"
>;

/**
 * WHAT A CARD REFUND'S OWN NOTE STILL HAS TO ANSWER: its amount less its own
 * notes' coverage (`sumRefundCreditNoteCoverageOfRowsCents`, as a close's
 * share is read), and less what the own notes of the refunds Stripe failed
 * later that the recovery replay sent it again for cover - the slice the
 * replay marked made with it, and nothing else (`readFailedRefundsAnsweredBy`:
 * #4104 left that note to answer it). It qualifies - a non-zero amount - only on a bank-transfer
 * payment, in a counted status (`isRecordedRefundStatus`: a refund Stripe
 * failed or cancelled paid nothing back), and made since the cutover. The
 * enqueue and the note's execution both ask, so a refund that failed, or a
 * historical one somehow asked for, completes as covered and raises nothing.
 * Null when the payment has no such refund row.
 */
export async function readCardRefundNoteShare(db: ShareReader, paymentId: string, stripeRefundId: string): Promise<CardRefundNoteShare | null> {
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { source: true } });
  const refund = await db.paymentRefund.findFirst({
    where: { paymentId, stripeRefundId },
    select: { amountCents: true, status: true, stripeCreatedAt: true, createdAt: true },
  });
  if (!payment || !refund) return null;
  const qualifies =
    payment.source === PaymentSource.INTERNET_BANKING &&
    isRecordedRefundStatus(refund.status) &&
    madeSinceCardRefundNoteCutover(refund, await cardRefundNoteCutoverSeconds(db));
  const amountCents = qualifies ? Math.max(0, refund.amountCents) : 0;
  const coveredCents = await sumRefundCreditNoteCoverageOfRowsCents(paymentId, cardRefundNoteRowsWhere(paymentId, stripeRefundId), db);
  const answeredCents = amountCents > 0 ? (await readFailedRefundsAnsweredBy(db, paymentId, stripeRefundId)).coverCents : 0;
  return { amountCents, coveredCents, answeredCents, uncoveredCents: Math.max(0, amountCents - coveredCents - answeredCents) };
}

/**
 * Which door made a card refund, read from the Stripe metadata every app door
 * stamps (`payment-recovery-keys.ts`): an approved refund request (the
 * `reason` its one builder stamps), another app door (it carries a `reason`),
 * or none - a refund made outside the app, in the Stripe dashboard.
 */
export type CardRefundDoor = "refund-request" | "app" | "outside-app";

const REFUND_REQUEST_REFUND_REASON = buildRefundRequestRefundMetadata("", "").reason;

export function cardRefundDoorOf(metadata: Record<string, string> | null | undefined): CardRefundDoor {
  const reason = metadata?.reason;
  if (reason === REFUND_REQUEST_REFUND_REASON) return "refund-request";
  return typeof reason === "string" && reason.trim() !== "" ? "app" : "outside-app";
}

/**
 * #4312: HOW A LATE CAPTURE'S ASK SPLITS on a bank-transfer payment - pure.
 * The capture's ask is unchanged (its counted refunds less every note naming
 * it, `noteLateCaptureRefunds`); within it, each refund made since the cutover
 * (`own`) is asked for on its own record, oldest first, at what its own notes
 * do not cover yet, and the older refunds (`legacy`) keep the one note for the
 * capture they always had - their refunds less every other note naming the
 * capture (one naming no refund, or a refund no longer counted). A
 * capture-wide note that already answers more than the older refunds (one an
 * older release raised for a newer refund) takes its excess off the own asks,
 * so no refund is noted twice.
 */
export function planLateCaptureCardNotes(input: {
  own: ReadonlyArray<{ stripeRefundId: string; amountCents: number; ownNotedCents: number }>;
  legacyRefundedCents: number;
  legacyNotedCents: number;
}): { own: Array<{ stripeRefundId: string; askCents: number }>; legacyAskCents: number } {
  const ownRefundedCents = input.own.reduce((sum, refund) => sum + Math.max(0, refund.amountCents), 0);
  const ownNotedCents = input.own.reduce((sum, refund) => sum + Math.max(0, refund.ownNotedCents), 0);
  const askCents = input.legacyRefundedCents + ownRefundedCents - input.legacyNotedCents - ownNotedCents;
  // Never more than the capture's whole ask, as before #4312 (a note of a refund that failed since counts there too).
  const legacyAskCents = Math.max(0, Math.min(askCents, input.legacyRefundedCents - input.legacyNotedCents));
  let ownCapCents = askCents - legacyAskCents;
  const own: Array<{ stripeRefundId: string; askCents: number }> = [];
  for (const refund of input.own) {
    const cents = Math.min(ownCapCents, Math.max(0, refund.amountCents - refund.ownNotedCents));
    if (cents <= 0) continue;
    own.push({ stripeRefundId: refund.stripeRefundId, askCents: cents });
    ownCapCents -= cents;
  }
  return { own, legacyAskCents };
}
