// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function stubPreviewFetch(body: Record<string, unknown> = previewBody) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CancelBookingButton — admin/member framing (#1303)", () => {
  it("shows member-framed copy for the booking owner (default)", async () => {
    stubPreviewFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    const button = screen.getByRole("button", { name: "Cancel Booking" });
    expect(button).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Cancellation Summary")).toBeTruthy();
    });
    // The admin-on-behalf note must not appear for the owner.
    expect(screen.queryByText(/on behalf of the member/i)).toBeNull();
  });

  it("shows admin-on-behalf copy for a non-owner admin", async () => {
    stubPreviewFetch();
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    const button = screen.getByRole("button", {
      name: "Cancel on behalf of member",
    });
    expect(button).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => {
      // Preview header is re-framed and an explicit admin note appears.
      expect(
        screen.getByText("Cancel on behalf of member", { selector: "p" })
      ).toBeTruthy();
    });
    expect(screen.getByText(/on behalf of the member/i)).toBeTruthy();
    expect(screen.getByText(/applied to the member.?s account/i)).toBeTruthy();
  });
});

describe("CancelBookingButton — per-cancel member-email choice (#1705)", () => {
  function stubPreviewAndCancelFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("cancel-preview")) {
        return { ok: true, json: async () => previewBody };
      }
      return {
        ok: true,
        json: async () => ({ refundAmountCents: 4500, refundMethod: "card" }),
      };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
  }

  it("asks whether to email the member and posts notifyMember: false on 'Cancel without emailing'", async () => {
    const { calls } = stubPreviewAndCancelFetch();
    render(
      <CancelBookingButton bookingId="bk_1" onBehalfOfMember canChooseMemberEmail />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });

    // Confirm opens the choice dialog; nothing is posted yet.
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    expect(
      screen.getByText("Email the member about this cancellation?")
    ).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" })
    );
    await waitFor(() => {
      expect(
        screen.getByText(/was not emailed about this cancellation/i)
      ).toBeTruthy();
    });
    // The suppressed run must not promise a confirmation email.
    expect(screen.queryByText(/confirmation email shortly/i)).toBeNull();
    const post = calls.find((c) => c.url.endsWith("/cancel"));
    expect(post).toBeDefined();
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      refundMethod: "card",
      notifyMember: false,
    });
  });

  it("posts notifyMember: true on 'Cancel and email member'", async () => {
    const { calls } = stubPreviewAndCancelFetch();
    render(
      <CancelBookingButton bookingId="bk_1" onBehalfOfMember canChooseMemberEmail />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel and email member" })
    );

    await waitFor(() => {
      expect(screen.getByText(/confirmation email shortly/i)).toBeTruthy();
    });
    const post = calls.find((c) => c.url.endsWith("/cancel"));
    expect(post).toBeDefined();
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      refundMethod: "card",
      notifyMember: true,
    });
  });

  it("keeps the immediate always-notify confirm for a member self-cancel (no dialog, no flag)", async () => {
    const { calls } = stubPreviewAndCancelFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));

    await waitFor(() => {
      expect(screen.getByText(/confirmation email shortly/i)).toBeTruthy();
    });
    const post = calls.find((c) => c.url.endsWith("/cancel"));
    expect(post).toBeDefined();
    // No dialog was shown and no flag rides on the member request.
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      refundMethod: "card",
    });
    expect(
      screen.queryByText("Email the member about this cancellation?")
    ).toBeNull();
  });
});

describe("CancelBookingButton — state-bound hosting override (#2576)", () => {
  const prompt = (key: string, reference: string) => ({
    error: "This cancellation would strand another booking.",
    code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
    requiresOverrideReason: true,
    strandedStateKey: `v1:${key.repeat(64)}`,
    strandedBookings: [
      {
        bookingId: `private-${reference}`,
        reference,
        lodgeName: "Example Lodge",
        nights: ["2026-09-01"],
      },
    ],
  });

  function stubOverrideFlow() {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        calls.push({ url, body });
        if (url.includes("cancel-preview")) {
          return new Response(JSON.stringify(previewBody), { status: 200 });
        }
        attempt += 1;
        if (attempt <= 2) {
          return new Response(
            JSON.stringify(
              attempt === 1 ? prompt("a", "ACB-OLD") : prompt("b", "ACB-NEW"),
            ),
            { status: 409 },
          );
        }
        return new Response(
          JSON.stringify({ refundAmountCents: 4500, refundMethod: "card" }),
          { status: 200 },
        );
      }),
    );
    return calls;
  }

  it("keeps one empty alert mounted through the pending request before announcing the 409", async () => {
    let completeCancel!: (response: Response) => void;
    const pendingCancel = new Promise<Response>((resolve) => {
      completeCancel = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("cancel-preview")
          ? Promise.resolve(
              new Response(JSON.stringify(previewBody), { status: 200 }),
            )
          : pendingCancel,
      ),
    );
    render(
      <CancelBookingButton
        bookingId="bk_1"
        onBehalfOfMember
        canChooseMemberEmail
        canOverrideHostingCoverage
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Cancellation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" }),
    );

    await screen.findByText("Cancelling booking...");
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert.textContent).toBe("");
    expect(alert.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      completeCancel(
        new Response(JSON.stringify(prompt("a", "ACB-OLD")), { status: 409 }),
      );
    });
    expect(await screen.findByText("ACB-OLD")).toBeTruthy();
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert.getAttribute("aria-busy")).toBe("false");
  });

  it("retires the complete override intent when the officer keeps the booking", async () => {
    const calls = stubOverrideFlow();
    render(
      <CancelBookingButton
        bookingId="bk_1"
        onBehalfOfMember
        canChooseMemberEmail
        canOverrideHostingCoverage
      />,
    );
    const alert = screen.getByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Cancellation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" }),
    );
    expect(await screen.findByText("ACB-OLD")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "Abandoned private override reason." },
    });
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep Booking" }));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert.textContent).toBe("");
    expect(screen.queryByLabelText(/Private hosting override reason/i)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    await screen.findByRole("button", { name: "Confirm Cancellation" });
    expect(
      screen.queryByText(/Review the affected bookings and nights/i),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm Cancellation" }),
    );
    expect(
      screen.getByText("Email the member about this cancellation?"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel and email member" }),
    );

    expect(await screen.findByText("ACB-NEW")).toBeTruthy();
    expect(
      (screen.getByLabelText(
        /Private hosting override reason/i,
      ) as HTMLTextAreaElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText(
        /I confirm these exact affected bookings and nights/i,
      ) as HTMLInputElement).checked,
    ).toBe(false);
    const cancelBodies = calls
      .filter((call) => call.url.endsWith("/cancel"))
      .map((call) => call.body);
    expect(cancelBodies).toEqual([
      { refundMethod: "card", notifyMember: false },
      { refundMethod: "card", notifyMember: true },
    ]);
  });

  it("retries the same refund/notify proposal without a second dialog and refreshes drift", async () => {
    const calls = stubOverrideFlow();
    render(
      <CancelBookingButton
        bookingId="bk_1"
        onBehalfOfMember
        canChooseMemberEmail
        canOverrideHostingCoverage
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Cancellation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" }),
    );
    expect(await screen.findByText("ACB-OLD")).toBeTruthy();
    expect(screen.queryByText("private-ACB-OLD")).toBeNull();

    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "First cancellation coverage reason." },
    });
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    );
    const retry = screen.getByRole("button", {
      name: "Confirm hosting override and cancel",
    });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(await screen.findByText("ACB-NEW")).toBeTruthy();
    expect(
      screen.queryByText("Email the member about this cancellation?"),
    ).toBeNull();
    expect(
      (screen.getByLabelText(
        /Private hosting override reason/i,
      ) as HTMLTextAreaElement).value,
    ).toBe("");

    fireEvent.change(screen.getByLabelText(/Private hosting override reason/i), {
      target: { value: "Second cancellation coverage reason." },
    });
    fireEvent.click(
      screen.getByLabelText(/I confirm these exact affected bookings and nights/i),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm hosting override and cancel" }),
    );
    await screen.findByText(/Booking cancelled on behalf of the member/i);

    const cancelBodies = calls
      .filter((call) => call.url.endsWith("/cancel"))
      .map((call) => call.body);
    expect(cancelBodies).toHaveLength(3);
    expect(cancelBodies[0]).toEqual({ refundMethod: "card", notifyMember: false });
    expect(cancelBodies[1]).toMatchObject({
      refundMethod: "card",
      notifyMember: false,
      hostingCoverageOverride: {
        strandedStateKey: `v1:${"a".repeat(64)}`,
      },
    });
    expect(cancelBodies[2]).toMatchObject({
      refundMethod: "card",
      notifyMember: false,
      hostingCoverageOverride: {
        reason: "Second cancellation coverage reason.",
        strandedStateKey: `v1:${"b".repeat(64)}`,
      },
    });
  });

  it("never renders another booking's details without explicit override authority", async () => {
    const calls = stubOverrideFlow();
    render(
      <CancelBookingButton
        bookingId="bk_1"
        onBehalfOfMember
        canChooseMemberEmail
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Cancellation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" }),
    );
    expect(
      await screen.findByText("This cancellation would strand another booking."),
    ).toBeTruthy();
    expect(screen.queryByText("ACB-OLD")).toBeNull();
    expect(calls.filter((call) => call.url.endsWith("/cancel"))).toHaveLength(1);
  });

  it("retires the prompt permanently when the refund proposal changes", async () => {
    stubOverrideFlow();
    render(
      <CancelBookingButton
        bookingId="bk_1"
        onBehalfOfMember
        canChooseMemberEmail
        canOverrideHostingCoverage
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm Cancellation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" }),
    );
    expect(await screen.findByText("ACB-OLD")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Hold .*account credit/i }));
    await waitFor(() => expect(screen.queryByText("ACB-OLD")).toBeNull());
    fireEvent.click(
      screen.getByRole("radio", { name: /Refund .*original payment method/i }),
    );
    expect(screen.queryByText("ACB-OLD")).toBeNull();
  });
});

describe("CancelBookingButton — restored applied credit on a no-payment cancel (#1547)", () => {
  const noPaymentWithRestore = {
    refundAmountCents: 0,
    keptAmountCents: 0,
    changeFeeCents: 0,
    refundPercentage: 0,
    creditRefundAmountCents: 0,
    creditRefundPercentage: 0,
    creditRestoredCents: 3000,
    totalPaidCents: 0,
    hasPayment: false,
  };

  it("shows the will-be-returned line under 'no payment taken' for the owner", async () => {
    stubPreviewFetch(noPaymentWithRestore);
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));

    await waitFor(() => {
      expect(
        screen.getByText(/No payment has been taken for this booking/i)
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        /previously applied account credit will be returned to your account/i
      )
    ).toBeTruthy();
  });

  it("frames the restored-credit line for the member when an admin cancels on their behalf", async () => {
    stubPreviewFetch(noPaymentWithRestore);
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No payment has been taken for this booking/i)
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/will be returned to the member.?s account/i)
    ).toBeTruthy();
  });
});

describe("CancelBookingButton — manual (cash / off-Xero) settlement copy (#2262 H4)", () => {
  // Credit tier deliberately differs from the card tier so a wrong-tier figure
  // is caught: card 90% = $45.00, credit 80% = $40.00, kept $10.00.
  const manualPreview = {
    refundAmountCents: 4500,
    keptAmountCents: 500,
    changeFeeCents: 0,
    refundPercentage: 90,
    creditRefundAmountCents: 4000,
    creditRefundPercentage: 80,
    creditRestoredCents: 0,
    totalPaidCents: 5000,
    hasPayment: true,
    manualRefund: true,
  };

  function stubManualFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("cancel-preview")) {
        return { ok: true, json: async () => manualPreview };
      }
      // The executed cancel raises the hand-back task at the CREDIT tier and
      // reports refundMethod "manual" (booking-cancel.ts manual branch).
      return {
        ok: true,
        json: async () => ({ refundAmountCents: 4000, refundMethod: "manual" }),
      };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
  }

  it("preview shows the credit-tier figure the club will hand back — never the card-tier 'Refund to card' row or the method radios", async () => {
    stubManualFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });

    // The explanatory paragraph carries the credit-tier amount.
    expect(
      screen.getByText(/paid in cash or by bank transfer/i)
    ).toBeTruthy();
    // The summary row is the club-arranged figure at the credit tier…
    expect(screen.getByText("Refund arranged by the club:")).toBeTruthy();
    expect(screen.getAllByText("$40.00").length).toBeGreaterThan(0);
    // …with the kept amount derived from the credit percentage.
    expect(screen.getByText(/Amount kept \(80% refund\):/)).toBeTruthy();
    expect(screen.getByText("$10.00")).toBeTruthy();
    // The card-tier row, figure and radios never render.
    expect(screen.queryByText("Refund to card:")).toBeNull();
    expect(screen.queryByText("$45.00")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("success panel says the club will arrange the refund — the 'original payment method' sentence never renders for manual", async () => {
    stubManualFetch();
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));

    await waitFor(() => {
      expect(
        screen.getByText(/The club will arrange your refund of \$40\.00 directly/)
      ).toBeTruthy();
    });
    // The plan-forbidden sentence.
    expect(screen.queryByText(/original payment method/i)).toBeNull();
    // And no false account-credit claim either.
    expect(screen.queryByText(/added to your account/i)).toBeNull();
  });

  it("admin-on-behalf success panel frames the manual hand-back for the member", async () => {
    stubManualFetch();
    render(
      <CancelBookingButton bookingId="bk_1" onBehalfOfMember canChooseMemberEmail />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" })
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" })
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          /The club will arrange the member.?s refund of \$40\.00 directly/
        )
      ).toBeTruthy();
    });
    expect(screen.queryByText(/original payment method/i)).toBeNull();
  });
});

// #3643 follow-up: an internet banking payment always refunds as account
// credit (`forcedCancelRefundMethod`, the cancel path's own decision). The
// preview says so, and the dialog offers only that option, with a reason.
describe("CancelBookingButton — internet banking refunds as credit only", () => {
  function stubFetchByUrl(preview: Record<string, unknown>) {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).endsWith("/cancel-preview")
          ? preview
          : { refundAmountCents: 5000, refundMethod: "credit", creditAmountCents: 5000 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("shows only the credit outcome with its reason, and cancels as credit", async () => {
    const fetchMock = stubFetchByUrl({ ...previewBody, refundMethodForced: "credit" });
    render(<CancelBookingButton bookingId="bk_ib" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(screen.getByTestId("forced-credit-refund")).toBeTruthy();
    });

    expect(screen.queryByText("Choose refund method:")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/paid by internet banking, so any refund is held as account credit/)).toBeTruthy();
    expect(screen.getByText("Credit to account:")).toBeTruthy();
    expect(screen.queryByText("Refund to card:")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ refundMethod: "credit" });
  });

  it("still offers the card-or-credit choice for a card payment", async () => {
    stubFetchByUrl({ ...previewBody, refundMethodForced: null });
    render(<CancelBookingButton bookingId="bk_card" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(screen.getByText("Choose refund method:")).toBeTruthy();
    });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByTestId("forced-credit-refund")).toBeNull();
  });

  // #3653: a joiner's booking the group organiser paid for by card refunds to
  // the ORGANISER's card - no account-credit choice for the joiner.
  it("shows only the organiser's-card outcome for a booking the organiser paid for, and cancels as card", async () => {
    const fetchMock = stubFetchByUrl({ ...previewBody, refundMethodForced: "organiser_card" });
    render(<CancelBookingButton bookingId="bk_child" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(screen.getByTestId("organiser-card-refund")).toBeTruthy();
    });
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByTestId("forced-credit-refund")).toBeNull();
    expect(screen.getByText(/paid for this booking, so any refund goes back to their card/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ refundMethod: "card" });
  });
});

// #3973: the confirmation after a joiner's organiser-paid cancel names the
// ORGANISER's card, in the "Booking Cancelled" email's own words and tone, keyed
// off the cancel's `organiserRefund` answer rather than `refundMethod: "card"`.
describe("CancelBookingButton — a refund the group organiser receives (#3973)", () => {
  function stubOrganiserFetch(result: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).endsWith("/cancel-preview") ? { ...previewBody, refundMethodForced: "organiser_card" } : result,
      })),
    );
  }

  async function confirmCancel() {
    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm Cancellation" })).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    });
  }

  it.each([
    [
      "made",
      { method: "organiser_card", amountCents: 2500 },
      "A refund of $25.00 has been processed to the group organiser's card, because the group organiser paid for this booking. You will receive a confirmation email shortly.",
      "text-success-11",
    ],
    [
      "still on its way",
      { method: "organiser_card_pending", amountCents: 2500 },
      "A refund of $25.00 is on its way to the group organiser's card, because the group organiser paid for this booking. You will receive a confirmation email shortly.",
      "text-info-11",
    ],
    [
      "carried by the group's cancellation, still running",
      { method: "group_cancel_refunding", amountCents: 3000 },
      "The group organiser's cancellation is already refunding $30.00 for this booking to the organiser's card. You will receive a confirmation email shortly.",
      "text-info-11",
    ],
    [
      "carried by the group's cancellation, made",
      { method: "group_cancel_refunded", amountCents: 3000 },
      "The group organiser's cancellation refunded $30.00 for this booking to the organiser's card. You will receive a confirmation email shortly.",
      "text-success-11",
    ],
  ] as const)("names the organiser's refund %s, in the email's words and tone", async (_label, organiserRefund, sentence, tone) => {
    stubOrganiserFetch({ refundAmountCents: organiserRefund.method.startsWith("group") ? 0 : 2500, refundMethod: "card", organiserRefund });
    render(<CancelBookingButton bookingId="bk_child" />);
    await confirmCancel();

    await waitFor(() => {
      expect(screen.getByText(sentence)).toBeTruthy();
    });
    expect(screen.getByText(sentence).className).toContain(tone);
    expect(screen.queryByText(/original payment method/i)).toBeNull();
  });

  // #3949 (owner decision, 22 Oct 2026): a place the organiser paid for by internet banking.
  it("names the organiser's bank transfer, in the dialog and the confirmation, never the joiner's cash or credit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).endsWith("/cancel-preview")
            ? { ...previewBody, refundMethodForced: "organiser_by_hand" }
            : { refundAmountCents: 2500, refundMethod: "manual", organiserRefund: { method: "organiser_by_hand", amountCents: 2500 } },
      })),
    );
    render(<CancelBookingButton bookingId="bk_child" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => expect(screen.getByTestId("cancel-organiser-by-hand-refund-note")).toBeTruthy());
    expect(screen.getByTestId("cancel-organiser-by-hand-refund-note").textContent).toMatch(/to the group organiser directly/);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    });
    await waitFor(() => {
      expect(
        screen.getByText("The club will refund $25.00 to the group organiser directly, because the group organiser paid for this booking. You will receive a confirmation email shortly."),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/arrange your refund/i)).toBeNull();
  });

  it("keeps the member's own card refund wording when the refund is theirs", async () => {
    stubOrganiserFetch({ refundAmountCents: 2500, refundMethod: "card" });
    render(<CancelBookingButton bookingId="bk_own" />);
    await confirmCancel();

    await waitFor(() => {
      expect(
        screen.getByText("Your refund of $25.00 has been processed to your original payment method. You will receive a confirmation email shortly."),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/organiser/i)).toBeNull();
  });
});

// #4084: a cancel whose refund to the member's own card Stripe did not make
// (thrown and queued, or answered failed or canceled) says it is on its way, in
// the "Booking Cancelled" email's own words, as information; keyed off the
// cancel's `ownCardRefund` answer, never `refundMethod: "card"`.
describe("CancelBookingButton — an own-card refund not made yet (#4084)", () => {
  function stubOwnCardFetch(result: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (String(url).endsWith("/cancel-preview") ? previewBody : result),
      })),
    );
  }

  async function confirmCancel(buttonName: string) {
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm Cancellation" })).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm Cancellation" }));
    });
  }

  it.each([
    [
      "the member",
      false,
      "Cancel Booking",
      "A refund of $45.00 is on its way to your original payment method. You will receive a confirmation email shortly.",
    ],
    [
      "an officer on the member's behalf",
      true,
      "Cancel on behalf of member",
      "A refund of $45.00 is on its way to the member's original payment method. They will receive a confirmation email shortly.",
    ],
  ] as const)("tells %s the refund is on its way, as information", async (_label, onBehalfOfMember, buttonName, sentence) => {
    stubOwnCardFetch({ refundAmountCents: 4500, refundMethod: "card", ownCardRefund: { method: "card_pending", amountCents: 4500 } });
    render(<CancelBookingButton bookingId="bk_own" onBehalfOfMember={onBehalfOfMember} />);
    await confirmCancel(buttonName);

    await waitFor(() => {
      expect(screen.getByText(sentence)).toBeTruthy();
    });
    expect(screen.getByText(sentence).className).toContain("text-info-11");
    expect(screen.queryByText(/has been processed/i)).toBeNull();
  });

  it.each([
    [
      "the member",
      false,
      "Cancel Booking",
      "Your refund of $45.00 has been processed to your original payment method. You will receive a confirmation email shortly.",
    ],
    [
      "an officer on the member's behalf",
      true,
      "Cancel on behalf of member",
      "The refund of $45.00 has been processed to the member's original payment method. They will receive a confirmation email shortly.",
    ],
  ] as const)("keeps the made wording, byte-identical, for %s when Stripe made the refund", async (_label, onBehalfOfMember, buttonName, sentence) => {
    stubOwnCardFetch({ refundAmountCents: 4500, refundMethod: "card", ownCardRefund: { method: "card", amountCents: 4500 } });
    render(<CancelBookingButton bookingId="bk_own" onBehalfOfMember={onBehalfOfMember} />);
    await confirmCancel(buttonName);

    await waitFor(() => {
      expect(screen.getByText(sentence)).toBeTruthy();
    });
    expect(screen.getByText(sentence).className).toContain("text-success-11");
    expect(screen.queryByText(/on its way/i)).toBeNull();
  });

  // #4097 (`INV-PAY-129`): the card's own amount, and the part the card refund
  // plan could not carry, which the club refunds by bank transfer - as information.
  it.each([
    [
      "made, for the member",
      { method: "card", amountCents: 3000, byHandCents: 1500 },
      false,
      "Cancel Booking",
      "A refund of $30.00 has been processed to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer. You will receive a confirmation email shortly.",
    ],
    [
      "on its way, for an officer on the member's behalf",
      { method: "card_pending", amountCents: 3000, byHandCents: 1500 },
      true,
      "Cancel on behalf of member",
      "A refund of $30.00 is on its way to the member's original payment method, and the club will refund the remaining $15.00 to the member by bank transfer. They will receive a confirmation email shortly.",
    ],
    [
      "nothing on the card",
      { method: "card", amountCents: 0, byHandCents: 4500 },
      false,
      "Cancel Booking",
      "The club will refund $45.00 to you by bank transfer. You will receive a confirmation email shortly.",
    ],
    [
      "nothing on the card and nothing holding the rest",
      { method: "card", amountCents: 0, toCheckCents: 4500 },
      false,
      "Cancel Booking",
      "The club will be in touch about the $45.00 refund. You will receive a confirmation email shortly.",
    ],
    [
      "a bank part and a part to check, for an officer",
      { method: "card", amountCents: 3000, byHandCents: 500, toCheckCents: 1000 },
      true,
      "Cancel on behalf of member",
      "A refund of $30.00 has been processed to the member's original payment method; the club will refund $5.00 to the member by bank transfer and will be in touch about the remaining $10.00. They will receive a confirmation email shortly.",
    ],
  ] as const)("#4097: names the card's amount and the bank-transfer remainder (%s)", async (_label, ownCardRefund, onBehalfOfMember, buttonName, sentence) => {
    stubOwnCardFetch({ refundAmountCents: 4500, refundMethod: "card", ownCardRefund });
    render(<CancelBookingButton bookingId="bk_own" onBehalfOfMember={onBehalfOfMember} />);
    await confirmCancel(buttonName);

    await waitFor(() => {
      expect(screen.getByText(sentence)).toBeTruthy();
    });
    expect(screen.getByText(sentence).className).toContain("text-info-11");
    expect(screen.queryByText(/\$45\.00 has been processed/i)).toBeNull();
  });
});

// #3643 DECISION 2: a payment the app cannot credit is settled by hand.
describe("CancelBookingButton — a recorded payment settled by hand", () => {
  it("says the cancel treats the booking as unpaid and the treasurer settles the payment", async () => {
    stubPreviewFetch({ ...previewBody, hasPayment: false, paymentSettledByHand: true });
    render(<CancelBookingButton bookingId="bk_org" onBehalfOfMember />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel on behalf of member" }));
    await waitFor(() => {
      expect(screen.getByTestId("payment-settled-by-hand")).toBeTruthy();
    });
    expect(screen.queryByText(/No payment has been taken/)).toBeNull();
  });
});

// #4119 (`INV-PAY-131`): where the cancel's card refund plan is short, the
// preview's card line is the card's part, beside the bank-transfer part and the
// part the club will be in touch about, then the wording home's one sentence
// under the figures. The card option names where each part goes.
describe("CancelBookingButton — a card refund plan that cannot carry the whole refund (#4119)", () => {
  const cardShortfall = { cardCents: 3000, bankCents: 1000, checkCents: 500 };

  async function openPreview(props: { onBehalfOfMember?: boolean } = {}, body: Record<string, unknown> = { ...previewBody, cardShortfall }) {
    stubPreviewFetch(body);
    render(<CancelBookingButton bookingId="bk_short" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: props.onBehalfOfMember ? "Cancel on behalf of member" : "Cancel Booking" }));
    await waitFor(() => expect(screen.getByText("Choose refund method:")).toBeTruthy());
  }

  function row(label: string): string | null {
    return screen.queryByText(label)?.nextElementSibling?.textContent ?? null;
  }

  it("quotes the card only its part, and names the rest by part", async () => {
    const { ownCardRefundWithShortfallSentence } = await import("@/lib/booking-modified-email-copy");
    await openPreview();
    expect([row("Refund to card:"), row("Refund by bank transfer:"), row("To be confirmed by the club:")]).toEqual(["$30.00", "$10.00", "$5.00"]);
    const sentence = screen.getByTestId("cancel-preview-card-shortfall");
    expect(sentence.textContent).toBe(
      ownCardRefundWithShortfallSentence(3000, { bankCents: 1000, checkCents: 500, formatAmount: (cents) => `$${(cents / 100).toFixed(2)}` }, "planned"),
    );
    // The sentence sits under the figures, not among them.
    expect(sentence.parentElement?.contains(screen.getByText("To be confirmed by the club:"))).toBe(true);
    expect(screen.getByText("To be confirmed by the club:").closest("div.border-t")?.contains(sentence)).toBe(false);
    // The card option names each part's destination, and promises nothing of the part to check.
    expect(screen.getByText("Refund $30.00 to original payment method and $10.00 by bank transfer")).toBeTruthy();
    expect(screen.queryByText(/Refund \$45\.00/)).toBeNull();
  });

  it("leaves a part out when it is nothing, and frames the sentence for the member when an officer cancels", async () => {
    await openPreview({ onBehalfOfMember: true }, { ...previewBody, cardShortfall: { cardCents: 3500, bankCents: 1000, checkCents: 0 } });
    expect(row("The club will be in touch about:")).toBeNull();
    expect(screen.getByTestId("cancel-preview-card-shortfall").textContent).toBe(
      "A refund of $35.00 will be processed to the member's original payment method, and the club will refund the remaining $10.00 to the member by bank transfer.",
    );
  });

  it.each([
    { split: { cardCents: 4000, bankCents: 0, checkCents: 500 }, label: "Refund $40.00 to original payment method" },
    { split: { cardCents: 0, bankCents: 4500, checkCents: 0 }, label: "Refund $45.00 by bank transfer" },
    { split: { cardCents: 0, bankCents: 0, checkCents: 4500 }, label: "Refund: the club will be in touch" },
  ])("labels the card option by its parts: $label", async ({ split, label }) => {
    await openPreview({}, { ...previewBody, cardShortfall: split });
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("is the card option's line only: account credit is quoted whole", async () => {
    await openPreview();
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(row("Credit to account:")).toBe("$50.00");
    expect(screen.queryByTestId("cancel-preview-card-shortfall")).toBeNull();
    expect(row("Refund to card:")).toBeNull();
  });

  it("keeps the whole refund on the card when the plan carries it", async () => {
    await openPreview({}, previewBody);
    expect(row("Refund to card:")).toBe("$45.00");
    expect(screen.queryByTestId("cancel-preview-card-shortfall")).toBeNull();
    expect(screen.getByText("Refund $45.00 to original payment method")).toBeTruthy();
  });
});
