import { describe, expect, it, vi } from "vitest";

import {
  classifyBookingInvoiceSyncFault,
  getBookingInvoiceSyncFault,
} from "@/lib/booking-invoice-sync-status";

/**
 * WHAT THE BOOKING PAGE SAYS ABOUT ITS XERO INVOICE (#3001, MAD epic #2725).
 *
 * The cases below are the ones an officer meets, and each of the first four is a
 * different answer to "what do I do now?" — which is why they are four kinds and
 * not one "Xero failed" flag.
 *
 * The case this file guards hardest is the one that is NOT a failure: an invoice
 * email that was deliberately withheld. Three separate rules can withhold it and
 * none of them is a fault, so a warning raised for any of them sends an officer
 * to chase a provider that did exactly what it was told.
 */

/** A booking-invoice create operation, in the shape the projection selects. */
function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op_1",
    status: "SUCCEEDED",
    replayable: true,
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_1",
    queueType: null,
    requestPayload: null,
    responsePayload: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    lastErrorMessage: null,
    manuallyResolvedAt: null,
    ...overrides,
  } as Parameters<typeof classifyBookingInvoiceSyncFault>[0];
}

/** The completion payload a real invoice create writes, with its invoice total. */
function completionPayload(extra: Record<string, unknown>) {
  return {
    invoice: { invoices: [{ total: 120 }] },
    paymentSkipped: false,
    ...extra,
  };
}

describe("nothing to warn about", () => {
  it("says nothing when the operation succeeded", () => {
    expect(classifyBookingInvoiceSyncFault(operation())).toBeNull();
  });

  it.each(["PENDING", "RUNNING", "WAITING_PAYMENT"])(
    "says nothing while the outbox is still working (%s)",
    (status) => {
      expect(classifyBookingInvoiceSyncFault(operation({ status }))).toBeNull();
    },
  );

  it("says nothing when an operator has already resolved it directly in Xero", () => {
    // The existing override, and the whole point of it: a failure can be cleared
    // without touching booking, payment or invoice state. A warning that kept
    // shouting afterwards would make the override useless.
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "FAILED",
          lastErrorMessage: "Xero rejected the invoice",
          manuallyResolvedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ),
    ).toBeNull();
  });
});

describe("a deliberately withheld invoice email is not a failure", () => {
  /*
    #2258, #2929 and #3035. Two are the club's own decision and one is not the
    club's decision at all — this installation being a copy. All three complete
    the operation SUCCEEDED, and the officer already sees what was withheld
    through the withheld-email summary, which is where that belongs.
  */
  it.each([
    ["the per-booking No emails switch (#2258)", "invoiceEmailWithheldByNoEmails"],
    ["the creation-time choice (#2929)", "invoiceEmailWithheldByCreationChoice"],
    ["the non-production suppression (#3035)", "invoiceEmailWithheldForEnvironment"],
  ])("raises no warning for %s", (_label, key) => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "SUCCEEDED",
          xeroObjectId: "inv_1",
          responsePayload: completionPayload({ [key]: true, invoiceEmailSkipped: true }),
        }),
      ),
    ).toBeNull();
  });

  it("raises no warning when all three withheld it at once", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "SUCCEEDED",
          xeroObjectId: "inv_1",
          responsePayload: completionPayload({
            invoiceEmailWithheldByNoEmails: true,
            invoiceEmailWithheldByCreationChoice: true,
            invoiceEmailWithheldForEnvironment: true,
          }),
        }),
      ),
    ).toBeNull();
  });

  it("DOES warn when the email genuinely failed, which is the fourth reason", () => {
    // The one that is a fault. If this ever agrees with the three above, the
    // distinction has been flattened and the next support call is misdiagnosed.
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_1",
        xeroObjectNumber: "INV-0042",
        responsePayload: completionPayload({
          invoiceEmailError: { message: "SMTP refused" },
        }),
      }),
    );

    expect(fault?.kind).toBe("MEMBER_NOT_SENT_INVOICE");
  });
});

describe("the invoice never reached Xero", () => {
  it("names it as not raised, and carries the redacted reason", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "FAILED",
          lastErrorMessage: "Xero rejected the invoice: account code missing",
        }),
      ),
    ).toMatchObject({
      kind: "INVOICE_NOT_RAISED",
      invoiceReachedXero: false,
      invoiceNumber: null,
      reason: "Xero rejected the invoice: account code missing",
    });
  });

  it("a FAILED row that DOES carry an invoice id is not called 'not raised'", () => {
    // It failed after Xero accepted the invoice. Telling an officer no invoice
    // exists would walk them straight into raising a second one.
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "FAILED",
          xeroObjectId: "inv_9",
          xeroObjectNumber: "INV-0099",
          lastErrorMessage: "Link write failed",
        }),
      ),
    ).toMatchObject({
      kind: "PARTLY_COMPLETED",
      invoiceReachedXero: true,
      invoiceNumber: "INV-0099",
    });
  });
});

describe("the invoice reached Xero but something after it did not", () => {
  it("names a failed payment write, and offers the retry the engine supports", () => {
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_2",
        xeroObjectNumber: "INV-0043",
        responsePayload: completionPayload({
          paymentError: { message: "payment write rejected" },
        }),
      }),
    );

    expect(fault).toMatchObject({
      kind: "PAYMENT_NOT_RECORDED",
      invoiceReachedXero: true,
      retrySupported: true,
      retryBlockedReason: null,
    });
  });

  it("does NOT offer a retry for an email-only failure, and says why", () => {
    // The money fence: 'repairing' one of these records a bank payment against
    // an invoice the member has not paid. The refusal is the engine's own, so
    // the booking page and the Xero screen cannot disagree about the same row.
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_3",
        responsePayload: completionPayload({
          invoiceEmailError: { message: "send failed" },
        }),
      }),
    );

    expect(fault?.kind).toBe("MEMBER_NOT_SENT_INVOICE");
    expect(fault?.retrySupported).toBe(false);
    expect(fault?.retryBlockedReason).toContain("send the invoice from Xero instead");
  });

  it("leads with the payment when both legs failed", () => {
    // Documented precedence: an invoice showing as awaiting payment for money
    // the club already holds misstates the ledger, while an unsent invoice is a
    // message an officer can relay.
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "PARTIAL",
          xeroObjectId: "inv_4",
          responsePayload: completionPayload({
            paymentError: { message: "payment write rejected" },
            invoiceEmailError: { message: "send failed" },
          }),
        }),
      )?.kind,
    ).toBe("PAYMENT_NOT_RECORDED");
  });

  it("never shows a PARTIAL row the stale message of an earlier failed attempt", () => {
    // `completeXeroSyncOperation` does not clear `lastErrorMessage`, so a row
    // that failed, was retried and came back PARTIAL still carries the previous
    // attempt's text. Showing it here would describe the wrong event.
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "PARTIAL",
          xeroObjectId: "inv_5",
          lastErrorMessage: "Xero rejected the invoice (previous attempt)",
          responsePayload: completionPayload({
            invoiceEmailError: { message: "send failed" },
          }),
        }),
      )?.reason,
    ).toBeNull();
  });

  it("falls back to 'partly completed' when the payload records no fault at all", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "PARTIAL",
          xeroObjectId: "inv_6",
          responsePayload: completionPayload({}),
        }),
      )?.kind,
    ).toBe("PARTLY_COMPLETED");
  });
});

describe("which operation is the current one", () => {
  it("matches on the booking's own correlation key and takes the newest row", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);

    await getBookingInvoiceSyncFault("bkg_77", {
      deps: { db: { xeroSyncOperation: { findFirst } } },
    });

    const args = findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };

    // Keyed on the BOOKING, never joined through the payment row — a booking
    // whose payment is missing or replaced would otherwise match nothing and
    // the page would report all-clear over a failed invoice.
    expect(args.where).toMatchObject({
      correlationKey: "booking:bkg_77:invoice:v1",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
    });

    // Newest first, with a deterministic tie-break: an older failure can never
    // outvote a later success.
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("reports nothing when the booking has no invoice operation at all", async () => {
    // A cash booking marked paid by hand never enqueues one, and must not be
    // warned about.
    await expect(
      getBookingInvoiceSyncFault("bkg_78", {
        deps: {
          db: { xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) } },
        },
      }),
    ).resolves.toBeNull();
  });

  it("classifies the row the query returned", async () => {
    await expect(
      getBookingInvoiceSyncFault("bkg_79", {
        deps: {
          db: {
            xeroSyncOperation: {
              findFirst: vi.fn().mockResolvedValue(
                operation({ status: "FAILED", lastErrorMessage: "boom" }),
              ),
            },
          },
        },
      }),
    ).resolves.toMatchObject({ kind: "INVOICE_NOT_RAISED", reason: "boom" });
  });
});
