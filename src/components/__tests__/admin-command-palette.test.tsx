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

  it("groups by hub, in menu order (S2 #4797)", async () => {
    renderPalette();
    pressCtrlK();
    await screen.findByPlaceholderText("Search admin features…");

    // cmdk portals the dialog to document.body; read the group headings there.
    const headings = Array.from(
      document.body.querySelectorAll("[cmdk-group-heading]"),
    ).map((el) => el.textContent);

    // The hub registry's order. The queue views are listed after every page in
    // the index; they must still land in Bookings, not in a group of their own.
    expect(headings).toEqual([
      "Home",
      "Bookings",
      "Fees & booking rules",
      "Finance",
      "Members",
      "Lodge",
      "Website",
      "Messages & email",
      "Help & system",
      "Club settings",
    ]);
  });

  it("offers a page the sidebar does not link (S2 #4797)", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    fireEvent.change(input, { target: { value: "Chores" } });
    // Clicked, not Enter: cmdk 1.1.1 never reorders groups by score, so the
    // first fuzzy match in hub order is the one Enter would open.
    fireEvent.click(await screen.findByRole("option", { name: /^Chores/ }));

    expect(pushMock).toHaveBeenCalledWith("/admin/chores");
  });

  it("opens a retired page's name on the tab that holds it (S2 #4797)", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    fireEvent.change(input, { target: { value: "Family Suggestions" } });
    fireEvent.click(await screen.findByRole("option", { name: /^Family Suggestions/ }));

    expect(pushMock).toHaveBeenCalledWith("/admin/family-groups?tab=suggestions");
  });

  it("still finds pages by their old sidebar section name", async () => {
    renderPalette();
    pressCtrlK();

    const input = await screen.findByPlaceholderText("Search admin features…");
    fireEvent.change(input, { target: { value: "Setup & Configuration" } });
    await waitFor(() => expect(screen.getByRole("option", { name: /^Modules/ })).not.toBeNull());
    expect(screen.getByRole("option", { name: /^Access Roles/ })).not.toBeNull();
  });

  it("groups Lobby Display under Lodge with no duplicate", async () => {
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
    ).toBe("Lodge");
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
    // Bookings-only, non-full-admin.
    renderPalette(matrix({ bookings: "view" }), false);
    pressCtrlK();

    await screen.findByPlaceholderText("Search admin features…");

    // A bookings page is offered…
    expect(screen.getByRole("option", { name: /^Bookings$/ })).not.toBeNull();
    // …but membership and fullAdminOnly pages are absent from the palette DOM.
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("Export & Import")).toBeNull();
    expect(screen.queryByText("Access Roles")).toBeNull();
  });
});
