// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { unzipSync, strFromU8 } from "fflate";
import AdminDisplayReferencePage, { EXTRAS_GALLERY_ENTRIES } from "./page";
import { listDisplayModules } from "@/lib/lodge-display/module-registry";
import { listDisplayConditions } from "@/lib/lodge-display/conditions";
import { listDisplayCssTokens } from "@/lib/lodge-display/css-tokens";
import { BUILT_IN_DISPLAY_TEMPLATES } from "@/lib/lodge-display/built-in-seeds";

// LTV-034 (#80): the reference page is read-only presentation over three
// client-safe registries. This is the light cross-registry sweep (mirroring the
// module-registry integrity idiom): every module, condition, and CSS token in
// the registries must appear on the page, so adding one to a registry surfaces
// it here without hand-maintained duplication. The live status fetch is stubbed;
// the static registry content renders independently of it.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/admin/lodges")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ lodges: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          lodgeId: "lodge-default",
          lodgeName: "Silverpeak Lodge",
          conditions: listDisplayConditions().map((c) => ({
            name: c.name,
            value: false,
          })),
        }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Display reference page data sources", () => {
  it("renders every module, condition and CSS token from the registries", async () => {
    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const text = container.textContent ?? "";

    for (const mod of listDisplayModules()) {
      expect(text, `module "${mod.name}" missing`).toContain(mod.name);
      expect(text, `embed token for "${mod.name}" missing`).toContain(
        mod.embedToken
      );
    }
    for (const condition of listDisplayConditions()) {
      expect(text, `condition "${condition.name}" missing`).toContain(
        condition.name
      );
    }
    for (const token of listDisplayCssTokens()) {
      expect(text, `css token "${token.name}" missing`).toContain(token.name);
    }
  });

  it("lists every built-in board and both extras-bundle boards in the gallery (issue #2047)", async () => {
    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const text = container.textContent ?? "";

    // Section heading + the delivery-channel badges.
    expect(text).toContain("Template gallery");
    expect(text).toContain("Built-in");
    expect(text).toContain("Extras bundle");
    // Every seeded built-in template name appears (derived from the seeds, so a
    // new built-in surfaces here without hand-editing this test).
    for (const template of BUILT_IN_DISPLAY_TEMPLATES) {
      expect(text, `built-in "${template.name}" missing from gallery`).toContain(
        template.name
      );
    }
    // The two extras (documented statically, guarded by the bundle test).
    expect(text).toContain("Busy weekend (rotating)");
    expect(text).toContain("Minimal arrivals strip");
    expect(text).toContain("display-template-pack.bundle.zip");
  });

  it("extras gallery entries do not drift from the committed bundle (issue #2047, F5)", () => {
    // The extras gallery is described statically (the bundle is not seeded), so it
    // can silently drift from what the committed zip actually ships. Parse the
    // bundle here and assert the gallery's keys AND module lists match exactly —
    // any drift (a renamed key, an added/removed/reordered module) fails CI.
    const zipPath = path.join(
      process.cwd(),
      "docs/lobby-display/seeds/display-template-pack.bundle.zip"
    );
    const files = unzipSync(readFileSync(zipPath));
    const templates = JSON.parse(
      strFromU8(files["display/templates.json"])
    ) as Array<{ key: string; slotContent: Record<string, { module?: string }> }>;

    // The modules a template embeds, in slot order, deduped — the SAME derivation
    // the gallery uses for built-ins (page.tsx builtInModuleNames).
    const bundleModuleNames = (slotContent: Record<string, { module?: string }>) => {
      const names: string[] = [];
      for (const content of Object.values(slotContent)) {
        if (content?.module && !names.includes(content.module)) names.push(content.module);
      }
      return names;
    };
    const bundleByKey = new Map(
      templates.map((t) => [t.key, bundleModuleNames(t.slotContent)])
    );

    // Same set of keys on both sides (no gallery entry for a missing bundle
    // template, no bundle template absent from the gallery).
    expect([...EXTRAS_GALLERY_ENTRIES.map((e) => e.templateKey)].sort()).toEqual(
      [...bundleByKey.keys()].sort()
    );
    // Each gallery entry's module list matches the bundle's, in order.
    for (const entry of EXTRAS_GALLERY_ENTRIES) {
      const fromBundle = bundleByKey.get(entry.templateKey);
      expect(fromBundle, `bundle has no template "${entry.templateKey}"`).toBeDefined();
      expect(
        entry.moduleNames,
        `gallery modules for "${entry.templateKey}" drifted from the bundle`
      ).toEqual(fromBundle);
    }
  });

  it("shows the live indicator once the status endpoint responds", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/admin/lodges")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ lodges: [{ id: "lodge-default", name: "Silverpeak Lodge" }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            lodgeId: "lodge-default",
            lodgeName: "Silverpeak Lodge",
            conditions: [
              { name: "content:notice", value: true },
              { name: "occupancy:empty-today", value: false },
            ],
          }),
      });
    });

    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("Silverpeak Lodge")
    );
    expect(container.textContent ?? "").toContain("true now");
    expect(container.textContent ?? "").toContain("false now");
  });
});
