// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  canEdit: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => harness.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

// Mocked so the messages this panel shows can be asserted. Safe to do file-wide:
// this file renders only this panel.
vi.mock("sonner", () => ({
  toast: { success: harness.toastSuccess, error: harness.toastError },
}));

import { PublicContentSettingsPanel } from "@/components/admin/public-content-settings-panel";
import { PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT } from "@/lib/public-content-settings-events";

const SETTINGS = {
  membershipTypes: false,
  entranceFees: false,
  hutFees: false,
  bookingPolicySummary: false,
  cancellationPolicy: false,
  annualFees: false,
  showBookNow: true,
  bookNowTarget: "BOOKING_FLOW" as const,
  bookNowPageId: null as string | null,
  committeePhotoDisplay: "NONE" as const,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PublicContentSettingsPanel", () => {
  beforeEach(() => {
    harness.canEdit = false;
    harness.toastSuccess.mockReset();
    harness.toastError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  /*
    #2352, second review finding S2. This panel posts its WHOLE settings object,
    and the route rejects a stale Book Now pair with a specific 400 — but the panel
    threw the body away (`if (!response.ok) throw new Error();`) and showed one
    generic line, so an officer whose save was refused because of a Book Now target
    was told nothing about which control to fix and every retry failed identically.
  */
  it("shows the server's reason when a save is refused", async () => {
    harness.canEdit = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? jsonResponse({ settings: SETTINGS, pages: [] })
          : jsonResponse(
              { error: "The selected Book Now page is not published." },
              400,
            ),
      ),
    );
    render(<PublicContentSettingsPanel />);

    const save = await screen.findByRole("button", { name: "Save visibility" });
    fireEvent.click(save);

    await waitFor(() => {
      expect(harness.toastError).toHaveBeenCalledWith(
        "The selected Book Now page is not published.",
      );
    });
    expect(harness.toastSuccess).not.toHaveBeenCalled();
  });

  it("falls back to the generic message when the failure carries no reason", async () => {
    harness.canEdit = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? jsonResponse({ settings: SETTINGS, pages: [] })
          : new Response("gateway timeout", { status: 504 }),
      ),
    );
    render(<PublicContentSettingsPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Save visibility" }),
    );

    await waitFor(() => {
      expect(harness.toastError).toHaveBeenCalledWith(
        "Could not update public content visibility.",
      );
    });
  });

  /*
    #2352, second review finding S2. Deleting the Book Now target page moves the
    stored setting back to the booking flow inside the delete's own transaction.
    This panel is a sibling of the one that fires the delete, loaded once on mount
    and never again — so it went on holding the deleted page's id, and its next
    save was refused, repeatably, until the officer reloaded the browser.
  */
  it("reloads when a sibling panel changes the stored settings", async () => {
    harness.canEdit = true;
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        settings: { ...SETTINGS, hutFees: fetchMock.mock.calls.length > 1 },
        pages: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicContentSettingsPanel />);

    const hutFees = await screen.findByRole("checkbox", { name: "Hut fees" });
    expect((hutFees as HTMLInputElement).checked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event(PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT));
    });

    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox", { name: "Hut fees" }) as HTMLInputElement)
          .checked,
      ).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /*
    #2352, second review finding S2, the second arm. `save()` posts
    `bookNowTarget` whether or not the radios are rendered, and the route validates
    it without consulting `showBookNow` — so a club with the button hidden and a
    stored PAGE target whose page had been unpublished could not save ANYTHING in
    this panel and had no control on the screen to repair the setting the route was
    rejecting.
  */
  it("keeps the Book Now target controls reachable when the button is hidden", async () => {
    harness.canEdit = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          settings: {
            ...SETTINGS,
            showBookNow: false,
            bookNowTarget: "PAGE",
            bookNowPageId: "p1",
          },
          pages: [{ id: "p1", title: "Trip Reports", path: "/trip-reports" }],
        }),
      ),
    );
    render(<PublicContentSettingsPanel />);

    expect(
      await screen.findByRole("radio", { name: "Go to the booking flow" }),
    ).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Go to a content page" })).toBeChecked();
    expect(
      screen.getByText(/The button is hidden, but a page target is still saved/),
    ).toBeInTheDocument();
  });

  it("renders no target controls when the button is off and the target is the booking flow", async () => {
    harness.canEdit = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ settings: { ...SETTINGS, showBookNow: false }, pages: [] }),
      ),
    );
    render(<PublicContentSettingsPanel />);

    await screen.findByRole("checkbox", { name: "Show the Book Now button" });
    expect(
      screen.queryByRole("radio", { name: "Go to a content page" }),
    ).not.toBeInTheDocument();
  });
});
