import { strToU8 } from "fflate";

import {
  FeeScheduleValidationError,
  lockFeeSchedule,
  validateSubscriptionCategoryFeeComponents,
} from "@/lib/authoritative-fees";
import type { ClubFormat } from "@/lib/club-format";
import { formatDateOnly } from "@/lib/date-only";
import type { BundleEntry } from "../bundle";
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  rawHasValue,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type ImportMode,
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";
import { RowValidator, nz, readCsvRows } from "../values";
import { describeWindow, windowsOverlap } from "./membership-fees";

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
// category name may not repeat (case-insensitive) under a different key; every
// fee carries components summing exactly to its amount; and a category's fee
// windows may not overlap — the database has no constraint for the last one.

const CATEGORIES_FILE = "membership-fees/subscription-categories.csv";
const FEES_FILE = "membership-fees/subscription-category-fees.csv";
const COMPONENTS_FILE = "membership-fees/subscription-category-fee-components.csv";

const CATEGORY_FIELDS = ["key", "name", "description", "isActive", "sortOrder"] as const;
const CATEGORY_DATA_FIELDS = ["name", "description", "isActive", "sortOrder"] as const;
const FEE_FIELDS = [
  "categoryKey",
  "effectiveFrom",
  "effectiveTo",
  "amountCents",
  "prorationRule",
] as const;
const FEE_DATA_FIELDS = ["effectiveTo", "amountCents", "prorationRule"] as const;
const COMPONENT_FIELDS = [
  "categoryKey",
  "effectiveFrom",
  "label",
  "amountCents",
  "prorate",
  "xeroAccountCode",
  "xeroItemCode",
  "sortOrder",
] as const;
const COMPONENT_DATA_FIELDS = [
  "amountCents",
  "prorate",
  "xeroAccountCode",
  "xeroItemCode",
  "sortOrder",
] as const;

// Mirrors the admin category route's schema.
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SORT_ORDER = 100000;
const DEFAULT_PRORATION_RULE = "NONE";

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

function toDateStr(value: Date | null): string {
  return value ? formatDateOnly(value) : "";
}

function feeKey(categoryKey: string, effectiveFrom: Date): string {
  return `${categoryKey}/${toDateStr(effectiveFrom)}`;
}

// ---- Current-state loading (shared by export, plan and apply) ----------------

interface CategoryCurrent {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  sortOrder: number;
}
interface ComponentCurrent {
  id: string;
  label: string;
  amountCents: number;
  prorate: boolean;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  sortOrder: number;
}
interface FeeCurrent {
  id: string;
  categoryKey: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  amountCents: number;
  prorationRule: string;
  components: ComponentCurrent[];
}
interface SubscriptionCategoryState {
  categories: Map<string, CategoryCurrent>;
  /** by feeKey(categoryKey, effectiveFrom) */
  fees: Map<string, FeeCurrent>;
}

async function loadState(db: ReadDb): Promise<SubscriptionCategoryState> {
  const rows = await db.subscriptionCategory.findMany({
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      isActive: true,
      isBuiltIn: true,
      sortOrder: true,
      fees: {
        select: {
          id: true,
          effectiveFrom: true,
          effectiveTo: true,
          amountCents: true,
          prorationRule: true,
          components: {
            select: {
              id: true,
              label: true,
              amountCents: true,
              prorate: true,
              xeroAccountCode: true,
              xeroItemCode: true,
              sortOrder: true,
            },
          },
        },
      },
    },
  });
  const categories = new Map<string, CategoryCurrent>();
  const fees = new Map<string, FeeCurrent>();
  for (const { fees: categoryFees, ...category } of rows) {
    categories.set(category.key, category);
    for (const fee of categoryFees) {
      fees.set(feeKey(category.key, fee.effectiveFrom), { ...fee, categoryKey: category.key });
    }
  }
  return { categories, fees };
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
          toDateStr(a.effectiveFrom).localeCompare(toDateStr(b.effectiveFrom)),
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
        effectiveFrom: toDateStr(fee.effectiveFrom),
        effectiveTo: toDateStr(fee.effectiveTo),
        amountCents: fee.amountCents,
        prorationRule: fee.prorationRule,
      });
      const components = [...fee.components].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      );
      for (const component of components) {
        componentRows.push({
          categoryKey: fee.categoryKey,
          effectiveFrom: toDateStr(fee.effectiveFrom),
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

// ---- Row parsing + strict validation (shared by plan and apply) --------------

interface ParsedCategory {
  raw: Record<string, string>;
  key: string;
  data: { name: string; description: string | null; isActive: boolean; sortOrder: number };
}
interface ParsedFee {
  raw: Record<string, string>;
  categoryKey: string;
  effectiveFrom: Date;
  key: string;
  data: { effectiveTo: Date | null; amountCents: number; prorationRule: string };
}
interface ParsedComponent {
  raw: Record<string, string>;
  parentKey: string;
  label: string;
  key: string;
  data: {
    amountCents: number;
    prorate: boolean;
    xeroAccountCode: string | null;
    xeroItemCode: string | null;
    sortOrder: number;
  };
}
interface ParsedBundle {
  categories: ParsedCategory[];
  fees: ParsedFee[];
  components: ParsedComponent[];
}

function parseCategories(files: Map<string, Uint8Array>, errors: string[]): ParsedCategory[] {
  const out: ParsedCategory[] = [];
  const seen = new Set<string>();
  readCsvRows(files, CATEGORIES_FILE).forEach((raw, i) => {
    const v = new RowValidator(CATEGORIES_FILE, i, errors);
    const key = v.required("key", raw.key);
    const name = v.required("name", raw.name);
    if (v.ok && name.length > MAX_NAME_LENGTH) {
      errors.push(`${CATEGORIES_FILE} row ${i + 2}: name — must be at most ${MAX_NAME_LENGTH} characters`);
    }
    const description = nz(raw.description);
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `${CATEGORIES_FILE} row ${i + 2}: description — must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    const isActive = nz(raw.isActive) === null ? true : v.bool("isActive", raw.isActive);
    const sortOrder = nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
    if (v.ok && (sortOrder < 0 || sortOrder > MAX_SORT_ORDER)) {
      errors.push(`${CATEGORIES_FILE} row ${i + 2}: sortOrder — must be between 0 and ${MAX_SORT_ORDER}`);
    }
    if (!v.ok) return;
    if (seen.has(key)) {
      errors.push(`${CATEGORIES_FILE}: duplicate row for key "${key}" — each category may appear at most once`);
      return;
    }
    seen.add(key);
    out.push({ raw, key, data: { name, description, isActive, sortOrder } });
  });
  return out;
}

function parseFees(files: Map<string, Uint8Array>, errors: string[]): ParsedFee[] {
  const out: ParsedFee[] = [];
  const seen = new Set<string>();
  readCsvRows(files, FEES_FILE).forEach((raw, i) => {
    const v = new RowValidator(FEES_FILE, i, errors);
    const categoryKey = v.required("categoryKey", raw.categoryKey);
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const effectiveTo = nz(raw.effectiveTo) === null ? null : v.date("effectiveTo", raw.effectiveTo);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    const prorationRule =
      nz(raw.prorationRule) === null
        ? DEFAULT_PRORATION_RULE
        : v.enum("prorationRule", "MembershipFeeProrationRule", raw.prorationRule);
    if (v.ok && effectiveTo !== null && effectiveTo < effectiveFrom) {
      errors.push(`${FEES_FILE} row ${i + 2}: effectiveTo — cannot be before effectiveFrom`);
    }
    if (!v.ok) return;
    const key = feeKey(categoryKey, effectiveFrom);
    if (seen.has(key)) {
      errors.push(`${FEES_FILE}: duplicate row for fee "${key}" — each category fee window may appear at most once`);
      return;
    }
    seen.add(key);
    out.push({ raw, categoryKey, effectiveFrom, key, data: { effectiveTo, amountCents, prorationRule } });
  });
  return out;
}

function parseComponents(files: Map<string, Uint8Array>, errors: string[]): ParsedComponent[] {
  const out: ParsedComponent[] = [];
  readCsvRows(files, COMPONENTS_FILE).forEach((raw, i) => {
    const v = new RowValidator(COMPONENTS_FILE, i, errors);
    const categoryKey = v.required("categoryKey", raw.categoryKey);
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const label = v.required("label", raw.label);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    const prorate = nz(raw.prorate) === null ? true : v.bool("prorate", raw.prorate);
    const sortOrder = nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
    if (!v.ok) return;
    const parentKey = feeKey(categoryKey, effectiveFrom);
    out.push({
      raw,
      parentKey,
      label,
      key: `${parentKey}/${label}`,
      data: {
        amountCents,
        prorate,
        xeroAccountCode: nz(raw.xeroAccountCode),
        xeroItemCode: nz(raw.xeroItemCode),
        sortOrder,
      },
    });
  });
  return out;
}

function parseBundle(files: Map<string, Uint8Array>, errors: string[]): ParsedBundle {
  return {
    categories: parseCategories(files, errors),
    fees: parseFees(files, errors),
    components: parseComponents(files, errors),
  };
}

/** The value a merge-mode import keeps when the bundle cell is blank. */
function effective<T>(mode: ImportMode, raw: Record<string, string>, field: string, bundle: T, current: T | undefined): T {
  return mode === "overwrite" || rawHasValue(raw, field) || current === undefined ? bundle : current;
}

// ---- Post-merge validation (plan time, and again at the in-lock re-plan) -----

function validateCategoryRows(parsed: ParsedBundle, state: SubscriptionCategoryState, errors: string[]): void {
  for (const row of parsed.categories) {
    if (state.categories.get(row.key)?.isBuiltIn) {
      errors.push(
        `${CATEGORIES_FILE}: category "${row.key}" is the target's built-in Individual category, which config transfer never changes — remove the row`,
      );
    }
  }
  // Names are unique case-insensitively (the admin route refuses a duplicate),
  // judged across the target categories the bundle leaves in place plus the
  // bundle's own rows.
  const keyByName = new Map<string, string>();
  const bundleKeys = new Set(parsed.categories.map((row) => row.key));
  for (const category of state.categories.values()) {
    if (!bundleKeys.has(category.key)) keyByName.set(category.name.toLowerCase(), category.key);
  }
  for (const row of parsed.categories) {
    const name = row.data.name.toLowerCase();
    const clash = keyByName.get(name);
    if (clash !== undefined && clash !== row.key) {
      errors.push(
        `${CATEGORIES_FILE}: category "${row.key}" is named "${row.data.name}", which category "${clash}" already uses — category names must be unique; rename one on the Subscription Categories page or in the bundle`,
      );
    }
    keyByName.set(name, row.key);
  }
}

function validateFeeCategories(parsed: ParsedBundle, state: SubscriptionCategoryState, errors: string[]): void {
  const bundleKeys = new Set(parsed.categories.map((row) => row.key));
  for (const fee of parsed.fees) {
    const target = state.categories.get(fee.categoryKey);
    if (target?.isBuiltIn) {
      errors.push(
        `${FEES_FILE}: fee "${fee.key}" names the built-in Individual category, which never bills a fee of its own`,
      );
    } else if (!target && !bundleKeys.has(fee.categoryKey)) {
      errors.push(
        `${FEES_FILE}: fee "${fee.key}" names category "${fee.categoryKey}", which is neither in ${CATEGORIES_FILE} nor on the target`,
      );
    }
  }
}

/** A category's fee windows may not overlap after the merge (the DB does not check). */
function validateFeeWindows(
  parsed: ParsedBundle,
  state: SubscriptionCategoryState,
  mode: ImportMode,
  errors: string[],
): void {
  type Window = { key: string; effectiveFrom: Date; effectiveTo: Date | null };
  const byCategory = new Map<string, Window[]>();
  const push = (categoryKey: string, window: Window) =>
    byCategory.set(categoryKey, [...(byCategory.get(categoryKey) ?? []), window]);
  const bundleKeys = new Set(parsed.fees.map((fee) => fee.key));
  for (const fee of state.fees.values()) {
    if (!bundleKeys.has(feeKey(fee.categoryKey, fee.effectiveFrom))) {
      push(fee.categoryKey, { key: feeKey(fee.categoryKey, fee.effectiveFrom), ...fee });
    }
  }
  for (const fee of parsed.fees) {
    const current = state.fees.get(fee.key);
    push(fee.categoryKey, {
      key: fee.key,
      effectiveFrom: fee.effectiveFrom,
      effectiveTo: effective(mode, fee.raw, "effectiveTo", fee.data.effectiveTo, current?.effectiveTo),
    });
  }
  for (const [categoryKey, windows] of byCategory) {
    const sorted = [...windows].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (windowsOverlap(a, b)) {
          errors.push(
            `${FEES_FILE}: category "${categoryKey}" would have overlapping fee windows ${describeWindow(a)} and ${describeWindow(b)} — a category has one fee in effect on any day; close the earlier window first`,
          );
        }
      }
    }
  }
}

/**
 * Every imported fee ends with components summing exactly to its amount — the
 * bundle's own set first, then the post-merge set (bundle components upserted
 * by label plus any target components the bundle does not carry, which an
 * upsert-only import leaves in place).
 */
function validateFeeComponents(
  parsed: ParsedBundle,
  state: SubscriptionCategoryState,
  mode: ImportMode,
  errors: string[],
  format: ClubFormat,
): void {
  const byParent = new Map<string, ParsedComponent[]>();
  for (const component of parsed.components) {
    byParent.set(component.parentKey, [...(byParent.get(component.parentKey) ?? []), component]);
  }
  const feeKeys = new Set(parsed.fees.map((fee) => fee.key));
  for (const [parentKey, components] of byParent) {
    if (!feeKeys.has(parentKey)) {
      errors.push(
        `${COMPONENTS_FILE}: component(s) reference fee "${parentKey}", which is not in ${FEES_FILE} — a component set must travel with its fee`,
      );
    }
    const labels = components.map((component) => component.label);
    const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index);
    if (duplicates.length > 0) {
      errors.push(
        `${COMPONENTS_FILE}: fee "${parentKey}" carries duplicate component label(s) ${[...new Set(duplicates)].map((label) => `"${label}"`).join(", ")} — labels must be unique within a fee`,
      );
    }
  }

  const check = (where: string, components: Array<{ label: string; amountCents: number }>, amountCents: number) => {
    try {
      validateSubscriptionCategoryFeeComponents(
        { components: components.map((component) => ({ ...component, prorate: true, sortOrder: 0 })), amountCents },
        format,
      );
    } catch (error) {
      if (!(error instanceof FeeScheduleValidationError)) throw error;
      errors.push(`${COMPONENTS_FILE}: ${where} — ${error.message}`);
    }
  };

  for (const fee of parsed.fees) {
    const bundleComponents = byParent.get(fee.key) ?? [];
    check(`fee "${fee.key}"`, bundleComponents.map((c) => ({ label: c.label, amountCents: c.data.amountCents })), fee.data.amountCents);

    const current = state.fees.get(fee.key);
    if (!current) continue;
    const currentByLabel = new Map(current.components.map((component) => [component.label, component]));
    const bundleLabels = new Set(bundleComponents.map((component) => component.label));
    const merged = [
      ...bundleComponents.map((component) => ({
        label: component.label,
        amountCents: effective(
          mode,
          component.raw,
          "amountCents",
          component.data.amountCents,
          currentByLabel.get(component.label)?.amountCents,
        ),
      })),
      ...current.components.filter((component) => !bundleLabels.has(component.label)),
    ];
    const total = effective(mode, fee.raw, "amountCents", fee.data.amountCents, current.amountCents);
    check(
      `after merging into the target's fee "${fee.key}" (an import never deletes a component the bundle leaves out)`,
      merged,
      total,
    );
  }
}

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
