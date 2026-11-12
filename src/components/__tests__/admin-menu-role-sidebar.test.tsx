// @vitest-environment jsdom

/**
 * The sidebar's role switcher (C14 #4811), in both states.
 *
 * Omitted menu props are today's sidebar. Passed hub keys replace that list
 * with one link per hub, and the switcher appears only for an officer who
 * holds two or more menu roles and is not a Full Admin.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import type { AdminMenuRoleChoice } from "@/lib/admin-menu-role";

const nav = vi.hoisted(() => ({
  refresh: vi.fn(),
  pathname: "/admin/dashboard",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn() }),
}));

import { AdminSidebar } from "@/components/admin-sidebar";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

const fullMatrix: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

const twoRoles: readonly AdminMenuRoleChoice[] = [
  { token: "ADMIN_BOOKINGS", label: "Booking Officer" },
  { token: "FINANCE_ADMIN", label: "Treasurer" },
];

function renderSidebar(
  props: Partial<React.ComponentProps<typeof AdminSidebar>> = {},
) {
  return render(
    <ClubTimeProvider zone="Pacific/Auckland" locale={CLUB_FORMAT_TEST.locale}>
      <AdminSidebar
        features={allOn}
        permissionMatrix={fullMatrix}
        isFullAdmin={false}
        {...props}
      />
    </ClubTimeProvider>,
  );
}

beforeAll(() => {
  // Radix Select opens on a key, then measures and scrolls. jsdom has neither.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  nav.refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

describe("the sidebar role switcher", () => {
  it("leaves today's sidebar in place when no menu is passed", () => {
    renderSidebar();
    expect(screen.getAllByText("Admin Panel").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Bookings & Beds" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox", { name: "Show menu for" })).toBeNull();
  });

  it("lists the given hubs and the switcher for an officer with two roles", () => {
    renderSidebar({
      menuHubKeys: ["bookings", "dashboard"],
      menuRoles: twoRoles,
      selectedMenuRole: null,
    });
    expect(screen.getAllByRole("link", { name: "Home" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Bookings" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Website" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bookings & Beds" })).toBeNull();
    const [switcher] = screen.getAllByRole("combobox", { name: "Show menu for" });
    fireEvent.keyDown(switcher, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "All my roles" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Treasurer" })).toBeTruthy();
  });

  it("hides the switcher from a Full Admin and from an officer with one role", () => {
    const { unmount } = renderSidebar({
      isFullAdmin: true,
      menuHubKeys: ["dashboard", "bookings", "rules"],
      menuRoles: twoRoles,
      selectedMenuRole: null,
    });
    expect(screen.queryByRole("combobox", { name: "Show menu for" })).toBeNull();
    unmount();

    renderSidebar({
      menuHubKeys: ["dashboard", "website"],
      menuRoles: [{ token: "ADMIN_CONTENT", label: "Content Manager" }],
      selectedMenuRole: "ADMIN_CONTENT",
    });
    expect(screen.queryByRole("combobox", { name: "Show menu for" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Website" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Bookings" })).toBeNull();
  });

  it("posts the chosen role and refreshes", async () => {
    renderSidebar({
      menuHubKeys: ["dashboard", "bookings", "rules", "finance", "lodge", "settings"],
      menuRoles: twoRoles,
      selectedMenuRole: null,
    });
    const [switcher] = screen.getAllByRole("combobox", { name: "Show menu for" });
    fireEvent.keyDown(switcher, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Treasurer" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/menu-role",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ role: "FINANCE_ADMIN" }),
      }),
    );
  });

  it("does not refresh when the save is refused", async () => {
    const pending = Promise.resolve({
      ok: false,
      json: async () => ({ error: "Invalid request" }),
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    renderSidebar({
      menuHubKeys: ["dashboard", "bookings"],
      menuRoles: twoRoles,
      selectedMenuRole: null,
    });
    const [switcher] = screen.getAllByRole("combobox", { name: "Show menu for" });
    fireEvent.keyDown(switcher, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Treasurer" }));
    await act(async () => {
      await pending;
    });
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
