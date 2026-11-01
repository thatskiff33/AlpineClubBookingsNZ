// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";

/**
 * #4533: on a finished stay's request, the officer may enter the promo code the
 * member should have had. The figures are worked out for exactly that code,
 * Approve and apply sends it, and on a promo-only correction the officer
 * chooses whether the member is emailed.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    version: 2,
    executesOnApproval: true,
    acceptsOfficerGuests: true,
    acceptsOfficerPromo: true,
    promoCorrection: null,
    requestedChanges: { requested: { summary: "Locked-period booking change", addGuests: [] } },
    reason: "I should have had my free night",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-06-20T10:00:00.000Z",
    requestedBy: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    reviewedBy: null,
    linkedModification: null,
    booking: {
      id: "bk-1",
      checkIn: "2026-06-10T00:00:00.000Z",
      checkOut: "2026-06-16T00:00:00.000Z",
      status: "COMPLETED",
      finalPriceCents: 30000,
      member: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      organisation: null,
      payment: null,
    },
    ...overrides,
  };
}

const QUOTE = {
  priceDiffCents: -5_000,
  changeFeeCents: 0,
  additionalAmountCents: 0,
  refundAmountCents: 0,
  accountCreditAmountCents: 5_000,
  capacityOverridden: false,
  settlementMethod: "credit",
};

let rows: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [request()];
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/quote")) return jsonResponse({ id: "req-1", quote: QUOTE });
    if (init?.method === "PATCH") {
      return jsonResponse({
        id: "req-1",
        execution: { executed: true, followUpFailed: false, promoCodesApplied: ["FREENIGHT"], memberEmailWithheld: true },
      });
    }
    if (url.includes("/api/admin/booking-change-requests")) {
      return jsonResponse({ data: rows, page: 1, pageSize: 25, total: rows.length, memberGuestFind: null });
    }
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function bodies(match: (url: string, init: RequestInit | undefined) => boolean) {
  return fetchMock.mock.calls
    .filter(([input, init]) => match(String(input), init as RequestInit | undefined))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}
const quoteBodies = () => bodies((url, init) => url.endsWith("/quote") && init?.method === "POST");
const patchBodies = () => bodies((url, init) => url.endsWith("req-1") && init?.method === "PATCH");

describe("change-request panel — the officer enters a promo code (#4533)", () => {
  it("offers the entry only on a request that takes one", async () => {
    rows = [request({ acceptsOfficerPromo: false })];
    render(<BookingChangeRequestsPanel />);
    await screen.findByRole("button", { name: "Approve and apply" });
    expect(screen.queryByLabelText(/Promo code to apply/)).toBeNull();
  });

  it("prices the code, sends it with the approval, and honours the email choice", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "Your free night is now applied." },
    });
    fireEvent.change(screen.getByLabelText(/Promo code to apply/), { target: { value: "FREENIGHT" } });
    // A promo-only correction: the officer may withhold the email.
    const notify = screen.getByLabelText("Apply and email member about the correction");
    expect(notify).toBeChecked();
    fireEvent.click(notify);

    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByText(/Account credit/);
    expect(quoteBodies().at(-1)).toEqual({ officerPromo: { promoCode: "FREENIGHT" } });

    // A changed code clears the figures it no longer describes.
    fireEvent.change(screen.getByLabelText(/Promo code to apply/), { target: { value: "FREENIGHTS" } });
    expect(screen.getByRole("button", { name: "Approve and apply" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Promo code to apply/), { target: { value: "FREENIGHT" } });
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve and apply" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toMatchObject({
      status: "APPROVED",
      execute: true,
      officerPromo: { promoCode: "FREENIGHT" },
      notifyMember: false,
      expectedFigures: { additionalAmountCents: 0, refundAmountCents: 0, accountCreditAmountCents: 5_000 },
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Promo code FREENIGHT applied to the booking and the request approved. The member was not emailed.",
      ),
    );
  });

  it("does not offer the email choice beside a guest change", async () => {
    rows = [
      request({
        acceptsOfficerGuests: false,
        promoCorrection: { codes: ["FREENIGHT"], onlyChange: false },
        acceptsOfficerPromo: false,
      }),
    ];
    render(<BookingChangeRequestsPanel />);
    await screen.findByRole("button", { name: "Approve and apply" });
    expect(screen.queryByLabelText("Apply and email member about the correction")).toBeNull();
  });

  it("drops the choice for a booking whose emails are off, and sends none (#2259)", async () => {
    rows = [request({ booking: { ...request().booking, noEmails: true } })];
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "Your free night is now applied." },
    });
    fireEvent.change(screen.getByLabelText(/Promo code to apply/), { target: { value: "FREENIGHT" } });
    expect(screen.queryByLabelText("Apply and email member about the correction")).toBeNull();
    expect(screen.getByTestId("booking-no-emails-notice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve and apply" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).not.toHaveProperty("notifyMember");
  });

  it("offers it on a promo correction raised from Edit Booking", async () => {
    rows = [
      request({
        acceptsOfficerGuests: false,
        acceptsOfficerPromo: false,
        promoCorrection: { codes: ["FREENIGHT"], onlyChange: true },
      }),
    ];
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByLabelText("Apply and email member about the correction")).toBeChecked();
  });
});
