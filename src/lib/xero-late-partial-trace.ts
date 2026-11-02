/**
 * #4686 (`INV-INT-029`): the trace a part-success (PARTIAL) leaves when the
 * attempt that made it no longer holds its operation row.
 *
 * A run can stall in Xero past the stale threshold; Reset stale running fails
 * its row and an officer's Retry may queue it again in place (PENDING), or a
 * withdrawal close it, or a later attempt end it. When the stalled call then
 * comes back only partly done, its Xero object exists, but its PARTIAL is not
 * written over the row (`outcomeWriteGuard`): that would undo the Retry. Nor
 * is it linked: a link would answer the queued run's own checks for it (a
 * credit note's counts toward the payment's refund coverage, `INV-INT-028`),
 * and the queued run makes the same keyed call, which normally answers with
 * this very object and records it itself. This is its one trace, as #4426's and
 * #4655's late notes have (`traceUnrecordedLateNote`, which names a credit
 * note's booking and amount, which a PARTIAL of any type does not carry):
 *
 * 1. a warning naming the object, logged inside the refused write
 *    (`refusedOutcomeWrite`);
 * 2. a re-read of the row: if it records this very object, nothing is wrong
 *    and only an info line is logged;
 * 3. one audit row (`xero.operation.late_partial_not_recorded`, `xero`);
 * 4. #4374's alert, once per object (`unrecordedLateSuccessAlert`).
 *
 * Each step is caught: nothing here throws into the run. Run it after the
 * refused write commits, outside any transaction - the alert sends an email.
 */
import type { XeroSyncOperation } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { isResolvedInXero, resolutionLabel } from "@/lib/xero-operation-resolution";
import {
  stalledAttemptCameBack,
  unrecordedLateSuccessAlert,
  type UnrecordedXeroObject,
} from "@/lib/xero-success-after-resolution-alert";

export const LATE_PARTIAL_NOT_RECORDED_ACTION = "xero.operation.late_partial_not_recorded";

/** A part-success whose write was refused because its attempt lost its claim. */
export interface LostClaimPartial {
  claim: XeroOperationClaim;
  xeroObjectType: string | null;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
}

/**
 * `completeXeroSyncOperation`'s hand-off once its refused write has returned:
 * a part-success naming no object made nothing to trace. Inside a caller's own
 * transaction (`store`), not yet committed, it is only logged - no production
 * caller completes PARTIAL there. Never throws.
 */
export async function afterLostClaimPartial(
  claim: XeroOperationClaim,
  completion: { xeroObjectType?: string | null; xeroObjectId?: string | null; xeroObjectNumber?: string | null },
  insideCallerTransaction: boolean,
): Promise<void> {
  if (!completion.xeroObjectId) return;
  const partial = { claim, xeroObjectType: completion.xeroObjectType ?? null, xeroObjectId: completion.xeroObjectId, xeroObjectNumber: completion.xeroObjectNumber ?? null };
  if (insideCallerTransaction) {
    logger.error(partial, "Xero part-success not recorded after its claim was lost, inside a caller's transaction: no audit row or alert (#4686)");
    return;
  }
  await traceLostClaimPartial(partial);
}

/** Re-read, audit and alert a part-success no row records. Never throws. */
export async function traceLostClaimPartial(partial: LostClaimPartial): Promise<void> {
  const trace = {
    operationId: partial.claim.id,
    claimStartedAt: partial.claim.startedAt?.toISOString() ?? null,
    xeroObjectType: partial.xeroObjectType,
    xeroObjectId: partial.xeroObjectId,
    xeroObjectNumber: partial.xeroObjectNumber,
  };
  const notRecorded = "Part-success from Xero not recorded";
  let row: XeroSyncOperation | null;
  try {
    row = await prisma.xeroSyncOperation.findUnique({ where: { id: partial.claim.id } });
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its operation could not be re-read: no audit row or alert; this log is its only record (#4686)`);
    return;
  }
  if (row?.xeroObjectId === partial.xeroObjectId) {
    logger.info(trace, "The late part-success is the object the operation records: nothing to record or alert (#4686)");
    return;
  }
  const resolved = row ? isResolvedInXero(row) : false;
  try {
    await createAuditLog({
      action: LATE_PARTIAL_NOT_RECORDED_ACTION,
      entityType: "XeroSyncOperation",
      entityId: partial.claim.id,
      category: "xero",
      severity: "important",
      outcome: "blocked",
      summary: "Part-success from a stalled Xero job not recorded",
      details: `A stalled Xero job came back after it lost its claim${row ? ` (the operation now stands ${row.status}${resolved ? ", resolved by hand" : ""})` : ""}, having only partly succeeded: it made ${partial.xeroObjectType ?? "an object"} ${partial.xeroObjectNumber ?? partial.xeroObjectId} in Xero. The app did not record it on the operation; check it in Xero.`,
      metadata: {
        ...trace,
        rowFound: row !== null,
        rowStatus: row?.status ?? null,
        resolvedByHand: row ? resolved : null,
        recordedXeroObjectId: row?.xeroObjectId ?? null,
      },
    });
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its audit row failed (#4686)`);
  }
  if (!row) {
    logger.error(trace, `${notRecorded}, and its operation row is gone: no alert sent (#4686)`);
    return;
  }
  try {
    const late: UnrecordedXeroObject = {
      xeroObjectType: partial.xeroObjectType ?? "OBJECT",
      xeroObjectId: partial.xeroObjectId,
      xeroObjectNumber: partial.xeroObjectNumber,
    };
    await unrecordedLateSuccessAlert(row, late, lostClaimPartialMessage(row, late), LOST_CLAIM_PARTIAL_WARNING)();
  } catch (error) {
    logger.error({ ...trace, err: error }, `${notRecorded}, and its alert failed (#4686)`);
  }
}

const LOST_CLAIM_PARTIAL_WARNING =
  "Xero part-success arrived after its attempt lost its operation and was not recorded on it; Xero may now hold the item twice (INV-INT-029, #4686)";

/** The row's state as an officer reads it, and what follows from it. */
function rowState(row: XeroSyncOperation): string {
  if (isResolvedInXero(row)) return `The operation stays marked "${resolutionLabel(row.manuallyResolvedReason)}".`;
  if (row.status === "PENDING") return "The operation is queued to run again (a Retry), and stays queued: its run makes the same Xero call and may answer with this one and record it, or make another.";
  return `The operation keeps what it records now (${row.status.toLowerCase()}).`;
}

/** The alert's body: the attempt lost its row, came back part-done, and what to check. */
function lostClaimPartialMessage(row: XeroSyncOperation, late: UnrecordedXeroObject): string {
  return `This Xero operation's attempt stalled and lost its hold on the operation (Reset stale running, then a Retry, a withdrawal or another attempt). Then ${stalledAttemptCameBack(late)} It only partly succeeded - part of its work, such as a payment, an email or an allocation, was not done - and the app did not record it on the operation, so the operation's outcome was not overwritten. ${rowState(row)} Check Xero: if it holds two for one item, keep the one the operation records (once its run finishes, if it is queued) and finish by hand anything the late one left undone.`;
}
