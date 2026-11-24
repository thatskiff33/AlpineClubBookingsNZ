import { strToU8 } from "fflate";

import { lockFeeSchedule } from "@/lib/authoritative-fees";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import type { BundleEntry } from "../bundle";
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type ImportMode,
  type PlanContext,
  type PlanItem,
  type TxDb,
} from "../import-types";
import { nz, readCsvRows } from "../values";
import {
  CATEGORIES_FILE,
  CATEGORY_DATA_FIELDS,
  CATEGORY_FIELDS,
  COMPONENTS_FILE,
  COMPONENT_DATA_FIELDS,
  COMPONENT_FIELDS,
  FEES_FILE,
  FEE_DATA_FIELDS,
  FEE_FIELDS,
  loadState,
  parseBundle,
  validateCategoryRows,
  validateFeeCategories,
  validateFeeComponents,
  validateFeeWindows,
} from "./subscription-category-rows";


// subscription-categories entity (#5248): the club's SUBSCRIPTION CATEGORIES
// (the billing axis decoupled from membership type, #4554) and their flat
// annual fee schedules. Rides the membership-fees category as its own module,
// exactly as age-tier does; the fee exporter/importer never touch these tables.
//
//   membership-fees/subscription-categories.csv
//     key, name, description, isActive, sortOrder
//     natural key: `key` (SubscriptionCategory.key @unique).
//   membership-fees/subscription-category-fees.csv
//     categoryKey, effectiveFrom, effectiveTo, amountCents, prorationRule
//     natural key: categoryKey x effectiveFrom (SubscriptionCategoryFee
//     @@unique([subscriptionCategoryId, effectiveFrom])).
//   membership-fees/subscription-category-fee-components.csv
//     categoryKey, effectiveFrom, label, amountCents, prorate, xeroAccountCode,
//     xeroItemCode, sortOrder
//     natural key: (parent fee) x label — no DB unique, so key-weak, matched by
//     label within its fee like the annual-fee components.
//
// NOT carried: the built-in Individual row (`isBuiltIn`), which every install
// seeds for itself and which never has a fee; `id`, timestamps; and member
// ASSIGNMENTS — which member is in which category is member data, and member
// data never travels in a configuration bundle.
//
// IMPORT is upsert-only and never deletes, like every fee schedule here. A
// category matches by key and is updated in place; a fee matches by its
// category and start date and is updated in place (an issued charge keeps its
// own frozen snapshot, so changing a fee row never rewrites a charge). Because
// config transfer bypasses the admin API, the planner re-checks what that API
// enforces, against the EFFECTIVE POST-MERGE state (bundle rows plus target
// rows the bundle leaves in place): no row may target the built-in category; a
// NEW category key must have the admin page's shape (`isCatalogueKey`); a
// category name may not repeat (case-insensitive) under a different key; every
// fee carries components summing exactly to its amount; and a category's fee
// windows may not overlap — the database has no constraint for the last one.

registerEntity({
  entity: "subscription-category",
  category: "membership-fees",
  tier: "key-strong",
  format: "csv",
  file: CATEGORIES_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...CATEGORY_FIELDS],
});
registerEntity({
  entity: "subscription-category-fee",
  category: "membership-fees",
  tier: "key-strong",
  format: "csv",
  file: FEES_FILE,
  naturalKey: ["categoryKey", "effectiveFrom"],
  singleton: false,
  fields: [...FEE_FIELDS],
});
registerEntity({
  entity: "subscription-category-fee-component",
  category: "membership-fees",
  tier: "key-weak",
  format: "csv",
  file: COMPONENTS_FILE,
  naturalKey: ["categoryKey", "effectiveFrom", "label"],
  singleton: false,
  fields: [...COMPONENT_FIELDS],
});

const FILES = [CATEGORIES_FILE, FEES_FILE, COMPONENTS_FILE] as const;

function bundleCarriesSubscriptionCategories(files: Map<string, Uint8Array>): boolean {
  return FILES.some((file) => files.has(file));
}

// ---- Export ------------------------------------------------------------------

function byStableOrder(a: { sortOrder: number; key: string }, b: { sortOrder: number; key: string }) {
  return a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);
}

export const subscriptionCategoriesExporter: CategoryExporter = {
  category: "membership-fees",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const state = await loadState(ctx.db);
    const categories = [...state.categories.values()]
      .filter((category) => !category.isBuiltIn)
      .sort(byStableOrder);
    // No club categories → emit nothing, so an install that never used them
    // carries no empty files.
    if (categories.length === 0) return [];

    const exported = new Set(categories.map((category) => category.key));
    const fees = [...state.fees.values()]
      .filter((fee) => exported.has(fee.categoryKey))
      .sort(
        (a, b) =>
          a.categoryKey.localeCompare(b.categoryKey) ||
          calendarDateOfDateOnlyInstant(a.effectiveFrom).localeCompare(
            calendarDateOfDateOnlyInstant(b.effectiveFrom),
          ),
      );

    const categoryRows = categories.map((category) => ({
      key: category.key,
      name: category.name,
      description: category.description ?? "",
      isActive: category.isActive,
      sortOrder: category.sortOrder,
    }));
    const feeRows: Record<string, unknown>[] = [];
    const componentRows: Record<string, unknown>[] = [];
    for (const fee of fees) {
      feeRows.push({
        categoryKey: fee.categoryKey,
        effectiveFrom: calendarDateOfDateOnlyInstant(fee.effectiveFrom),
        effectiveTo: fee.effectiveTo ? calendarDateOfDateOnlyInstant(fee.effectiveTo) : "",
        amountCents: fee.amountCents,
        prorationRule: fee.prorationRule,
      });
      const components = [...fee.components].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      );
      for (const component of components) {
        componentRows.push({
          categoryKey: fee.categoryKey,
          effectiveFrom: calendarDateOfDateOnlyInstant(fee.effectiveFrom),
          label: component.label,
          amountCents: component.amountCents,
          prorate: component.prorate,
          xeroAccountCode: component.xeroAccountCode,
          xeroItemCode: component.xeroItemCode,
          sortOrder: component.sortOrder,
        });
      }
    }

    return [
      {
        path: CATEGORIES_FILE,
        category: "membership-fees",
        rowCount: categoryRows.length,
        bytes: strToU8(serialiseCsv([...CATEGORY_FIELDS], categoryRows)),
      },
      {
        path: FEES_FILE,
        category: "membership-fees",
        rowCount: feeRows.length,
        bytes: strToU8(serialiseCsv([...FEE_FIELDS], feeRows)),
      },
      {
        path: COMPONENTS_FILE,
        category: "membership-fees",
        rowCount: componentRows.length,
        bytes: strToU8(serialiseCsv([...COMPONENT_FIELDS], componentRows)),
      },
    ];
  },
};

// ---- Plan --------------------------------------------------------------------

function planItem(
  entity: string,
  key: string,
  mode: ImportMode,
  raw: Record<string, string>,
  data: Record<string, unknown>,
  current: object | null,
): PlanItem {
  const changed = changedFields(updateDataForMode(mode, raw, data), current);
  return { entity, key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined };
}

async function planSubscriptionCategories(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  // Files absent → no change, and the delegate is never read, so an older
  // bundle imports exactly as before.
  if (!bundleCarriesSubscriptionCategories(ctx.files)) {
    return { items, warnings: [], errors, fingerprintParts };
  }
  const parsed = parseBundle(ctx.files, errors);
  const state = await loadState(ctx.db);
  validateCategoryRows(parsed, state, errors);
  validateFeeCategories(parsed, state, errors);
  validateFeeWindows(parsed, state, ctx.mode, errors);
  validateFeeComponents(parsed, state, ctx.mode, errors, ctx.format);

  for (const row of parsed.categories) {
    const current = state.categories.get(row.key) ?? null;
    fingerprintParts.push(
      `subscription-category:${row.key}:${current ? hashRow([...CATEGORY_DATA_FIELDS, "isBuiltIn"], current) : "absent"}`,
    );
    items.push(planItem("subscription-category", row.key, ctx.mode, row.raw, row.data, current));
  }
  for (const row of parsed.fees) {
    const current = state.fees.get(row.key) ?? null;
    fingerprintParts.push(
      `subscription-category-fee:${row.key}:${current ? hashRow([...FEE_DATA_FIELDS], current) : "absent"}`,
    );
    items.push(planItem("subscription-category-fee", row.key, ctx.mode, row.raw, row.data, current));
  }
  for (const row of parsed.components) {
    const current = state.fees.get(row.parentKey)?.components.find((c) => c.label === row.label) ?? null;
    fingerprintParts.push(
      `subscription-category-fee-component:${row.key}:${current ? hashRow([...COMPONENT_DATA_FIELDS], current) : "absent"}`,
    );
    items.push(planItem("subscription-category-fee-component", row.key, ctx.mode, row.raw, row.data, current));
  }
  return { items, warnings: [], errors, fingerprintParts };
}

// ---- Apply -------------------------------------------------------------------

/**
 * Take the fee-schedule lock of every EXISTING category the bundle's fee rows
 * touch, in id order, so the in-lock re-plan's overlap and component checks and
 * the writes see one serialised schedule — the same per-category lock the fee
 * configuration route takes. Called by the apply orchestrator after the
 * config-import lock and before the re-plan. A category the import creates
 * needs none: no other writer can see its id yet.
 */
export async function lockAffectedSubscriptionCategoryFeeSchedules(
  tx: TxDb,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const keys = [
    ...new Set(
      [...readCsvRows(files, FEES_FILE), ...readCsvRows(files, COMPONENTS_FILE)]
        .map((raw) => nz(raw.categoryKey))
        .filter((key): key is string => key !== null),
    ),
  ];
  if (keys.length === 0) return;
  const categories = await tx.subscriptionCategory.findMany({
    where: { key: { in: keys } },
    select: { id: true },
  });
  for (const id of categories.map((category) => category.id).sort()) {
    await lockFeeSchedule(tx, "subscriptionCategory", id);
  }
}

async function applySubscriptionCategories(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  if (!bundleCarriesSubscriptionCategories(ctx.files)) return result;
  const errors: string[] = []; // the plan blocked every error; defensive only
  const parsed = parseBundle(ctx.files, errors);
  const state = await loadState(ctx.tx);

  // Categories, by key: create, or update the target's own row in place.
  const categoryIdByKey = new Map(
    [...state.categories.values()].map((category) => [category.key, category.id]),
  );
  for (const row of parsed.categories) {
    const current = state.categories.get(row.key) ?? null;
    if (current?.isBuiltIn) {
      result.skipped += 1;
      continue;
    }
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: async (data) => {
        const created = await ctx.tx.subscriptionCategory.create({
          data: { key: row.key, isBuiltIn: false, ...data },
          select: { id: true },
        });
        categoryIdByKey.set(row.key, created.id);
      },
      update: (write) => ctx.tx.subscriptionCategory.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  // Fees, by category and start date; keep each fee's id for its components.
  const feeIdByKey = new Map<string, string>();
  for (const row of parsed.fees) {
    const subscriptionCategoryId = categoryIdByKey.get(row.categoryKey);
    if (!subscriptionCategoryId || state.categories.get(row.categoryKey)?.isBuiltIn) {
      result.skipped += 1;
      continue;
    }
    const current = state.fees.get(row.key) ?? null;
    if (current) feeIdByKey.set(row.key, current.id);
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: async (data) => {
        const created = await ctx.tx.subscriptionCategoryFee.create({
          data: {
            subscriptionCategoryId,
            effectiveFrom: row.effectiveFrom,
            ...data,
          } as never,
          select: { id: true },
        });
        feeIdByKey.set(row.key, created.id);
      },
      update: (write) =>
        ctx.tx.subscriptionCategoryFee.update({ where: { id: current!.id }, data: write as never }),
      result,
    });
  }

  // Components, by fee and label. Upsert-only: the plan has already refused
  // any import whose leftover components would break Σ = fee amount.
  for (const row of parsed.components) {
    const subscriptionCategoryFeeId = feeIdByKey.get(row.parentKey);
    if (!subscriptionCategoryFeeId) {
      result.skipped += 1;
      continue;
    }
    const current =
      state.fees.get(row.parentKey)?.components.find((component) => component.label === row.label) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: (data) =>
        ctx.tx.subscriptionCategoryFeeComponent.create({
          data: { subscriptionCategoryFeeId, label: row.label, ...data },
          select: { id: true },
        }),
      update: (write) =>
        ctx.tx.subscriptionCategoryFeeComponent.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }
  return result;
}

export const subscriptionCategoriesImporter: CategoryImporter = {
  category: "membership-fees",
  plan: planSubscriptionCategories,
  apply: applySubscriptionCategories,
};
