// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MembershipCancellationBlockerNotice } from "@/components/admin/membership-cancellation-blocker-notice";
import {
  describeMembershipCancellationBlocker,
  type MembershipCancellationBlocker,
  type MembershipCancellationUnpaidInvoiceBlocker,
} from "@/lib/membership-cancellation-blocker-messages";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
} from "@/lib/club-time";

/**
 * The panel a reviewer actually reads before pressing Approve (#2392). Until
 * this suite existed the wording was tested, the loader was tested, and the
 * thing on screen was tested by nobody — which is how a deep link got computed,
 * serialized to the browser and never rendered (#2392 review, H1/L12).
 */

const RETURN_TO = "/admin/membership-cancellations";

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

function ownedBookings(count: number): MembershipCancellationBlocker[] {
  return Array.from({ length: count }, (_, index) => ({
    ...ownedBooking,
    bookingId: `booking-${index}`,
  }));
}

function unpaidInvoices(
  count: number,
  prefix = "inv",
): MembershipCancellationBlocker[] {
  return Array.from({ length: count }, (_, index) =>
    unpaidInvoice({
      invoiceId: `${prefix}-${index}`,
      invoiceNumber: `INV-${prefix}-${index}`,
    }),
  );
}

describe("the cancellation review queue's blocker panel", () => {
  it("shows nothing at all when nothing is blocking", () => {
    const { container } = render(
      <MembershipCancellationBlockerNotice blockers={[]} returnTo={RETURN_TO} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("links an invoice straight to itself in Xero", () => {
    render(
      <MembershipCancellationBlockerNotice
        blockers={[unpaidInvoice()]}
        returnTo={RETURN_TO}
      />,
    );

    const link = screen.getByRole("link", { name: "Invoice INV-0042" });
    expect(link.getAttribute("href")).toBe(
      "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-1",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    // The balance, status and due date stay next to it, unlinked.
    expect(screen.getByRole("listitem").textContent).toContain(
      "NZD 120.50 still owing (AUTHORISED",
    );
  });

  it("links an unnumbered bill to the contact page, which is the only way to find it", () => {
    render(
      <MembershipCancellationBlockerNotice
        blockers={[
          unpaidInvoice({
            invoiceId: "bill-guid-9",
            invoiceNumber: null,
            direction: "payable",
            xeroUrl: null,
          }),
        ]}
        returnTo={RETURN_TO}
      />,
    );

    const link = screen.getByRole("link", {
      name: "Bill (no number, Xero id bill-guid-9)",
    });
    expect(link.getAttribute("href")).toBe(
      "https://go.xero.com/Contacts/View/contact-1",
    );
  });

  /**
   * The panel renders the invoice line in two pieces — a linked label and a
   * plain-text detail — while the server writes it as one sentence. The two must
   * read identically, separator included: the whole point of the shared module
   * is that the reviewer sees on screen exactly what the 409 would say. The
   * wording test next door only ever compared the server to itself (#2392
   * review, residual 2).
   */
  describe("says exactly what the server would say", () => {
    it("matches the server's sentence for an invoice with no due date", () => {
      const blocker = unpaidInvoice({ dueDate: null });
      render(
        <MembershipCancellationBlockerNotice
          blockers={[blocker]}
          returnTo={RETURN_TO}
        />,
      );

      expect(screen.getByRole("listitem").textContent).toBe(
        describeMembershipCancellationBlocker(blocker),
      );
    });

    it("matches it for a dated invoice too, in the club's date format", () => {
      const blocker = unpaidInvoice();
      render(
        <MembershipCancellationBlockerNotice
          blockers={[blocker]}
          returnTo={RETURN_TO}
        />,
      );

      /*
        Only the date formatting is the panel's own; every other character,
        including the separator between label and detail, comes from the server.

        THE ORACLE IS ZONE-FREE, and it used to be a projection. This built its
        expectation with `formatNZDate(new Date(value))` from the retired
        `nzst-date` adapter, which read the UTC-midnight encoding back through
        `APP_TIME_ZONE`: the identity for a club east of Greenwich and the
        PREVIOUS day for any club west of it. An invoice due date is a CALENDAR
        DAY, so it takes no zone at all — which is what the panel itself does
        (`formatDateOnly` in `membership-cancellation-blocker-notice.tsx`).
      */
      expect(screen.getByRole("listitem").textContent).toBe(
        describeMembershipCancellationBlocker(blocker, {
          formatDate: (value) => formatClubDate(calendarDateOfSerialisedDbDate(value)),
        }),
      );
    });

    it("matches it for a bill, where the label is the Xero id", () => {
      const blocker = unpaidInvoice({
        invoiceId: "bill-guid-9",
        invoiceNumber: null,
        direction: "payable",
        xeroUrl: null,
        dueDate: null,
      });
      render(
        <MembershipCancellationBlockerNotice
          blockers={[blocker]}
          returnTo={RETURN_TO}
        />,
      );

      expect(screen.getByRole("listitem").textContent).toBe(
        describeMembershipCancellationBlocker(blocker),
      );
    });
  });

  it("stops listing after twenty rows and points at the contact for the rest", () => {
    render(
      <MembershipCancellationBlockerNotice
        blockers={Array.from({ length: 200 }, (_, index) =>
          unpaidInvoice({
            invoiceId: `inv-${index}`,
            invoiceNumber: `INV-${index}`,
          }),
        )}
        returnTo={RETURN_TO}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText(/and 180 more on this contact/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the contact in Xero" })
        .getAttribute("href"),
    ).toBe("https://go.xero.com/Contacts/View/contact-1");
  });

  /**
   * "…on this contact" is a statement about Xero. Said over hidden BOOKINGS it is
   * simply false, and the same twenty-row cap applies to a member with a long
   * run of future stays (#2392 review, residual 1).
   */
  describe("the overflow line follows what is actually overflowing", () => {
    it("names bookings when bookings are what is hidden", () => {
      render(
        <MembershipCancellationBlockerNotice
          blockers={ownedBookings(25)}
          returnTo={RETURN_TO}
        />,
      );

      expect(
        screen.getByText(/and 5 more future bookings or guest appearances/),
      ).toBeTruthy();
      expect(screen.queryByText(/on this contact/)).toBeNull();
      // Nothing hidden is in Xero, so there is nothing to open there.
      expect(
        screen.queryByRole("link", { name: "Open the contact in Xero" }),
      ).toBeNull();
    });

    it("stays neutral when the hidden rows are a mix", () => {
      render(
        <MembershipCancellationBlockerNotice
          blockers={[
            ...unpaidInvoices(10),
            ...ownedBookings(15),
            ...unpaidInvoices(5, "later"),
          ]}
          returnTo={RETURN_TO}
        />,
      );

      expect(screen.getByText(/and 10 more not shown here/)).toBeTruthy();
      // Some of the hidden rows ARE invoices, so the contact link still helps.
      expect(
        screen.getByRole("link", { name: "Open the contact in Xero" }),
      ).toBeTruthy();
    });

    it("does not offer the contact link when only bookings are hidden", () => {
      render(
        <MembershipCancellationBlockerNotice
          blockers={[...unpaidInvoices(5), ...ownedBookings(20)]}
          returnTo={RETURN_TO}
        />,
      );

      expect(
        screen.getByText(/and 5 more future bookings or guest appearances/),
      ).toBeTruthy();
      expect(
        screen.queryByRole("link", { name: "Open the contact in Xero" }),
      ).toBeNull();
    });
  });

  it("gives the escape hatch a link, not just a name", () => {
    render(
      <MembershipCancellationBlockerNotice
        blockers={[unpaidInvoice()]}
        returnTo={RETURN_TO}
      />,
    );

    // The settings page is the SINGULAR path — one character from the queue's
    // own URL, which is exactly why naming it in prose was not enough.
    const link = screen.getByRole("link", {
      name: "Open Membership Cancellation settings",
    });
    expect(link.getAttribute("href")).toContain("/admin/membership-cancellation");
    expect(link.getAttribute("href")).not.toContain(
      "/admin/membership-cancellations?",
    );
  });

  it("renders a failed check as its own explanation, with the way out", () => {
    render(
      <MembershipCancellationBlockerNotice
        blockers={[{ type: "invoice_check_unavailable", reason: "rate_limited" }]}
        returnTo={RETURN_TO}
      />,
    );

    const item = screen.getByRole("listitem");
    expect(item.textContent).toContain("API limit");
    expect(item.textContent).toContain(
      '"Archive Xero contacts after cancellation approval"',
    );
    expect(
      screen.getByRole("link", { name: "Open Membership Cancellation settings" }),
    ).toBeTruthy();
  });

  it("does not head a bookings-plus-failed-check panel as bookings only", () => {
    const { container } = render(
      <MembershipCancellationBlockerNotice
        blockers={[
          ownedBooking,
          { type: "invoice_check_unavailable", reason: "disconnected" },
        ]}
        returnTo={RETURN_TO}
      />,
    );

    expect(within(container).getByText("Resolve these before approval.")).toBeTruthy();
  });

  it("leaves a bookings-only panel exactly as it was", () => {
    const { container } = render(
      <MembershipCancellationBlockerNotice
        blockers={[ownedBooking]}
        returnTo={RETURN_TO}
      />,
    );

    expect(
      within(container).getByText("Resolve these bookings before approval."),
    ).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toContain(
      "Owned booking booking-1 (PAID)",
    );
    // No Xero blocker, so no Xero advice and no settings link.
    expect(screen.queryByRole("link")).toBeNull();
  });
});
