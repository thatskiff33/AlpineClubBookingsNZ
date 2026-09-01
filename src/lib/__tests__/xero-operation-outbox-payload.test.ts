import { describe, expect, it } from "vitest";
import {
  getQueuedOutboxExpectedOperation,
  readQueuedOutboxPayload,
  readQueueType,
  XERO_OUTBOX_QUEUE_TYPES,
} from "@/lib/xero-operation-outbox-payload";

describe("xero operation outbox payload parsing", () => {
  it("normalizes entrance fee invoice payloads with integer cents", () => {
    expect(
      readQueuedOutboxPayload({
        queueType: "ENTRANCE_FEE_INVOICE",
        category: "ADULT",
        itemCode: "EF-ADULT",
        feeAmountCents: "15000",
        description: "Entrance fee",
      })
    ).toEqual({
      queueType: "ENTRANCE_FEE_INVOICE",
      category: "ADULT",
      itemCode: "EF-ADULT",
      feeAmountCents: 15000,
      description: "Entrance fee",
    });
  });

  it("rejects incomplete or unknown queued payloads", () => {
    expect(
      readQueuedOutboxPayload({
        queueType: "BOOKING_INVOICE",
        bookingId: " ",
      })
    ).toBeNull();
    expect(
      readQueuedOutboxPayload({
        queueType: "REFUND_CREDIT_NOTE",
        refundAmountCents: "not-a-number",
      })
    ).toBeNull();
    expect(readQueuedOutboxPayload({ queueType: "UNKNOWN" })).toBeNull();
  });

  it("parses supplementary invoice flags without coercing non-booleans", () => {
    expect(
      readQueuedOutboxPayload({
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        priceDiffCents: 2500,
        changeFeeCents: "500",
        bookingModificationId: "mod_1",
        recordPayment: false,
        waitForConfirmedAdditionalPayment: "yes",
      })
    ).toEqual({
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "booking_1",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      bookingModificationId: "mod_1",
      recordPayment: false,
      paymentIntentId: undefined,
      waitForConfirmedAdditionalPayment: undefined,
      shortfallReviewTaskId: undefined,
    });
  });

  /**
   * #3193: the second ask's marker survives the parse, and the claim guard
   * accepts its anchor.
   *
   * Both halves matter and they fail differently. A dropped marker sends the
   * handler down the ordinary path, which would write the invoice's link onto
   * the BOOKING CHANGE - where the change's own reads would find it - and key
   * the create the way the change's own invoice is keyed, so Xero would answer
   * it with the invoice already sent. A missing `ManualRefundTask` in the claim
   * guard is quieter and just as bad: the row is skipped on every pass, forever,
   * and the difference is never billed at all.
   */
  it("carries the second ask's review task through the parse (#3193)", () => {
    expect(
      readQueuedOutboxPayload({
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        priceDiffCents: 3000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
        recordPayment: false,
        shortfallReviewTaskId: "task_2",
      })
    ).toMatchObject({ shortfallReviewTaskId: "task_2" });

    expect(
      getQueuedOutboxExpectedOperation("SUPPLEMENTARY_INVOICE").localModels
    ).toContain("ManualRefundTask");
  });

  it("normalizes modification account-credit note payloads", () => {
    expect(
      readQueuedOutboxPayload({
        queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
        bookingId: "booking_1",
        paymentId: "payment_1",
        refundAmountCents: "3750",
        bookingModificationId: "mod_1",
      })
    ).toEqual({
      queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
      bookingId: "booking_1",
      paymentId: "payment_1",
      refundAmountCents: 3750,
      bookingModificationId: "mod_1",
    });
  });

  it("maps queued payload types to guarded sync operation claims", () => {
    expect(getQueuedOutboxExpectedOperation("BOOKING_INVOICE_UPDATE")).toEqual({
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModels: ["Payment"],
    });
    expect(
      getQueuedOutboxExpectedOperation("GROUP_SETTLEMENT_INVOICE_VOID")
    ).toEqual({
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModels: ["GroupBookingSettlement"],
    });
    expect(
      getQueuedOutboxExpectedOperation(
        "MEMBERSHIP_CANCELLATION_CREDIT_NOTE"
      )
    ).toEqual({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModels: ["MemberSubscription"],
    });
    expect(getQueuedOutboxExpectedOperation("CREDIT_NOTE_ALLOCATION")).toEqual({
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModels: [
        "Payment",
        "Booking",
        "BookingModification",
        "MemberCreditNoteAllocation",
      ],
    });
    expect(getQueuedOutboxExpectedOperation("APPLIED_CREDIT_ALLOCATION")).toEqual({
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModels: ["Payment"],
    });
    expect(getQueuedOutboxExpectedOperation("MODIFICATION_ACCOUNT_CREDIT_NOTE")).toEqual({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModels: ["Booking", "BookingModification"],
    });
  });

  it("reads queue type only from object payloads", () => {
    expect(readQueueType({ queueType: "BOOKING_INVOICE" })).toBe(
      "BOOKING_INVOICE"
    );
    expect(readQueueType(null)).toBeNull();
    expect(readQueueType(["BOOKING_INVOICE"])).toBeNull();
  });

  it("exposes the exact set of outbox queue types the pending scan dispatches (#1272)", () => {
    // Single source of truth: the pending-outbox scan filters `queueType IN`
    // this list and the dispatch switch routes exactly these members. Locking
    // the wire values guards the scan/dispatch domain against drift.
    expect([...XERO_OUTBOX_QUEUE_TYPES]).toEqual([
      "ENTRANCE_FEE_INVOICE",
      "BOOKING_INVOICE",
      "BOOKING_INVOICE_UPDATE",
      "REFUND_CREDIT_NOTE",
      "ACCOUNT_CREDIT_NOTE",
      "SUPPLEMENTARY_INVOICE",
      "MODIFICATION_CREDIT_NOTE",
      "MODIFICATION_ACCOUNT_CREDIT_NOTE",
      "CREDIT_NOTE_ALLOCATION",
      "APPLIED_CREDIT_ALLOCATION",
      "APPLIED_CREDIT_DEALLOCATION",
      "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
      "MEMBERSHIP_CANCELLATION_CONTACT",
      "GROUP_SETTLEMENT_INVOICE",
      "GROUP_SETTLEMENT_INVOICE_VOID",
      "MEMBERSHIP_SUBSCRIPTION_INVOICE",
    ]);
    expect(new Set(XERO_OUTBOX_QUEUE_TYPES).size).toBe(
      XERO_OUTBOX_QUEUE_TYPES.length
    );
  });

  it("routes every scanned queue type through the guarded expected-operation map (#1272)", () => {
    // Every queueType the scan selects must resolve to a concrete claim guard,
    // so the column scan can never surface a type the dispatch path lacks.
    const expectedEntityTypes = new Map<string, string>([
      ["ENTRANCE_FEE_INVOICE", "INVOICE"],
      ["BOOKING_INVOICE", "INVOICE"],
      ["BOOKING_INVOICE_UPDATE", "INVOICE"],
      ["REFUND_CREDIT_NOTE", "CREDIT_NOTE"],
      ["ACCOUNT_CREDIT_NOTE", "CREDIT_NOTE"],
      ["SUPPLEMENTARY_INVOICE", "INVOICE"],
      ["MODIFICATION_CREDIT_NOTE", "CREDIT_NOTE"],
      ["MODIFICATION_ACCOUNT_CREDIT_NOTE", "CREDIT_NOTE"],
      ["CREDIT_NOTE_ALLOCATION", "ALLOCATION"],
      ["APPLIED_CREDIT_ALLOCATION", "ALLOCATION"],
      ["APPLIED_CREDIT_DEALLOCATION", "ALLOCATION"],
      ["MEMBERSHIP_CANCELLATION_CREDIT_NOTE", "CREDIT_NOTE"],
      ["MEMBERSHIP_CANCELLATION_CONTACT", "CONTACT"],
      ["GROUP_SETTLEMENT_INVOICE", "INVOICE"],
      ["GROUP_SETTLEMENT_INVOICE_VOID", "INVOICE"],
      ["MEMBERSHIP_SUBSCRIPTION_INVOICE", "INVOICE"],
    ]);
    for (const queueType of XERO_OUTBOX_QUEUE_TYPES) {
      expect(getQueuedOutboxExpectedOperation(queueType).entityType).toBe(
        expectedEntityTypes.get(queueType)
      );
    }
  });
});
