// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5066: the booking page's invoice control and its invoice account card
 * render the page's offer, and nothing else — Xero's invoice (slice 1) or, with
 * Xero off, the app's generated one (slice 2).
 */
const mocks = vi.hoisted(() => ({ toastError: vi.fn(), save: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/lib/save-response-as-file", () => ({ saveResponseAsFile: mocks.save }));

import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";
import { BookingInvoiceControl } from "@/components/download-invoice-button";
import { BookingInvoiceAccountCard } from "@/components/booking-invoice-account-card";
import type { BookingInvoiceAccount } from "@/lib/booking-invoice-access";

const CREDIT_NOTE = { creditNoteId: "xero-cn-1", creditNoteNumber: "CN-0007", kind: "CHANGE" as const };
const ACCOUNT: BookingInvoiceAccount = {
  summary: { totalCents: 45_000, changeFeeCents: 0, creditAppliedCents: 5_000, paidCents: 40_000, keptCents: 0, balanceCents: 0, balanceWhen: "NOW" },
  invoiceUpdateNotice: null,
};

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("BookingInvoiceControl", () => {
  it("renders nothing when nothing is offered", () => {
    const { container } = render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "NONE" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("tells a member to ask the club, and staff on someone else's booking to check the club's accounts (#1289, N1)", () => {
    const { rerender } = render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: false }} />);
    expect(screen.getByText(/Please ask the club for copies/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: true }} />);
    expect(screen.getByText(/Check the club's accounts for copies/)).toBeInTheDocument();
    expect(screen.queryByText(/ask the club/)).toBeNull();
    expect(screen.queryByText(/Xero/)).toBeNull();
  });

  it("with Xero off, explains Xero documents, an extra charge and a recorded GST-registered period in the reader's voice (#5066 slice 2)", () => {
    const { rerender } = render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: false, reason: "XERO_DOCUMENTS" }} />);
    expect(screen.getByText("This booking's invoice is in the club's accounts. Please ask the club for a copy.")).toBeInTheDocument();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: true, reason: "XERO_DOCUMENTS" }} />);
    expect(screen.getByText(/Check the club's accounts for a copy/)).toBeInTheDocument();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: false, reason: "EXTRA_CHARGE" }} />);
    // Neutral: a withdrawn extra charge lands here too, with nothing outstanding (re-review item 3).
    expect(screen.getByText("Please ask the club for a copy of this booking's invoice.")).toBeInTheDocument();
    expect(screen.queryByText(/payment link|no single invoice/)).toBeNull();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: true, reason: "EXTRA_CHARGE" }} />);
    expect(screen.getByText("An extra charge has been raised on this booking, so no invoice is generated for it here. Check the booking's payments.")).toBeInTheDocument();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: false, reason: "REGISTERED_TAX_PERIOD" }} />);
    expect(screen.getByText("Please ask the club for a copy of this booking's invoice.")).toBeInTheDocument();
    expect(screen.queryByText(/GST|tax/i)).toBeNull();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: true, reason: "REGISTERED_TAX_PERIOD" }} />);
    expect(screen.getByText(/period the club recorded as GST-registered/)).toBeInTheDocument();
    expect(screen.getByText(/Provide one from the club's own records\./)).toBeInTheDocument();
    expect(screen.queryByText(/more than one invoice/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("downloads the booking's invoice through the shared file saver", async () => {
    const response = new Response("%PDF", { status: 200 });
    fetchMock.mockResolvedValue(response);
    render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "XERO_INVOICE", invoiceNumber: "INV-0042", creditNotes: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download invoice INV-0042" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(response, "invoice.pdf"));
    expect(fetchMock).toHaveBeenCalledWith("/api/bookings/bk-1/invoice");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("says a 404 means the page is stale, and shows the route's own message otherwise", async () => {
    render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "XERO_INVOICE", invoiceNumber: null, creditNotes: [] }} />);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Booking not found" }, { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "Download invoice" }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("This invoice is no longer available from this page; please refresh."),
    );
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Xero is busy" }, { status: 502 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download invoice" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download invoice" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenLastCalledWith("Xero is busy"));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("BookingEditor renders the offer it is handed", () => {
  const editorData = (overrides: Partial<BookingEditorData>): BookingEditorData => ({
    id: "bk-1",
    lodgeName: "Lodge",
    checkIn: "2026-08-03",
    checkOut: "2026-08-05",
    nights: 2,
    status: "CONFIRMED",
    guests: [],
    viewerRole: "USER",
    totalPriceCents: 20_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 20_000,
    promo: null,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    editPolicy: { mode: "future", today: "2026-07-01", editableFrom: null, checkInEditable: true },
    ...overrides,
  });

  it("shows the Download invoice button in Stay Details when the payload carries the offer", () => {
    render(<BookingEditor booking={editorData({ invoiceOffer: { kind: "XERO_INVOICE", invoiceNumber: "INV-7", creditNotes: [] } })} canModify={false} />);
    expect(screen.getByRole("button", { name: "Download invoice INV-7" })).toBeInTheDocument();
  });

  it("shows the invoice account card under Payment when the payload carries the account lines", () => {
    render(
      <BookingEditor
        booking={editorData({ invoiceOffer: { kind: "XERO_INVOICE", invoiceNumber: "INV-7", creditNotes: [CREDIT_NOTE] }, invoiceAccount: ACCOUNT })}
        canModify={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Invoice and credits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download credit note CN-0007" })).toBeInTheDocument();
  });

  it("with Xero off, offers the generated invoice's download and its account card, with no credit notes (#5066 slice 2)", async () => {
    const response = new Response("%PDF", { status: 200 });
    fetchMock.mockResolvedValue(response);
    render(
      <BookingEditor
        booking={editorData({ invoiceOffer: { kind: "GENERATED", notYetApproved: true }, invoiceAccount: ACCOUNT })}
        canModify={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Invoice and credits" })).toBeInTheDocument();
    expect(screen.getByLabelText("Booking account summary")).toHaveTextContent("Account credit applied$50.00");
    expect(screen.queryByText("Credit notes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download invoice" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(response, "invoice.pdf"));
    expect(fetchMock).toHaveBeenCalledWith("/api/bookings/bk-1/invoice");
  });

  it("shows no account card beside an ask-the-club line", () => {
    render(<BookingEditor booking={editorData({ invoiceOffer: { kind: "ASK_CLUB", staffViewer: false }, invoiceAccount: ACCOUNT })} canModify={false} />);
    expect(screen.queryByText("Invoice and credits")).toBeNull();
  });

  it("shows no invoice control when the payload carries no offer", () => {
    render(<BookingEditor booking={editorData({})} canModify={false} />);
    expect(screen.queryByRole("button", { name: /Download invoice/ })).toBeNull();
    expect(screen.queryByText(/more than one invoice/)).toBeNull();
    expect(screen.queryByText("Invoice and credits")).toBeNull();
  });
});

describe("BookingInvoiceAccountCard", () => {
  it("shows the summary from the app's own records, in the club's money format", () => {
    render(<BookingInvoiceAccountCard bookingId="bk-1" creditNotes={[]} account={ACCOUNT} />);
    const summary = screen.getByLabelText("Booking account summary");
    expect(summary).toHaveTextContent("Booking total$450.00");
    expect(summary).toHaveTextContent("Account credit applied$50.00");
    expect(summary).toHaveTextContent("Paid, less refunds and credits returned$400.00");
    expect(summary).toHaveTextContent("Still to pay$0.00");
    expect(summary).not.toHaveTextContent("Change fees");
    expect(summary).not.toHaveTextContent("Kept under");
    expect(screen.queryByText("Credit notes")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a change fee and what the booking's terms kept as their own rows, and when an amount falls due (F3, F4)", () => {
    const account: BookingInvoiceAccount = {
      summary: { totalCents: 45_000, changeFeeCents: 5_000, creditAppliedCents: 0, paidCents: 55_000, keptCents: 5_000, balanceCents: 0, balanceWhen: "NOW" },
      invoiceUpdateNotice: null,
    };
    const { rerender } = render(<BookingInvoiceAccountCard bookingId="bk-1" creditNotes={[]} account={account} />);
    const summary = screen.getByLabelText("Booking account summary");
    expect(summary).toHaveTextContent("Booking total$450.00");
    expect(summary).toHaveTextContent("Change fees$50.00");
    expect(summary).toHaveTextContent("Kept under the booking's change terms$50.00");
    rerender(
      <BookingInvoiceAccountCard
        bookingId="bk-1"
        creditNotes={[]}
        account={{ ...account, summary: { ...account.summary, paidCents: 0, keptCents: 0, balanceCents: 50_000, balanceWhen: "AFTER_REVIEW" } }}
      />,
    );
    expect(screen.getByLabelText("Booking account summary")).toHaveTextContent("Due once reviewed$500.00");
  });

  it("says in plain words when the invoice in Xero does not show the latest change", () => {
    const notice = "A change to this booking could not be made to the invoice in the club's accounts, so the invoice does not show it.";
    render(
      <BookingInvoiceAccountCard
        bookingId="bk-1"
        creditNotes={[]}
        account={{ ...ACCOUNT, invoiceUpdateNotice: notice }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(notice);
  });

  it("lists each credit note with what it was for and its own download", async () => {
    const response = new Response("%PDF", { status: 200 });
    fetchMock.mockResolvedValue(response);
    const notes = [
      CREDIT_NOTE,
      { creditNoteId: "xero-cn-2", creditNoteNumber: null, kind: "REFUND" as const },
    ];
    render(<BookingInvoiceAccountCard bookingId="bk-1" creditNotes={notes} account={ACCOUNT} />);
    expect(screen.getByRole("heading", { level: 3, name: "Credit notes" })).toBeInTheDocument();
    expect(screen.getByText("For a change to the booking")).toBeInTheDocument();
    expect(screen.getByText("For a refund")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download credit note CN-0007" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(response, "credit-note.pdf"));
    expect(fetchMock).toHaveBeenCalledWith("/api/bookings/bk-1/invoice/credit-notes/xero-cn-1");
    expect(screen.getByRole("button", { name: "Download credit note" })).toBeInTheDocument();
  });

  it("says a credit note's 404 means the page is stale", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Booking not found" }, { status: 404 }));
    render(<BookingInvoiceAccountCard bookingId="bk-1" creditNotes={[CREDIT_NOTE]} account={ACCOUNT} />);
    fireEvent.click(screen.getByRole("button", { name: "Download credit note CN-0007" }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("This credit note is no longer available from this page; please refresh."),
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
