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
