// #4757 (`INV-SSOT`): what the repair tool does with a credit note's own create
// row (`readOwnNoteRowState`), for both arms that allocate a note - an edit's
// note and a cancelled unpaid booking's invoice-clearing note. One dispatcher,
// so a guard added here holds for both.
import { recordedClearingTargets, targetsWithoutAllocation, type ClearingAllocationTarget } from "@/lib/xero-clearing-allocations";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import type {
  BlockingOperationMatch,
  BookingXeroRepairAction,
  MutableFinding,
  XeroObjectLinkRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildRetryAction } from "./xero-booking-repair-findings";
import {
  blockingCandidates,
  getBlockingOperation,
  getLiveOperation,
  isStuckOperation,
  noteAllocationLinks,
  readOwnNoteRowState,
} from "./xero-booking-repair-object-resolution";
import { readJsonRecord } from "./xero-booking-repair-utils";

type NoteAllocationKind = "modification" | "clearing";

const WORDING: Record<
  NoteAllocationKind,
  { failed: string; stuck: string; live: string; repairing: string; retry: string; handMade: string; unretryable?: string }
> = {
  modification: {
    failed: "A Xero credit-note allocation operation failed and cannot be auto-retried - resolve the operation manually.",
    stuck: "A pending or running Xero credit-note allocation operation looks stuck.",
    live: "A Xero credit-note allocation operation is already pending or running.",
    repairing: "A retry is working on this modification credit note now; check again when it finishes.",
    retry: "A modification credit note exists, but its allocation did not complete; retrying replays it.",
    handMade:
      "Part of this modification credit note's allocation was resolved by hand in Xero, and a retry would allocate that part again - allocate the rest by hand in Xero.",
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
    handMade:
      "Part of this invoice-clearing credit note's allocations was resolved by hand in Xero, and a retry would allocate that part again - allocate the invoices left by hand in Xero.",
  },
};

/** The arm that would allocate the note, and two behaviours from main each arm keeps, as explicit options. */
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
 * - `allocation-row-first`: beside the note's retry, an ALLOCATE row in the
 *   arm's scope that is not the note's own attempt - the arm answers
 *   `blocking` (that row's retry, a blocked report, or the resolved report)
 *   instead, even where the note already has an allocation. For a clearing
 *   note this is new with #4757: before, its retry was offered beside such a row.
 */
export type OwnNoteRowOutcome =
  | { outcome: "handled" | "arm-decides" }
  | { outcome: "allocation-row-first"; blocking: BlockingOperationMatch };

const HANDLED: OwnNoteRowOutcome = { outcome: "handled" };
const ARM_DECIDES: OwnNoteRowOutcome = { outcome: "arm-decides" };

/** The note's recorded plan; a redacted or unreadable one makes no row its own. */
function readPlan(requestPayload: unknown): ClearingAllocationTarget[] {
  try {
    return recordedClearingTargets(requestPayload) ?? [];
  } catch {
    return [];
  }
}

/**
 * #4757 review S1: an ALLOCATE row the note's own create or PARTIAL retry made
 * for a planned target - this note, and a plan entry's invoice AND amount.
 * Xero's allocation key is (note, invoice, amount), and the note's retry skips
 * a target already linked and links with the note's role, so it is the one
 * route to that allocation. Any other row (another note, invoice or amount -
 * the old tool's evidence-sized allocation) is a second key.
 */
function isOwnAttempt(operation: XeroOperationRecord, creditNoteId: string, plan: ClearingAllocationTarget[]): boolean {
  const payload = readJsonRecord(operation.requestPayload);
  return (
    payload?.creditNoteId === creditNoteId &&
    plan.some((target) => target.invoiceId === payload.invoiceId && target.amountCents === payload.amountCents)
  );
}

/**
 * Reads the note's own row (`readOwnNoteRowState`) and acts on it. `operations`
 * and `links` are the arm's scope: the whole booking's for a clearing note,
 * the note's own for an edit's note.
 */
export function dispatchOwnNoteRow(
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>,
  operations: XeroOperationRecord[],
  links: XeroObjectLinkRecord[],
  arm: NoteAllocationArm
): OwnNoteRowOutcome {
  const row = readOwnNoteRowState(operations, links, arm.creditNoteId);
  if (row === null) return ARM_DECIDES;
  // #4757 review F1: an allocation row in flight beside the note's retry or its
  // running repair could allocate the note a second time. Reported, nothing offered.
  if (row.kind === "retry" || row.kind === "repairing") {
    const liveAllocation = getLiveOperation(operations, "ALLOCATION", "ALLOCATE");
    if (liveAllocation) {
      addBlockedNoteAllocationFinding(findings, arm, liveAllocation);
      return HANDLED;
    }
  }
  if (row.kind === "retry") {
    // #4757 review S1: the note's own attempts never stand in its retry's way
    // (it covers them, and the later targets a refused first one never
    // reached); any other row goes to the arm first - two keys never both retried.
    // Resolved in Xero, such a row was allocated by hand (#3635, `INV-INT-025`).
    const plan = readPlan(row.operation.requestPayload);
    const candidates = blockingCandidates(operations, "ALLOCATION", "ALLOCATE");
    const own = candidates.filter((operation) => isOwnAttempt(operation, arm.creditNoteId, plan));
    const blocking = getBlockingOperation(candidates.filter((operation) => !own.includes(operation)), "ALLOCATION", "ALLOCATE");
    if (blocking) return { outcome: "allocation-row-first", blocking };
    // #4757 review S2: an own attempt resolved by hand has no link, so the
    // retry would allocate it again. Whole by hand: the resolved report; else a
    // person allocates the planned invoices left, listed, and nothing is offered.
    const handMade = own.filter((operation) => isResolvedInXero(operation));
    if (handMade.length > 0) {
      const byHand = new Set(handMade.map((operation) => readJsonRecord(operation.requestPayload)?.invoiceId));
      const left = targetsWithoutAllocation(plan, arm.creditNoteId, noteAllocationLinks(links)).filter(
        (target) => !byHand.has(target.invoiceId)
      );
      if (left.length === 0) return { outcome: "allocation-row-first", blocking: { kind: "resolved", resolvedOperation: handMade[0] } };
      addFinding(findings, {
        code: "MANUAL_REVIEW_REQUIRED",
        severity: "manual_review",
        summary: WORDING[arm.kind].handMade,
        safeToAutoApply: false,
        details: {
          ...arm.details,
          creditNoteId: arm.creditNoteId,
          operationId: row.operation.id,
          resolvedOperationIds: handMade.map((operation) => operation.id),
          unallocatedInvoices: left,
        },
        actionKeys: [],
      });
      return HANDLED;
    }
  }
  // A RUNNING row stays reported below even beside a FAILED allocation row: a
  // retry of that row beside the running repair is a second route too
  // (#4259 review F1), so it waits until the repair ends.
  switch (row.kind) {
    case "resolved": {
      // Allocated by hand: nothing retried or queued, but a separate live
      // allocation row is still seen (Xero review F8), report-only. No
      // resolved-by-officer finding (`arm.resolved`, #4763).
      const blocking = getBlockingOperation(operations, "ALLOCATION", "ALLOCATE");
      if (blocking && blocking.kind !== "resolved") addBlockedNoteAllocationFinding(findings, arm, blocking.operation);
      return HANDLED;
    }
    case "repairing":
      addBlockedNoteAllocationFinding(findings, arm, row.operation, WORDING[arm.kind].repairing);
      return HANDLED;
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
      return HANDLED;
    }
    case "unretryable":
      if (arm.unretryable === "fall-through") return ARM_DECIDES;
      addBlockedNoteAllocationFinding(findings, arm, row.operation, WORDING[arm.kind].unretryable, {
        retryUnsupportedReason: row.reason,
      });
      return HANDLED;
    default: {
      const unhandled: never = row;
      throw new Error(`Unhandled own note row state: ${JSON.stringify(unhandled)}`);
    }
  }
}
