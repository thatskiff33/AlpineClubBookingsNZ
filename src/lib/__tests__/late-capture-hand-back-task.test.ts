import { describe, expect, it, vi } from "vitest";

// The sentences' module reads the database elsewhere; nothing here touches it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  automaticCancelledBookingRefundTaskReasons,
  cancelledBookingModificationRefundReason,
  deletedBookingModificationRefundReason,
} from "@/lib/deleted-booking-modification-payment";
import { isAutomaticCancelledBookingRefundTaskReason, isLateCaptureHandBackTask } from "@/lib/late-capture-hand-back-task";

/**
 * #4843: a #2700 row raised before `kind` existed carries NULL, and its frozen
 * reason sentence is then the only thing that says it is a late capture's
 * question. The rule reads the sentences off the same builders, so these use
 * the REAL builders rather than copies that could agree with a wrong rule.
 */
describe("which tasks are a late capture's question (#4843)", () => {
  const SHORT_INTENT = "pi_3QabcDEF123ghiJKL456mno";
  /** 200 characters: the most the 500-character cap leaves room for after the longest sentence. */
  const LONG_INTENT = `pi_${"x".repeat(197)}`;

  it("reads every automatic sentence as one, for any intent id", () => {
    for (const intent of [SHORT_INTENT, LONG_INTENT]) {
      for (const reason of automaticCancelledBookingRefundTaskReasons(intent)) {
        expect(isAutomaticCancelledBookingRefundTaskReason(reason)).toBe(true);
      }
    }
  });

  it("reads no other reason as one: a cancellation's hand-back, a sentence with no id, or one edited", () => {
    const sentence = deletedBookingModificationRefundReason(SHORT_INTENT);
    expect(isAutomaticCancelledBookingRefundTaskReason("Cash refund owed after cancellation")).toBe(false);
    expect(isAutomaticCancelledBookingRefundTaskReason(sentence.replace(SHORT_INTENT, ""))).toBe(false);
    expect(isAutomaticCancelledBookingRefundTaskReason(`${sentence} (edited)`)).toBe(false);
    expect(isAutomaticCancelledBookingRefundTaskReason(`Note: ${sentence}`)).toBe(false);
  });

  it("is the typed kind, or a NULL-kind row carrying a late-capture sentence - never another NULL-kind row", () => {
    const lateReason = deletedBookingModificationRefundReason(SHORT_INTENT);
    expect(isLateCaptureHandBackTask({ kind: "DELETED_BOOKING_LATE_CAPTURE", reason: "anything" })).toBe(true);
    expect(isLateCaptureHandBackTask({ kind: null, reason: lateReason })).toBe(true);
    expect(isLateCaptureHandBackTask({ kind: null, reason: cancelledBookingModificationRefundReason(SHORT_INTENT) })).toBe(true);
    expect(isLateCaptureHandBackTask({ kind: null, reason: "Cash refund owed after cancellation" })).toBe(false);
    expect(isLateCaptureHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", reason: lateReason })).toBe(false);
  });
});
