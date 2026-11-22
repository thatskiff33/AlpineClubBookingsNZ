import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
} from "@/config/modules";
import { featureFlagsSchema } from "@/config/schema";
import { SINGLETONS } from "@/lib/config-transfer/categories/club-settings";

const SCHEMA = readFileSync(
  path.join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);

// Issue hoppers99/AlpineClubBookingsNZ#26 (LTV-001): the lobby-display data model and module flag exist and
// the key is registered at every module-key enumeration point, defaulting OFF
// so no club sees the surface without opting in.

describe("lobbyDisplay module registration (issue hoppers99/AlpineClubBookingsNZ#26)", () => {
  it("registers the module key, defaulting OFF", () => {
    expect(MODULE_KEYS).toContain("lobbyDisplay");
    expect(DEFAULT_MODULE_SETTINGS.lobbyDisplay).toBe(false);
    expect(MODULE_DEFINITIONS.lobbyDisplay.label).toBe("Lobby TV display");
  });

  it("is part of the feature-flag schema and the config-transfer field list", () => {
    const allOff = Object.fromEntries(MODULE_KEYS.map((k) => [k, false]));
    expect(featureFlagsSchema.parse(allOff).lobbyDisplay).toBe(false);

    const moduleSpec = SINGLETONS.find(
      (s) => s.entity === "club-module-settings",
    );
    expect(moduleSpec?.fields).toContain("lobbyDisplay");
  });
});

describe("display authoring v2 Prisma models (LTV-024)", () => {
  it("generates client types for DisplayLayout and the v2 DisplayTemplate", () => {
    const device: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
    };
    const layout: Prisma.DisplayLayoutUncheckedCreateInput = {
      key: "everyday",
      name: "Everyday",
      bodyHtml: "<main></main>",
      defaultCss: "",
      areas: [],
    };
    const template: Prisma.DisplayTemplateUncheckedCreateInput = {
      key: "everyday-board",
      name: "Everyday board",
      layoutId: "layout-1",
      slotContent: {},
      cssOverrides: "",
      footerHtml: "",
    };

    expect(device.name).toBe("Lobby TV");
    expect(layout.key).toBe("everyday");
    expect(template.layoutId).toBe("layout-1");

    // No plaintext token column exists — only tokenHash.
    const badTokenDevice: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
      // @ts-expect-error — a plaintext `token` column must not exist
      token: "raw-token-value",
    };
    // The old per-device content column is gone.
    const badRegionDevice: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
      // @ts-expect-error — regionConfig was dropped in the v2 rebuild
      regionConfig: {},
    };
    // The retired region/panel columns are gone from DisplayTemplate.
    const badTemplate: Prisma.DisplayTemplateUncheckedCreateInput = {
      ...template,
      // @ts-expect-error — the retired `source` column must not exist
      source: "CUSTOM",
    };
    const badDefinitionTemplate: Prisma.DisplayTemplateUncheckedCreateInput = {
      ...template,
      // @ts-expect-error — the retired `definition` column must not exist
      definition: {},
    };
    expect(badTokenDevice).toBeDefined();
    expect(badRegionDevice).toBeDefined();
    expect(badTemplate).toBeDefined();
    expect(badDefinitionTemplate).toBeDefined();
  });

  it("exposes the v2 entities and removes the old shape in schema.prisma", () => {
    expect(SCHEMA).toMatch(/model DisplayLayout \{/);
    expect(SCHEMA).toMatch(/model DisplayTemplate \{/);
    // Layout carries the structural fields (ADR-003 §1).
    const layoutBlock = SCHEMA.slice(
      SCHEMA.indexOf("model DisplayLayout {"),
      SCHEMA.indexOf("model DisplayTemplate {"),
    );
    expect(layoutBlock).toMatch(/bodyHtml\s+String\s+@db\.Text/);
    expect(layoutBlock).toMatch(/defaultCss\s+String\s+@db\.Text/);
    expect(layoutBlock).toMatch(/areas\s+Json/);
    // v2 Template references a Layout and drops the old JSON definition/source.
    const templateBlock = SCHEMA.slice(
      SCHEMA.indexOf("model DisplayTemplate {"),
      SCHEMA.indexOf("model LodgeDisplayDevice {"),
    );
    expect(templateBlock).toMatch(/layoutId\s+String/);
    expect(templateBlock).toMatch(/slotContent\s+Json/);
    expect(templateBlock).toMatch(/cssOverrides\s+String\s+@db\.Text/);
    expect(templateBlock).toMatch(/footerHtml\s+String\s+@db\.Text/);
    expect(templateBlock).not.toContain("definition");
    expect(templateBlock).not.toContain("source");
    expect(templateBlock).toMatch(/onDelete: Restrict/);
    // The old data-only model and its enum are gone.
    expect(SCHEMA).not.toContain("enum DisplayTemplateSource");
    // The device drops regionConfig and the vestigial templateKey (removed in
    // hoppers99/AlpineClubBookingsNZ#86 / LTV-040), keeping only the templateId SetNull FK.
    const deviceBlock = SCHEMA.slice(
      SCHEMA.indexOf("model LodgeDisplayDevice {"),
    );
    expect(deviceBlock).not.toContain("regionConfig");
    expect(deviceBlock).not.toContain("templateKey");
    expect(deviceBlock).toMatch(/onDelete: SetNull/);
  });

  it("adds the per-device pollSeconds override column (LTV-039)", () => {
    const deviceBlock = SCHEMA.slice(
      SCHEMA.indexOf("model LodgeDisplayDevice {"),
    );
    // Nullable Int override; null = the client default cadence.
    expect(deviceBlock).toMatch(/pollSeconds\s+Int\?/);

    // The Prisma client accepts the new optional column on create.
    const device: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
      pollSeconds: 30,
    };
    const defaulted: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
      pollSeconds: null,
    };
    expect(device.pollSeconds).toBe(30);
    expect(defaulted.pollSeconds).toBeNull();
  });

  it("leaves the Lodge display columns unchanged", () => {
    expect(SCHEMA).toMatch(/displayConfig\s+Json\?/);
    expect(SCHEMA).toMatch(/displayNameGranularity\s+DisplayNameGranularity\?/);
    expect(SCHEMA).toMatch(/displayNotice\s+String\?\s+@db\.VarChar\(2000\)/);
  });
});
