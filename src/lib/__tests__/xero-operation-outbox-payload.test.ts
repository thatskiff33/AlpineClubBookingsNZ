import { describe, expect, it } from "vitest";
import {
  getQueuedOutboxExpectedOperation,
  readQueuedOutboxPayload,
  readQueueType,
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
    });
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
      localModels: ["Payment", "Booking", "BookingModification"],
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
});
