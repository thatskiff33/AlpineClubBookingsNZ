// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

    expect(screen.getByRole("status").textContent).toContain(
      "You asked for your account to be deleted on 29 Jun 2026.",
    );
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
      expect(screen.getByRole("status").textContent).toContain(
        "Your deletion request has been submitted.",
      ),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
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
