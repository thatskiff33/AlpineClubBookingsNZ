// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
}));
const { toastSuccess, toastError, refresh } = mocks;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
// #1997: the button derives view-only gating from the session matrix via
// useAdminAreaEditAccess("bookings"). Mock an all-edit admin so the existing
// confirm-flow assertions (enabled action) hold.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

function stubFetch(response: { ok: boolean; body?: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    json: async () => response.body ?? {},
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ConfirmPendingGuestsButton", () => {
  it("does not POST until the confirmation dialog is accepted, then asks the email choice and POSTs it (#1769b)", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );

    // Consequence dialog is open; nothing has been POSTed yet.
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/saved card will be charged \$100\.00/i)
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    // A charged-card booking sends a confirmation email, so the email-choice
    // dialog opens next — still no POST until the admin picks.
    const emailButton = await screen.findByRole("button", {
      name: "Confirm and email member",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(emailButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ notifyMember: true }),
      })
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it("POSTs notifyMember:false and reflects the choice in the toast when the admin declines the email (#1769b)", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    const noEmailButton = await screen.findByRole("button", {
      name: "Confirm without emailing",
    });
    fireEvent.click(noEmailButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({
        body: JSON.stringify({ notifyMember: false }),
      })
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Pending guests confirmed. The member was not emailed."
      )
    );
  });

  it("POSTs directly with no email-choice dialog on the payment-owed branch (#1769b)", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod={false}
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    // No card + priced → moves to payment-owed, emails no one → plain Confirm.
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // No email-choice dialog was shown, and the POST carries no notify field.
    expect(
      screen.queryByRole("button", { name: "Confirm and email member" })
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({ body: JSON.stringify({}) })
    );
  });

  it("does not POST when the dialog is cancelled", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod={false}
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    // No-card copy is stated in the dialog.
    expect(
      screen.getByText(/payment-owed \(no card on file\)/i)
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/payment-owed \(no card on file\)/i)
      ).toBeNull()
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows an error toast (mapping CAPACITY_EXCEEDED) when the POST fails", async () => {
    stubFetch({ ok: false, body: { error: "CAPACITY_EXCEEDED" } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    const emailButton = await screen.findByRole("button", {
      name: "Confirm and email member",
    });
    fireEvent.click(emailButton);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Not enough beds remain for these dates. Use Force confirm to overbook if intended."
      )
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("uses positive payment facts from an ordinary failure to suppress another charge while canonical refresh is unresolved", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    stubFetch({
      ok: false,
      body: {
        error: "private database detail",
        paymentReceived: true,
        finalisationPending: true,
      },
    });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />,
    );

    const alert = document.getElementById("confirm-pending-guests-error-b1");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("");

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm and email member" }),
    );

    await waitFor(() =>
      expect(alert?.textContent).toMatch(/saved card was charged/i),
    );
    expect(alert?.textContent).toMatch(/could not be finalised/i);
    expect(alert?.textContent).toMatch(/do not charge again/i);
    expect(alert?.textContent).not.toContain("private database detail");
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Confirm pending guests" }),
    ).toBeNull();

    // A router refresh has no success callback. If the server component cannot
    // replace this card, the local proof and suppression must survive.
    fireEvent.click(screen.getByRole("button", { name: "Reload booking status" }));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(alert?.textContent).toMatch(/saved card was charged/i);
    expect(
      screen.queryByRole("button", { name: "Confirm pending guests" }),
    ).toBeNull();
  });

  it("keeps cancelled refund recovery distinct from booking finalisation pending", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    stubFetch({
      ok: false,
      body: {
        error: "private provider detail",
        status: "CANCELLED",
        refunded: false,
        refundRecoveryPending: true,
        paymentReceived: true,
        paymentIntentId: "pi_private",
      },
    });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
      />,
    );

    const alert = document.getElementById("confirm-pending-guests-error-b1");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("");

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm and email member" }),
    );

    await waitFor(() =>
      expect(alert?.textContent).toMatch(
        /booking cancelled - refund recovery pending/i,
      ),
    );
    expect(alert?.textContent).toMatch(/automatic refund recovery is pending/i);
    expect(alert?.textContent).toMatch(/do not charge again/i);
    expect(alert?.textContent).not.toMatch(/finalisation unconfirmed/i);
    expect(alert?.textContent).not.toContain("private provider detail");
    expect(alert?.textContent).not.toContain("pi_private");
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Confirm pending guests" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Reload booking and refund status" }),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(alert?.textContent).toMatch(/automatic refund recovery is pending/i);
  });

  it.each([
    [
      "finalisationPending",
      {
        code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
        paymentReceived: true,
      },
    ],
    [
      "paymentReceived",
      {
        status: "CANCELLED",
        refunded: false,
        refundRecoveryPending: true,
      },
    ],
    [
      "refundRecoveryPending",
      {
        status: "CANCELLED",
        refunded: false,
        paymentReceived: true,
      },
    ],
  ])(
    "does not claim recovery or suppress retry without %s",
    async (_missingFact, partialFacts) => {
      stubFetch({
        ok: false,
        body: {
          error: "Reload before trying again.",
          ...partialFacts,
        },
      });
      render(
        <ConfirmPendingGuestsButton
          bookingId="b1"
          hasSavedPaymentMethod
          finalPriceCents={10000}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Confirm pending guests" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Charge and confirm" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm and email member" }),
      );

      await screen.findByText("Reload before trying again.");
      expect(screen.queryByText(/saved card was charged/i)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Confirm pending guests" }),
      ).not.toBeNull();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it("states the no-charge copy and a plain Confirm label for a $0 booking", () => {
    stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={0}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/confirm the booking at no charge/i)
    ).not.toBeNull();
    // Zero-dollar path never charges, so the confirm affordance is a plain
    // "Confirm" — not "Charge and confirm".
    expect(
      within(dialog).queryByRole("button", { name: "Charge and confirm" })
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Confirm" })
    ).not.toBeNull();
  });

  /*
    #2259 honesty rule. With the booking's "No emails" switch on the mailer
    withholds the confirmation whatever is chosen here, so the choice is not
    offered: the dialog states the position and confirms down the send-nothing
    path. Re-offering "Confirm and email member" would invite the admin to
    believe the member was told.
  */
  it("offers no email choice while the booking's No emails switch is on (#2259)", async () => {
    const fetchMock = stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
        noEmails
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    // The dialog's action carries the same label as the trigger behind it, so
    // scope the query to the dialog (as the sibling tests above do).
    const dialog = await screen.findByRole("dialog");
    const suppressButton = within(dialog).getByRole("button", {
      name: "Confirm pending guests",
    });
    // The affirmative choice is gone, and the reason is stated in its place.
    expect(
      within(dialog).queryByRole("button", { name: "Confirm and email member" })
    ).toBeNull();
    expect(
      within(dialog).getByText(/Emails are off for this booking/i)
    ).not.toBeNull();

    fireEvent.click(suppressButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    /*
      #2259 H1 — the load-bearing assertion. The body must carry NO
      notifyMember at all. `notifyMember: false` would make the route skip the
      send, so the mailer's gate never runs, no SKIPPED_NO_EMAILS row is
      written, and the booking's withheld list would omit the very confirmation
      this action suppressed. Absent lets the send be attempted and WITHHELD.
    */
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bookings/b1/confirm-pending-guests",
      expect.objectContaining({ body: JSON.stringify({}) })
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Pending guests confirmed. Emails are off for this booking, so nothing was sent."
      )
    );
  });

  it("still offers the email choice on an ordinary booking (#2259 control)", async () => {
    stubFetch({ ok: true, body: { success: true } });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod
        finalPriceCents={10000}
        noEmails={false}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm pending guests" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Charge and confirm" }));

    expect(
      await screen.findByRole("button", { name: "Confirm and email member" })
    ).not.toBeNull();
    expect(screen.queryByText(/Emails are off for this booking/i)).toBeNull();
  });
});
