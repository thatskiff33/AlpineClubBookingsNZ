import { strToU8 } from "fflate";

import { sanitizePageContentHtml } from "@/lib/page-content-html";
import type { BundleEntry } from "../bundle";
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import { remapImageRefs } from "../media";
import type { CategoryExporter, ExportContext } from "../export-types";
import { extractImageIds } from "./site-content";
import {
  LODGES_PREFIX,
  folderLodgeSlug,
  folderSegment,
  lodgeFolderFiles,
  lodgeFolderSegments,
} from "./lodge-config";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  resolutionKey,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { RowValidator, nz, readCsvRows } from "../values";

// lodge-config category (part 2): lodge instructions and chore templates, laid
// out to match the per-lodge folders from lodge-config (part 1):
//   lodge-config/lodges/<slug>/instructions.csv     key, contentHtml
//   lodge-config/lodges/<slug>/chore-templates.csv  name, description, ...
//   lodge-config/instructions.csv                   key, contentHtml  ← club-wide
// Instructions are two-level: club-wide (lodgeId null) rows are the base shown
// for every lodge; a lodge folder's rows override the same keys for that lodge.
// Chore templates are always lodge-scoped. Instruction content may embed images
// (remapped on apply). Booking/cancellation/min-stay policies are intentionally
// deferred (replace-set semantics + refund maths). See ADR-001/002.

/** Club-wide (lodgeId null) instructions live here, outside any lodge folder. */
const CLUB_INSTRUCTION_FILE = "lodge-config/instructions.csv";

const INSTRUCTION_FIELDS = ["key", "contentHtml"] as const;
const CHORE_FIELDS = [
  "name", "description", "recommendedPeopleMin",
  "recommendedPeopleMax", "isEssential", "ageRestriction", "conditionalNote",
  "minAge", "sortOrder", "timeOfDay", "frequencyMode", "frequencyDays", "active",
] as const;

registerEntity({
  entity: "lodge-instruction",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/instructions.csv`,
  naturalKey: ["key"],
  singleton: false,
  fields: [...INSTRUCTION_FIELDS],
});
registerEntity({
  entity: "chore-template",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/chore-templates.csv`,
  naturalKey: ["name"],
  singleton: false,
  fields: [...CHORE_FIELDS],
});

// ---- Shared parsing/building (plan + apply) ---------------------------------

interface ChoreCurrent {
  id: string;
  lodgeId: string;
  name: string;
  description: string | null;
  recommendedPeopleMin: number;
  recommendedPeopleMax: number;
  isEssential: boolean;
  ageRestriction: string;
  conditionalNote: string | null;
  minAge: number;
  sortOrder: number;
  timeOfDay: string;
  frequencyMode: string;
  frequencyDays: number | null;
  active: boolean;
}
const CHORE_SELECT = {
  id: true, lodgeId: true, name: true, description: true,
  recommendedPeopleMin: true, recommendedPeopleMax: true, isEssential: true,
  ageRestriction: true, conditionalNote: true, minAge: true, sortOrder: true,
  timeOfDay: true, frequencyMode: true, frequencyDays: true, active: true,
} as const;
const CHORE_HASH_FIELDS = [
  "description", "recommendedPeopleMin", "recommendedPeopleMax", "isEssential",
  "ageRestriction", "conditionalNote", "minAge", "sortOrder", "timeOfDay",
  "frequencyMode", "frequencyDays", "active",
];

interface OpsBatch {
  lodgeIdBySlug: Map<string, string>;
  clubInstructions: Map<string, { id: string; contentHtml: string }>; // by key
  lodgeInstructions: Map<string, { id: string; contentHtml: string }>; // lodgeId/key
  chores: Map<string, ChoreCurrent>; // lodgeId/name
  choresById: Map<string, ChoreCurrent>;
  choresByLodge: Map<string, ChoreCurrent[]>;
}

async function loadOpsBatch(db: ReadDb, slugs: string[]): Promise<OpsBatch> {
  const lodges = await db.lodge.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  const lodgeIdBySlug = new Map(lodges.map((l) => [l.slug, l.id]));
  const lodgeIds = lodges.map((l) => l.id);

  const [instructionRows, choreRows] = await Promise.all([
    db.lodgeInstruction.findMany({
      where: { OR: [{ lodgeId: null }, { lodgeId: { in: lodgeIds } }] },
      select: { id: true, lodgeId: true, key: true, contentHtml: true },
    }),
    db.choreTemplate.findMany({
      where: { lodgeId: { in: lodgeIds } },
      select: CHORE_SELECT,
    }),
  ]);

  const clubInstructions = new Map<string, { id: string; contentHtml: string }>();
  const lodgeInstructions = new Map<string, { id: string; contentHtml: string }>();
  for (const row of instructionRows) {
    if (row.lodgeId === null) clubInstructions.set(String(row.key), row);
    else lodgeInstructions.set(`${row.lodgeId}/${row.key}`, row);
  }
  const chores = new Map<string, ChoreCurrent>();
  const choresById = new Map<string, ChoreCurrent>();
  const choresByLodge = new Map<string, ChoreCurrent[]>();
  for (const row of choreRows) {
    const key = `${row.lodgeId}/${row.name}`;
    if (!chores.has(key)) chores.set(key, row); // key-weak: first match
    choresById.set(row.id, row);
    const list = choresByLodge.get(row.lodgeId) ?? [];
    list.push(row);
    choresByLodge.set(row.lodgeId, list);
  }
  return { lodgeIdBySlug, clubInstructions, lodgeInstructions, chores, choresById, choresByLodge };
}

/** Validate + build an instruction row; blank content is legal only in merge mode on an existing row. */
function parseInstructionRow(
  file: string,
  index: number,
  raw: Record<string, string>,
  errors: string[],
): { key: string } | null {
  const v = new RowValidator(file, index, errors);
  v.enum("key", "LodgeInstructionKey", raw.key);
  if (!v.ok) return null;
  return { key: raw.key.trim() };
}

/** Validate + build a chore row (mode-aware blanks). */
function parseChoreRow(
  file: string,
  index: number,
  raw: Record<string, string>,
  blankOk: boolean,
  errors: string[],
): { name: string; data: Record<string, unknown> } | null {
  const v = new RowValidator(file, index, errors);
  const name = v.required("name", raw.name);
  const opt = <T>(cell: unknown, strict: () => T, fallback: T): T =>
    blankOk && nz(cell) === null ? fallback : strict();
  const data = {
    description: nz(raw.description),
    recommendedPeopleMin: opt(raw.recommendedPeopleMin, () => v.int("recommendedPeopleMin", raw.recommendedPeopleMin), 1),
    recommendedPeopleMax: opt(raw.recommendedPeopleMax, () => v.int("recommendedPeopleMax", raw.recommendedPeopleMax), 2),
    isEssential: opt(raw.isEssential, () => v.bool("isEssential", raw.isEssential), false),
    ageRestriction: opt(raw.ageRestriction, () => v.enum("ageRestriction", "AgeRestriction", raw.ageRestriction), "ANY") as never,
    conditionalNote: nz(raw.conditionalNote),
    minAge: opt(raw.minAge, () => v.int("minAge", raw.minAge), 0),
    sortOrder: opt(raw.sortOrder, () => v.int("sortOrder", raw.sortOrder), 0),
    timeOfDay: opt(raw.timeOfDay, () => v.enum("timeOfDay", "ChoreTimeOfDay", raw.timeOfDay), "ANYTIME") as never,
    frequencyMode: opt(raw.frequencyMode, () => v.enum("frequencyMode", "ChoreFrequencyMode", raw.frequencyMode), "DAILY") as never,
    frequencyDays: nz(raw.frequencyDays) === null ? null : v.int("frequencyDays", raw.frequencyDays),
    active: opt(raw.active, () => v.bool("active", raw.active), true),
  };
  if (!v.ok) return null;
  return { name, data };
}

// ---- Export ----------------------------------------------------------------

export const lodgeOpsExporter: CategoryExporter = {
  category: "lodge-config",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const instructions = await ctx.db.lodgeInstruction.findMany({
      orderBy: { key: "asc" },
      select: { key: true, contentHtml: true, lodge: { select: { slug: true } } },
    });
    const chores = await ctx.db.choreTemplate.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        name: true, description: true, recommendedPeopleMin: true,
        recommendedPeopleMax: true, isEssential: true, ageRestriction: true,
        conditionalNote: true, minAge: true, sortOrder: true, timeOfDay: true,
        frequencyMode: true, frequencyDays: true, active: true,
        lodge: { select: { slug: true } },
      },
    });

    for (const i of instructions) {
      for (const id of extractImageIds(i.contentHtml ?? "")) ctx.media.reference(id);
    }

    const clubInstructions: Record<string, unknown>[] = [];
    const instructionsByLodge = new Map<string, Record<string, unknown>[]>();
    for (const i of instructions) {
      const row = { key: i.key, contentHtml: i.contentHtml };
      if (i.lodge?.slug) {
        const list = instructionsByLodge.get(i.lodge.slug) ?? [];
        list.push(row);
        instructionsByLodge.set(i.lodge.slug, list);
      } else {
        clubInstructions.push(row);
      }
    }
    const choresByLodge = new Map<string, Record<string, unknown>[]>();
    for (const c of chores) {
      const list = choresByLodge.get(c.lodge.slug) ?? [];
      list.push({
        name: c.name, description: c.description,
        recommendedPeopleMin: c.recommendedPeopleMin, recommendedPeopleMax: c.recommendedPeopleMax,
        isEssential: c.isEssential, ageRestriction: c.ageRestriction, conditionalNote: c.conditionalNote,
        minAge: c.minAge, sortOrder: c.sortOrder, timeOfDay: c.timeOfDay,
        frequencyMode: c.frequencyMode, frequencyDays: c.frequencyDays, active: c.active,
      });
      choresByLodge.set(c.lodge.slug, list);
    }

    // Always emit the top-level club-wide (lodgeId null) instructions file so
    // the "shown for every lodge unless overridden" slot is discoverable.
    const entries: BundleEntry[] = [
      { path: CLUB_INSTRUCTION_FILE, category: "lodge-config", rowCount: clubInstructions.length, bytes: strToU8(serialiseCsv([...INSTRUCTION_FIELDS], clubInstructions)) },
    ];

    // Emit the per-lodge skeletons for EVERY lodge (header-only when empty).
    const lodges = await ctx.db.lodge.findMany({ orderBy: { slug: "asc" }, select: { slug: true } });
    for (const { slug } of lodges) {
      const paths = lodgeFolderFiles(folderSegment(slug));
      const ins = instructionsByLodge.get(slug) ?? [];
      const ch = choresByLodge.get(slug) ?? [];
      entries.push({ path: paths.instructions, category: "lodge-config", rowCount: ins.length, bytes: strToU8(serialiseCsv([...INSTRUCTION_FIELDS], ins)) });
      entries.push({ path: paths.choreTemplates, category: "lodge-config", rowCount: ch.length, bytes: strToU8(serialiseCsv([...CHORE_FIELDS], ch)) });
    }
    return entries;
  },
};

// ---- Plan ------------------------------------------------------------------

async function planLodgeOps(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];

  const segments = lodgeFolderSegments(ctx.files);
  const slugs = segments
    .map((seg) => folderLodgeSlug(ctx.files, seg))
    .filter((s): s is string => s !== null);
  const batch = await loadOpsBatch(ctx.db, slugs);

  const planInstruction = (
    displayKey: string,
    raw: Record<string, string>,
    current: { contentHtml: string } | null,
  ) => {
    fingerprintParts.push(
      `lodge-instruction:${displayKey}:${current ? hashRow(["contentHtml"], current) : "absent"}`,
    );
    const write = updateDataForMode(
      ctx.mode,
      { contentHtml: raw.contentHtml ?? "" },
      { contentHtml: sanitizePageContentHtml(raw.contentHtml ?? "") },
    );
    const changed = changedFields(write, current);
    items.push({ entity: "lodge-instruction", key: displayKey, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
  };

  // Club-wide instructions (lodgeId null).
  readCsvRows(ctx.files, CLUB_INSTRUCTION_FILE).forEach((raw, i) => {
    const parsed = parseInstructionRow(CLUB_INSTRUCTION_FILE, i, raw, errors);
    if (!parsed) return;
    planInstruction(`club/${parsed.key}`, raw, batch.clubInstructions.get(parsed.key) ?? null);
  });

  // Per-lodge instructions + chore templates.
  for (const segment of segments) {
    const slug = folderLodgeSlug(ctx.files, segment);
    if (!slug) continue; // lodge-config part 1 reports the descriptor error
    const paths = lodgeFolderFiles(segment);
    const lodgeId = batch.lodgeIdBySlug.get(slug) ?? null;

    readCsvRows(ctx.files, paths.instructions).forEach((raw, i) => {
      const parsed = parseInstructionRow(paths.instructions, i, raw, errors);
      if (!parsed) return;
      const current = lodgeId ? batch.lodgeInstructions.get(`${lodgeId}/${parsed.key}`) ?? null : null;
      planInstruction(`${slug}/${parsed.key}`, raw, current);
    });

    const bundleChoreNames = new Set<string>();
    const choreRows = readCsvRows(ctx.files, paths.choreTemplates);
    for (const raw of choreRows) if (nz(raw.name)) bundleChoreNames.add(raw.name.trim());
    choreRows.forEach((raw, i) => {
      const key = `${slug}/${raw.name?.trim() ?? ""}`;
      const resolvedId = ctx.resolutions.get(resolutionKey("chore-template", key));
      const exactMatch = lodgeId ? batch.chores.get(`${lodgeId}/${raw.name?.trim() ?? ""}`) ?? null : null;
      let current: ChoreCurrent | null = exactMatch;
      let candidates: PlanItem["candidates"];
      if (!exactMatch && lodgeId) {
        // Kept on RESOLVED rows too, so the admin can change or undo the match.
        const options = (batch.choresByLodge.get(lodgeId) ?? []).filter(
          (c) => !bundleChoreNames.has(c.name),
        );
        if (options.length > 0) {
          candidates = options.map((c) => ({ id: c.id, label: c.name }));
        }
      }
      if (resolvedId) {
        const target = batch.choresById.get(resolvedId);
        if (!target || target.lodgeId !== lodgeId) {
          errors.push(`Chore template "${key}": the matched template no longer exists on this lodge — re-run the preview.`);
          return;
        }
        current = target;
      }
      const parsed = parseChoreRow(paths.choreTemplates, i, raw, ctx.mode === "merge" && !!current, errors);
      if (!parsed) return;
      fingerprintParts.push(
        `chore-template:${key}:${current ? hashRow(CHORE_HASH_FIELDS, current) : "absent"}`,
      );
      const data = resolvedId ? { name: parsed.name, ...parsed.data } : parsed.data;
      const write = updateDataForMode(ctx.mode, { ...raw, name: parsed.name }, data);
      const changed = changedFields(write, current);
      items.push({
        entity: "chore-template",
        key,
        action: planActionFor(current, changed),
        changedFields: changed.length ? changed : undefined,
        ...(candidates ? { candidates } : {}),
      });
    });
  }

  return { items, warnings, errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyLodgeOps(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only

  const segments = lodgeFolderSegments(ctx.files);
  const slugs = segments
    .map((seg) => folderLodgeSlug(ctx.files, seg))
    .filter((s): s is string => s !== null);
  const batch = await loadOpsBatch(ctx.tx, slugs);

  const applyInstruction = async (
    lodgeId: string | null,
    key: string,
    raw: Record<string, string>,
    current: { id: string; contentHtml: string } | null,
  ) => {
    const html = sanitizePageContentHtml(
      remapImageRefs(raw.contentHtml ?? "", ctx.imageRemap),
    );
    await applyRow({
      mode: ctx.mode,
      raw: { contentHtml: raw.contentHtml ?? "" },
      data: { contentHtml: html },
      current,
      create: (data) =>
        ctx.tx.lodgeInstruction.create({ data: { lodgeId, key: key as never, ...data } }),
      update: (write) =>
        ctx.tx.lodgeInstruction.update({ where: { id: current!.id }, data: write }),
      result,
    });
  };

  // Club-wide instructions.
  for (const [i, raw] of readCsvRows(ctx.files, CLUB_INSTRUCTION_FILE).entries()) {
    const parsed = parseInstructionRow(CLUB_INSTRUCTION_FILE, i, raw, errors);
    if (!parsed) { result.skipped += 1; continue; }
    await applyInstruction(null, parsed.key, raw, batch.clubInstructions.get(parsed.key) ?? null);
  }

  // Per-lodge instructions + chore templates. NB: lodges are created by the
  // lodge-config (part 1) apply, which runs earlier in the same transaction —
  // re-resolve slugs that were missing from the pre-batch.
  for (const segment of segments) {
    const slug = folderLodgeSlug(ctx.files, segment);
    const paths = lodgeFolderFiles(segment);
    let lodgeId = slug ? batch.lodgeIdBySlug.get(slug) ?? null : null;
    if (slug && !lodgeId) {
      const lodge = await ctx.tx.lodge.findUnique({ where: { slug }, select: { id: true } });
      lodgeId = lodge?.id ?? null;
    }

    for (const [i, raw] of readCsvRows(ctx.files, paths.instructions).entries()) {
      const parsed = parseInstructionRow(paths.instructions, i, raw, errors);
      if (!parsed || !lodgeId) { result.skipped += 1; continue; }
      const current = batch.lodgeInstructions.get(`${lodgeId}/${parsed.key}`) ?? null;
      await applyInstruction(lodgeId, parsed.key, raw, current);
    }

    for (const [i, raw] of readCsvRows(ctx.files, paths.choreTemplates).entries()) {
      if (!lodgeId) { result.skipped += 1; continue; }
      const key = `${slug}/${raw.name?.trim() ?? ""}`;
      const resolvedId = ctx.resolutions.get(resolutionKey("chore-template", key));
      const current = resolvedId
        ? batch.choresById.get(resolvedId) ?? null
        : batch.chores.get(`${lodgeId}/${raw.name?.trim() ?? ""}`) ?? null;
      if (resolvedId && !current) { result.skipped += 1; continue; }
      const parsed = parseChoreRow(paths.choreTemplates, i, raw, ctx.mode === "merge" && !!current, errors);
      if (!parsed) { result.skipped += 1; continue; }
      const data = resolvedId ? { name: parsed.name, ...parsed.data } : parsed.data;
      await applyRow({
        mode: ctx.mode,
        raw: { ...raw, name: parsed.name },
        data,
        current,
        create: (d) =>
          ctx.tx.choreTemplate.create({ data: { lodgeId, name: parsed.name, ...(d as object) } as never }),
        update: (write) =>
          ctx.tx.choreTemplate.update({ where: { id: current!.id }, data: write }),
        result,
      });
    }
  }

  return result;
}

export const lodgeOpsImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planLodgeOps,
  apply: applyLodgeOps,
};
