import type { Prisma } from "@prisma/client";
import { cardRefundStillOwedOrigin } from "../../card-refund-still-owed-origin";
import {
  BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX,
  CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX,
  EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX,
  REFUND_REQUEST_REFUND_RECOVERY_PREFIX,
  cardRefundFailedLaterRefundId,
  cardRefundStillOwedCloseRecordId,
  duplicateCaptureIntentIdForRecoveryKey,
  isGroupSettlementRefundRecoveryKey,
  isOrganiserChildRefundKey,
  lateCaptureIntentOfApprovalRefundRecoveryKey,
} from "../../payment-recovery-keys";
import { refundFamilyKey } from "./application-state";
import { memberMoneyEventKeys, type RefundObligationScope } from "./keys";
import type { CardRefundObligationRef } from "./refund-reservations";

/**
 * WHICH REFUND DEBT A CARD REFUND ROW PAYS (#4516, Ledger M4c; plan section 5, "Runner mapping"). One exhaustive
 * map from a recovery row's key to the R05 its door posted, shared by the recovery runner and a "Paid another way"
 * close. A row it cannot map (an organiser's or a group settlement's, M6) sends exactly as today with no
 * reservation, and a close of it posts nothing; an obligation not in the journal is the same.
 */

export interface CardRefundRecoveryRow {
  type: string;
  idempotencyKey: string;
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
}

/** What the key alone says: a door's scope, a failed refund's, a part close's, or nothing. Pure. */
export type CardRefundKeyObligation =
  | { kind: "door"; ref: CardRefundObligationRef }
  | { kind: "failed-later"; stripeRefundId: string }
  | { kind: "still-owed"; closeRecordId: string }
  | null;

const door = (scope: RefundObligationScope, id: string, ensureFaceCents?: number): CardRefundKeyObligation =>
  id.length > 0 ? { kind: "door", ref: { scope, id, ...(ensureFaceCents === undefined ? {} : { ensureFaceCents }) } } : null;

export function cardRefundObligationOfRecoveryKey(row: CardRefundRecoveryRow): CardRefundKeyObligation {
  const key = row.idempotencyKey;
  if (isOrganiserChildRefundKey(key) || isGroupSettlementRefundRecoveryKey(key)) return null;
  // A superseded intent's refund defers its R05 to the sender, sized as the row is (design section 5, step 2).
  if (row.type === "REFUND_SUPERSEDED_PAYMENT") return door("capture-return", row.paymentIntentId, row.amountCents);
  if (row.type !== "REFUND_BOOKING_MODIFICATION") return null;
  if (key === `${BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX}${row.bookingId}`) return door("cancellation", row.bookingId);
  if (key.startsWith(`${CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX}${row.bookingId}_`)) {
    return door("capture-return", key.slice(`${CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX}${row.bookingId}_`.length));
  }
  const duplicate = duplicateCaptureIntentIdForRecoveryKey(row.bookingId, key);
  if (duplicate) return door("capture-return", duplicate);
  const lateCapture = lateCaptureIntentOfApprovalRefundRecoveryKey(key);
  if (lateCapture) return door("capture-return", lateCapture);
  if (key.startsWith(REFUND_REQUEST_REFUND_RECOVERY_PREFIX)) return door("refund-request", key.slice(REFUND_REQUEST_REFUND_RECOVERY_PREFIX.length));
  if (key.startsWith(BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX)) return door("modification", key.slice(BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX.length));
  if (key.startsWith(EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX)) return door("review", key.slice(EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX.length));
  const failed = cardRefundFailedLaterRefundId(key);
  if (failed) return { kind: "failed-later", stripeRefundId: failed };
  const close = cardRefundStillOwedCloseRecordId(key);
  if (close) return { kind: "still-owed", closeRecordId: close };
  return null;
}

/** An R05 key back to the door it names: `refund-obligation|<scope>|<id>`, with any chain suffix dropped. */
export function refundDoorOfObligationKey(key: string): CardRefundObligationRef | null {
  const root = refundFamilyKey(key);
  const [head, scope, id] = root.split("|");
  if (head !== "refund-obligation" || !scope || !id) return null;
  const ref = { scope: scope as RefundObligationScope, id };
  return memberMoneyEventKeys.refundObligation(ref.scope, ref.id) === root.split("|after|")[0] ? ref : null;
}

type Db = Pick<Prisma.TransactionClient, "memberMoneyEvent" | "manualRefundTask" | "paymentRecoveryOperation">;

/** The debt an applied card refund paid: its R12's pay, or (review L4) the answer that applied it later. */
async function paidByRefund(db: Db, stripeRefundId: string): Promise<string | null> {
  for (const eventKey of [memberMoneyEventKeys.refund(stripeRefundId), memberMoneyEventKeys.refundAnswer(stripeRefundId)]) {
    const event = await db.memberMoneyEvent.findUnique({ where: { eventKey },
      select: { journal: { select: { applications: { select: { obligation: { select: { obligationKey: true } } } } } } } });
    const paid = event?.journal?.applications[0]?.obligation.obligationKey;
    if (paid) return paid;
  }
  return null;
}

/**
 * The debt a row pays, resolved exactly. A failed-later row owes what the failed refund answered (its R12's pay,
 * or the answer that applied it, reversed by R13); one that posted unapplied and was never answered names no debt.
 * A still-owed row owes what the row it was first owed on did (`cardRefundStillOwedOrigin`).
 */
export async function resolveCardRefundObligation(db: Db, row: CardRefundRecoveryRow): Promise<CardRefundObligationRef | null> {
  const mapped = cardRefundObligationOfRecoveryKey(row);
  if (!mapped) return null;
  if (mapped.kind === "door") return mapped.ref;
  if (mapped.kind === "failed-later") {
    const paid = await paidByRefund(db, mapped.stripeRefundId);
    return paid ? refundDoorOfObligationKey(paid) : null;
  }
  const origin = await cardRefundStillOwedOrigin(db, row.idempotencyKey);
  return origin ? resolveCardRefundObligation(db, origin) : null;
}
