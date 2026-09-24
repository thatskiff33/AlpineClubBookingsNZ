import { describe, expect, it } from "vitest";
import {
  summarizeXeroOperation,
  type XeroOperationSummary,
} from "@/lib/xero-operation-summaries";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function factValue(summary: XeroOperationSummary, label: string): string | undefined {
  return summary.facts.find((fact) => fact.label === label)?.value;
}

describe("summarizeXeroOperation — queued outbox payloads", () => {
  it("summarizes a queued booking invoice", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking-abcdefghijklmno" },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: create booking invoice");
    // shortId truncates ids longer than 12 chars.
    expect(factValue(summary!, "Booking")).toBe("booking-abcd...");
  });

  it("summarizes a queued entrance-fee invoice with cents money", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        queueType: "ENTRANCE_FEE_INVOICE",
        category: "ADULT",
        itemCode: "ENTRANCE",
        feeAmountCents: 5000,
        description: "Joining fee",
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: create entrance-fee invoice");
    expect(factValue(summary!, "Category")).toBe("ADULT");
    expect(factValue(summary!, "Fee")).toBe("$50.00");
    expect(factValue(summary!, "Item code")).toBe("ENTRANCE");
    expect(factValue(summary!, "Description")).toBe("Joining fee");
  });

  it("summarizes a queued supplementary invoice and computes the net", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking-1",
        priceDiffCents: 4000,
        changeFeeCents: 1000,
        waitForConfirmedAdditionalPayment: true,
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(factValue(summary!, "Price difference")).toBe("$40.00");
    expect(factValue(summary!, "Change fee")).toBe("$10.00");
    expect(factValue(summary!, "Net to bill")).toBe("$50.00");
    expect(factValue(summary!, "Status")).toBe(
      "Waiting for confirmed additional payment"
    );
  });

  it("summarizes a queued group-settlement invoice void", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "UPDATE",
      requestPayload: {
        queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
        settlementId: "settlement-abcdefghijklmno",
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: void cancelled group-settlement invoice");
    expect(factValue(summary!, "Settlement")).toBe("settlement-a...");
  });

  it("summarizes a queued refund credit note with a watermark", () => {
    const summary = summarizeXeroOperation({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      requestPayload: {
        queueType: "REFUND_CREDIT_NOTE",
        refundAmountCents: 2500,
        watermarkCents: 7500,
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: create refund credit note");
    expect(factValue(summary!, "Refund amount")).toBe("$25.00");
    expect(factValue(summary!, "Covers refunds up to")).toBe("$75.00");
  });

  it("summarizes a queued credit-note allocation", () => {
    const summary = summarizeXeroOperation({
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      requestPayload: {
        queueType: "CREDIT_NOTE_ALLOCATION",
        creditNoteId: "cn-1",
        invoiceId: "inv-1",
        amountCents: 12345,
        role: "REPAIR",
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: allocate credit note to invoice");
    expect(factValue(summary!, "Amount")).toBe("$123.45");
    expect(factValue(summary!, "Role")).toBe("REPAIR");
  });

  it("summarizes a checkpointed applied-credit deallocation", () => {
    const summary = summarizeXeroOperation({
      entityType: "ALLOCATION",
      operationType: "UPDATE",
      requestPayload: {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-abcdefghijklmno",
        checkpoint: {
          creditNoteId: "credit-note-abcdefghijklmno",
          currentCents: 4000,
          targetCents: 2500,
          phase: "PROVIDER_VERIFIED",
        },
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: reduce applied credit on Xero invoice");
    expect(factValue(summary!, "Current allocation")).toBe("$40.00");
    expect(factValue(summary!, "Target allocation")).toBe("$25.00");
    expect(factValue(summary!, "Recovery phase")).toBe("PROVIDER_VERIFIED");
  });

  it("summarizes a queued membership-cancellation contact", () => {
    const summary = summarizeXeroOperation({
      entityType: "CONTACT",
      operationType: "UPDATE",
      requestPayload: {
        queueType: "MEMBERSHIP_CANCELLATION_CONTACT",
        memberId: "member-1",
        requestId: "req-1",
        participantId: "participant-1",
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Queued: archive membership-cancellation contact");
    expect(factValue(summary!, "Member")).toBe("member-1");
  });
});

describe("summarizeXeroOperation — persisted Xero API shapes", () => {
  it("summarizes a created invoice from request + response (dollars → cents)", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        invoices: [
          {
            type: "ACCREC",
            contact: { contactID: "contact-abcdefghijklmnop" },
            reference: "Booking abcdef12",
            status: "AUTHORISED",
            lineItems: [
              { description: "Adult - 2 nights", quantity: 2, unitAmount: 25 },
              { description: "Child - 2 nights", quantity: 2, unitAmount: 10 },
            ],
          },
        ],
      },
      responsePayload: {
        invoice: {
          invoices: [
            {
              invoiceID: "xero-inv-1",
              invoiceNumber: "INV-0042",
              total: 70,
              amountDue: 0,
              status: "PAID",
            },
          ],
        },
      },
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Create invoice in Xero");
    expect(factValue(summary!, "Reference")).toBe("Booking abcdef12");
    expect(factValue(summary!, "Invoice number")).toBe("INV-0042");
    expect(factValue(summary!, "Contact")).toBe("contact-abcd...");
    expect(factValue(summary!, "Line items")).toBe("2");
    expect(factValue(summary!, "Lines")).toBe("Adult - 2 nights; Child - 2 nights");
    expect(factValue(summary!, "Total")).toBe("$70.00");
    expect(factValue(summary!, "Amount due")).toBe("$0.00");
    expect(factValue(summary!, "Status")).toBe("PAID");
  });

  it("titles an updated invoice differently", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "UPDATE",
      requestPayload: { invoices: [{ reference: "Booking abcdef12", lineItems: [] }], bookingId: "b1", invoiceId: "i1" },
      responsePayload: { invoice: { invoices: [{ invoiceNumber: "INV-0042", total: 90 }] } },
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Update invoice in Xero");
    expect(factValue(summary!, "Total")).toBe("$90.00");
  });

  it("summarizes a created credit note with its allocation", () => {
    const summary = summarizeXeroOperation({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      requestPayload: {
        creditNotes: [{ reference: "Refund booking", lineItems: [{ description: "Refund" }] }],
        allocation: { invoiceId: "inv-99", amount: 30 },
      },
      responsePayload: {
        creditNote: {
          creditNotes: [
            { creditNoteID: "cn-1", creditNoteNumber: "CN-0007", total: 30, status: "PAID" },
          ],
        },
      },
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Create credit note in Xero");
    expect(factValue(summary!, "Credit note number")).toBe("CN-0007");
    expect(factValue(summary!, "Total")).toBe("$30.00");
    expect(factValue(summary!, "Allocated")).toBe("$30.00");
    expect(factValue(summary!, "Allocated to invoice")).toBe("inv-99");
  });

  it("recognizes a reused existing credit note", () => {
    const summary = summarizeXeroOperation({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      requestPayload: { creditNotes: [{ reference: "x" }] },
      responsePayload: { existingCreditNoteId: "cn-exist-1" },
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Reused existing credit note");
    expect(factValue(summary!, "Credit note")).toBe("cn-exist-1");
  });

  it("summarizes a persisted allocation (no queueType)", () => {
    const summary = summarizeXeroOperation({
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      requestPayload: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 5000 },
      responsePayload: { allocations: [{ amount: 50 }] },
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Allocate credit note to invoice");
    expect(factValue(summary!, "Amount")).toBe("$50.00");
    expect(factValue(summary!, "Credit note")).toBe("cn-1");
  });

  it("summarizes a managed contact-group sync", () => {
    const summary = summarizeXeroOperation({
      entityType: "CONTACT_GROUP",
      operationType: "SYNC_MANAGED_MEMBERSHIP",
      requestPayload: {
        memberId: "m1",
        // No `memberName`: the writer stopped storing a composed person name
        // in the payload (INV-PRIV-011, #2683), and the panel labels the row
        // with the member id it already stores.
        ageTier: "ADULT",
        xeroContactId: "xc1",
        defaultGroup: { id: "g1", name: "Adult Members" },
        acceptedGroups: [{ id: "g1", name: "Adult Members" }],
        currentManagedGroups: [{ id: "g0", name: "Youth Members" }],
      },
      responsePayload: {
        addedGroupIds: ["g1"],
        removedGroupIds: ["g0"],
        resultingGroups: [{ id: "g1", name: "Adult Members" }],
      },
    }, CLUB_FORMAT_TEST);
    expect(summary?.title).toBe("Sync managed Xero contact groups");
    expect(factValue(summary!, "Member")).toBe("m1");
    expect(factValue(summary!, "Age tier")).toBe("ADULT");
    expect(factValue(summary!, "Default group")).toBe("Adult Members");
    expect(factValue(summary!, "Groups added")).toBe("1");
    expect(factValue(summary!, "Groups removed")).toBe("1");
    expect(factValue(summary!, "Resulting groups")).toBe("Adult Members");
  });
});

describe("summarizeXeroOperation — redaction and fallback", () => {
  it("returns null for unmapped shapes so the panel shows raw JSON", () => {
    expect(
      summarizeXeroOperation({
        entityType: "PAYMENT",
        operationType: "CREATE",
        requestPayload: { some: "thing" },
        responsePayload: null,
      }, CLUB_FORMAT_TEST)
    ).toBeNull();

    expect(
      summarizeXeroOperation({
        entityType: "INVOICE",
        operationType: "CREATE",
        requestPayload: { unexpected: true },
        responsePayload: null,
      }, CLUB_FORMAT_TEST)
    ).toBeNull();
  });

  it("builds facts from redacted data — never echoes a value redaction would mask", () => {
    const summary = summarizeXeroOperation({
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        invoices: [
          {
            reference: "Booking abcdef12",
            contact: { contactID: "c1", emailAddress: "secret@example.com" },
            lineItems: [{ description: "contact guest@example.com about this" }],
          },
        ],
      },
      responsePayload: null,
    }, CLUB_FORMAT_TEST);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("guest@example.com");
    // The redacted line description surfaces as the redaction sentinel.
    expect(factValue(summary!, "Lines")).toBe("[REDACTED]");
  });
});
