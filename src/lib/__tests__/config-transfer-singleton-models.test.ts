import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

// Registering every category module as a side effect so getRegisteredEntities()
// is complete for the cross-checks below.
import "@/lib/config-transfer/categories/site-content";
import "@/lib/config-transfer/categories/club-settings";
import "@/lib/config-transfer/categories/lodge-config";
import "@/lib/config-transfer/categories/lodge-ops";
import "@/lib/config-transfer/categories/committee";
import "@/lib/config-transfer/categories/induction";
import "@/lib/config-transfer/categories/membership-fees";
import "@/lib/config-transfer/categories/age-tier";
import "@/lib/config-transfer/categories/xero-config";

import { getRegisteredEntities } from "@/lib/config-transfer/registry";
import { SINGLETONS } from "@/lib/config-transfer/categories/club-settings";
import {
  MODEL_LEVEL_EXCLUSIONS,
  SINGLETON_MODELS_REGISTERED_ELSEWHERE,
  singletonShapedModelNamesFromSchema,
  unclassifiedSingletonModels,
} from "@/lib/config-transfer/singleton-models";

// Test helper: reads a fixed repo file under process.cwd(); the path is
// test-controlled, not user input.
function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const SCHEMA_TEXT = readRepoFile("prisma/schema.prisma");
const SINGLETON_MODELS = singletonShapedModelNamesFromSchema(SCHEMA_TEXT);

/** Prisma model name a club-settings SingletonSpec's delegate maps to. */
function modelNameOf(delegate: string): string {
  return delegate[0].toUpperCase() + delegate.slice(1);
}

/** Every singleton-shaped model config transfer EXPORTS via the club-settings category. */
const CLUB_SETTINGS_SINGLETON_MODELS = SINGLETONS.map((s) => modelNameOf(s.delegate));

/** The three buckets a singleton-shaped model can legitimately fall into. */
function accountedForSet(): Set<string> {
  return new Set([
    ...CLUB_SETTINGS_SINGLETON_MODELS,
    ...Object.keys(SINGLETON_MODELS_REGISTERED_ELSEWHERE),
    ...Object.keys(MODEL_LEVEL_EXCLUSIONS),
  ]);
}

describe("config-transfer singleton-shaped model enumeration", () => {
  it("mechanically finds the id=\"default\" singletons from the schema", () => {
    // Sanity: the parser found a non-trivial set and includes known members of
    // each bucket (a registered one, an excluded one, and a newly-portable one).
    expect(SINGLETON_MODELS.length).toBeGreaterThanOrEqual(18);
    expect(SINGLETON_MODELS).toContain("ClubModuleSettings"); // registered
    expect(SINGLETON_MODELS).toContain("ClubTheme"); // registered elsewhere
    expect(SINGLETON_MODELS).toContain("XeroGroupingSettings"); // excluded
    expect(SINGLETON_MODELS).toContain("LoginSecuritySetting"); // newly portable
    expect(SINGLETON_MODELS).toContain("PublicContentSettings");
    expect(SINGLETON_MODELS).toContain("MembershipSubscriptionBillingSettings");
    // AgeTierSetting is @default(cuid()) + tier @unique — NOT a singleton, so it
    // must NOT appear here (out of scope for the SINGLETON guard by shape). It is
    // still covered by config transfer, but as a MULTI-ROW natural-key entity
    // (the "age-tier" entity in the membership-fees category, #2200), not via the
    // singleton mechanism this guard polices.
    expect(SINGLETON_MODELS).not.toContain("AgeTierSetting");
    expect(getRegisteredEntities().some((e) => e.entity === "age-tier")).toBe(true);
  });
});

// The guard (#2200). Every singleton-shaped Prisma model must be registered for
// export or named in MODEL_LEVEL_EXCLUSIONS with a reason, so a future settings
// singleton cannot silently join config transfer's blind spot.
describe("every singleton-shaped model is registered or excluded (model-level guard)", () => {
  it("leaves no singleton-shaped model unclassified", () => {
    const unclassified = unclassifiedSingletonModels(SINGLETON_MODELS, accountedForSet());
    expect(unclassified).toEqual([]);
  });

  // --- Mutation checks: prove the guard actually fails on drift. ---

  it("FAILS when a new singleton-shaped model appears unclassified", () => {
    const withFakeModel = [...SINGLETON_MODELS, "FutureSettings"].sort();
    const unclassified = unclassifiedSingletonModels(withFakeModel, accountedForSet());
    expect(unclassified).toEqual(["FutureSettings"]);
  });

  it("FAILS when a real classification is removed", () => {
    // Drop XeroGroupingSettings's exclusion: it must resurface as unclassified.
    const accounted = accountedForSet();
    accounted.delete("XeroGroupingSettings");
    const unclassified = unclassifiedSingletonModels(SINGLETON_MODELS, accounted);
    expect(unclassified).toContain("XeroGroupingSettings");
  });

  it("FAILS when a registered singleton is dropped from the export set", () => {
    // Simulate un-registering ClubModuleSettings (e.g. a refactor removes it).
    const accounted = accountedForSet();
    accounted.delete("ClubModuleSettings");
    expect(
      unclassifiedSingletonModels(SINGLETON_MODELS, accounted),
    ).toContain("ClubModuleSettings");
  });
});

describe("model-level classification is well-formed (no drift, no double-classification)", () => {
  it("every MODEL_LEVEL_EXCLUSIONS entry is a real, currently singleton-shaped model with a reason", () => {
    const singletons = new Set(SINGLETON_MODELS);
    for (const [model, reason] of Object.entries(MODEL_LEVEL_EXCLUSIONS)) {
      expect(singletons.has(model), `${model} excluded but not singleton-shaped`).toBe(true);
      expect(reason.trim().length, `${model} excluded without a reason`).toBeGreaterThan(0);
    }
  });

  it("every registered-elsewhere entry is singleton-shaped and genuinely registered", () => {
    const singletons = new Set(SINGLETON_MODELS);
    const registeredEntities = new Set(getRegisteredEntities().map((e) => e.entity));
    for (const model of Object.keys(SINGLETON_MODELS_REGISTERED_ELSEWHERE)) {
      expect(singletons.has(model), `${model} claimed registered but not singleton-shaped`).toBe(true);
    }
    // ClubTheme's registration is the club-theme entity in site-content; if that
    // registration is ever removed, this stale claim must fail loudly.
    expect(SINGLETON_MODELS_REGISTERED_ELSEWHERE).toHaveProperty("ClubTheme");
    expect(registeredEntities.has("club-theme")).toBe(true);
  });

  it("no model is classified in more than one bucket", () => {
    const buckets: Array<[string, string[]]> = [
      ["club-settings", CLUB_SETTINGS_SINGLETON_MODELS],
      ["registered-elsewhere", Object.keys(SINGLETON_MODELS_REGISTERED_ELSEWHERE)],
      ["excluded", Object.keys(MODEL_LEVEL_EXCLUSIONS)],
    ];
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [bucket, models] of buckets) {
      for (const model of models) {
        const prior = seen.get(model);
        if (prior) collisions.push(`${model} in both ${prior} and ${bucket}`);
        else seen.set(model, bucket);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("every club-settings singleton model is singleton-shaped and not excluded", () => {
    const singletons = new Set(SINGLETON_MODELS);
    for (const model of CLUB_SETTINGS_SINGLETON_MODELS) {
      expect(singletons.has(model), `${model} registered but not singleton-shaped`).toBe(true);
      expect(model in MODEL_LEVEL_EXCLUSIONS, `${model} both registered and excluded`).toBe(false);
    }
  });
});


it("keeps webhook receipt history and monitoring policy local to the target install", () => {
  expect(SINGLETON_MODELS).toContain("XeroInboundSettings");
  expect(MODEL_LEVEL_EXCLUSIONS.XeroInboundSettings).toContain("instance-local");
  expect(CLUB_SETTINGS_SINGLETON_MODELS).not.toContain("XeroInboundSettings");
});
