import "server-only";

import { readBundle, sha256Hex, type ReadBundleResult } from "./bundle";
import {
  computeFingerprint,
  resolutionMap,
  type CategoryImporter,
  type CategoryPlan,
  type ImportMode,
  type ImportPlan,
  type MatchResolution,
  type ReadDb,
} from "./import-types";
import type { ConfigTransferCategory } from "./manifest";
import { mediaApplies, planBundleMedia } from "./media";
import { siteContentImporter } from "./categories/site-content";
import { clubSettingsImporter } from "./categories/club-settings";
import { lodgeConfigImporter } from "./categories/lodge-config";
import { bedAllocationSettingsImporter } from "./categories/bed-allocation-settings";
import { bookingPoliciesImporter } from "./categories/booking-policies";
import { lodgeOpsImporter } from "./categories/lodge-ops";
import { displayImporter } from "./categories/display";
import { committeeImporter } from "./categories/committee";
import { inductionImporter } from "./categories/induction";
import { membershipFeesImporter } from "./categories/membership-fees";
import { ageTierImporter } from "./categories/age-tier";
import { xeroConfigImporter, connectedXeroTenantId, readXeroSourceTenantId } from "./categories/xero-config";

// Import plan orchestrator (dry-run). Reads + validates the bundle, runs each
// selected category's planner, and produces a stateless ImportPlan whose
// fingerprint binds the touched rows' current DB state PLUS the bundle bytes,
// the write mode, the category selection, and any match resolutions — apply
// re-derives it under the advisory lock and refuses any mismatch (ADR-002).

/** All registered category importers, in dependency-safe apply order. */
export const CATEGORY_IMPORTERS: CategoryImporter[] = [
  siteContentImporter,
  clubSettingsImporter,
  lodgeConfigImporter,
  bedAllocationSettingsImporter,
  // Booking policies depend on lodge slugs and intentionally replace their
  // complete policy set, so they apply immediately after lodge configuration.
  bookingPoliciesImporter,
  lodgeOpsImporter,
  displayImporter,
  committeeImporter,
  inductionImporter,
  // age-tier rides the membership-fees category as its own module (#2200); its
  // plan/apply short-circuit when the bundle carries no age-tiers.csv.
  ageTierImporter,
  membershipFeesImporter,
  xeroConfigImporter,
];

export interface ImportPlanOptions {
  mode: ImportMode;
  /**
   * Admin-selected categories; intersected with the manifest's
   * includedCategories. Omitted → everything the manifest includes.
   */
  selectedCategories?: ConfigTransferCategory[];
  resolutions?: MatchResolution[];
}

/** Convenience wrapper: parse the bundle, then plan from the parsed form. */
export async function buildImportPlan(
  db: ReadDb,
  bundleBytes: Uint8Array,
  options: ImportPlanOptions,
): Promise<ImportPlan> {
  return buildImportPlanFromParsed(
    db,
    readBundle(bundleBytes),
    sha256Hex(bundleBytes),
    options,
  );
}

/**
 * Plan from an already-parsed bundle (apply re-plans inside its transaction
 * without re-reading the zip). Single source of truth for classification,
 * validation errors, and the fingerprint.
 */
export async function buildImportPlanFromParsed(
  db: ReadDb,
  parsed: ReadBundleResult,
  bundleSha256: string,
  options: ImportPlanOptions,
): Promise<ImportPlan> {
  const { manifest, files, warnings: integrityWarnings } = parsed;
  const mode = options.mode;
  const resolutions = options.resolutions ?? [];

  // Effective categories: manifest ∩ admin selection (selection defaults to
  // everything the manifest includes).
  const selectedCategories = manifest.includedCategories.filter(
    (c) => !options.selectedCategories || options.selectedCategories.includes(c),
  );

  const planCtx = {
    db,
    files,
    manifest,
    mode,
    resolutions: resolutionMap(resolutions),
    selectedCategories,
  };

  // A category may be served by more than one importer module (e.g.
  // lodge-config); merge their results into one plan section per category.
  const byCategory = new Map<string, CategoryPlan>();
  const fingerprintParts: string[] = [];
  const errors: string[] = [];
  const doorCodeChanges: string[] = [];
  const summary = { create: 0, update: 0, delete: 0, unchanged: 0 };

  const tally = (items: CategoryPlan["items"]) => {
    for (const item of items) {
      if (item.action === "create") summary.create += 1;
      else if (item.action === "update") summary.update += 1;
      else if (item.action === "delete") summary.delete += 1;
      else summary.unchanged += 1;
    }
  };

  for (const importer of CATEGORY_IMPORTERS) {
    if (!selectedCategories.includes(importer.category)) continue;
    const result = await importer.plan(planCtx);
    const merged = byCategory.get(importer.category) ?? {
      category: importer.category,
      items: [],
      warnings: [],
      errors: [],
      fingerprintParts: [],
    };
    merged.items.push(...result.items);
    merged.warnings.push(...result.warnings);
    merged.errors.push(...result.errors);
    merged.fingerprintParts.push(...result.fingerprintParts);
    byCategory.set(importer.category, merged);
    fingerprintParts.push(...result.fingerprintParts);
    errors.push(...result.errors);
    doorCodeChanges.push(...(result.doorCodeChanges ?? []));
    tally(result.items);
  }

  // Media rides with its referencing categories: validated + disclosed in the
  // dry-run (errors block apply), applied only when those categories are in.
  if (mediaApplies(selectedCategories)) {
    const media = await planBundleMedia(db, files);
    if (media.items.length > 0 || media.errors.length > 0) {
      const target = byCategory.get("site-content") ?? {
        category: "site-content" as const,
        items: [],
        warnings: [],
        errors: [],
        fingerprintParts: [],
      };
      target.items.push(...media.items);
      target.warnings.push(...media.warnings);
      target.errors.push(...media.errors);
      byCategory.set("site-content", target);
      errors.push(...media.errors);
      tally(media.items);
    }
  }

  const categories: CategoryPlan[] = [...byCategory.values()];

  // Xero cross-org check only matters when the Xero category is selected.
  // Source org comes from xero-config/source.json, not the manifest.
  const xeroSelected = selectedCategories.includes("xero-config");
  const sourceTenantId = xeroSelected ? readXeroSourceTenantId(files) : null;
  const targetTenantId = xeroSelected ? await connectedXeroTenantId(db) : null;
  const mismatch =
    xeroSelected && sourceTenantId !== null && sourceTenantId !== targetTenantId;
  // The previewed cross-org verdict must still hold at apply: fingerprint the
  // TARGET org so connecting/switching Xero between preview and apply trips
  // the drift guard instead of applying against an org the admin never saw.
  if (xeroSelected) {
    fingerprintParts.push(`xero-target-org:${targetTenantId ?? "none"}`);
  }

  return {
    formatVersion: manifest.formatVersion,
    categories,
    fingerprint: computeFingerprint(fingerprintParts, {
      bundleSha256,
      mode,
      selectedCategories,
      resolutions,
    }),
    doorCodesIncluded: manifest.doorCodesIncluded,
    doorCodeChanges,
    selectedCategories,
    integrityWarnings,
    errors,
    xero: {
      sourceTenantId,
      targetTenantId,
      mismatch,
    },
    summary,
  };
}
