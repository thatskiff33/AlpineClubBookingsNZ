// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
const h = vi.hoisted(() => ({ edit: undefined as boolean | undefined, refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({ ADMIN_VIEW_ONLY_ACTION_REASON: "View only", useAdminAreaEditAccess: () => h.edit, useAdminAreaViewAccess: () => true }));
vi.mock("@/components/admin/admin-booking-tools-card", () => ({ AdminBookingToolsCard: () => <div>Booking edit tools</div> }));
vi.mock("@/components/admin/booking-withheld-emails-banner", () => ({ BookingWithheldEmailsBanner: () => null }));
vi.mock("@/lib/booking-payment-state", () => ({ savedCardChargeCents: () => 0 }));
import { XeroSyncNowButton } from "@/components/admin/xero-sync-now-button";
import { BookingAdminToolsSection } from "@/app/(authenticated)/bookings/[id]/_components/booking-admin-tools-section";

describe("Xero sync-now controls", () => {
  beforeEach(() => { h.edit = true; vi.stubGlobal("fetch", h.fetch); });
  it.each([false, undefined])("keeps the action disabled for permission state %s", (edit) => {
    h.edit = edit;
    render(<XeroSyncNowButton target={{ scope: "member", id: "member" }} />);
    expect(screen.getByRole("button", { name: "Sync from Xero now" })).toBeDisabled();
    if (edit === false) expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent("Finance edit access");
    else expect(screen.getByTestId("admin-view-only-banner")).toBeEmptyDOMElement();
  });
  it("shows the returned summary, refreshes data, and prevents duplicate clicks", async () => {
    let complete!: (response: Response) => void;
    h.fetch.mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
    const onSynced = vi.fn();
    render(<XeroSyncNowButton target={{ scope: "booking", id: "booking" }} onSynced={onSynced} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync from Xero now" }));
    expect(screen.getByRole("button", { name: "Syncing from Xero…" })).toBeDisabled();
    complete(new Response(JSON.stringify({ message: "Already in step." })));
    expect(await screen.findByText("Already in step.")).toBeVisible();
    await waitFor(() => expect(onSynced).toHaveBeenCalledOnce());
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.refresh).toHaveBeenCalledOnce();
  });
  it("shows rate-limit errors without refreshing or claiming success", async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "Try again shortly." }), { status: 429 }));
    render(<XeroSyncNowButton target={{ scope: "club" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync everything from Xero now" }));
    expect(await screen.findByText("Try again shortly.")).toBeVisible();
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each([false, true])("shows booking sync with finance edit=%s and no booking edit tools", (edit) => {
    h.edit = edit;
    // Only the finance control renders; operational tools and their reads stay gated.
    const props = {
      booking: { id: "booking" }, editorData: {}, modules: { xeroIntegration: true },
      viewer: { canSeeAdminTools: false }, access: { isDeleted: false }, adminTools: {}, payment: { savedCard: null },
    } as ComponentProps<typeof BookingAdminToolsSection>;
    render(<BookingAdminToolsSection {...props} />);
    expect(screen.queryByText("Booking edit tools")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync from Xero now" })).toHaveProperty("disabled", !edit);
  });
});
