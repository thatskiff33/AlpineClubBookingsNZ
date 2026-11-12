// @vitest-environment jsdom

// The cancel flow's announcement and focus walk (#4949). Every step swaps the
// flow's controls, so each one says where focus goes: the status region while
// loading or cancelling, the heading of the preview and success panels, the
// recovery alert on failure, and the trigger again on the way back to idle.
// Focus must never be left on the page itself.

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expectRecoveryAlertToHoldFocus,
  expectToHoldFocus,
} from "@/lib/__tests__/helpers/focus";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { CancelBookingButton } from "@/components/cancel-booking-button";

const previewBody = {
  refundAmountCents: 4500,
  keptAmountCents: 500,
  changeFeeCents: 0,
  refundPercentage: 90,
  creditRefundAmountCents: 5000,
  creditRefundPercentage: 100,
  creditRestoredCents: 0,
  totalPaidCents: 5000,
  hasPayment: true,
};

type Deferred = { resolve: (response: Response) => void };

/** Each request waits until the test releases it, so every step is observable. */
function stubDeferredFetch() {
  const pending: Record<"preview" | "cancel", Deferred[]> = {
    preview: [],
    cancel: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending[url.includes("cancel-preview") ? "preview" : "cancel"].push({
            resolve,
          });
        }),
    ),
  );
  return {
    async release(kind: "preview" | "cancel", body: unknown, status = 200) {
      const next = pending[kind].shift();
      if (!next) throw new Error(`no ${kind} request is waiting`);
      await act(async () => {
        next.resolve(new Response(JSON.stringify(body), { status }));
      });
    },
  };
}

/** A real click focuses the button first; `fireEvent.click` alone does not. */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

function statusRegion() {
  return document.getElementById("cancel-booking-bk_1-status");
}

function recoveryAlert() {
  return document.getElementById("cancel-booking-bk_1-error");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CancelBookingButton — announcements and focus (#4949)", () => {
  it("walks idle, loading, preview, cancelling and success without dropping focus", async () => {
    const fetches = stubDeferredFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    const status = statusRegion();
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("");

    press(screen.getByRole("button", { name: "Cancel Booking" }));
    // The status region was mounted empty and is now filled — and holds focus,
    // because the button that had it is gone.
    expect(statusRegion()).toBe(status);
    expect(status).toHaveTextContent("Loading cancellation details...");
    await expectToHoldFocus(status!, "the loading status");

    await fetches.release("preview", previewBody);
    const previewHeading = screen.getByText("Cancellation Summary");
    await expectToHoldFocus(previewHeading, "the Cancellation Summary heading");
    expect(status).toHaveTextContent("");

    press(screen.getByRole("button", { name: "Confirm Cancellation" }));
    expect(statusRegion()).toBe(status);
    expect(status).toHaveTextContent("Cancelling booking...");
    await expectToHoldFocus(status!, "the cancelling status");

    await fetches.release("cancel", { refundAmountCents: 4500, refundMethod: "credit" });
    const successHeading = screen.getByText("Booking cancelled successfully");
    await expectToHoldFocus(successHeading, "the success heading");
    // The refund sentence is read with the focused heading, as its description.
    const detail = document.getElementById(
      successHeading.getAttribute("aria-describedby") ?? "",
    );
    expect(detail).toHaveTextContent(
      /A credit of \$45\.00 has been added to your account for future bookings\./,
    );
    expect(status).toHaveTextContent("");
  });

  it("focuses the on-behalf heading when an officer's preview loads", async () => {
    const fetches = stubDeferredFetch();
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    press(screen.getByRole("button", { name: "Cancel on behalf of member" }));
    await fetches.release("preview", previewBody);

    await expectToHoldFocus(
      screen.getByText("Cancel on behalf of member", { selector: "p" }),
      "the on-behalf heading",
    );
  });

  it("returns focus to Cancel Booking after Keep Booking", async () => {
    const fetches = stubDeferredFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    press(screen.getByRole("button", { name: "Cancel Booking" }));
    await fetches.release("preview", previewBody);
    press(screen.getByRole("button", { name: "Keep Booking" }));

    await expectToHoldFocus(
      screen.getByRole("button", { name: "Cancel Booking" }),
      "the Cancel Booking button",
    );
  });

  it("puts a failed cancel in the recovery alert, which takes focus, and Try Again returns to idle", async () => {
    const fetches = stubDeferredFetch();
    render(<CancelBookingButton bookingId="bk_1" />);
    const alert = recoveryAlert();
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("");

    press(screen.getByRole("button", { name: "Cancel Booking" }));
    await fetches.release("preview", previewBody);
    press(screen.getByRole("button", { name: "Confirm Cancellation" }));
    await fetches.release("cancel", { error: "The booking has already started." }, 409);

    expect(recoveryAlert()).toBe(alert);
    expect(alert).toHaveTextContent("The booking has already started.");
    await expectRecoveryAlertToHoldFocus(alert);
    expect(statusRegion()).toHaveTextContent("");

    press(screen.getByRole("button", { name: "Try Again" }));
    expect(alert).toHaveTextContent("");
    await expectToHoldFocus(
      screen.getByRole("button", { name: "Cancel Booking" }),
      "the Cancel Booking button",
    );
  });

  it("announces a failed preview load the same way", async () => {
    const fetches = stubDeferredFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    press(screen.getByRole("button", { name: "Cancel Booking" }));
    await fetches.release("preview", { error: "Booking not found" }, 404);

    const alert = recoveryAlert();
    expect(alert).toHaveTextContent("Booking not found");
    await expectRecoveryAlertToHoldFocus(alert);
  });

  it("moves focus to the cancelling status after the officer's notify dialog closes", async () => {
    const fetches = stubDeferredFetch();
    render(
      <CancelBookingButton bookingId="bk_1" onBehalfOfMember canChooseMemberEmail />,
    );

    press(screen.getByRole("button", { name: "Cancel on behalf of member" }));
    await fetches.release("preview", previewBody);
    press(screen.getByRole("button", { name: "Confirm Cancellation" }));
    press(await screen.findByRole("button", { name: "Cancel and email member" }));

    // The closing dialog restores focus in its own cleanup; the status region
    // must still hold focus once that has run.
    const status = statusRegion();
    expect(status).toHaveTextContent("Cancelling booking...");
    await expectToHoldFocus(status!, "the cancelling status");

    await fetches.release("cancel", { refundAmountCents: 0, refundMethod: "card" });
    await expectToHoldFocus(
      screen.getByText("Booking cancelled on behalf of the member"),
      "the success heading",
    );
  });
});
