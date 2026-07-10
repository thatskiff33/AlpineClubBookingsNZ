// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("CancelBookingButton — admin notify choice (#1705)", () => {
  function stubCapturingFetch(
    calls: Array<{ url: string; init?: RequestInit }>,
    body: Record<string, unknown> = previewBody,
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => body };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
  }

  function cancelCall(calls: Array<{ url: string; init?: RequestInit }>) {
    return calls.find(
      (c) => c.url.includes("/cancel") && !c.url.includes("cancel-preview"),
    );
  }

  it("offers both email choices and posts notifyMember:false without emailing", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubCapturingFetch(calls);
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Cancel without emailing" }),
      ).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancel and email member" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel without emailing" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No cancellation email was sent to the member/i),
      ).toBeTruthy();
    });
    const call = cancelCall(calls);
    expect(call).toBeTruthy();
    expect(JSON.parse(call!.init!.body as string)).toMatchObject({
      notifyMember: false,
    });
  });

  it("posts notifyMember:true when the admin chooses to email", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubCapturingFetch(calls);
    render(<CancelBookingButton bookingId="bk_1" onBehalfOfMember />);

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel on behalf of member" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Cancel and email member" }),
      ).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel and email member" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/They will receive a confirmation email shortly/i),
      ).toBeTruthy();
    });
    const call = cancelCall(calls);
    expect(JSON.parse(call!.init!.body as string)).toMatchObject({
      notifyMember: true,
    });
  });

  it("member self-cancel has a single confirm and never sends notifyMember", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubCapturingFetch(calls);
    render(<CancelBookingButton bookingId="bk_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Booking" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm Cancellation" }),
      ).toBeTruthy();
    });
    // No email-choice buttons in the member self-cancel flow.
    expect(
      screen.queryByRole("button", { name: "Cancel without emailing" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm Cancellation" }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/You will receive a confirmation email shortly/i),
      ).toBeTruthy();
    });
    const call = cancelCall(calls);
    const parsed = JSON.parse(call!.init!.body as string);
    expect(parsed.notifyMember).toBeUndefined();
    expect(parsed.refundMethod).toBe("card");
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
