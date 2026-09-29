import { describe, expect, it } from "vitest";
import {
  buildMembershipCancellationApprovalBlockedMessage,
  describeMembershipCancellationBlocker,
  describeUnpaidInvoiceBlockerParts,
  formatBlockerAmount,
  membershipCancellationBlockerHeading,
  membershipCancellationBlockerHint,
  type MembershipCancellationBlocker,
  type MembershipCancellationInvoiceCheckUnavailableReason,
  type MembershipCancellationUnpaidInvoiceBlocker,
} from "@/lib/membership-cancellation-blocker-messages";

function unpaidInvoice(
  overrides: Partial<MembershipCancellationUnpaidInvoiceBlocker> = {},
): MembershipCancellationUnpaidInvoiceBlocker {
  return {
    type: "unpaid_invoice",
    invoiceId: "inv-1",
    invoiceNumber: "INV-0042",
    invoiceStatus: "AUTHORISED",
    direction: "receivable",
    amountDueCents: 12050,
    currency: "NZD",
    dueDate: "2026-06-30",
    xeroUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1",
    xeroContactUrl: "https://go.xero.com/Contacts/View/contact-1",
    ...overrides,
  };
}

const ownedBooking: MembershipCancellationBlocker = {
  type: "owned_booking",
  bookingId: "booking-1",
  bookingStatus: "PAID",
  checkIn: "2099-01-01T00:00:00.000Z",
  checkOut: "2099-01-03T00:00:00.000Z",
};

describe("membership cancellation blocker wording", () => {
  it("names the invoice, its balance, its status and its due date", () => {
    // The figures are pinned exactly; the prose around them is asserted by
    // substring so a wording tweak does not fail an arithmetic test.
    const line = describeMembershipCancellationBlocker(unpaidInvoice());
    expect(line).toContain("Invoice INV-0042");
    expect(line).toContain("NZD 120.50 still owing");
    expect(line).toContain("AUTHORISED");
    expect(line).toContain("due 2026-06-30");
  });

  it("calls a payable a bill", () => {
    expect(
      describeMembershipCancellationBlocker(
        unpaidInvoice({ direction: "payable", invoiceNumber: "BILL-9" }),
      ),
    ).toContain("Bill BILL-9");
  });

  it("falls back to the Xero id when an invoice has no number", () => {
    expect(
      describeMembershipCancellationBlocker(
        unpaidInvoice({ invoiceNumber: null }),
      ),
    ).toContain("(no number, Xero id inv-1)");
  });

  // #2392 review (H1): the queue links the label, so the sentence has to come
  // apart at exactly that point — and rejoin into the server's own wording.
  describe("the linkable split", () => {
    it("rejoins into the same sentence the server sends", () => {
      const blocker = unpaidInvoice();
      const { label, detail } = describeUnpaidInvoiceBlockerParts(blocker);

      expect(`${label} — ${detail}`).toBe(
        describeMembershipCancellationBlocker(blocker),
      );
    });

    it("links an invoice straight to itself in Xero", () => {
      expect(describeUnpaidInvoiceBlockerParts(unpaidInvoice()).href).toContain(
        "InvoiceID=inv-1",
      );
    });

    it("falls back to the contact page for a bill, which has no invoice link", () => {
      expect(
        describeUnpaidInvoiceBlockerParts(
          unpaidInvoice({ direction: "payable", xeroUrl: null }),
        ).href,
      ).toBe("https://go.xero.com/Contacts/View/contact-1");
    });

    it("honours the caller's date format in the detail half", () => {
      expect(
        describeUnpaidInvoiceBlockerParts(unpaidInvoice(), {
          formatDate: (value) => `[${value}]`,
        }).detail,
      ).toContain("due [2026-06-30]");
    });
  });

  it("leaves an unknown currency off rather than guessing one", () => {
    expect(
      describeMembershipCancellationBlocker(
        unpaidInvoice({ currency: "UNKNOWN" }),
      ),
    ).toContain("120.50 still owing");
  });

  // #3722: the stored figure is hundredths of the major unit for every
  // currency, so a currency without two decimal places must not be padded to
  // two — that would claim a precision the invoice does not have.
  describe("an invoice currency without two decimal places", () => {
    it("prints a zero-decimal amount as a whole number", () => {
      expect(formatBlockerAmount(120000, "JPY")).toBe("JPY 1200");
      expect(
        describeMembershipCancellationBlocker(
          unpaidInvoice({ amountDueCents: 120000, currency: "JPY" }),
        ),
      ).toContain("JPY 1200 still owing");
    });

    it("keeps the hundredths it was given, unpadded", () => {
      expect(formatBlockerAmount(123, "KWD")).toBe("KWD 1.23");
      expect(formatBlockerAmount(120, "KWD")).toBe("KWD 1.2");
    });

    it("reads the code the way the minor-unit rule does", () => {
      expect(formatBlockerAmount(120000, "jpy")).toBe("jpy 1200");
    });

    it("leaves a two-decimal currency, and an unknown one, at two places", () => {
      expect(formatBlockerAmount(120000, "NZD")).toBe("NZD 1200.00");
      expect(formatBlockerAmount(120000, "UNKNOWN")).toBe("1200.00");
      expect(formatBlockerAmount(120000, "")).toBe("1200.00");
    });

    it("carries the same figure into the approval refusal", () => {
      expect(
        buildMembershipCancellationApprovalBlockedMessage([
          unpaidInvoice({ amountDueCents: 120000, currency: "JPY" }),
        ]),
      ).toContain("INV-0042 (JPY 1200)");
    });
  });

  it("keeps the existing booking wording, and honours a caller's date format", () => {
    expect(
      describeMembershipCancellationBlocker(ownedBooking, {
        formatDate: (value) => `[${value.slice(0, 10)}]`,
      }),
    ).toBe("Owned booking booking-1 (PAID) from [2099-01-01] to [2099-01-03]");
  });

  describe("the approval refusal", () => {
    it("names the invoices and says how to clear them", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        unpaidInvoice(),
        unpaidInvoice({ invoiceId: "inv-2", invoiceNumber: "INV-0051", amountDueCents: 8000 }),
      ]);

      expect(message).toContain("INV-0042 (NZD 120.50)");
      expect(message).toContain("INV-0051 (NZD 80.00)");
      expect(message).toContain("paid, credited with an allocated credit note, or voided in Xero");
      expect(message).toContain(
        '"Archive Xero contacts after cancellation approval"',
      );
    });

    it("caps the named invoices and says how many more there are", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage(
        Array.from({ length: 8 }, (_, index) =>
          unpaidInvoice({
            invoiceId: `inv-${index}`,
            invoiceNumber: `INV-${index}`,
          }),
        ),
      );

      expect(message).toContain("INV-4");
      expect(message).not.toContain("INV-5");
      expect(message).toContain("and 3 more");
    });

    it("keeps the booking sentence unchanged, and combines it with the invoice one", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        ownedBooking,
        unpaidInvoice(),
      ]);

      expect(message).toContain(
        "Approval is blocked while this member has future bookings or guest appearances.",
      );
      expect(message).toContain("INV-0042");
    });

    it("points the approver at the panel, where the whole list is linked", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        unpaidInvoice(),
      ]);

      expect(message).toContain("listed beside this participant");
    });

    // #2392 review (H2): the owner's worry was a cancellation held hostage.
    // "Try again later" on its own IS being held hostage — Xero's daily limit
    // resets at midnight UTC — so every failure names the way out.
    it("offers the escape hatch on every failure, not just a disconnected Xero", () => {
      const reasons: MembershipCancellationInvoiceCheckUnavailableReason[] = [
        "disconnected",
        "rate_limited",
        "unavailable",
        "invalid_request",
        "too_many_invoices",
      ];

      for (const reason of reasons) {
        const message = buildMembershipCancellationApprovalBlockedMessage([
          { type: "invoice_check_unavailable", reason },
        ]);
        expect(message, reason).toContain(
          '"Archive Xero contacts after cancellation approval"',
        );
        expect(message, reason).toContain("Membership Cancellation settings");
      }
    });

    it("says so when waiting will not help", () => {
      const invalid = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "invalid_request" },
      ]);
      expect(invalid).toContain("Waiting will not fix this one");
      expect(invalid).toContain("merged or deleted in Xero");
      expect(invalid).not.toContain("Try again in a few minutes");

      const tooMany = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "too_many_invoices" },
      ]);
      expect(tooMany).toContain("Waiting will not fix this one");
      expect(tooMany).toContain("settle or void them in Xero");
    });

    it("explains a disconnected Xero and offers two ways out", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ]);

      expect(message).toContain("Xero is not connected");
      expect(message).toContain("Reconnect Xero");
      expect(message).toContain(
        '"Archive Xero contacts after cancellation approval"',
      );
    });

    it("tells the approver to wait when Xero is only temporarily unreachable", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "unavailable" },
      ]);

      expect(message).toContain("could not be reached");
      expect(message).toContain("Try again in a few minutes");
      expect(message).not.toContain("Reconnect Xero");
    });

    it("names the API limit when that is what stopped the check, and how long that is", () => {
      const message = buildMembershipCancellationApprovalBlockedMessage([
        { type: "invoice_check_unavailable", reason: "rate_limited" },
      ]);

      expect(message).toContain("API limit");
      expect(message).toContain("once the limit resets");
      // Not a vague "later": the reviewer is told it can be most of a day, so
      // they can judge whether to use the escape hatch instead.
      expect(message).toContain("midnight UTC");
    });
  });

  describe("the review queue panel", () => {
    it("heads a booking-only panel the way it always did", () => {
      expect(membershipCancellationBlockerHeading([ownedBooking])).toBe(
        "Resolve these bookings before approval.",
      );
      expect(membershipCancellationBlockerHint([ownedBooking])).toBeNull();
    });

    it("heads an invoice panel with the money framing and offers a route out", () => {
      expect(membershipCancellationBlockerHeading([unpaidInvoice()])).toBe(
        "Settle these in Xero before approval.",
      );
      expect(membershipCancellationBlockerHint([unpaidInvoice()])).toContain(
        "void or credit it",
      );
    });

    it("heads a mixed panel neutrally", () => {
      expect(
        membershipCancellationBlockerHeading([ownedBooking, unpaidInvoice()]),
      ).toBe("Resolve these before approval.");
    });

    // #2392 review (L9): the old heading read "Resolve these bookings before
    // approval." over a bullet saying Xero was not connected — which is not a
    // booking and not the reviewer's to resolve.
    it("does not head a bookings-plus-failed-check panel as bookings only", () => {
      const blockers: MembershipCancellationBlocker[] = [
        ownedBooking,
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ];

      expect(membershipCancellationBlockerHeading(blockers)).toBe(
        "Resolve these before approval.",
      );
    });

    it("explains the check itself when that is all that is wrong", () => {
      const blockers: MembershipCancellationBlocker[] = [
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ];
      expect(membershipCancellationBlockerHeading(blockers)).toBe(
        "Approval cannot be checked yet.",
      );
      expect(membershipCancellationBlockerHint(blockers)).toContain(
        "the check has to run first",
      );
    });
  });
});
