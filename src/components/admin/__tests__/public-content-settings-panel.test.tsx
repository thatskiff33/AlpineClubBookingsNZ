// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const access = vi.hoisted(() => ({ canEdit: false, toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => access.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));
vi.mock("sonner", () => ({ toast: { error: access.toastError, success: access.toastSuccess } }));

import { PublicContentSettingsPanel } from "@/components/admin/public-content-settings-panel";

describe("PublicContentSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    access.canEdit = false;
    access.toastError.mockClear();
    access.toastSuccess.mockClear();
  });

  it("gives view-only users a visible and ARIA-associated explanation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ settings: {
      membershipTypes: false,
      entranceFees: false,
      hutFees: false,
      bookingPolicySummary: false,
      cancellationPolicy: false,
      annualFees: false,
    } }))));
    render(<PublicContentSettingsPanel />);

    const notice = await screen.findByText(/Content view access can inspect public visibility/);
    // "Annual membership fees" is the new dedicated {{annual-fees}} opt-in (#1933, E7).
    const checkbox = screen.getByRole("checkbox", { name: "Annual membership fees" });
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    // #2160: the reason moved into `AdminViewOnlySectionBanner`, so the notice
    // text now sits several levels below the id-carrying wrapper (banner box →
    // role="status" → wrapper) rather than directly inside it. The association
    // that matters is unchanged and is asserted directly: the element the
    // checkbox points at is the one that CONTAINS the explanation.
    const describedBy = checkbox.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reasonRegion = document.getElementById(String(describedBy));
    expect(reasonRegion).not.toBeNull();
    expect(reasonRegion?.contains(notice)).toBe(true);
    expect((screen.getByRole("button", { name: "Save visibility" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // #3852: the button hidden, the saved page target later hidden. The route
  // rejects that target on every save, so the controls that fix it must be on
  // screen, and the failure must say which setting is wrong.
  it("keeps the Book Now target controls reachable and shows the server's reason", async () => {
    access.canEdit = true;
    const settings = {
      membershipTypes: false,
      entranceFees: false,
      hutFees: false,
      bookingPolicySummary: false,
      cancellationPolicy: false,
      annualFees: false,
      showBookNow: false,
      bookNowTarget: "PAGE",
      bookNowPageId: "hidden-page",
      committeePhotoDisplay: "NONE",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ error: "The selected Book Now page is not published." }), { status: 400 })
        : new Response(JSON.stringify({ settings, pages: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicContentSettingsPanel />);

    const bookingFlow = await screen.findByRole("radio", { name: "Go to the booking flow" });
    expect(screen.getByRole("radio", { name: "Go to a content page" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    await waitFor(() =>
      expect(access.toastError).toHaveBeenCalledWith("The selected Book Now page is not published."),
    );

    // …and the repair is one click away.
    fireEvent.click(bookingFlow);
    expect((bookingFlow as HTMLInputElement).checked).toBe(true);
  });
});
