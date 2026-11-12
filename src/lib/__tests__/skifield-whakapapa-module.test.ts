import { describe, expect, it } from "vitest";

import { getRequiredFeaturesForPath } from "@/config/feature-routes";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
} from "@/config/modules";

/**
 * #4932 — the Whakapapa (Mt Ruapehu) conditions report is its own module.
 *
 * The default is the load-bearing part: the report reads one ski field's
 * public feed, so a new install must not start with it on. An existing install
 * keeps its value through migration 20261212010000_add_skifield_whakapapa_module,
 * which prisma/migration-verification proves against a real database.
 */
describe("skifieldWhakapapa module flag", () => {
  it("is a known module key whose card says it is Whakapapa-specific", () => {
    expect(MODULE_KEYS).toContain("skifieldWhakapapa");
    expect(MODULE_DEFINITIONS.skifieldWhakapapa.label).toMatch(
      /Whakapapa \(Mt Ruapehu\)/,
    );
    expect(MODULE_DEFINITIONS.skifieldWhakapapa.description).toMatch(
      /Whakapapa-specific/,
    );
  });

  it("defaults OFF on a new install, while the generic widget stays ON", () => {
    expect(DEFAULT_MODULE_SETTINGS.skifieldWhakapapa).toBe(false);
    expect(DEFAULT_MODULE_SETTINGS.skifieldConditions).toBe(true);
    const flags = getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS);
    expect(flags.skifieldWhakapapa).toBe(false);
    expect(flags.skifieldConditions).toBe(true);
  });

  it("gates the Whakapapa feed and its admin cache, and leaves the generic widget on its own flag", () => {
    expect(getRequiredFeaturesForPath("/api/skifield-whakapapa")).toEqual([
      "skifieldWhakapapa",
    ]);
    expect(getRequiredFeaturesForPath("/api/admin/mountain-conditions")).toEqual([
      "skifieldWhakapapa",
    ]);
    expect(getRequiredFeaturesForPath("/api/skifield-conditions")).toEqual([
      "skifieldConditions",
    ]);
  });
});
