import { createHash } from "node:crypto";

import type { PrismaClient, Prisma } from "@prisma/client";

import type { ConfigTransferCategory, ConfigTransferManifest } from "./manifest";

// Import-side contracts: plan (dry-run) and apply. Categories are upsert-only
// except the explicitly previewed booking-policy replace-set (ADR-002). The
// plan is stateless — recomputed at apply time and guarded by a fingerprint of
// the touched rows so a concurrent DB change forces a re-plan.

/**
 * Read-side client for planners. TransactionClient-shaped so the SAME planner
 * code runs against the global client (preview) and inside the apply
 * transaction (the in-lock drift re-plan) — PrismaClient is structurally
 * assignable to it.
 */
export type ReadDb = Prisma.TransactionClient | PrismaClient;
export type TxDb = Prisma.TransactionClient;

/**
 * A key-weak match resolution chosen in the dry-run picker: "bundle row `key`
 * of `entity` IS existing row `matchId` (renamed)". Bound into the fingerprint
 * so apply refuses resolutions that weren't previewed.
 */
export interface MatchResolution {
  entity: string;
  key: string;
  matchId: string;
}

/** Lookup key for a resolution. */
export function resolutionKey(entity: string, key: string): string {
  return `${entity}\u0000${key}`;
}

export function resolutionMap(
  resolutions: MatchResolution[],
): Map<string, string> {
  return new Map(
    resolutions.map((r) => [resolutionKey(r.entity, r.key), r.matchId]),
  );
}

/**
 * How an import writes fields onto an EXISTING row:
 * - "merge" (default): only fields whose bundle value is present + non-empty are
 *   written; blank/omitted fields keep the target's existing value. Safe with
 *   the always-emitted full skeleton — a partial bundle patches, never wipes.
 * - "overwrite": the bundle fully defines the row; blank fields clear the target.
 * Creates always use the bundle's values regardless of mode (nothing to keep).
 */
export type ImportMode = "merge" | "overwrite";

/** True for any present non-null value except an empty/blank string. */
export function rawHasValue(
  raw: Record<string, unknown>,
  field: string,
): boolean {
  const value = raw[field];
  if (value === null || value === undefined) return false;
  return typeof value === "string" ? value.trim() !== "" : true;
}

/**
 * The field set to write on UPDATE for the given mode. In merge mode, drop any
 * field whose bundle source (`raw`) is blank/omitted so the target keeps its
 * existing value; in overwrite mode, write everything. `data` keys must match
 * the bundle column/key names (they do across all categories).
 */
export function updateDataForMode<T extends Record<string, unknown>>(
  mode: ImportMode,
  raw: Record<string, unknown>,
  data: T,
): Partial<T> {
  if (mode === "overwrite") return data;
  const out: Partial<T> = {};
  for (const key of Object.keys(data) as (keyof T & string)[]) {
    if (rawHasValue(raw, key)) out[key] = data[key];
  }
  return out;
}

/**
 * Canonical string form of a field value for change detection. Compares the
 * value the apply WOULD write (already coerced to its DB type) against the
 * current DB value — both are the same type, so this canonical form (date-only
 * for Date, "" for null/undefined, String() otherwise) compares them accurately
 * without false positives from formatting.
 */
const DATEISH_STRING = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?)?$/;

export function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  // A bundle-side ISO date/date-time STRING must compare equal to the DB-side
  // Date it represents (e.g. a DateTime setting serialised by JSON.stringify,
  // or a YYYY-MM-DD cell vs a @db.Date column) — canonicalise both to ISO.
  if (typeof value === "string" && DATEISH_STRING.test(value)) {
    const date = new Date(
      value.length === 10 ? `${value}T00:00:00.000Z` : value,
    );
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  // Json columns (e.g. Lodge.displayConfig, DisplayTemplate.definition):
  // canonicalise structurally with sorted keys so equal objects compare equal
  // regardless of key order — String(value) would collapse every object to
  // "[object Object]" and hide changes.
  if (typeof value === "object") {
    return comparisonJson(value);
  }
  return String(value);
}

/**
 * A key-sorted rendering of a value, FOR COMPARING TWO OF THEM AND NOTHING ELSE.
 *
 * ## Why this is not `stableStringify` (#3251)
 *
 * It looks like the canonical deterministic stringifier in
 * `@/lib/stable-digest`, and it is deliberately NOT it. Two facts decide that:
 *
 * 1. **This is not an identity.** Nothing here is hashed, stored, or re-derived
 *    later and compared against a stored value. The output exists for the
 *    length of one `!==` inside `changedFields`, to decide whether an import
 *    preview should call a row changed. `INV-SSOT-001` is about one FACT having
 *    one home, and "a stored key that must survive a redeploy" and "a scratch
 *    string two values are compared through" are different facts.
 * 2. **They are not byte-equivalent, so adopting the canonical helper would be
 *    an unforced behaviour change.** This function renders a one-element array
 *    holding `undefined` as `"[]"` — `JSON.stringify(undefined)` returns the
 *    VALUE `undefined`, which `Array#join` renders as the empty string — while
 *    the canonical `stableStringify` renders it `"[null]"`, because
 *    `JSON.stringify` maps a hole in an array to `null`. Measured, not assumed;
 *    `config-transfer-import-types.test.ts` pins both sides of that divergence.
 *    Neither answer is wrong; they answer different questions, and swapping one
 *    for the other inside a differ would silently change which rows an operator
 *    is told changed.
 *
 * The NAME is what #3251 was actually about: the old one read as a near-synonym
 * of `stableStringify` and invited a future reader to "finish the job" by
 * importing the canonical one. `comparisonJson` says what it is for.
 */
function comparisonJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(comparisonJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${comparisonJson(record[key])}`)
    .join(",")}}`;
}

/**
 * The allowlisted fields that differ between the write-data (what apply would
 * write for the chosen mode) and the current row. Empty when nothing changes,
 * so the planner can reclassify a no-op update as "unchanged".
 */
export function changedFields(
  writeData: Record<string, unknown>,
  current: object | null,
): string[] {
  if (!current) return [];
  const row = current as Record<string, unknown>;
  const changed: string[] = [];
  for (const field of Object.keys(writeData)) {
    if (canonicalValue(writeData[field]) !== canonicalValue(row[field])) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * Classify an existing/absent row into a plan action for the chosen mode. A row
 * that exists but whose write-data matches the current values is "unchanged".
 */
export function planActionFor(
  current: object | null,
  changed: string[],
): PlanAction {
  if (!current) return "create";
  return changed.length > 0 ? "update" : "unchanged";
}

export type PlanAction = "create" | "update" | "delete" | "unchanged";

export interface PlanItem {
  entity: string;
  /** Display value of the natural key, e.g. the slug. */
  key: string;
  action: PlanAction;
  /** For updates: which allowlisted fields differ. */
  changedFields?: string[];
  /**
   * Key-weak match candidates for an unmatched (create) row: existing rows the
   * admin may declare this row a rename of. Picking one becomes a
   * MatchResolution bound into the apply fingerprint.
   */
  candidates?: Array<{ id: string; label: string }>;
}

export interface CategoryPlanResult {
  items: PlanItem[];
  /** Behaviour-change / ambiguity notes surfaced in the dry-run. */
  warnings: string[];
  /**
   * Row-validation failures ("file row N: field — message"). Errors BLOCK
   * apply: the bundle is fixed and re-previewed; the import never writes less
   * or different data than the file says.
   */
  errors: string[];
  /**
   * Stable strings describing the CURRENT state of every row this category
   * would touch. Hashed into the global fingerprint so apply can detect drift
   * since the plan was shown.
   */
  fingerprintParts: string[];
  /** Slugs of lodges whose door code this plan would set or change. */
  doorCodeChanges?: string[];
}

export interface CategoryPlan extends CategoryPlanResult {
  category: ConfigTransferCategory;
}

export interface ImportPlan {
  formatVersion: number;
  categories: CategoryPlan[];
  /**
   * Fingerprint binding EVERYTHING the apply depends on: the touched rows'
   * current DB state, the bundle bytes (sha256), the write mode, the selected
   * categories, and any match resolutions. Apply re-derives it inside the
   * transaction (under the advisory lock) and refuses on any mismatch — what
   * was previewed is exactly what is applied (ADR-002).
   */
  fingerprint: string;
  doorCodesIncluded: boolean;
  /** Lodges whose door code this import would set or change (slugs only). */
  doorCodeChanges: string[];
  /** Categories this plan covers (manifest categories ∩ admin selection). */
  selectedCategories: ConfigTransferCategory[];
  /**
   * Advisory bundle-integrity notes (checksum drift, declared-but-missing or
   * present-but-undeclared files) from a hand-edited bundle. Shown in the
   * dry-run; never blocks. See ADR-001 "hand-edit".
   */
  integrityWarnings: string[];
  /** Aggregated row-validation failures. Non-empty → apply is refused. */
  errors: string[];
  xero: {
    sourceTenantId: string | null;
    targetTenantId: string | null;
    mismatch: boolean;
  };
  summary: { create: number; update: number; delete: number; unchanged: number };
}

export interface CategoryApplyResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: number;
}

export interface PlanContext {
  db: ReadDb;
  files: Map<string, Uint8Array>;
  manifest: ConfigTransferManifest;
  /** Drives the per-field change preview: merge ignores blank fields. */
  mode: ImportMode;
  /** Admin-chosen key-weak match resolutions, keyed by resolutionKey(). */
  resolutions: Map<string, string>;
  /**
   * Effective categories this import will apply (manifest ∩ admin selection). A
   * category planner needs this to reason about cross-category precedence — e.g.
   * xero-config's legacy joining-fee materialisation is only superseded when the
   * membership-fees category is ACTUALLY being applied (#1941). Always populated
   * by the plan orchestrator; optional so ad-hoc callers/tests need not set it
   * (a consumer treats absence as "no cross-category precedence in effect").
   */
  selectedCategories?: ConfigTransferCategory[];
}

/** Facts collected during apply for the audit record (never secret VALUES). */
export interface ApplyNotes {
  /** Slugs of lodges whose door code was actually written. */
  doorCodesWritten: string[];
}

export interface ApplyContext {
  tx: TxDb;
  files: Map<string, Uint8Array>;
  manifest: ConfigTransferManifest;
  /** merge (blank fields keep existing) vs overwrite (blank fields clear). */
  mode: ImportMode;
  /** Admin-chosen key-weak match resolutions, keyed by resolutionKey(). */
  resolutions: Map<string, string>;
  /** Member id performing the import, for audit-of-who fields. */
  actorMemberId: string;
  /** Old MediaImage id → new id, for rewriting /api/images/<id> in content. */
  imageRemap: Map<string, string>;
  /** Mutable audit facts (e.g. which lodges' door codes were written). */
  notes: ApplyNotes;
  /**
   * Effective categories this import is applying (manifest ∩ admin selection).
   * Lets a category importer honour cross-category precedence — e.g. xero-config
   * only skips the legacy joining-fee materialisation when membership-fees is
   * actually being applied (#1941). Always populated by the apply orchestrator;
   * optional so ad-hoc callers/tests need not set it.
   */
  selectedCategories?: ConfigTransferCategory[];
}

export interface CategoryImporter {
  category: ConfigTransferCategory;
  plan(ctx: PlanContext): Promise<CategoryPlanResult>;
  apply(ctx: ApplyContext): Promise<CategoryApplyResult>;
}

/**
 * Stable content hash of an allowlisted row projection (order-independent).
 *
 * ## Considered and deliberately left alone by the #3250 sweep
 *
 * This is a third `sha256(JSON.stringify(...))` in the deterministic-identity
 * family, and the sweep that gave that family one home looked at it and did not
 * move it. The reasoning, recorded so the next reader inherits a decision rather
 * than an oversight:
 *
 * - The FIELD LIST is already ordinal — `[...fields].sort()` with no comparator
 *   is a code-unit sort — so the locale hazard #3252 was about does not reach
 *   here at all.
 * - The residual difference from `stableDigest` is that a field's VALUE may be a
 *   Json column whose keys arrive in insertion order, which this does not
 *   normalise. That is a genuine latent hazard, and it is NOT a locale one.
 * - Its remedy is not free: this hash is the preview-to-apply fingerprint of a
 *   config import, so adopting a different derivation refuses every in-flight
 *   preview at deploy. That is a self-healing refusal, but it is a behaviour
 *   change with no reported defect behind it, on a path none of #3250/#3251/#3252
 *   names in its body — so it belongs in its own issue with its own evidence,
 *   not folded into this one.
 */
export function hashRow(fields: string[], row: object): string {
  const record = row as Record<string, unknown>;
  const ordered = [...fields].sort();
  const canonical = JSON.stringify(
    ordered.map((f) => [f, record[f] ?? null]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Everything the fingerprint binds beyond the touched rows' DB state. */
export interface FingerprintBinding {
  /** sha256 hex of the uploaded bundle bytes. */
  bundleSha256: string;
  mode: ImportMode;
  selectedCategories: ConfigTransferCategory[];
  resolutions: MatchResolution[];
}

/**
 * Compute the global fingerprint: touched-row state parts PLUS the bundle
 * bytes, mode, category selection, and resolutions — so apply refuses not just
 * DB drift but a substituted bundle, a switched mode, a different selection, or
 * unpreviewed resolutions (order-stable throughout).
 */
export function computeFingerprint(
  parts: string[],
  binding: FingerprintBinding,
): string {
  const bound = [
    `bundle:${binding.bundleSha256}`,
    `mode:${binding.mode}`,
    `selection:${[...binding.selectedCategories].sort().join(",")}`,
    ...binding.resolutions
      .map((r) => `resolution:${resolutionKey(r.entity, r.key)}=${r.matchId}`)
      .sort(),
  ];
  return createHash("sha256")
    .update([...parts].sort().concat(bound).join("\n"))
    .digest("hex");
}

/**
 * Shared keyed-row apply: the single choke point for write-mode filtering and
 * truthful result counting. Skips the DB write entirely when the mode-filtered
 * write-data matches the current row (counted "unchanged", mirroring the plan's
 * classification), so post-apply results and the audit agree with the preview.
 */
export async function applyRow<T extends Record<string, unknown>>(params: {
  mode: ImportMode;
  raw: Record<string, unknown>;
  data: T;
  /** Current row with the SAME field set as `data` selected, or null. */
  current: object | null;
  create: (data: T) => Promise<unknown>;
  update: (writeData: Partial<T>) => Promise<unknown>;
  result: CategoryApplyResult;
}): Promise<void> {
  const { mode, raw, data, current, create, update, result } = params;
  if (!current) {
    await create(data);
    result.created += 1;
    return;
  }
  const write = updateDataForMode(mode, raw, data);
  const changed = changedFields(write, current);
  if (changed.length === 0) {
    result.unchanged += 1;
    return;
  }
  await update(write);
  result.updated += 1;
}
