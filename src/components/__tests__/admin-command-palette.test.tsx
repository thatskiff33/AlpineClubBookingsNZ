// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { AdminCommandPalette } from "@/components/admin-command-palette";
import { openAdminCommandPalette } from "@/lib/admin-command-palette-events";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function matrix(
  over: Partial<Record<keyof AdminPermissionMatrix, "none" | "view" | "edit">>,
): AdminPermissionMatrix {
  return {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...over,
  };
}

const fullMatrix = matrix({
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
});

function renderPalette(
  permissionMatrix: AdminPermissionMatrix = fullMatrix,
  isFullAdmin = true,
) {
  return render(
    <AdminCommandPalette
      features={allOn}
      permissionMatrix={permissionMatrix}
      isFullAdmin={isFullAdmin}
    />,
  );
}

function pressCtrlK() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
}

describe("AdminCommandPalette", () => {
  beforeEach(() => {
    pushMock.mockReset();
    // cmdk scrolls the active item into view; jsdom has no layout engine.
    Element.prototype.scrollIntoView = vi.fn();
    // cmdk observes its list size; jsdom ships no ResizeObserver.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("opens on Ctrl/Cmd-K and exposes a searchable combobox", async () => {
    renderPalette();

    expect(screen.queryByPlaceholderText("Search admin features…")).toBeNull();

    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    expect(input).not.toBeNull();
    // cmdk gives the input combobox semantics and an associated listbox.
    expect(input.getAttribute("role")).toBe("combobox");
    expect(screen.getByRole("listbox")).not.toBeNull();
  });

  it("opens from the shared window event (the sidebar button path)", async () => {
    renderPalette();

    openAdminCommandPalette();

    expect(
      await screen.findByPlaceholderText("Search admin features…"),
    ).not.toBeNull();
  });

  it("filters as you type, and Enter navigates to the selected page", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    fireEvent.change(input, { target: { value: "Payments" } });

    await waitFor(() =>
      expect(screen.getByText("Payments")).not.toBeNull(),
    );

    fireEvent.keyDown(input, { key: "Enter" });

    expect(pushMock).toHaveBeenCalledWith("/admin/payments");
  });

  it("navigates with arrow-key selection then Enter", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    // "xero" filters to the two Xero pages; arrow down moves off the first.
    fireEvent.change(input, { target: { value: "xero" } });

    await waitFor(() =>
      expect(screen.getByText("Xero Sync")).not.toBeNull(),
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toMatch(/^\/admin\/xero/);
  });

  it("matches keyword synonyms that are not in the label", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    // "accounting" is a keyword on Xero Sync, not part of its label.
    fireEvent.change(input, { target: { value: "accounting" } });

    await waitFor(() =>
      expect(screen.getByText("Xero Sync")).not.toBeNull(),
    );
  });

  it("closes on Escape and restores focus to the previously focused element", async () => {
    renderPalette();

    const opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    openAdminCommandPalette();
    const input = await screen.findByPlaceholderText("Search admin features…");
    // Focus moved into the dialog.
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search admin features…")).toBeNull(),
    );
    // Radix restores focus to the element that had it before open.
    await waitFor(() => expect(document.activeElement).toBe(opener));

    opener.remove();
  });

  it("orders groups by canonical sidebar section order, not dedup insertion order", async () => {
    renderPalette();
    pressCtrlK();
    await screen.findByPlaceholderText("Search admin features…");

    // cmdk portals the dialog to document.body; read the group headings there.
    const headings = Array.from(
      document.body.querySelectorAll("[cmdk-group-heading]"),
    ).map((el) => el.textContent);

    // Matches the sidebar's buildAdminNavSections order. Regression guard:
    // the de-dup keys "Bookings & Beds" pages first under "Needs Attention",
    // which must not drag that group ahead of "Needs Attention".
    expect(headings).toEqual([
      "General",
      "Needs Attention",
      "Bookings & Beds",
      "Rates & Policies",
      "Finance",
      "Members",
      "Lodge Operations",
      "Monitoring & Support",
      "Setup & Configuration",
    ]);
  });

  it("groups Lobby Display under Lodge Operations with no duplicate", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    fireEvent.change(input, { target: { value: "Lobby Display" } });

    const matches = await screen.findAllByText("Lobby Display");
    expect(matches).toHaveLength(1);
    expect(
      matches[0]
        .closest("[cmdk-group]")
        ?.querySelector("[cmdk-group-heading]")?.textContent,
    ).toBe("Lodge Operations");
  });

  it("does not restore focus to the opener when a selection navigates away", async () => {
    renderPalette();

    const opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();

    openAdminCommandPalette();
    const input = await screen.findByPlaceholderText("Search admin features…");
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: "Payments" } });
    await waitFor(() => expect(screen.getByText("Payments")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Search admin features…"),
      ).toBeNull(),
    );
    expect(pushMock).toHaveBeenCalledWith("/admin/payments");
    // Focus is NOT bounced back to the opener — the destination page takes it.
    // (Only an Escape/overlay dismiss restores focus; see the test above.)
    expect(document.activeElement).not.toBe(opener);

    opener.remove();
  });

  it("never reveals an href the admin cannot access (interaction path)", async () => {
    // Bookings-only, non-full-admin: same filter as getVisibleAdminNavSections.
    renderPalette(matrix({ bookings: "view" }), false);
    pressCtrlK();

    await screen.findByPlaceholderText("Search admin features…");

    // A bookings page is offered…
    expect(screen.getByText("Bookings")).not.toBeNull();
    // …but membership and fullAdminOnly pages are absent from the palette DOM.
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("Export & Import")).toBeNull();
    expect(screen.queryByText("Access Roles")).toBeNull();
  });
});
