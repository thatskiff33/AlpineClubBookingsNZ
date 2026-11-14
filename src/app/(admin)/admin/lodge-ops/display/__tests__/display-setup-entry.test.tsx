// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextualHelp } from "@/lib/contextual-help";
import { DISPLAY_WIZARD_HREF } from "../setup/display-wizard-state";

// The wizard's two entry points, exactly as the owner decided them (29 Jul 2026):
// a setup card on the Lobby Display hub while boards or devices are missing,
// plus an always-available Help link.
//
// The "always available" half is the part worth pinning: a club that finishes
// setup, then replaces a TV a year later, must still be able to find the wizard.
// So the hub keeps the same destination as an ordinary card once the gold lead
// card retires, and the Help panel names it on every display page.

const counts = vi.hoisted(() => ({ templates: 0, pairedDevices: 0 }));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ lobbyDisplay: true }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    displayTemplate: { count: vi.fn(async () => counts.templates) },
    lodgeDisplayDevice: { count: vi.fn(async () => counts.pairedDevices) },
  },
}));

async function renderHub() {
  const { default: DisplayHubPage } = await import("../page");
  return render(await DisplayHubPage());
}

beforeEach(() => {
  counts.templates = 0;
  counts.pairedDevices = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Lobby Display hub's guided-setup entry point (#2249)", () => {
  it("leads with the setup card while the club has no boards", async () => {
    counts.templates = 0;
    counts.pairedDevices = 0;
    await renderHub();

    const card = screen.getByRole("link", {
      name: /guided setup — nothing on your screens yet/i,
    });
    expect(card.getAttribute("href")).toBe(DISPLAY_WIZARD_HREF);
    // Exactly one entry point, never the lead card AND the grid card.
    expect(
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href") === DISPLAY_WIZARD_HREF),
    ).toHaveLength(1);
  });

  it("leads with the setup card while boards exist but no screen is working", async () => {
    counts.templates = 7;
    counts.pairedDevices = 0;
    await renderHub();

    expect(
      screen.getByRole("link", {
        name: /guided setup — nothing on your screens yet/i,
      }),
    ).toBeTruthy();
  });

  it("keeps the wizard reachable as an ordinary card once a screen is live", async () => {
    counts.templates = 7;
    counts.pairedDevices = 1;
    await renderHub();

    expect(
      screen.queryByRole("link", {
        name: /nothing on your screens yet/i,
      }),
    ).toBeNull();
    const card = screen.getByRole("link", { name: /guided setup/i });
    expect(card.getAttribute("href")).toBe(DISPLAY_WIZARD_HREF);
  });
});

describe("the Help panel names the wizard on every display page", () => {
  it("resolves the Lobby Display guide from any /admin/display path", () => {
    for (const path of [
      "/admin/display",
      "/admin/display/devices",
      "/admin/display/templates",
      "/admin/display/setup",
    ]) {
      const help = getContextualHelp(path, "admin");
      expect(help.title, `no Lobby Display help for ${path}`).toBe(
        "Lobby Display",
      );
      expect(help.actions.join(" ")).toContain(DISPLAY_WIZARD_HREF);
    }
  });

  it("states the shared install-wide cursor and the module exemption", () => {
    const notes = getContextualHelp("/admin/display", "admin").notes ?? [];
    expect(notes.join(" ")).toMatch(/WHOLE club, not per admin/i);
    expect(notes.join(" ")).toMatch(
      /except the guided setup wizard, whose first step turns the module on/i,
    );
  });
});
