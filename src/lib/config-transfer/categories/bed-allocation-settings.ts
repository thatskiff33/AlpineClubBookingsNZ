import { strFromU8, strToU8 } from "fflate";

import { DEFAULT_BED_ALLOCATION_SETTINGS } from "@/config/club-settings-defaults";
import {
  BedAllocationSettingsValidationError,
  parseBedAllocationPriorityOrder,
  resolveEffectiveBedAllocationSettings,
  type BedAllocationPriority,
} from "@/lib/bed-allocation-settings";
import type { BundleEntry } from "../bundle";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  changedFields,
  hashRow,
  planActionFor,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";
import { registerEntity } from "../registry";
import {
  folderLodgeSlug,
  folderSegment,
  lodgeFolderSegments,
  LODGES_PREFIX,
} from "./lodge-config";

export const BED_ALLOCATION_SETTINGS_FILE = "bed-allocation-settings.json";
const SETTINGS_FIELDS = [
  "autoAllocationEnabled",
  "allocationPriorityOrder",
] as const;

registerEntity({
  entity: "lodge-bed-allocation-settings",
  category: "lodge-config",
  tier: "key-strong",
  format: "json",
  file: `${LODGES_PREFIX}<slug>/${BED_ALLOCATION_SETTINGS_FILE}`,
  naturalKey: ["lodgeSlug"],
  singleton: false,
  fields: [...SETTINGS_FIELDS],
});

export function bedAllocationSettingsFile(segment: string): string {
  return `${LODGES_PREFIX}${segment}/${BED_ALLOCATION_SETTINGS_FILE}`;
}

interface ParsedSettings {
  raw: Record<string, unknown>;
  createData: {
    autoAllocationEnabled: boolean;
    allocationPriorityOrder: BedAllocationPriority[];
  };
  updateData: {
    autoAllocationEnabled?: boolean;
    allocationPriorityOrder: BedAllocationPriority[];
  };
}

interface CurrentSettings {
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: string[];
}

/** One strict parser shared by preview and apply. */
function parseSettings(
  bytes: Uint8Array,
  file: string,
  errors: string[],
): ParsedSettings | null {
  let incoming: unknown;
  try {
    incoming = JSON.parse(strFromU8(bytes));
  } catch (error) {
    errors.push(
      `${file}: not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
    return null;
  }
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    errors.push(`${file}: must be a JSON object`);
    return null;
  }

  const record = incoming as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(
    (key) => !(SETTINGS_FIELDS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    errors.push(`${file}: unknown field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
    return null;
  }
  if (
    "autoAllocationEnabled" in record &&
    typeof record.autoAllocationEnabled !== "boolean"
  ) {
    errors.push(`${file}: autoAllocationEnabled must be a boolean`);
    return null;
  }

  let allocationPriorityOrder: BedAllocationPriority[];
  try {
    allocationPriorityOrder =
      "allocationPriorityOrder" in record
        ? parseBedAllocationPriorityOrder(
            record.allocationPriorityOrder,
            `${file}: allocationPriorityOrder`,
            400,
          )
        : [...DEFAULT_BED_ALLOCATION_SETTINGS.allocationPriorityOrder];
  } catch (error) {
    errors.push(
      error instanceof BedAllocationSettingsValidationError
        ? error.message
        : `${file}: allocationPriorityOrder is invalid`,
    );
    return null;
  }

  // Priority omission is the sole backward-compat exception: normalise it to
  // the canonical historical order and count it as present. Auto omission is
  // intentionally absent from updateData in BOTH modes, so an existing target
  // keeps its value; creates receive the canonical default below.
  const raw: Record<string, unknown> = { allocationPriorityOrder };
  const updateData: ParsedSettings["updateData"] = { allocationPriorityOrder };
  if ("autoAllocationEnabled" in record) {
    raw.autoAllocationEnabled = record.autoAllocationEnabled;
    updateData.autoAllocationEnabled = record.autoAllocationEnabled as boolean;
  }

  return {
    raw,
    updateData,
    createData: {
      autoAllocationEnabled:
        updateData.autoAllocationEnabled ??
        DEFAULT_BED_ALLOCATION_SETTINGS.autoAllocationEnabled,
      allocationPriorityOrder,
    },
  };
}

function settingsSegments(files: Map<string, Uint8Array>): string[] {
  return lodgeFolderSegments(files).filter((segment) =>
    files.has(bedAllocationSettingsFile(segment)),
  );
}

async function loadTargets(
  db: ReadDb | TxDb,
  slugs: string[],
): Promise<{
  lodgeIdBySlug: Map<string, string>;
  settingsByLodgeId: Map<string, CurrentSettings>;
}> {
  if (slugs.length === 0) {
    return { lodgeIdBySlug: new Map(), settingsByLodgeId: new Map() };
  }
  const lodges = await db.lodge.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  const lodgeIdBySlug = new Map(lodges.map((lodge) => [lodge.slug, lodge.id]));
  const lodgeIds = lodges.map((lodge) => lodge.id);
  const rows = lodgeIds.length
    ? await db.bedAllocationSettings.findMany({
        where: { id: { in: lodgeIds } },
        select: {
          id: true,
          autoAllocationEnabled: true,
          allocationPriorityOrder: true,
        },
      })
    : [];
  return {
    lodgeIdBySlug,
    settingsByLodgeId: new Map(rows.map((row) => [row.id, row])),
  };
}

export const bedAllocationSettingsExporter: CategoryExporter = {
  category: "lodge-config",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const lodges = await ctx.db.lodge.findMany({
      orderBy: { slug: "asc" },
      select: { id: true, slug: true },
    });
    const entries: BundleEntry[] = [];
    for (const lodge of lodges) {
      // The runtime resolver is the authoritative fallback contract. It also
      // strictly validates persisted priority arrays, so corrupt settings fail
      // export instead of being copied into a bundle.
      const settings = await resolveEffectiveBedAllocationSettings(ctx.db, lodge.id);
      entries.push({
        path: bedAllocationSettingsFile(folderSegment(lodge.slug)),
        category: "lodge-config",
        rowCount: 1,
        bytes: strToU8(
          JSON.stringify(
            {
              autoAllocationEnabled: settings.autoAllocationEnabled,
              allocationPriorityOrder: settings.allocationPriorityOrder,
            },
            null,
            2,
          ),
        ),
      });
    }
    return entries;
  },
};

async function planBedAllocationSettings(
  ctx: PlanContext,
): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const segments = settingsSegments(ctx.files);
  const slugBySegment = new Map<string, string>();
  const seenSlugs = new Set<string>();

  for (const segment of segments) {
    const file = bedAllocationSettingsFile(segment);
    const slug = folderLodgeSlug(ctx.files, segment);
    if (!slug) {
      errors.push(`${file}: requires a valid sibling lodge.json with an authoritative slug`);
      continue;
    }
    if (seenSlugs.has(slug)) {
      errors.push(`${file}: duplicate bed-allocation settings for lodge slug "${slug}"`);
      continue;
    }
    seenSlugs.add(slug);
    slugBySegment.set(segment, slug);
  }

  const batch = await loadTargets(ctx.db, [...seenSlugs]);
  for (const segment of segments) {
    const slug = slugBySegment.get(segment);
    if (!slug) continue;
    const file = bedAllocationSettingsFile(segment);
    const parsed = parseSettings(ctx.files.get(file)!, file, errors);
    if (!parsed) continue;
    const lodgeId = batch.lodgeIdBySlug.get(slug) ?? null;
    const current = lodgeId
      ? batch.settingsByLodgeId.get(lodgeId) ?? null
      : null;
    fingerprintParts.push(
      `lodge-bed-allocation-settings:${slug}:${current ? hashRow([...SETTINGS_FIELDS], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, parsed.raw, parsed.updateData);
    const changed = changedFields(write, current);
    items.push({
      entity: "lodge-bed-allocation-settings",
      key: slug,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  return { items, warnings: [], errors, fingerprintParts };
}

async function applyBedAllocationSettings(
  ctx: ApplyContext,
): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    skipped: 0,
  };
  const segments = settingsSegments(ctx.files);
  const slugBySegment = new Map<string, string>();
  for (const segment of segments) {
    const slug = folderLodgeSlug(ctx.files, segment);
    if (slug) slugBySegment.set(segment, slug);
  }
  // Base lodge-config runs first in this transaction, so this re-query resolves
  // both pre-existing (active or inactive) lodges and lodges just created from
  // their selected lodge.json descriptor.
  const batch = await loadTargets(ctx.tx, [...new Set(slugBySegment.values())]);

  for (const segment of segments) {
    const slug = slugBySegment.get(segment);
    const file = bedAllocationSettingsFile(segment);
    const lodgeId = slug ? batch.lodgeIdBySlug.get(slug) ?? null : null;
    const errors: string[] = [];
    const parsed = parseSettings(ctx.files.get(file)!, file, errors);
    if (!slug || !lodgeId || !parsed) {
      result.skipped += 1;
      continue;
    }
    const current = batch.settingsByLodgeId.get(lodgeId) ?? null;
    if (!current) {
      await ctx.tx.bedAllocationSettings.create({
        data: {
          id: lodgeId,
          lodgeId,
          ...parsed.createData,
          updatedByMemberId: ctx.actorMemberId,
        },
      });
      result.created += 1;
      continue;
    }
    const write = updateDataForMode(ctx.mode, parsed.raw, parsed.updateData);
    const changed = changedFields(write, current);
    if (changed.length === 0) {
      result.unchanged += 1;
      continue;
    }
    await ctx.tx.bedAllocationSettings.update({
      where: { id: lodgeId },
      data: { ...write, updatedByMemberId: ctx.actorMemberId },
    });
    result.updated += 1;
  }
  return result;
}

export const bedAllocationSettingsImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planBedAllocationSettings,
  apply: applyBedAllocationSettings,
};
