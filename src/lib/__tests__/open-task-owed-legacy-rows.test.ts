import { describe, expect, it } from "vitest";

import {
  OWED_RECONCILIATION_PAYMENTS,
  owedReconciliationPaymentRow,
} from "@/lib/__tests__/helpers/net-collected-scope-fixture";
import { deletedBookingModificationRefundReason } from "@/lib/late-capture-reason-sentences";
import { isLateCaptureAwaitingDecisionTask, openTaskOwedCents, type HandBackTaskRow } from "@/lib/manual-refund-task-settlement-rules";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";

/**
 * #4848: WHICH OPEN TASK IS A LATE CAPTURE AWAITING THE TREASURER, for the owed
 * figures (Net Collected's parts and "Refunds owed"). `kind` was added on 19 Aug
 * 2026 with no backfill, so a row raised before it carries NULL. Such a row is
 * a late capture only when it carries one of the frozen late-capture reason
 * sentences (`isLateCaptureHandBackTask`, the rule the hand-back's still-owed
 * check uses) - never merely because its booking was deleted, which a
 * cancellation's hand-back on a booking deleted later also is. The sentence is
 * the REAL builder's, so a copy cannot agree with a wrong rule.
 */
const LEGACY_LATE_CAPTURE_REASON = deletedBookingModificationRefundReason("pi_legacy_late_4848");
const HAND_BACK_REASON = "Cancellation refund owed by hand";

const task = (overrides: Partial<HandBackTaskRow>): HandBackTaskRow => ({
  status: "OPEN",
  kind: null,
  amountCents: 2_500,
  partPaymentReviewPaymentId: null,
  occurrenceKey: null,
  reason: HAND_BACK_REASON,
  ...overrides,
});

describe("a legacy NULL-kind task's owed part follows its reason, not its booking (#4848)", () => {
  // MUTATION (#4848): put back "NULL kind on a deleted booking" and the first case reads late-capture owed.
  it("a legacy cancellation hand-back is hand-back owed", () => {
    expect(isLateCaptureAwaitingDecisionTask(task({}))).toBe(false);
    expect(openTaskOwedCents([task({})])).toEqual({ handBackCents: 2_500, lateCaptureCents: 0 });
  });

  // MUTATION (#4848): gate on the typed kind alone and this reads hand-back owed.
  it("a legacy #2700 row, named by its sentence, is late-capture owed", () => {
    const legacy = task({ reason: LEGACY_LATE_CAPTURE_REASON });
    expect(isLateCaptureAwaitingDecisionTask(legacy)).toBe(true);
    expect(openTaskOwedCents([legacy])).toEqual({ handBackCents: 0, lateCaptureCents: 2_500 });
  });

  it("a typed late capture is late-capture owed whatever its reason, and only while OPEN", () => {
    const typed = task({ kind: "DELETED_BOOKING_LATE_CAPTURE", reason: "Held for a treasurer" });
    expect(openTaskOwedCents([typed])).toEqual({ handBackCents: 0, lateCaptureCents: 2_500 });
    for (const status of ["COMPLETED", "DISMISSED"]) {
      expect(openTaskOwedCents([{ ...typed, status }, task({ status, reason: LEGACY_LATE_CAPTURE_REASON })])).toEqual({
        handBackCents: 0,
        lateCaptureCents: 0,
      });
    }
  });

  describe("through Net Collected's cash parts, on a booking deleted after its task was raised", () => {
    const deleted = OWED_RECONCILIATION_PAYMENTS.find((row) => row.bookingId === "b-deleted-late-capture")!;

    it("reads the fixture's legacy #2700 row as a late capture (every reader's figure unchanged)", () => {
      expect(deleted.deletedAt).not.toBeNull();
      expect(getNetCollectedCashParts(owedReconciliationPaymentRow(deleted))).toMatchObject({
        handBackOwedCents: 0,
        lateCaptureOwedCents: 2_500,
      });
    });

    it("reads a legacy cancellation hand-back there as hand-back owed, the same total in its own line", () => {
      const handBack = {
        ...deleted,
        manualRefundTasks: deleted.manualRefundTasks.map((row) => ({ ...row, reason: HAND_BACK_REASON })),
      };
      expect(getNetCollectedCashParts(owedReconciliationPaymentRow(handBack))).toMatchObject({
        handBackOwedCents: 2_500,
        lateCaptureOwedCents: 0,
      });
    });
  });
});
