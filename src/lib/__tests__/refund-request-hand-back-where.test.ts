import { describe, expect, it } from "vitest";
import {
  cardRefundPaidAnotherWayOccurrenceKey,
  COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE,
  editRefundHandBackOccurrenceKey,
  isRefundRequestHandBackTask,
  refundRequestHandBackOccurrenceKey,
} from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4215 (`INV-SSOT`, `INV-PAY-118`): the query that reads a refund request's
 * paid-back cash and the predicate every row reader asks are one definition.
 * A row the where fragment selects is a refund request's hand-back by the
 * predicate, and no other hand-back's key is selected by either.
 */
type Row = { kind: string | null; status: string; occurrenceKey: string | null };

/** What PostgreSQL answers for the fragment's three conditions. */
function selectedByFragment(row: Row): boolean {
  const where = COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE;
  return (
    row.kind === where.kind &&
    row.status === where.status &&
    (row.occurrenceKey?.startsWith(where.occurrenceKey.startsWith) ?? false)
  );
}

const handBack = (occurrenceKey: string | null, status = "COMPLETED"): Row => ({
  kind: "CANCELLED_BOOKING_HAND_BACK",
  status,
  occurrenceKey,
});

describe("a refund request's paid-back hand-back: one definition for the query and the row (#4215)", () => {
  it("every row the fragment selects is a refund request's hand-back", () => {
    const row = handBack(refundRequestHandBackOccurrenceKey("rr_1"));
    expect(selectedByFragment(row)).toBe(true);
    expect(isRefundRequestHandBackTask(row)).toBe(true);
  });

  it("selects only a COMPLETED one: open or dismissed moved no cash", () => {
    for (const status of ["OPEN", "DISMISSED"]) {
      const row = handBack(refundRequestHandBackOccurrenceKey("rr_1"), status);
      expect(selectedByFragment(row)).toBe(false);
      expect(isRefundRequestHandBackTask(row)).toBe(true);
    }
  });

  it("an edit's refund hand-back, a paid-another-way close and a cancellation's hand-back are neither", () => {
    for (const occurrenceKey of [
      editRefundHandBackOccurrenceKey("mod_1"),
      cardRefundPaidAnotherWayOccurrenceKey("op_1", { xeroRefundNote: "now" }),
      // A near miss: the prefix without its separator.
      "refund-request-hand-back",
      null,
    ]) {
      const row = handBack(occurrenceKey);
      expect(selectedByFragment(row)).toBe(false);
      expect(isRefundRequestHandBackTask(row)).toBe(false);
    }
  });

  it("another kind with the request's key is neither", () => {
    const row = { ...handBack(refundRequestHandBackOccurrenceKey("rr_1")), kind: "EDIT_FINANCIAL_REVIEW" };
    expect(selectedByFragment(row)).toBe(false);
    expect(isRefundRequestHandBackTask(row)).toBe(false);
  });
});
