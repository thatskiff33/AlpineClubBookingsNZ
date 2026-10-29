// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
const h = vi.hoisted(() => ({ edit: true as boolean | undefined, fetch: vi.fn() }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({ ADMIN_VIEW_ONLY_ACTION_REASON: "View only", useAdminAreaEditAccess: () => h.edit, useAdminAreaViewAccess: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { WebhookHealthPanel } from "../webhook-health-panel";
const health = { connected: true, silent: true, hours: 24, lastReceivedAt: "2026-06-29T23:59:59.999Z" };
const response = (value: unknown) => new Response(JSON.stringify(value));
describe("webhook health settings", () => {
  beforeEach(() => { h.edit = true; vi.stubGlobal("fetch", h.fetch); h.fetch.mockImplementation(async () => response(health)); });
  it("shows the receipt and warning, and stages changes until Save", async () => {
    render(<WebhookHealthPanel />);
    const hours = await screen.findByLabelText("Warn after hours without a webhook");
    expect(hours).toBeDisabled();
    expect(screen.getByText(/No Xero webhook has arrived/)).toBeVisible();
    expect(document.querySelector("time")).toHaveAttribute("datetime", health.lastReceivedAt);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(hours, { target: { value: "48" } });
    expect(h.fetch).toHaveBeenCalledOnce();
    h.fetch.mockResolvedValueOnce(response({ ...health, hours: 48, silent: false }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    expect(h.fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ hours: 48 }) });
    expect(await screen.findByText("Webhook warning threshold saved.")).toBeVisible();
    expect(screen.queryByText(/No Xero webhook has arrived/)).toBeNull();
  });
  it("Cancel restores the saved value without a write", async () => {
    render(<WebhookHealthPanel />);
    const hours = await screen.findByLabelText("Warn after hours without a webhook");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(hours, { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hours).toHaveValue(24); expect(hours).toBeDisabled(); expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("view-only finance users see disabled Edit and whole-club sync", async () => {
    h.edit = false;
    render(<WebhookHealthPanel />);
    expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sync everything from Xero now" })).toBeDisabled();
  });
});
