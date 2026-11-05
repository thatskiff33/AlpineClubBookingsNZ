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
import { addAction, addFinding, addResolvedInXeroFinding, buildRetryAction } from "./xero-booking-repair-findings";
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
  {
    failed: string;
    stuck: string;
    live: string;
    repairing: string;
    retry: string;
    handMade: string;
    unretryable: string;
    /** The document a resolved-by-officer finding names (`addResolvedInXeroFinding`). */
    resolvedDocument: string;
  }
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
    resolvedDocument: "credit-note allocation",
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
    unretryable:
      "The invoice-clearing credit note's allocations did not all complete and its operation cannot be retried here - allocate the invoices left by hand in Xero so the cancelled unpaid booking's invoice closes.",
    resolvedDocument: "invoice-clearing allocation",
  },
};

/** The arm that would allocate the note. */
type NoteAllocationArm = {
  kind: NoteAllocationKind;
  bookingId: string;
  creditNoteId: string;
  /** Carried on every blocked finding: an edit's note names its modification. */
  details: Record<string, unknown>;
  /** Carried on the retry finding beside `creditNoteId` and `operationId`. */
  retryDetails: Record<string, unknown>;
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
 * A note allocation an officer resolved in Xero (`INV-INT-025`): done, never
 * retried or queued beside, but reported - info, no action. One wording for an
 * allocation row the arm answers and the note's own resolved row (#4763).
 */
export function addResolvedNoteAllocationFinding(
  findings: MutableFinding[],
  arm: Pick<NoteAllocationArm, "kind" | "details">,
  operation: XeroOperationRecord,
  extraDetails: Record<string, unknown> = {}
) {
  addResolvedInXeroFinding(findings, operation, WORDING[arm.kind].resolvedDocument, { ...arm.details, ...extraDetails });
}

/**
 * What the dispatcher did with the note's own row:
 * - `handled`: reported, or the row's own retry offered - the caller queues
 *   nothing for the note's allocation;
 * - `arm-decides`: no own row says the note is unfinished;
 * - `allocation-row-first`: beside the note's retry, an ALLOCATE row in the
 *   arm's scope that is not the note's own attempt - the arm answers
 *   `blocking` (that row's retry, a blocked report, or the resolved report)
 *   instead, even where the note already has an allocation. For a clearing
 *   note this is new with #4757: before, its retry was offered beside such a row.
 *   A row the retry refuses is read the same way (#4762), and both get the
 *   resolved report when their own attempts resolved by hand leave no planned
 *   invoice.
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
  // #4757 review F1: an allocation row in flight beside the note's retry, its
  // running repair, or a by-hand instruction for a row the retry refuses
  // (#4762) could allocate the note a second time. Reported, nothing offered.
  if (row.kind === "retry" || row.kind === "repairing" || row.kind === "unretryable") {
    const liveAllocation = getLiveOperation(operations, "ALLOCATION", "ALLOCATE");
    if (liveAllocation) {
      addBlockedNoteAllocationFinding(findings, arm, liveAllocation);
      return HANDLED;
    }
  }
  if (row.kind === "retry" || row.kind === "unretryable") {
    const plan = readPlan(row.operation.requestPayload);
    const candidates = blockingCandidates(operations, "ALLOCATION", "ALLOCATE");
    const own = candidates.filter((operation) => isOwnAttempt(operation, arm.creditNoteId, plan));
    // #4757 review S1: the note's own attempts never stand in its retry's way
    // (it covers them, and the later targets a refused first one never
    // reached); any other unresolved row goes to the arm first - two keys never
    // both retried. A row resolved in Xero was allocated by hand (#3635,
    // `INV-INT-025`): it goes first only when it names this note (round 5) - one
    // of another note's on the booking is that note's concern, and would hold
    // this retry back for good. The same for a row the retry refuses (#4762):
    // an allocate-by-hand beside another row's later retry would allocate the
    // credit twice - except that with no readable plan (redacted, say) none of
    // its rows is known as its own attempt, so one resolved by hand could be
    // part of the note only: it never answers for the whole, and the blocked
    // report below stands.
    const planKnown = plan.length > 0;
    const others = candidates.filter(
      (operation) =>
        !own.includes(operation) &&
        (!isResolvedInXero(operation) ||
          (readJsonRecord(operation.requestPayload)?.creditNoteId === arm.creditNoteId &&
            (row.kind === "retry" || planKnown)))
    );
    const blocking = getBlockingOperation(others, "ALLOCATION", "ALLOCATE");
    if (blocking) return { outcome: "allocation-row-first", blocking };
    // #4757 review S2: an own attempt resolved by hand has no link, so the
    // retry would allocate it again. Whole by hand: the resolved report, for a
    // row the retry refuses too (#4762); else a person allocates the planned
    // invoices left, listed, and nothing is offered.
    const handMade = own.filter((operation) => isResolvedInXero(operation));
    const byHand = new Set(handMade.map((operation) => readJsonRecord(operation.requestPayload)?.invoiceId));
    const left = targetsWithoutAllocation(plan, arm.creditNoteId, noteAllocationLinks(links)).filter(
      (target) => !byHand.has(target.invoiceId)
    );
    const [firstHandMade] = handMade;
    if (firstHandMade !== undefined && left.length === 0) {
      return { outcome: "allocation-row-first", blocking: { kind: "resolved", resolvedOperation: firstHandMade } };
    }
    if (row.kind === "unretryable") {
      // #4762: reported blocked for both arms, the invoices left listed - or
      // null, meaning unknown, when the plan cannot be read: an empty list
      // would say nothing is left. A clearing note's fell through to its arm's
      // own path before, which could queue a fresh allocation of the whole
      // note against the primary invoice beside it - for a spread plan, the
      // #3535 hazard.
      addBlockedNoteAllocationFinding(findings, arm, row.operation, WORDING[arm.kind].unretryable, {
        retryUnsupportedReason: row.reason,
        unallocatedInvoices: planKnown ? left : null,
      });
      return HANDLED;
    }
    if (firstHandMade !== undefined) {
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
      // Allocated by hand (`INV-INT-025`): nothing retried or queued, but the
      // row is still reported (#4763), naming the note. It is answered ahead of
      // the in-flight check, others-first and the by-hand count above (and
      // `readOwnNoteRowState` reads it ahead of a running repair, which cannot
      // claim a resolved row): those decide whether the note's retry may be
      // offered, and a resolved row offers none, so none of them can change
      // the answer. Nor does a row beside it replace the report - that would
      // hide the officer's resolve: a separate live or failed allocation row
      // is reported alongside it (Xero review F8), report-only, since a retry
      // of it could allocate the note a second time.
      addResolvedNoteAllocationFinding(findings, arm, row.operation, { creditNoteId: arm.creditNoteId });
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
    default: {
      const unhandled: never = row;
      throw new Error(`Unhandled own note row state: ${JSON.stringify(unhandled)}`);
    }
  }
}
