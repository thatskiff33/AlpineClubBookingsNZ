// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #4956: the unexpired email-change link is named under the current address,
// and a successful request refreshes the route so the notice names the new one.
const { refresh, toast } = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast }));

import { ChangeEmailForm } from "@/app/(authenticated)/profile/change-email-form";

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe("ChangeEmailForm", () => {
  it("names the pending address and the link's expiry", () => {
    render(
      <ChangeEmailForm
        currentEmail="old@example.test"
        pendingChange={{
          newEmail: "new@example.test",
          expiresOn: "1 Jul 2026, 12:30 pm",
        }}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe(
      "A change to new@example.test is waiting for you to click the link we sent. The link expires 1 Jul 2026, 12:30 pm. Requesting again replaces it.",
    );
  });

  it("shows no pending line without a pending change", () => {
    render(<ChangeEmailForm currentEmail="old@example.test" />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refreshes the server state after a successful request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    render(<ChangeEmailForm currentEmail="old@example.test" />);

    fireEvent.change(screen.getByLabelText("New Email"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /request email change/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("does not refresh when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "This email is already in use" }), {
        status: 409,
      }),
    );
    render(<ChangeEmailForm currentEmail="old@example.test" />);

    fireEvent.change(screen.getByLabelText("New Email"), {
      target: { value: "taken@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /request email change/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This email is already in use"),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
