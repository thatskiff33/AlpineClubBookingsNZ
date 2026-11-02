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
 * this very object and records it itself. This is its one trace, the late
 * credit notes' skeleton (`traceLateXeroObject`, `INV-SSOT`):
 *
 * 1. a warning naming the object, logged inside the refused write
 *    (`refusedOutcomeWrite`);
 * 2. a re-read of the row: if it records this very object, nothing is wrong
 *    and only an info line is logged;
 * 3. one audit row per refused delivery (`xero.operation.late_partial_not_recorded`,
 *    `xero`), naming the part that did not finish (`partialFaultSummary`);
 * 4. #4374's alert, once per object (`unrecordedLateSuccessAlert`), naming it too.
 *
 * Each step is caught: nothing here throws into the run. Run it after the
 * refused write commits, outside any transaction - the alert sends an email.
 */
import type { XeroSyncOperation } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { asRecord } from "@/lib/xero-json";
import { traceLateXeroObject } from "@/lib/xero-late-note-trace";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { isResolvedInXero, resolutionLabel } from "@/lib/xero-operation-resolution";
import { stalledAttemptCameBack, type UnrecordedXeroObject } from "@/lib/xero-success-after-resolution-alert";

export const LATE_PARTIAL_NOT_RECORDED_ACTION = "xero.operation.late_partial_not_recorded";

/** A part-success whose write was refused because its attempt lost its claim. */
export interface LostClaimPartial {
  claim: XeroOperationClaim;
  xeroObjectType: string | null;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  /** PR #4708 review: what did not finish, redacted (`partialFaultSummary`), or null when the completion says nothing. */
  fault: string | null;
}

/**
 * The completion keys a part-success names its unfinished part under, as an
 * officer reads each: a payment or refund payment against the object, a credit
 * allocation, or the email of the invoice.
 */
const PARTIAL_FAULT_KEYS = [
  ["paymentError", "payment"],
  ["refundPaymentError", "refund payment"],
  ["allocationError", "allocation"],
  ["invoiceEmailError", "invoice email"],
  ["emailError", "email"],
  ["invoiceEmailFailureCause", "invoice email cause"],
] as const;

/** The longest fault summary kept; a provider error body can be long. */
const PARTIAL_FAULT_SUMMARY_MAX = 500;

/**
 * PR #4708 review: what a part-success says did not finish - its response's
 * fault keys and its `lastErrorMessage` - as one redacted line, or null. A
 * queued run may not redo that part (a group invoice already bound returns
 * early), so the officer is told what to finish by hand.
 */
export function partialFaultSummary(completion: { responsePayload?: unknown; lastErrorMessage?: string | null }): string | null {
  const payload = asRecord(completion.responsePayload) ?? {};
  const parts = PARTIAL_FAULT_KEYS.flatMap(([key, label]) => (payload[key] ? [`${label}: ${faultText(payload[key])}`] : []));
  if (completion.lastErrorMessage) parts.push(completion.lastErrorMessage);
  if (parts.length === 0) return null;
  const summary = redactSensitiveText(parts.join("; "));
  return summary.length > PARTIAL_FAULT_SUMMARY_MAX ? `${summary.slice(0, PARTIAL_FAULT_SUMMARY_MAX - 3)}...` : summary;
}

/** One fault as text: an error's message, a string as it is, else its JSON. */
function faultText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  const message = asRecord(value)?.message;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "unreadable fault";
  }
}

/**
 * `completeXeroSyncOperation`'s hand-off once its refused write has returned:
 * a part-success naming no object made nothing to trace. Inside a caller's own
 * transaction (`store`), not yet committed, it is only logged - no production
 * caller completes PARTIAL there. Never throws.
 */
export async function afterLostClaimPartial(
  claim: XeroOperationClaim,
  completion: {
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    responsePayload?: unknown;
    lastErrorMessage?: string;
  },
  insideCallerTransaction: boolean,
): Promise<void> {
  if (!completion.xeroObjectId) return;
  const partial = {
    claim,
    xeroObjectType: completion.xeroObjectType ?? null,
    xeroObjectId: completion.xeroObjectId,
    xeroObjectNumber: completion.xeroObjectNumber ?? null,
    fault: partialFaultSummary(completion),
  };
  if (insideCallerTransaction) {
    logger.error(partial, "Xero part-success not recorded after its claim was lost, inside a caller's transaction: no audit row or alert (#4686)");
    return;
  }
  await traceLostClaimPartial(partial);
}

/** Re-read, audit and alert a part-success no row records (`traceLateXeroObject`). Never throws. */
export async function traceLostClaimPartial(partial: LostClaimPartial): Promise<void> {
  const trace = {
    operationId: partial.claim.id,
    claimStartedAt: partial.claim.startedAt?.toISOString() ?? null,
    xeroObjectType: partial.xeroObjectType,
    xeroObjectId: partial.xeroObjectId,
    xeroObjectNumber: partial.xeroObjectNumber,
    fault: partial.fault,
  };
  await traceLateXeroObject({
    operationId: partial.claim.id,
    xeroObjectId: partial.xeroObjectId,
    trace,
    notRecorded: "Part-success from Xero not recorded",
    issue: "#4686",
    sameObject: "The late part-success is the object the operation records: nothing to record or alert (#4686)",
    audit: async (row) => {
      const resolved = row ? isResolvedInXero(row) : false;
      await createAuditLog({
        action: LATE_PARTIAL_NOT_RECORDED_ACTION,
        entityType: "XeroSyncOperation",
        entityId: partial.claim.id,
        category: "xero",
        severity: "important",
        outcome: "blocked",
        summary: "Part-success from a stalled Xero job not recorded",
        details: `A stalled Xero job came back after it lost its claim${row ? ` (the operation is now ${readableStatus(row.status)}${resolved ? ", resolved by hand" : ""})` : ""}, having only partly succeeded: it made ${partial.xeroObjectType ?? "an object"} ${partial.xeroObjectNumber ?? partial.xeroObjectId} in Xero${partial.fault ? `, and did not finish this: ${partial.fault}` : ""}. The app did not record it on the operation; check it in Xero.`,
        metadata: {
          ...trace,
          rowFound: row !== null,
          rowStatus: row?.status ?? null,
          resolvedByHand: row ? resolved : null,
          recordedXeroObjectId: row?.xeroObjectId ?? null,
        },
      });
    },
    lateObject: () => ({
      xeroObjectType: partial.xeroObjectType ?? "OBJECT",
      xeroObjectId: partial.xeroObjectId,
      xeroObjectNumber: partial.xeroObjectNumber,
    }),
    alertMessage: (row, late) => lostClaimPartialMessage(row, late, partial.fault),
    alertWarning: LOST_CLAIM_PARTIAL_WARNING,
  });
}

const LOST_CLAIM_PARTIAL_WARNING =
  "Xero part-success arrived after its attempt lost its operation and was not recorded on it; Xero may now hold the item twice (INV-INT-029, #4686)";

/** An operation status as an officer reads it, never the raw enum. */
const READABLE_STATUS: Readonly<Record<string, string>> = {
  PENDING: "queued",
  RUNNING: "running",
  WAITING_PAYMENT: "waiting for a payment",
  FAILED: "failed",
  PARTIAL: "partly done",
  SUCCEEDED: "succeeded",
  CANCELLED: "cancelled",
  SKIPPED: "skipped",
};

function readableStatus(status: string): string {
  return Object.hasOwn(READABLE_STATUS, status) ? READABLE_STATUS[status]! : status.toLowerCase().replace(/_/g, " ");
}

/** The row's state as an officer reads it, and what follows from it. */
function rowState(row: XeroSyncOperation): string {
  if (isResolvedInXero(row)) return `The operation stays marked "${resolutionLabel(row.manuallyResolvedReason)}".`;
  if (row.status === "PENDING") return "The operation is queued to run again (a Retry) and stays queued: its run makes the same Xero call and may answer with this one, or make another, and may not redo the part that did not finish.";
  return `The operation keeps what it records now (${readableStatus(row.status)}).`;
}

/** The alert's body: the attempt lost its row, came back part-done, and what to check. */
function lostClaimPartialMessage(row: XeroSyncOperation, late: UnrecordedXeroObject, fault: string | null): string {
  const unfinished = fault ? `It did not finish this: ${fault}.` : "Part of its work, such as a payment, an email or an allocation, was not done.";
  return `This Xero operation was reset and then queued again by a Retry, withdrawn or ended by another attempt; then ${stalledAttemptCameBack(late)} It only partly succeeded. ${unfinished} The app did not record it on the operation, so the operation's own outcome stands. ${rowState(row)} Check Xero: if it holds two for one item, keep the one the operation records (once its run finishes, if it is queued), and finish by hand what the late one left undone.`;
}
