/**
 * #4374 (`INV-INT-029`, `INV-INT-025`): a Xero success that lands on an
 * operation row already resolved in Xero.
 *
 * Two callers can hold one operation row (#1354). One fails, an officer marks
 * the row resolved in Xero and makes the document by hand, and the other
 * caller's own call of the same keyed request then succeeds. The success still
 * lands, links and all - they are real Xero objects - and the write leaves the
 * mark as it found it, so Xero may now hold the item twice. Nothing here guards
 * the write: the outcome guard (`xero-operation-outcome-guard.ts`) decides what
 * lands; this only says so, once per operation.
 *
 * A success that recorded no Xero object made nothing in Xero to duplicate, so
 * it raises nothing. One that did may still have adopted the officer's own
 * document (found by its reference), so the alert asks for a check, not a void.
 * A row the app itself closed because its credit note was spent outside the app
 * (#4219, `isClosedByCreditSpentOutsideApp`) had nothing made by hand: its alert
 * says the credit ledger and Xero may now disagree instead.
 *
 * The send is once-ever and best-effort. If it throws before reaching anyone,
 * or nobody can receive it, `sendAdminAlertOnceEver` gives the claim back or
 * defers it, but nothing calls again unless another success lands on the row:
 * the warning in the log is then the only trace (a stated limit, `INV-INT-029`).
 */
import type { XeroSyncOperation } from "@prisma/client";
import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import logger from "@/lib/logger";
import {
  isClosedByCreditSpentOutsideApp,
  isResolvedInXero,
  resolutionLabel,
} from "@/lib/xero-operation-resolution";

/**
 * The once-ever claim key of one operation's alert. #4426: a late Xero object
 * the app did not record is keyed by its own id too, so each one is told.
 */
export function xeroSuccessAfterResolutionAlertKey(operationId: string, unrecordedObjectId?: string): string {
  const key = `xero-success-after-resolution:${operationId}`;
  return unrecordedObjectId ? `${key}:${unrecordedObjectId}` : key;
}

/** The alert's body: what happened, and what an officer should check in Xero. */
function alertMessage(operation: XeroSyncOperation): string {
  // A success with no object id may still have changed Xero: an applied-credit
  // run allocates through child operations, and a deallocation records nothing.
  const recorded = operation.xeroObjectId
    ? `it recorded ${operation.xeroObjectType ?? "an object"} ${operation.xeroObjectNumber ?? operation.xeroObjectId} in Xero`
    : "it recorded no Xero object id, but it may still have made or changed items in Xero";
  const succeeded = `another attempt at the same Xero call then succeeded: ${recorded}. The operation now shows as succeeded.`;
  if (isClosedByCreditSpentOutsideApp(operation)) {
    return `The app closed this Xero operation ("${resolutionLabel(operation.manuallyResolvedReason)}") because its credit note was used in Xero outside the app, and brought the credit ledger into line with Xero; ${succeeded} The credit ledger and Xero may now disagree. Check the credit note's allocations in Xero against the member's credit.`;
  }
  return `This Xero operation was marked "${resolutionLabel(operation.manuallyResolvedReason)}", and ${succeeded} If the item was also made by hand in Xero, Xero may now hold it twice. The app may instead have found and used the one made by hand (same reference), leaving only one: check Xero before voiding a duplicate.`;
}

/**
 * The warning and alert due for a completion's row, or null when none is: the
 * row is SUCCEEDED and carries a resolution mark (`isResolvedInXero`), whether
 * or not it records a Xero object.
 *
 * `operation` must be the row as read after the guarded SUCCEEDED write, in
 * the same transaction: that write holds the row's lock until commit and never
 * changes the mark, so the mark read is the one the success landed on.
 *
 * The answer is a thunk to run after that transaction commits, outside it - it
 * sends an email. It never throws (`sendAdminAlertOnceEver`), and a repeat
 * logs again but sends nothing.
 */
export function successAfterResolutionAlert(
  operation: XeroSyncOperation | null,
): (() => Promise<void>) | null {
  if (operation?.status !== "SUCCEEDED" || !isResolvedInXero(operation)) return null;
  return alertOnce(
    operation,
    xeroSuccessAfterResolutionAlertKey(operation.id),
    { xeroObjectId: operation.xeroObjectId },
    alertMessage(operation),
    "Xero success landed on an operation already resolved in Xero; Xero may now hold the item twice (INV-INT-029)",
  );
}

/** A Xero object a late success made, which the app did not record (#4426). */
export interface UnrecordedXeroObject {
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  /** Its amount, already in the club's money format, when known. */
  amount?: string | null;
  bookingId?: string | null;
}

/** An object type as an officer reads it: `CREDIT_NOTE` is "credit note". */
function objectLabel(type: string | null | undefined): string {
  return type ? type.toLowerCase().replace(/_/g, " ") : "item";
}

/**
 * The late object as an officer reads it: "credit note CN-B for $200.00
 * (Xero id cn-b, booking b-1)".
 */
export function unrecordedObjectDescription(late: UnrecordedXeroObject): string {
  return `${objectLabel(late.xeroObjectType)} ${late.xeroObjectNumber ?? late.xeroObjectId}${late.amount ? ` for ${late.amount}` : ""} (Xero id ${late.xeroObjectId}${late.bookingId ? `, booking ${late.bookingId}` : ""})`;
}

/** The sentence every late-object alert opens its story with: a stalled attempt came back and made it. */
export function stalledAttemptCameBack(late: UnrecordedXeroObject): string {
  return `an earlier attempt at the same Xero call, which had stalled, came back: it made ${unrecordedObjectDescription(late)} in Xero.`;
}

/**
 * #4426 (`INV-INT-029`): a late success the executor did NOT record, because
 * an officer resolved its row by hand, recording a note, while Xero was
 * answering - a refund credit note's create (`recordCreatedRefundNote`). The
 * row keeps what the resolve recorded; the late object is named here, once
 * per object, so an officer can check it against the one made by hand. A
 * resolve withdrawn since (the re-read row is no longer resolved) is said so.
 * #4655: a caller whose late object was kept out for another reason (an
 * organiser adjustment's note, `recordCreatedOrganiserNote`) says why in
 * `errorMessage`; the key, the once-ever send and the warning stay this one's.
 * Same thunk contract as `successAfterResolutionAlert`: run outside any
 * transaction; never throws.
 */
export function unrecordedLateSuccessAlert(
  operation: XeroSyncOperation,
  late: UnrecordedXeroObject,
  errorMessage: string = refundNoteLateMessage(operation, late),
): () => Promise<void> {
  return alertOnce(
    operation,
    xeroSuccessAfterResolutionAlertKey(operation.id, late.xeroObjectId),
    { unrecordedXeroObjectId: late.xeroObjectId, unrecordedXeroObjectNumber: late.xeroObjectNumber, recordedXeroObjectId: operation.xeroObjectId, bookingId: late.bookingId ?? null },
    errorMessage,
    "Xero success arrived after its operation was reset or resolved and was not recorded on it; Xero may now hold the item twice (INV-INT-029)",
  );
}

/** #4426: a refund note's late answer, kept out by a resolve recording a note (or one withdrawn since). */
function refundNoteLateMessage(operation: XeroSyncOperation, late: UnrecordedXeroObject): string {
  const label = objectLabel(late.xeroObjectType);
  const came = `${stalledAttemptCameBack(late)} The app did not record it, link it to the payment or record a refund payment against it in Xero.`;
  return isResolvedInXero(operation)
    ? `This Xero operation was marked "${resolutionLabel(operation.manuallyResolvedReason)}", recording ${objectLabel(operation.xeroObjectType)} ${operation.xeroObjectNumber ?? operation.xeroObjectId ?? "(none)"}, and then ${came} The operation keeps the one the resolve recorded. Xero may now hold two for one item: check the late one in Xero and that it is not recorded on the payment before voiding it.`
    : `This Xero operation was resolved by hand, recording a ${label}, and then ${came} That resolve has since been withdrawn, so the operation now records no ${label}. Check the late one in Xero: if it is the one this operation should record, resolve the operation by hand with its number rather than voiding it.`;
}

/** The warning and the once-ever alert both shapes send. */
function alertOnce(
  operation: XeroSyncOperation,
  key: string,
  objects: Record<string, unknown>,
  errorMessage: string,
  warning: string,
): () => Promise<void> {
  const context = { operationId: operation.id, localModel: operation.localModel, localId: operation.localId, ...objects };
  return async () => {
    logger.warn(context, warning);
    await sendAdminAlertOnceEver({
      key,
      label: "Xero success-after-resolution alert",
      context,
      send: async () => {
        const { sendAdminXeroSyncErrorAlert } = await import("./email");
        return sendAdminXeroSyncErrorAlert({
          errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
          operation: `${operation.operationType} ${operation.entityType} for ${operation.localModel ?? "record"} ${operation.localId ?? "unknown"} (outbox operation ${operation.id})`,
          errorMessage,
          timestamp: new Date(),
        });
      },
    });
  };
}
