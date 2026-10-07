// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelBookingButton } from "@/components/cancel-booking-button";

/*
  #2259 honesty rule on the cancel path — the case owner decision D10's
  acknowledgement warns about by name ("including cancellation notices").

  While the switch is on, the mailer withholds the cancellation email whichever
  button the admin presses, so the choice is not offered. A MEMBER cancelling
  their own booking never sees any of it: the notify dialog is admin-only
  (`canChooseMemberEmail`), the suppression is scoped to it, and the booking
  page does not serialise the flag to a member at all.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-cancel";

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

const PREVIEW = {
  refundAmountCents: 5000,
  keptAmountCents: 0,
  changeFeeCents: 0,
  refundPercentage: 100,
  creditRefundAmountCents: 0,
  creditRefundPercentage: 0,
  creditRestoredCents: 0,
  totalPaidCents: 5000,
  hasPayment: true,
};

function installFetch() {
  fetchCalls = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    fetchCalls.push({ url, method: init?.method ?? "GET", body });
    const payload = url.includes("cancel-preview")
      ? PREVIEW
      : { refundAmountCents: 5000, refundMethod: "card" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function openPreview() {
  // The trigger's label depends on `onBehalfOfMember` (#1303), so match either.
  fireEvent.click(
    screen.getByRole("button", {
      name: /Cancel (Booking|on behalf of member)/i,
    }),
  );
  await screen.findByRole("button", { name: "Confirm Cancellation" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
}

function cancelPosts() {
  return fetchCalls.filter((c) =>
    c.url.endsWith(`/api/bookings/${BOOKING_ID}/cancel`),
  );
}

beforeEach(installFetch);
afterEach(() => vi.restoreAllMocks());

describe("CancelBookingButton — No emails honesty rule (#2259)", () => {
  it("offers no email choice while the switch is on, and cancels without a notify flag", async () => {
    render(
      <CancelBookingButton
        bookingId={BOOKING_ID}
        onBehalfOfMember
        canChooseMemberEmail
        noEmails
      />,
    );
    await openPreview();

    // Both the preview panel and the dialog now say emails are off — the
    // preview because promising a choice the dialog then withholds was its own
    // defect — so scope the dialog assertion rather than matching globally.
    const dialog = await screen.findByRole("dialog");
    const suppress = within(dialog).getByRole("button", {
      name: "Cancel booking",
    });
    expect(
      within(dialog).queryByRole("button", { name: "Cancel and email member" }),
    ).toBeNull();
    expect(
      within(dialog).getByText(/Emails are off for this booking/i),
    ).toBeInTheDocument();
    // …and the dialog must not promise a choice or an audit entry.
    expect(dialog.textContent).not.toMatch(/recorded in the audit log/i);
    expect(dialog.textContent).not.toMatch(/either way/i);

    fireEvent.click(suppress);
    await waitFor(() => expect(cancelPosts()).toHaveLength(1));
    /*
      #2259 H1: no notifyMember at all. `false` makes the cancel route skip the
      send outright, so the mailer's gate never runs and no withheld row is
      recorded — the banner would then be silent about the cancellation the
      member most needs to hear about.
    */
    expect(cancelPosts()[0].body).not.toHaveProperty("notifyMember");

    // …and the success panel must not promise an email that will not arrive.
    await waitFor(() =>
      expect(screen.queryByText(/receive a confirmation email/i)).toBeNull(),
    );
  });

  it("does not promise a choice in the preview it will not offer", async () => {
    // The preview used to say "you will choose whether the member is emailed
    // when you confirm" for any admin — contradicted a click later.
    render(
      <CancelBookingButton
        bookingId={BOOKING_ID}
        onBehalfOfMember
        canChooseMemberEmail
        noEmails
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Cancel (Booking|on behalf of member)/i,
      }),
    );
    const confirm = await screen.findByRole("button", {
      name: "Confirm Cancellation",
    });
    const preview = confirm.closest("div")?.parentElement;
    expect(preview?.textContent).not.toMatch(/you will choose whether/i);
    expect(preview?.textContent).toMatch(/Emails are off for this booking/i);
  });

  it("still offers the choice on an ordinary booking", async () => {
    render(
      <CancelBookingButton
        bookingId={BOOKING_ID}
        onBehalfOfMember
        canChooseMemberEmail
        noEmails={false}
      />,
    );
    await openPreview();

    expect(
      await screen.findByRole("button", { name: "Cancel and email member" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Emails are off for this booking/i)).toBeNull();
  });

  it("shows a self-cancelling member nothing about the switch", async () => {
    // Belt and braces: the page never serialises the flag to a member, but even
    // if it did, a member self-cancel has no notify dialog to suppress.
    render(<CancelBookingButton bookingId={BOOKING_ID} noEmails />);
    await openPreview();

    await waitFor(() => expect(cancelPosts()).toHaveLength(1));
    expect(screen.queryByText(/Emails are off for this booking/i)).toBeNull();
    expect(cancelPosts()[0].body).not.toHaveProperty("notifyMember");
  });
});
