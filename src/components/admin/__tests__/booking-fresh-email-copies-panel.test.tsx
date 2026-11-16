// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingFreshEmailCopiesPanel } from "../booking-fresh-email-copies-panel";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, confirmDialog: null }),
}));

const options = [{ template: "booking-confirmed" as const, unavailableReason: null, unarchivedFailureCount: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.confirm.mockResolvedValue(true);
});

describe("booking fresh email copies panel", () => {
  it("explains view access and disables the send", () => {
    render(<BookingFreshEmailCopiesPanel bookingId="booking-1" options={options} canEdit={false} />);
    expect(screen.getByRole("button", { name: "Send fresh confirmation" })).toBeDisabled();
    expect(screen.getByText(/Bookings edit access is required/)).toBeInTheDocument();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("explains an unavailable workflow and disables its action", () => {
    render(<BookingFreshEmailCopiesPanel bookingId="booking-1" options={[
      { ...options[0]!, unavailableReason: "This booking has been deleted." },
    ]} canEdit />);
    expect(screen.getByRole("button", { name: "Send fresh confirmation" })).toBeDisabled();
    expect(screen.getByText(/Not available: This booking has been deleted/)).toBeInTheDocument();
  });

  it("does not send when the officer cancels confirmation", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<BookingFreshEmailCopiesPanel bookingId="booking-1" options={options} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Send fresh confirmation" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("posts only the template, then reports the recipient and archive result", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ sentTo: "owner@example.org", archivedFailureCount: 1 }) });
    render(<BookingFreshEmailCopiesPanel bookingId="booking-1" options={options} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Send fresh confirmation" }));
    expect(await screen.findByText("Sent to owner@example.org. 1 earlier failed copy was archived.")).toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledWith("/api/admin/bookings/booking-1/fresh-email-copy", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template: "booking-confirmed" }),
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("shows a withheld send as a failure and does not refresh", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'This booking has the "No emails" switch turned on, so nothing was sent.' }) });
    render(<BookingFreshEmailCopiesPanel bookingId="booking-1" options={options} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Send fresh confirmation" }));
    expect(await screen.findByText(/nothing was sent/)).not.toHaveTextContent("Sent to");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send fresh confirmation" })).toBeEnabled();
  });
});
