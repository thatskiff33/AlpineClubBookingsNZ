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

  const hiddenPageSettings = {
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

  // #3852: the button hidden, the saved page target later hidden. The route
  // rejects that target on every save, so the controls that fix it must be on
  // screen, the failure must say which setting is wrong and stay on screen, and
  // the repair must survive the click that makes it.
  it("keeps the Book Now controls through the repair, shows the server's reason inline, and saves BOOKING_FLOW", async () => {
    access.canEdit = true;
    const puts: Array<Record<string, unknown>> = [];
    let failNext = true;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return new Response(JSON.stringify({ settings: hiddenPageSettings, pages: [] }));
      const sent = JSON.parse(String(init.body));
      puts.push(sent);
      if (failNext) {
        failNext = false;
        return new Response(JSON.stringify({ error: "The selected Book Now page is not published." }), { status: 400 });
      }
      return new Response(JSON.stringify({ settings: { ...sent, bookNowPageId: null } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicContentSettingsPanel />);

    await screen.findByRole("radio", { name: "Go to the booking flow" });
    expect(screen.getByRole("radio", { name: "Go to a content page" })).toBeTruthy();
    // The saved page is not in the published list: say so rather than show a blank choice.
    expect(screen.getByRole("option", { name: "The saved page is unpublished or deleted" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    await waitFor(() =>
      expect(access.toastError).toHaveBeenCalledWith("The selected Book Now page is not published."),
    );
    expect((await screen.findByRole("alert")).textContent).toBe("The selected Book Now page is not published.");

    // The repair is one click away, the controls stay until it is saved, and the
    // stale error clears on the edit.
    fireEvent.click(screen.getByRole("radio", { name: "Go to the booking flow" }));
    const bookingFlow = screen.getByRole("radio", { name: "Go to the booking flow" }) as HTMLInputElement;
    expect(bookingFlow.checked).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save visibility" }));
    await waitFor(() => expect(access.toastSuccess).toHaveBeenCalled());
    expect(puts).toHaveLength(2);
    expect(puts[1]).toMatchObject({ bookNowTarget: "BOOKING_FLOW" });
    // Saved: the target is now the booking flow and the button is hidden, so the controls go.
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Go to the booking flow" })).toBeNull());
  });

  it("points the disabled Book Now controls at the view-only explanation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ settings: { ...hiddenPageSettings, showBookNow: true }, pages: [{ id: "hidden-page", title: "Book", path: "/book" }] }))));
    render(<PublicContentSettingsPanel />);

    const notice = await screen.findByText(/Content view access can inspect public visibility/);
    for (const control of [
      screen.getByRole("radio", { name: "Go to the booking flow" }),
      screen.getByRole("radio", { name: "Go to a content page" }),
      screen.getByRole("combobox", { name: "Book Now page" }),
    ]) {
      expect((control as HTMLInputElement).disabled).toBe(true);
      const region = document.getElementById(String(control.getAttribute("aria-describedby")));
      expect(region?.contains(notice)).toBe(true);
    }
  });
});
