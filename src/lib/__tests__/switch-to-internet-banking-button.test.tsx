// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component does a hard window.location.reload() on success (deterministic
// server re-render, #1148 / #1371) rather than a soft router.refresh(), so the
// test stubs location.reload instead of the router.
const reloadMock = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  reloadMock.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";

describe("SwitchToInternetBankingButton", () => {
  it("opens confirmation without posting, and cancel keeps the card choice usable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SwitchToInternetBankingButton bookingId="abcd1234-booking" />);

    const button = screen.getByRole("button", { name: "Pay by internet banking instead" });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Switch to internet banking?" });
    expect(within(dialog).getByText(/can't switch back to paying by card/)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep paying by card" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the club's whole-lodge confirmation wording", async () => {
    const description = "Your whole-lodge booking stays confirmed while the payment is outstanding.";
    render(<SwitchToInternetBankingButton bookingId="whole-lodge" confirmDescription={description} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay by internet banking instead" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to internet banking?" });
    expect(within(dialog).getByText(description)).toBeVisible();
  });

  it("posts the booking id and reloads on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reference: "BOOKING-ABCD1234" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SwitchToInternetBankingButton bookingId="abcd1234-booking" />);

    fireEvent.click(
      screen.getByRole("button", { name: /Pay by internet banking instead/ })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Switch to internet banking?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch to internet banking" }));

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Switching..." })).toBeDisabled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("/api/payments/switch-to-internet-banking");
    expect(JSON.parse(init.body)).toEqual({ bookingId: "abcd1234-booking" });
  });

  it("surfaces the API error and does not reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Internet Banking payments are not available." }),
      }))
    );

    render(<SwitchToInternetBankingButton bookingId="abcd1234-booking" />);

    fireEvent.click(
      screen.getByRole("button", { name: /Pay by internet banking instead/ })
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch to internet banking" }));

    expect(
      await screen.findByText(/Internet Banking payments are not available./)
    ).toBeDefined();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pay by internet banking instead" })).toBeEnabled();
  });
});
