// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** #5066 slice 1: the booking page's invoice control renders the page's offer, and nothing else. */
const mocks = vi.hoisted(() => ({ toastError: vi.fn(), save: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/lib/save-response-as-file", () => ({ saveResponseAsFile: mocks.save }));

import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";
import { BookingInvoiceControl } from "@/components/download-invoice-button";

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

  it("tells a member to ask the club, and staff on someone else's booking to open Xero (#1289)", () => {
    const { rerender } = render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: false }} />);
    expect(screen.getByText(/Please ask the club for copies/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "ASK_CLUB", staffViewer: true }} />);
    expect(screen.getByText(/open Xero for copies/)).toBeInTheDocument();
    expect(screen.queryByText(/ask the club/)).toBeNull();
  });

  it("downloads the booking's invoice through the shared file saver", async () => {
    const response = new Response("%PDF", { status: 200 });
    fetchMock.mockResolvedValue(response);
    render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "XERO_INVOICE", invoiceNumber: "INV-0042" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download invoice INV-0042" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(response, "Invoice.pdf"));
    expect(fetchMock).toHaveBeenCalledWith("/api/bookings/bk-1/invoice");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("says a 404 means the page is stale, and shows the route's own message otherwise", async () => {
    render(<BookingInvoiceControl bookingId="bk-1" offer={{ kind: "XERO_INVOICE", invoiceNumber: null }} />);
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
    render(<BookingEditor booking={editorData({ invoiceOffer: { kind: "XERO_INVOICE", invoiceNumber: "INV-7" } })} canModify={false} />);
    expect(screen.getByRole("button", { name: "Download invoice INV-7" })).toBeInTheDocument();
  });

  it("shows no invoice control when the payload carries no offer", () => {
    render(<BookingEditor booking={editorData({})} canModify={false} />);
    expect(screen.queryByRole("button", { name: /Download invoice/ })).toBeNull();
    expect(screen.queryByText(/more than one invoice/)).toBeNull();
  });
});
