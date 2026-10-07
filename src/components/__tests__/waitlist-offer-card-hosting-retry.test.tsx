// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import {
  WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY,
  WAITLIST_OFFER_RELEASED_CAPACITY_BODY,
} from "@/lib/waitlist-confirm-recovery-contract";

const RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";

describe("WaitlistOfferCard participant retry attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalLocation = window.location;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  // #2623 T8 — this is the PHASE-ONE participant refusal: the claim rolled back
  // before the offer was consumed, so the offer is still live and the enabled CTA
  // is the correct answer. The response carries no `offerRevoked`, which is the
  // only thing that distinguishes it from the phase-two refusal below. Before
  // #2623 both refusals looked identical to this card, so it kept the CTA live in
  // both — inviting a click on an offer that no longer existed.
  it("keeps the offer available when a phase-one refusal left it intact, and focuses the permanently mounted retry alert", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: RETRY_MESSAGE,
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
      }),
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={12500}
      />,
    );

    const alert = document.getElementById("waitlist-confirm-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveClass("sr-only");

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
    await expectRecoveryAlertToHoldFocus(alert);
    // Synchronous, like every sibling surface: the scroll happens on the very
    // next line of the same effect as the focus move, so once focus has been
    // confirmed it has already been called. #2618 relaxed both this and the focus
    // assertion to polled `waitFor`s to work around the #2635 race; the helper
    // above absorbs the timing, so neither needs to poll.
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(
      screen.getByText(
        /a spot has become available for your waitlisted booking/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm Booking" }),
    ).toBeEnabled();
  });

  it("withdraws the confirm when the same 409 says the offer was already consumed (#2623 T8)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: RETRY_MESSAGE,
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        // Phase two failed after the offer was consumed; the compensating
        // release put the waitlist place back.
        offerRevoked: true,
        waitlistPlaceRestored: true,
      }),
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={0}
      />,
    );

    const alert = document.getElementById("waitlist-confirm-error");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
    // The honest end state, not the convenient one: the offer is gone, so the
    // CTA is gone and the only action left is reading canonical state.
    expect(
      screen.queryByRole("button", { name: "Confirm Booking" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Reload booking status" }),
    ).toBeEnabled();
    expect(screen.getByText("This offer is no longer open")).toBeInTheDocument();
    await expectRecoveryAlertToHoldFocus(alert);

    fireEvent.click(screen.getByRole("button", { name: "Reload booking status" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("withdraws the confirm on the capacity 409 that revokes the offer (#2623 T8)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ ...WAITLIST_OFFER_RELEASED_CAPACITY_BODY }),
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    expect(
      await screen.findByText(
        WAITLIST_OFFER_RELEASED_CAPACITY_BODY.error,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm Booking" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload booking status" }),
    ).toBeEnabled();
  });

  it("names the operator-recovery state on a stranded confirm and never invites a retry (#2623 T4)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ ...WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY }),
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    expect(
      await screen.findByText(WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY.error),
    ).toHaveTextContent(/waiting on a lodge administrator/i);
    expect(
      screen.queryByRole("button", { name: "Confirm Booking" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload booking status" }),
    ).toBeEnabled();
  });

  it("suppresses another confirm after a network failure until status is reloaded", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network unavailable")) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={12500}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    expect(
      await screen.findByText(/could not verify whether this offer was confirmed/i),
    ).toHaveTextContent(/Reload the booking and check its current status before trying again/i);
    expect(screen.queryByRole("button", { name: "Confirm Booking" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload booking status" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable successful response as status-unconfirmed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("invalid json");
      },
    }) as unknown as typeof fetch;

    render(
      <WaitlistOfferCard
        bookingId="booking-1"
        expiresAt="2026-08-01T00:00:00.000Z"
        finalPriceCents={12500}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));

    expect(
      await screen.findByRole("button", { name: "Reload booking status" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Confirm Booking" })).not.toBeInTheDocument();
  });
});
