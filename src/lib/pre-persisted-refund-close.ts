/**
 * #4126, #4144 (`INV-PAY-130`, `INV-SSOT`): A PRE-PERSISTED DOOR CLOSES ONLY
 * THE ROW IT SENT.
 *
 * The doors write their card refund's recovery row BEFORE the inline attempt -
 * the cancellation, the edit financial review, the duplicate capture, the
 * capacity race and the treasurer-approved late capture - and close it
 * `SUCCEEDED` once Stripe has made every slice. Between the refund and the
 * close another writer can move the row on: the runner claims it and its
 * attempt fails (Stripe's key-in-use error, say), and Stripe's later report
 * that the refund failed re-plans the slice onto its next key
 * (`card-refund-failed-later.ts`).
 * A close that ignored that would mark the re-planned debt paid, and "Refunds
 * owed" would stop counting it.
 *
 * So the close is a compare-and-set on the plan the door sent:
 *
 * - the sent-plan doors close an open row still on that plan (`sentPlanRowWhere`). A row
 *   the runner holds on the same plan is closed, which is harmless: its replay
 *   of the same keys is answered with the door's refunds, and only the close
 *   that moved the row writes a record;
 * - the late-capture approval closes only a row still untouched
 *   (`untouchedPrePersistedRowWhere`, #4126), as its record is written by
 *   whichever close moves the row.
 *
 * A close that matches nothing is read back (`reportLostPrePersistedClose`):
 * already closed, or held or re-planned by another writer, is logged and left
 * to the runner; a row still untouched that would not close is an anomaly -
 * logged and alerted to the officers once for the row, naming the refund.
 */
import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { NOBODY_ALERTED, alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import { isUntouchedPrePersistedRow } from "@/lib/payment-recovery-constants";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { sentPlanRowWhere, untouchedPrePersistedRowWhere } from "@/lib/refused-card-refund-retry";

type CloseStore = Prisma.TransactionClient | typeof prisma;

/** The fields of a door's close: its row's key, built once by `closeDoorRow`, and the plan it sent. */
export type DoorCloseArgs = {
  idempotencyKey: string;
  /** The plan the door's inline attempt sent. */
  sentPlan: ReadonlyArray<RefundAllocationSlice>;
  store?: CloseStore;
};

/** The one `SUCCEEDED` close of a door's own pre-persisted row, fenced as above. */
export async function closePrePersistedRefundRow({
  idempotencyKey,
  sentPlan,
  untouchedOnly = false,
  store = prisma,
}: DoorCloseArgs & {
  /** #4126: close only a row no worker has touched (the late-capture approval). */
  untouchedOnly?: boolean;
}): Promise<Prisma.BatchPayload> {
  return store.paymentRecoveryOperation.updateMany({
    where: untouchedOnly ? untouchedPrePersistedRowWhere(idempotencyKey, sentPlan) : sentPlanRowWhere(idempotencyKey, sentPlan),
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

/** The pre-persisted doors: each names its alert's once-ever key (`<door>-close-lost:<row id>`). */
export const PRE_PERSISTED_REFUND_DOORS = {
  "booking-modification": { name: "the booking modification", refundLabel: "The booking edit's card refund" },
  cancellation: { name: "the cancellation", refundLabel: "The cancellation's card refund" },
  "edit-review": { name: "the edit financial review", refundLabel: "The edit review's card refund" },
  "duplicate-capture": { name: "the duplicate capture", refundLabel: "The duplicate capture's refund" },
  "capacity-race": { name: "the capacity race", refundLabel: "The capacity race's refund" },
  "late-capture-approval": { name: "the late-capture approval", refundLabel: "The approved refund" },
} as const;

export type PrePersistedRefundDoor = keyof typeof PRE_PERSISTED_REFUND_DOORS;

/** The door, its row and the refund it made: what a close is run and a lost one reported with. */
export type LostCloseContext = {
  door: PrePersistedRefundDoor;
  idempotencyKey: string;
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  refundId: string | null;
  format: ClubFormat;
  /** Extra fields for the log lines. */
  context?: Record<string, unknown>;
};

/**
 * A door's close, run on its row's key - built once, here, so the close and the
 * read-back of a lost one cannot name two rows. `close` is handed that key and
 * says whether THIS close moved the row. Returns true when it did, false when
 * it matched nothing (read back and reported), and null when it threw - logged,
 * and no anomaly: the row is left to the runner's replay. Never throws.
 */
export async function closeDoorRow(lost: LostCloseContext, close: (idempotencyKey: string) => Promise<boolean>): Promise<boolean | null> {
  let closed: boolean;
  try {
    closed = await close(lost.idempotencyKey);
  } catch (err) {
    logger.error(
      { err, ...logContext(lost) },
      `Failed to close ${PRE_PERSISTED_REFUND_DOORS[lost.door].name}'s refund recovery operation after its inline refund was made; the recovery runner will replay the frozen plan idempotently`,
    );
    return null;
  }
  if (!closed) await reportLostPrePersistedClose(lost);
  return closed;
}

function logContext(lost: LostCloseContext): Record<string, unknown> {
  const { door, bookingId, paymentIntentId, idempotencyKey, refundId } = lost;
  return { ...lost.context, door, bookingId, paymentIntentId, idempotencyKey, refundId };
}

/**
 * The close matched nothing: read the row back. Closed already, or held or
 * re-planned by another writer, is logged and left to its owner - the runner
 * replays it. A row that is gone should not be - nothing deletes a door's
 * refund row (the mark-paid reversal deletes only superseded-intent rows) - so
 * it is logged as an error, not alerted. A row still
 * untouched is an anomaly: for the sent-plan doors nothing moves an
 * untouched row's plan once every slice was made - their re-plan follows only a
 * refusal (`keepRefusedPrePersistedRefundOwed`), a refund Stripe failed later
 * re-plans only a tried row, and a repeat enqueue writes the plan the door sends
 * - so it is logged and alerted to the officers once for the row, naming the
 * refund Stripe made, for a person to check before the runner replays a plan
 * that may no longer name these keys. Best effort, sent once: nothing calls
 * this again, so an alert that reaches nobody is not retried (the error log
 * above it stands). Never throws.
 */
export async function reportLostPrePersistedClose(lost: LostCloseContext): Promise<void> {
  const context = logContext(lost);
  const { name, refundLabel } = PRE_PERSISTED_REFUND_DOORS[lost.door];
  try {
    const row = await prisma.paymentRecoveryOperation.findUnique({
      where: { idempotencyKey: lost.idempotencyKey },
      select: { id: true, status: true, attempts: true },
    });
    if (!row) {
      logger.error(context, `${refundLabel} was made but its recovery operation no longer exists (#4144) - check the booking's refund`);
      return;
    }
    if (!isUntouchedPrePersistedRow(row)) {
      logger[row.status === PaymentRecoveryOperationStatus.SUCCEEDED ? "info" : "warn"](
        { ...context, operationId: row.id, status: row.status, attempts: row.attempts },
        `${refundLabel} was made, but ${name}'s close matched no open row it could close - already closed, held by the runner, or re-planned (#4144): left to the recovery runner`,
      );
      return;
    }
    logger.error(
      { ...context, operationId: row.id },
      `${refundLabel} was made but ${name}'s close lost on a row still untouched (#4126, #4144) - check the recovery operation`,
    );
    const booking = await prisma.booking.findUnique({ where: { id: lost.bookingId }, select: { id: true } });
    if (!booking) {
      logger.warn({ ...context, operationId: row.id }, `The lost close alert for ${name} was not sent: the booking no longer exists (#4144)`);
      return;
    }
    await sendAdminAlertOnceEver({
      key: `${lost.door}-close-lost:${row.id}`,
      label: `lost ${lost.door} close alert`,
      context: { ...context, operationId: row.id },
      send: async () =>
        (await alertPaymentRecoveryOfficers(
          {
            bookingId: lost.bookingId,
            operationId: row.id,
            amountCents: lost.amountCents,
            paymentIntentId: lost.paymentIntentId,
            errorMessage: `${refundLabel} was made at Stripe (${lost.refundId ?? "refund id unknown"}), but its recovery operation could not be closed. Check the operation before it is retried.`,
          },
          lost.format,
        )) ?? NOBODY_ALERTED,
    });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to check a lost close for ${name} (#4144)`);
  }
}
