// #4757 (`INV-SSOT`): what the repair tool does with a credit note's own create
// row (`readOwnNoteRowState`), for both arms that allocate a note - an edit's
// note and a cancelled unpaid booking's invoice-clearing note. One dispatcher,
// so a guard added here holds for both.
import type { BookingXeroRepairAction, MutableFinding, XeroOperationRecord } from "./xero-booking-repair-types";
import { addAction, addFinding, buildRetryAction } from "./xero-booking-repair-findings";
import {
  getBlockingOperation,
  getLiveOperation,
  isStuckOperation,
  type OwnNoteRowState,
} from "./xero-booking-repair-object-resolution";

type NoteAllocationKind = "modification" | "clearing";

const WORDING: Record<
  NoteAllocationKind,
  { failed: string; stuck: string; live: string; repairing: string; retry: string; unretryable?: string }
> = {
  modification: {
    failed: "A Xero credit-note allocation operation failed and cannot be auto-retried - resolve the operation manually.",
    stuck: "A pending or running Xero credit-note allocation operation looks stuck.",
    live: "A Xero credit-note allocation operation is already pending or running.",
    repairing: "A retry is working on this modification credit note now; check again when it finishes.",
    retry: "A modification credit note exists, but its allocation did not complete; retrying replays it.",
    unretryable:
      "A modification credit note's allocation did not complete and its operation cannot be retried here - allocate it by hand in Xero.",
  },
  clearing: {
    failed:
      "A Xero invoice-clearing allocation operation failed and is not retried here - resolve it by hand so the cancelled unpaid booking's invoice closes.",
    stuck: "A pending or running Xero invoice-clearing allocation operation looks stuck.",
    live: "A Xero invoice-clearing allocation operation is already pending or running.",
    repairing: "A retry is working on this invoice-clearing credit note now; check again when it finishes.",
    retry:
      "The invoice-clearing credit note exists, but its allocations did not all complete; retrying replays the recorded plan.",
  },
};

/** The arm that would allocate the note, and two options each arm states as it stood before #4757. */
type NoteAllocationArm = {
  kind: NoteAllocationKind;
  bookingId: string;
  creditNoteId: string;
  /** Carried on every blocked finding: an edit's note names its modification. */
  details: Record<string, unknown>;
  /** Carried on the retry finding beside `creditNoteId` and `operationId`. */
  retryDetails: Record<string, unknown>;
  /**
   * A PARTIAL row the retry refuses. An edit's note reports it; a clearing
   * note's falls through to the arm's own no-allocation path as it did before
   * #4757 - whether it should report it too is #4762, not decided here.
   */
  unretryable: "report" | "fall-through";
  /**
   * A row an officer resolved in Xero (`INV-INT-025`): neither arm reports a
   * resolved-by-officer finding for it, only a live allocation row beside it.
   * Whether it should is #4763, not decided here.
   */
  resolved: "live-allocation-only";
};

/** A note allocation held by a live, failed or unretryable row: reported, never retried or queued beside. */
export function addBlockedNoteAllocationFinding(
  findings: MutableFinding[],
  arm: Pick<NoteAllocationArm, "kind" | "details">,
  operation: XeroOperationRecord,
  summary?: string,
  extraDetails: Record<string, unknown> = {}
) {
  const wording = WORDING[arm.kind];
  addFinding(findings, {
    code: "BLOCKED_BY_XERO_OPERATION",
    severity: "warning",
    summary:
      summary ??
      (["FAILED", "PARTIAL"].includes(operation.status)
        ? wording.failed
        : isStuckOperation(operation)
          ? wording.stuck
          : wording.live),
    safeToAutoApply: false,
    details: { ...arm.details, operationId: operation.id, operationStatus: operation.status, ...extraDetails },
    actionKeys: [],
  });
}

/**
 * What the dispatcher did with the note's own row:
 * - `handled`: reported, or the row's own retry offered - the caller queues
 *   nothing for the note's allocation;
 * - `arm-decides`: no own row says the note is unfinished, or the arm keeps
 *   its own path for this state (#4762);
 * - `allocation-row-first`: beside the note's retry, an ALLOCATE row not in
 *   flight (FAILED, PARTIAL, or resolved in Xero) - the arm retries or
 *   reports that row, as it did before #4757, even where the note already
 *   has an allocation.
 */
type OwnNoteRowOutcome = "handled" | "arm-decides" | "allocation-row-first";

/** Acts on the note's own row. `allocationOperations`: the rows the arm reads its note's ALLOCATE rows from. */
export function dispatchOwnNoteRow(
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>,
  row: OwnNoteRowState | null,
  allocationOperations: XeroOperationRecord[],
  arm: NoteAllocationArm
): OwnNoteRowOutcome {
  if (row === null) return "arm-decides";
  // #4757 review F1: the retry's allocation key embeds the amount, so the
  // note's retry beside an allocation row of the note's (one the tool queued
  // before #4757) is a second route to one allocation, and the two can
  // allocate it twice. One in flight is reported, nothing offered.
  if (row.kind === "retry" || row.kind === "repairing") {
    const liveAllocation = getLiveOperation(allocationOperations, "ALLOCATION", "ALLOCATE");
    if (liveAllocation) {
      addBlockedNoteAllocationFinding(findings, arm, liveAllocation);
      return "handled";
    }
  }
  // Any other allocation row goes back to the arm, as before #4757: FAILED or
  // PARTIAL, the arm retries or reports it; resolved in Xero, the officer
  // allocated by hand, so the note's retry would be minted beside it - the
  // arm reports it and offers nothing (#3635, `INV-INT-025`).
  if (row.kind === "retry" && getBlockingOperation(allocationOperations, "ALLOCATION", "ALLOCATE")) {
    return "allocation-row-first";
  }
  // A RUNNING row stays reported below even beside a FAILED allocation row: a
  // retry of that row beside the running repair is the same second route
  // (#4259 review F1), so it waits until the repair ends.
  switch (row.kind) {
    case "resolved": {
      // Allocated by hand: nothing retried or queued, but a separate live
      // allocation row is still seen (Xero review F8), report-only. No
      // resolved-by-officer finding (`arm.resolved`, #4763).
      const blocking = getBlockingOperation(allocationOperations, "ALLOCATION", "ALLOCATE");
      if (blocking && blocking.kind !== "resolved") addBlockedNoteAllocationFinding(findings, arm, blocking.operation);
      return "handled";
    }
    case "repairing":
      addBlockedNoteAllocationFinding(findings, arm, row.operation, WORDING[arm.kind].repairing);
      return "handled";
    case "retry": {
      const action = addAction(actionMap, buildRetryAction(arm.bookingId, row.retry));
      addFinding(findings, {
        code: "MISSING_CREDIT_NOTE_ALLOCATION",
        severity: "critical",
        summary: WORDING[arm.kind].retry,
        safeToAutoApply: true,
        details: { ...arm.retryDetails, creditNoteId: arm.creditNoteId, operationId: row.operation.id },
        actionKeys: [action.key],
      });
      return "handled";
    }
    case "unretryable":
      if (arm.unretryable === "fall-through") return "arm-decides";
      addBlockedNoteAllocationFinding(findings, arm, row.operation, WORDING[arm.kind].unretryable, {
        retryUnsupportedReason: row.reason,
      });
      return "handled";
    default: {
      const unhandled: never = row;
      throw new Error(`Unhandled own note row state: ${JSON.stringify(unhandled)}`);
    }
  }
}
