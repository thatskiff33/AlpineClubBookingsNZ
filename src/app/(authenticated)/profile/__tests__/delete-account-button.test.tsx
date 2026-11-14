// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { expectToHoldFocus } from "@/lib/__tests__/helpers/focus";

// #4956: an open deletion request read by the server replaces the button with a
// lasting notice; a fresh submission refreshes the route so that notice takes
// over from the in-page confirmation.
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { DeleteAccountButton } from "@/app/(authenticated)/profile/delete-account-button";

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockClear();
});

describe("DeleteAccountButton", () => {
  it("shows the dated notice and no button while a request is open", () => {
    render(<DeleteAccountButton pendingRequest={{ requestedOn: "29 Jun 2026" }} />);

    // An admin can reject without emailing the member, so the notice must not
    // promise an email; and it is static content, not a live region (the
    // `submitted` confirmation is the one announced).
    expect(
      screen.getByText(
        "You asked for your account to be deleted on 29 Jun 2026. An admin will review it and may contact you by email.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /request account deletion/i }),
    ).toBeNull();
  });

  it("confirms a new request in place and refreshes the server state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 201 }),
    );
    render(<DeleteAccountButton pendingRequest={null} />);

    fireEvent.click(screen.getByRole("button", { name: /request account deletion/i }));
    fireEvent.click(screen.getByRole("button", { name: /submit deletion request/i }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Your deletion request has been submitted. An admin will review it and may contact you by email.",
      ),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #4949 with #4956: the refresh brings the open request in while the member's
  // focus is on the confirmation. The confirmation stays the one live region, its
  // text unchanged and its node kept, so nothing is announced twice and focus is
  // not dropped on the page.
  it("keeps the one announced confirmation, and its focus, when the refresh brings the open request in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 201 }),
    );
    const { rerender } = render(<DeleteAccountButton pendingRequest={null} />);

    const trigger = screen.getByRole("button", { name: /request account deletion/i });
    trigger.focus();
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /submit deletion request/i }));
    });

    const confirmation =
      "Your deletion request has been submitted. An admin will review it and may contact you by email.";
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(confirmation);
    await expectToHoldFocus(status, "the confirmation");

    // What `router.refresh()` does: the page passes the request it just read.
    rerender(<DeleteAccountButton pendingRequest={{ requestedOn: "29 Jun 2026" }} />);

    expect(screen.getAllByRole("status")).toEqual([status]);
    expect(status.textContent).toBe(confirmation);
    expect(screen.queryByText(/You asked for your account to be deleted/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /request account deletion/i }),
    ).toBeNull();
    await expectToHoldFocus(status, "the confirmation");
  });

  it("does not refresh when the server refuses the request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "You already have a pending deletion request" }),
        { status: 409 },
      ),
    );
    render(<DeleteAccountButton />);

    fireEvent.click(screen.getByRole("button", { name: /request account deletion/i }));
    fireEvent.click(screen.getByRole("button", { name: /submit deletion request/i }));

    await waitFor(() =>
      expect(
        screen.getByText("You already have a pending deletion request"),
      ).toBeTruthy(),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
