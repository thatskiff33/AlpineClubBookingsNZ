import {
  FeeScheduleValidationError,
  validateSubscriptionCategoryFeeComponents,
} from "@/lib/authoritative-fees";
import type { ClubFormat } from "@/lib/club-format";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { rawHasValue, type ImportMode, type ReadDb } from "../import-types";
import { isCatalogueKey } from "@/lib/catalogue-key";
import { RowValidator, nz, readCsvRows } from "../values";
import { describeWindow, windowsOverlap } from "./membership-fees";

// The rows of the subscription-categories config-transfer module (#5248):
// file names and columns, the target's current state, strict row parsing, and
// the post-merge checks the planner runs at preview and again at the in-lock
// re-plan. The module itself (subscription-categories.ts) registers the
// entities and owns export, plan and apply; see its header for the contract.


export const CATEGORIES_FILE = "membership-fees/subscription-categories.csv";
export const FEES_FILE = "membership-fees/subscription-category-fees.csv";
export const COMPONENTS_FILE = "membership-fees/subscription-category-fee-components.csv";

export const CATEGORY_FIELDS = ["key", "name", "description", "isActive", "sortOrder"] as const;
export const CATEGORY_DATA_FIELDS = ["name", "description", "isActive", "sortOrder"] as const;
export const FEE_FIELDS = [
  "categoryKey",
  "effectiveFrom",
  "effectiveTo",
  "amountCents",
  "prorationRule",
] as const;
export const FEE_DATA_FIELDS = ["effectiveTo", "amountCents", "prorationRule"] as const;
export const COMPONENT_FIELDS = [
  "categoryKey",
  "effectiveFrom",
  "label",
  "amountCents",
  "prorate",
  "xeroAccountCode",
  "xeroItemCode",
  "sortOrder",
] as const;
export const COMPONENT_DATA_FIELDS = [
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

function feeKey(categoryKey: string, effectiveFrom: Date): string {
  return `${categoryKey}/${calendarDateOfDateOnlyInstant(effectiveFrom)}`;
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

export async function loadState(db: ReadDb): Promise<SubscriptionCategoryState> {
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

export function parseBundle(files: Map<string, Uint8Array>, errors: string[]): ParsedBundle {
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

export function validateCategoryRows(parsed: ParsedBundle, state: SubscriptionCategoryState, errors: string[]): void {
  for (const row of parsed.categories) {
    const existing = state.categories.get(row.key);
    if (existing?.isBuiltIn) {
      errors.push(
        `${CATEGORIES_FILE}: category "${row.key}" is the target's built-in Individual category, which config transfer never changes — remove the row`,
      );
    } else if (!existing && !isCatalogueKey(row.key)) {
      // A NEW key must have the shape the Subscription Categories page mints
      // (src/lib/catalogue-key.ts); an existing target key is matched as-is.
      errors.push(
        `${CATEGORIES_FILE}: category "${row.key}" is not a valid new category key — use capital letters, digits and single underscores (at most 80 characters), as the Subscription Categories page creates them`,
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

export function validateFeeCategories(parsed: ParsedBundle, state: SubscriptionCategoryState, errors: string[]): void {
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
export function validateFeeWindows(
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
export function validateFeeComponents(
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
