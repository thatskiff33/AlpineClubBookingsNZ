import { describe, expect, it, vi } from "vitest";

import {
  classifyBookingInvoiceSyncFault,
  getBookingInvoiceSyncFault,
  type BookingInvoiceSyncContext,
} from "@/lib/booking-invoice-sync-status";

/**
 * WHAT THE BOOKING PAGE SAYS ABOUT ITS XERO INVOICE (#3001, MAD epic #2725).
 *
 * The cases below are the ones an officer meets, and each is a different answer
 * to "what do I do now?" — which is why they are five kinds and not one "Xero
 * failed" flag.
 *
 * TWO THINGS THIS FILE GUARDS HARDEST.
 *
 * The first is the case that is NOT a failure: an invoice email that was
 * deliberately withheld. Three separate rules can withhold it and none of them
 * is a fault, so a warning raised for any of them sends an officer to chase a
 * provider that did exactly what it was told.
 *
 * The second is the case that IS a failure and looks like the opposite. A row
 * that fails AFTER Xero accepted the invoice carries NO `xeroObjectId` — the
 * failure writer does not write that column at all — so the evidence that the
 * invoice exists has to come from what the workflow persisted before it could
 * fail. Reading it off the operation row answers "no invoice was raised" for
 * every failure, which is how an officer ends up raising a second one.
 */

/**
 * A booking-invoice create operation, in the shape the projection selects.
 *
 * `xeroObjectId` defaults to null and the FAILED cases below leave it there, on
 * purpose: that is what `failXeroSyncOperation` really produces. A fixture that
 * sets it on a failed row is describing a row the writers cannot write.
 */
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
    lastErrorCode: null,
    lastErrorMessage: null,
    startedAt: null,
    manuallyResolvedAt: null,
    ...overrides,
  } as Parameters<typeof classifyBookingInvoiceSyncFault>[0];
}

/** The frozen clock this suite runs on (`vitest.clock-setup.ts`). */
const NOW = new Date("2026-07-01T00:00:00.000Z");

/** "The club has no record of an invoice for this booking." */
function noEvidence(now: Date = NOW): BookingInvoiceSyncContext {
  return { evidence: { exists: false, invoiceNumber: null }, now };
}

/** "The payment, or the primary-invoice link, says Xero has it." */
function evidenceOf(
  invoiceNumber: string | null,
  now: Date = NOW,
): BookingInvoiceSyncContext {
  return { evidence: { exists: true, invoiceNumber }, now };
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
    expect(classifyBookingInvoiceSyncFault(operation(), noEvidence())).toBeNull();
  });

  it.each(["PENDING", "WAITING_PAYMENT"])(
    "says nothing while the outbox is still working (%s)",
    (status) => {
      expect(
        classifyBookingInvoiceSyncFault(operation({ status }), noEvidence()),
      ).toBeNull();
    },
  );

  it("says nothing about an operation that was claimed moments ago", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "RUNNING",
          startedAt: new Date(NOW.getTime() - 60_000),
        }),
        noEvidence(),
      ),
    ).toBeNull();
  });

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
        noEvidence(),
      ),
    ).toBeNull();
  });
});

describe("a deliberately withheld invoice email is not a failure", () => {
  /*
    #2258, #2929 and #3035. Two are the club's own decision and one is not the
    club's decision at all — this installation being a copy. All three complete
    the operation SUCCEEDED, and the first two are listed in the booking's
    withheld-emails banner. The third writes no row anywhere, which is why it is
    listed here rather than assumed to be visible somewhere else.
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
        evidenceOf("INV-0041"),
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
        evidenceOf("INV-0041"),
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
          invoiceEmailFailureCause: "PROVIDER",
        }),
      }),
      evidenceOf("INV-0042"),
    );

    expect(fault?.kind).toBe("MEMBER_NOT_SENT_INVOICE");
  });
});

describe("the invoice never reached Xero", () => {
  it("names it as not raised, carries the redacted reason, and offers the retry", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "FAILED",
          lastErrorMessage: "Xero rejected the invoice: account code missing",
        }),
        noEvidence(),
      ),
    ).toMatchObject({
      kind: "INVOICE_NOT_RAISED",
      invoiceReachedXero: false,
      invoiceNumber: null,
      reason: "Xero rejected the invoice: account code missing",
      action: { type: "RETRY" },
    });
  });
});

describe("a failure AFTER Xero accepted the invoice (#3001 review blocker)", () => {
  /*
    THE CASE THE PROJECTION EXISTS FOR, and the one it used to get backwards.

    `createXeroInvoiceForBooking` does real work after Xero returns the invoice:
    it stamps the id onto the payment, stamps it onto the primary payment
    transaction, and settles the applied-credit allocation — which makes another
    provider round trip. A throw in any of those fails the operation, and
    `failXeroSyncOperation` writes NO `xeroObjectId`. So the row looks exactly
    like a first-attempt rejection, and calling it "no invoice was raised" beside
    a Retry walks an officer into a duplicate invoice in the club's accounts.

    The evidence is what the workflow persisted before it could fail.
  */
  it("is called partly completed, not 'not raised', on the payment's stored invoice id", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "FAILED",
          // As the failure writer really leaves it.
          xeroObjectId: null,
          xeroObjectNumber: null,
          lastErrorMessage: "Could not settle the applied credit allocation",
        }),
        evidenceOf("INV-0099"),
      ),
    ).toMatchObject({
      kind: "PARTLY_COMPLETED",
      invoiceReachedXero: true,
      invoiceNumber: "INV-0099",
      reason: "Could not settle the applied credit allocation",
    });
  });

  it("never offers a Retry for it, whatever the recovery engine would run", () => {
    // The engine supports a retry for this row. Offering it would contradict the
    // standing guidance printed in the same paragraph — do not repeat the
    // action — so the affordance is decided here and not there.
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "FAILED",
        lastErrorMessage: "Link write failed",
      }),
      evidenceOf(null),
    );

    expect(fault?.kind).toBe("PARTLY_COMPLETED");
    expect(fault?.action).toEqual({ type: "RESOLVE", engineReason: null });
  });
});

describe("nobody can tell whether Xero has it", () => {
  it("reports a stuck RUNNING operation rather than all-clear", () => {
    // The issue's own opening scenario: a worker dies mid-invoice and the row
    // stays RUNNING for ever. Until #3001 the booking said nothing at all.
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "RUNNING",
          startedAt: new Date(NOW.getTime() - 60 * 60_000),
        }),
        noEvidence(),
      ),
    ).toMatchObject({
      kind: "INVOICE_STATE_UNKNOWN",
      invoiceReachedXero: false,
      action: { type: "RESOLVE" },
    });
  });

  it("reports the operator's stale-running reset as unknown, not as 'not raised'", () => {
    // The reset stamps a fixed code and a fixed message on a row nobody saw
    // through. It says nothing about whether Xero was reached, so neither does
    // this.
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "FAILED",
          lastErrorCode: "ORPHANED_STALE_RUNNING",
          lastErrorMessage:
            "Operation was stuck RUNNING past the staleness threshold and was reset to FAILED by an operator.",
        }),
        noEvidence(),
      ),
    ).toMatchObject({
      kind: "INVOICE_STATE_UNKNOWN",
      action: { type: "RESOLVE" },
    });
  });

  it("is NOT unknown once the club's own records show the invoice", () => {
    expect(
      classifyBookingInvoiceSyncFault(
        operation({
          status: "RUNNING",
          startedAt: new Date(NOW.getTime() - 60 * 60_000),
        }),
        evidenceOf("INV-0100"),
      ),
    ).toMatchObject({
      kind: "PARTLY_COMPLETED",
      invoiceNumber: "INV-0100",
    });
  });
});

describe("the invoice reached Xero but something after it did not", () => {
  it("names a failed payment write, and offers the retry the engine supports", () => {
    // The ONE place "do not raise a second invoice" and a retry legitimately
    // coexist: the retry records the missing payment and raises nothing.
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_2",
        xeroObjectNumber: "INV-0043",
        responsePayload: completionPayload({
          paymentError: { message: "payment write rejected" },
        }),
      }),
      evidenceOf("INV-0043"),
    );

    expect(fault).toMatchObject({
      kind: "PAYMENT_NOT_RECORDED",
      invoiceReachedXero: true,
      action: { type: "RETRY" },
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
          invoiceEmailFailureCause: "PROVIDER",
        }),
      }),
      evidenceOf(null),
    );

    expect(fault?.kind).toBe("MEMBER_NOT_SENT_INVOICE");
    expect(fault?.action).toMatchObject({ type: "RESOLVE" });
    expect(
      fault?.action.type === "RESOLVE" ? fault.action.engineReason : null,
    ).toContain("send the invoice from Xero instead");
  });

  it.each([
    ["PROVIDER"],
    ["NO_EMAILS_UNREADABLE"],
    ["ROLE_UNCONFIRMED"],
  ])("carries the email fault's own cause (%s) rather than flattening it", (cause) => {
    // Three unrelated events share this kind, and the remedy for one of them —
    // an unreadable "No emails" switch — is the opposite of the other two.
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_7",
        responsePayload: completionPayload({
          invoiceEmailError: { message: "stopped" },
          invoiceEmailFailureCause: cause,
        }),
      }),
      evidenceOf(null),
    );

    expect(fault).toMatchObject({
      kind: "MEMBER_NOT_SENT_INVOICE",
      emailFailureCause: cause,
    });
  });

  it("reports an unnamed cause as unknown rather than guessing one", () => {
    // Every row written before #3001 is this shape.
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_8",
        responsePayload: completionPayload({
          invoiceEmailError: { message: "stopped" },
        }),
      }),
      evidenceOf(null),
    );

    expect(fault).toMatchObject({
      kind: "MEMBER_NOT_SENT_INVOICE",
      emailFailureCause: null,
    });
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
        evidenceOf(null),
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
        evidenceOf(null),
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
        evidenceOf(null),
      )?.kind,
    ).toBe("PARTLY_COMPLETED");
  });
});

describe("what the stored payload is allowed to put in front of a person", () => {
  it("reads no VALUE out of the completion payload, only its booleans", () => {
    /*
      `INV-INT-005`. `paymentError` and `invoiceEmailError` have been through
      `sanitizeForJson` — a serialisation guard, NOT the operator-text redactor.
      The only redacted field on the row is `lastErrorMessage`. This drives the
      real payload through the real classifier, so a change that started reading
      an error value out of it fails HERE rather than in production.
    */
    const fault = classifyBookingInvoiceSyncFault(
      operation({
        status: "PARTIAL",
        xeroObjectId: "inv_9",
        xeroObjectNumber: "INV-0044",
        responsePayload: completionPayload({
          paymentError: {
            message: "Bearer sk_live_secret rejected for member@example.org",
            response: { headers: { authorization: "Bearer sk_live_secret" } },
          },
          invoiceEmailError: { message: "client_secret=hunter2" },
        }),
      }),
      evidenceOf("INV-0044"),
    );

    const rendered = JSON.stringify(fault);
    for (const secret of [
      "Bearer",
      "sk_live_secret",
      "client_secret",
      "hunter2",
      "member@example.org",
    ]) {
      expect(rendered).not.toContain(secret);
    }
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
    // whose payment row has not been created yet would otherwise match nothing
    // and the page would report all-clear over a failed invoice.
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

  it("corroborates the found row against the payment the row itself names", async () => {
    // The payment id comes off the operation's own `localId`. Nothing joins back
    // through the booking, so finding the row and corroborating it stay separate
    // questions.
    const readBookingInvoiceEvidenceForPayment = vi
      .fn()
      .mockResolvedValue({ exists: true, invoiceNumber: "INV-0101" });

    const fault = await getBookingInvoiceSyncFault("bkg_79", {
      deps: {
        db: {
          xeroSyncOperation: {
            findFirst: vi.fn().mockResolvedValue(
              operation({
                status: "FAILED",
                localId: "pay_42",
                lastErrorMessage: "boom",
              }),
            ),
          },
        },
        readBookingInvoiceEvidenceForPayment,
      },
    });

    expect(readBookingInvoiceEvidenceForPayment).toHaveBeenCalledWith("pay_42");
    expect(fault).toMatchObject({
      kind: "PARTLY_COMPLETED",
      invoiceReachedXero: true,
      invoiceNumber: "INV-0101",
      reason: "boom",
    });
  });

  it("classifies the row the query returned", async () => {
    await expect(
      getBookingInvoiceSyncFault("bkg_80", {
        deps: {
          db: {
            xeroSyncOperation: {
              findFirst: vi.fn().mockResolvedValue(
                operation({ status: "FAILED", lastErrorMessage: "boom" }),
              ),
            },
          },
          readBookingInvoiceEvidenceForPayment: vi
            .fn()
            .mockResolvedValue({ exists: false, invoiceNumber: null }),
        },
      }),
    ).resolves.toMatchObject({ kind: "INVOICE_NOT_RAISED", reason: "boom" });
  });
});
