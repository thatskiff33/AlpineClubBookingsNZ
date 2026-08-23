import { strToU8, strFromU8 } from "fflate";
import { z } from "zod";

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
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";
import { RowValidator, nz, readCsvRows } from "../values";
import type { ConfigTransferCategory } from "../manifest";
import { bundleCarriesJoiningFeeSchedule } from "./membership-fees";
import { addDaysDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";

// xero-config category: the accounting mappings — GL account/item-code mappings
// and per-category item codes. Contact-group rules/accepted-groups are excluded
// (they FK to member types / age-tier settings and are Xero-org-specific).
// The source Xero tenant id is recorded in xero-config/source.json (sealed with
// the rest of the category, so it only exists when Xero is exported); the plan
// warns on an org mismatch so codes are verified before applying (ADR-002).
//
// Item-code identity: the FULL natural key (category, membershipTypeKey,
// ageTier, seasonType, entranceFeeCategory) INCLUDING nulls, matched via an
// in-memory map — never the compound unique with a null coerced to false, which
// could not match a null row and duplicated it on every import. HUT_FEE codes
// are keyed by membership type (#1930, E4). The old-bundle IMPORT compat — the
// legacy `isMember` HUT_FEE key (true -> FULL, false -> NON_MEMBER) and the
// pre-#1931 `ENTRANCE_FEE` category name — was retired one release after the E13
// contraction (#2131): such a bundle is now REJECTED with a clear validation
// error, never silently upgraded. `membershipTypeId`-less HUT_FEE rows are not
// exported (export side unchanged); the #2130 STEP 2 contract migration deleted
// the last of them with the `isMember` column, but the skip is kept defensively
// for forks and older databases.

const ACCOUNT_FILE = "xero-config/account-mappings.csv";
const ITEM_FILE = "xero-config/item-code-mappings.csv";
/** Provenance: the Xero org connected at export time. Category-local, sealed. */
const XERO_SOURCE_FILE = "xero-config/source.json";

const ACCOUNT_FIELDS = ["key", "code", "itemCode"] as const;
const ITEM_FIELDS = [
  "category", "membershipTypeKey", "ageTier", "seasonType", "entranceFeeCategory",
  "itemCode", "amountCents",
] as const;

/**
 * XeroItemCodeMapping.category is a plain string column. HUT_FEE and JOINING_FEE
 * are the current categories. ENTRANCE_FEE was the pre-#1931 name for
 * JOINING_FEE; the old-bundle import compat that normalised it — and the legacy
 * isMember HUT_FEE key — closed one release after the E13 contraction (#2131),
 * so such a bundle is now rejected with a clear error instead of being silently
 * upgraded. The deeper transfer of joining-fee SCHEDULE amounts is follow-up
 * #1941.
 */
const ITEM_CATEGORIES = new Set(["HUT_FEE", "JOINING_FEE"]);
/** Pre-#1931 category name; rejected on import now the compat window closed (#2131). */
const LEGACY_ENTRANCE_FEE_CATEGORY = "ENTRANCE_FEE";
const JOINING_FEE_CATEGORY = "JOINING_FEE";

const xeroSourceSchema = z.object({ tenantId: z.string().nullable() });

/** Read the source Xero tenant id from the bundle (null if absent/unparseable). */
export function readXeroSourceTenantId(
  files: Map<string, Uint8Array>,
): string | null {
  const bytes = files.get(XERO_SOURCE_FILE);
  if (!bytes) return null;
  try {
    const parsed = xeroSourceSchema.safeParse(JSON.parse(strFromU8(bytes)));
    return parsed.success ? parsed.data.tenantId : null;
  } catch {
    return null;
  }
}

/**
 * The connected Xero org (tenant) id, or null. Single definition shared by the
 * export-side provenance stamp and the import-side cross-org check, so both
 * halves of the invariant always agree.
 */
export async function connectedXeroTenantId(db: ReadDb): Promise<string | null> {
  const token = await db.xeroToken.findFirst({
    select: { tenantId: true },
    orderBy: { updatedAt: "desc" },
  });
  return token?.tenantId ?? null;
}

registerEntity({
  entity: "xero-account-mapping",
  category: "xero-config",
  tier: "key-strong",
  format: "csv",
  file: ACCOUNT_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...ACCOUNT_FIELDS],
});
registerEntity({
  entity: "xero-item-code-mapping",
  category: "xero-config",
  tier: "key-strong",
  format: "csv",
  file: ITEM_FILE,
  naturalKey: ["category", "membershipTypeKey", "ageTier", "seasonType", "entranceFeeCategory"],
  singleton: false,
  fields: [...ITEM_FIELDS],
});

// ---- Shared parsing + batched state -----------------------------------------

/** Null-honest natural key for an item-code row ("-" marks null). */
function itemKeyOf(parts: {
  category: string;
  membershipTypeKey: string | null;
  ageTier: string | null;
  seasonType: string | null;
  entranceFeeCategory: string | null;
}): string {
  return [parts.category, parts.membershipTypeKey, parts.ageTier, parts.seasonType, parts.entranceFeeCategory]
    .map((v) => (v === null || v === undefined ? "-" : String(v)))
    .join("/");
}

interface ParsedItemRow {
  raw: Record<string, string>;
  key: string;
  identity: {
    category: string;
    membershipTypeKey: string | null;
    ageTier: string | null;
    seasonType: string | null;
    entranceFeeCategory: string | null;
  };
  data: { itemCode: string | null; amountCents: number | null };
}

function parseItemRow(
  index: number,
  raw: Record<string, string>,
  errors: string[],
  membershipTypesByKey: Map<
    string,
    { id: string; bookingBehavior: string; ageGroupsApply: boolean }
  >,
): ParsedItemRow | null {
  const v = new RowValidator(ITEM_FILE, index, errors);
  const rawCategory = v.required("category", raw.category);
  // Pre-#1931 ENTRANCE_FEE rows (old bundles) are no longer silently upgraded to
  // JOINING_FEE — the import compat window closed one release after E13 (#2131).
  // Reject them with a specific, actionable message rather than the generic
  // unknown-category error or a quiet normalisation.
  if (rawCategory === LEGACY_ENTRANCE_FEE_CATEGORY) {
    errors.push(
      `${ITEM_FILE} row ${index + 2}: category — legacy "ENTRANCE_FEE" item-code rows are no longer imported (renamed to JOINING_FEE in #1931); re-export this bundle from an install running the current release`,
    );
    return null;
  }
  if (rawCategory && !ITEM_CATEGORIES.has(rawCategory)) {
    errors.push(
      `${ITEM_FILE} row ${index + 2}: category — "${rawCategory}" is not HUT_FEE or JOINING_FEE`,
    );
    return null;
  }
  const category = rawCategory;

  // Membership-type key (HUT_FEE only). The legacy pre-#1930 `isMember` column
  // (true -> FULL, false -> NON_MEMBER) is no longer imported — the compat
  // window closed one release after E13 (#2131) — so a bundle carrying it is
  // rejected here, never silently mapped.
  let membershipTypeKey: string | null = null;
  if (nz(raw.membershipTypeKey) !== null) {
    membershipTypeKey = String(nz(raw.membershipTypeKey));
  } else if (nz(raw.isMember) !== null) {
    errors.push(
      `${ITEM_FILE} row ${index + 2}: the legacy 'isMember' HUT_FEE key is no longer imported; re-export this bundle from an install running the current release`,
    );
    return null;
  }
  // A current HUT_FEE row is always membership-type-keyed; one carrying neither a
  // membershipTypeKey nor the (now rejected) legacy isMember column is malformed
  // — block it rather than silently create a keyless frozen-legacy-shaped row
  // (no silent partial import).
  if (category === "HUT_FEE" && membershipTypeKey === null) {
    errors.push(
      `${ITEM_FILE} row ${index + 2}: membershipTypeKey — a HUT_FEE item-code row must name a membership type`,
    );
    return null;
  }
  const membershipType =
    membershipTypeKey !== null ? membershipTypesByKey.get(membershipTypeKey) : undefined;
  if (membershipTypeKey !== null && !membershipType) {
    errors.push(
      `${ITEM_FILE} row ${index + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
    );
    return null;
  }

  const identity = {
    category,
    membershipTypeKey,
    ageTier: v.enumOrNull("ageTier", "AgeTier", raw.ageTier),
    seasonType: v.enumOrNull("seasonType", "SeasonType", raw.seasonType),
    entranceFeeCategory: v.enumOrNull("entranceFeeCategory", "EntranceFeeCategory", raw.entranceFeeCategory),
  };

  // D2 invariant + shape validation for HUT_FEE rows (#1930, E4), blocking
  // errors exactly like an unknown membership type: item codes may only key a
  // rate-bearing type (MEMBER_RATE, or the built-in NON_MEMBER rate holder),
  // and the row's ageTier must match the type's ageGroupsApply shape.
  if (category === "HUT_FEE" && membershipTypeKey !== null && membershipType) {
    const rateBearing =
      membershipType.bookingBehavior === "MEMBER_RATE" ||
      membershipTypeKey === "NON_MEMBER";
    if (!rateBearing) {
      errors.push(
        `${ITEM_FILE} row ${index + 2}: membershipTypeKey — membership type "${membershipTypeKey}" does not carry its own hut fees (${membershipType.bookingBehavior} types own zero HUT_FEE rows)`,
      );
      return null;
    }
    if (!membershipType.ageGroupsApply && identity.ageTier !== null) {
      errors.push(
        `${ITEM_FILE} row ${index + 2}: ageTier — membership type "${membershipTypeKey}" prices from a single flat rate; leave ageTier blank`,
      );
      return null;
    }
    if (membershipType.ageGroupsApply && identity.ageTier === null) {
      errors.push(
        `${ITEM_FILE} row ${index + 2}: ageTier — membership type "${membershipTypeKey}" uses per-age-tier rates; specify an ageTier`,
      );
      return null;
    }
  }

  const data = {
    itemCode: nz(raw.itemCode),
    amountCents: nz(raw.amountCents) === null ? null : v.moneyCents("amountCents", raw.amountCents),
  };
  if (!v.ok) return null;
  return { raw, key: itemKeyOf(identity), identity, data };
}

interface XeroBatch {
  accounts: Map<string, { id: string; key: string; code: string | null; itemCode: string | null }>;
  items: Map<string, { id: string; itemCode: string | null; amountCents: number | null }>;
  // Full descriptors for import validation (#1930, E4): HUT_FEE rows may only
  // target rate-bearing types (D2) and must match the type's ageGroupsApply
  // shape.
  membershipTypesByKey: Map<
    string,
    { id: string; bookingBehavior: string; ageGroupsApply: boolean }
  >;
  membershipTypeKeyById: Map<string, string>;
}

async function loadXeroBatch(db: ReadDb): Promise<XeroBatch> {
  const [accountRows, itemRows, membershipTypeRows] = await Promise.all([
    db.xeroAccountMapping.findMany({
      select: { id: true, key: true, code: true, itemCode: true },
    }),
    db.xeroItemCodeMapping.findMany({
      select: {
        id: true, category: true, ageTier: true, seasonType: true,
        membershipTypeId: true, entranceFeeCategory: true, itemCode: true, amountCents: true,
      },
    }),
    db.membershipType.findMany({
      select: { id: true, key: true, bookingBehavior: true, ageGroupsApply: true },
    }),
  ]);
  const membershipTypesByKey = new Map(
    membershipTypeRows.map((t) => [
      t.key,
      { id: t.id, bookingBehavior: t.bookingBehavior, ageGroupsApply: t.ageGroupsApply },
    ]),
  );
  const membershipTypeKeyById = new Map(membershipTypeRows.map((t) => [t.id, t.key]));
  const items = new Map<string, { id: string; itemCode: string | null; amountCents: number | null }>();
  for (const row of itemRows) {
    // Skip `membershipTypeId`-less HUT_FEE rows: the editor and config transfer
    // operate only on the membership-type key (#1930, E4). Defensive — the
    // #2130 STEP 2 contract migration deleted the legacy rows, but a fork's
    // database can still hold one.
    if (row.category === "HUT_FEE" && !row.membershipTypeId) continue;
    const key = itemKeyOf({
      category: row.category,
      membershipTypeKey: row.membershipTypeId
        ? membershipTypeKeyById.get(row.membershipTypeId) ?? null
        : null,
      ageTier: row.ageTier,
      seasonType: row.seasonType,
      entranceFeeCategory: row.entranceFeeCategory,
    });
    if (!items.has(key)) items.set(key, row); // first match wins on duplicates
  }
  return {
    accounts: new Map(accountRows.map((r) => [r.key, r])),
    items,
    membershipTypesByKey,
    membershipTypeKeyById,
  };
}

// ---- Joining-fee materialisation from item-code amounts (#1931, E5) ---------
//
// A bundle can carry joining-fee AMOUNTS in the amountCents column of
// xero-config/item-code-mappings.csv — a column the runtime no longer reads
// (authoritative amounts live in the JoiningFee schedule). (Pre-#1931 bundles
// used the ENTRANCE_FEE category name for these rows; that import compat closed
// in #2131, so a genuinely old bundle is now rejected before it reaches here and
// only current JOINING_FEE rows arrive.) Importing such a bundle into a fresh
// install would otherwise configure item codes but ZERO fee amounts: every
// member would join with no joining fee, silently. Mirror the migration's D-R1
// fan-out at apply time: for each imported JOINING_FEE row with a positive
// amount whose category has no
// JoiningFee window covering today on the target, materialise open windows —
// the per-tier amounts (ADULT / YOUTH / CHILD folding onto CHILD+INFANT) onto
// every joining-fee-liable membership type (all types except the built-in
// NON_MEMBER and SCHOOL and the Family type), and the FAMILY amount as a
// single flat NULL-tier row on the built-in Family type. A materialised row's
// effectiveTo is bounded to the day before that cell's earliest future window
// so it never overlaps a deliberately scheduled future fee. A category that
// already has a covering window is left entirely alone (deliberate target
// config wins). First-class fee-schedule transfer is follow-up #1941.

const JOINING_FEE_PER_TIER_TARGETS: Record<string, string[]> = {
  ADULT: ["ADULT"],
  YOUTH: ["YOUTH"],
  CHILD: ["CHILD", "INFANT"],
};
const JOINING_FEE_EXCLUDED_TYPE_KEYS = new Set(["NON_MEMBER", "SCHOOL", "FAMILY"]);
const FAMILY_MEMBERSHIP_TYPE_KEY = "FAMILY";

interface JoiningFeeWindow {
  membershipTypeId: string;
  ageTier: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function joiningFeeWindowCovers(
  window: { effectiveFrom: Date; effectiveTo: Date | null },
  day: Date,
): boolean {
  return (
    window.effectiveFrom.getTime() <= day.getTime() &&
    (window.effectiveTo === null || window.effectiveTo.getTime() >= day.getTime())
  );
}

/** Positive imported JOINING_FEE amounts by entrance-fee category. */
function importedJoiningFeeAmounts(rows: ParsedItemRow[]): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const row of rows) {
    if (row.identity.category !== JOINING_FEE_CATEGORY) continue;
    const category = row.identity.entranceFeeCategory;
    const amount = row.data.amountCents;
    if (!category || amount === null || amount <= 0) continue;
    if (!amounts.has(category)) amounts.set(category, amount); // first wins
  }
  return amounts;
}

interface JoiningFeeMaterialisationDecision {
  /** Categories (with amounts) that will materialise: no covering window. */
  materialise: Array<{ category: string; amountCents: number }>;
  warnings: string[];
  /** Coverage state per amount-bearing category, bound into the fingerprint. */
  fingerprintParts: string[];
}

/**
 * Decide which imported joining-fee categories need materialisation. Shared by
 * plan (dry-run visibility + fingerprint) and apply (re-derived in-lock on the
 * same inputs), so what was previewed is exactly what is applied.
 */
async function decideJoiningFeeMaterialisation(
  db: ReadDb,
  rows: ParsedItemRow[],
  membershipTypesByKey: Map<string, { id: string }>,
  today: Date,
): Promise<JoiningFeeMaterialisationDecision> {
  const decision: JoiningFeeMaterialisationDecision = {
    materialise: [],
    warnings: [],
    fingerprintParts: [],
  };
  const amounts = importedJoiningFeeAmounts(rows);
  if (amounts.size === 0) return decision;

  const windows: JoiningFeeWindow[] = await db.joiningFee.findMany({
    select: {
      membershipTypeId: true,
      ageTier: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  });
  const familyTypeId =
    membershipTypesByKey.get(FAMILY_MEMBERSHIP_TYPE_KEY)?.id ?? null;

  for (const [category, amountCents] of [...amounts.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const covered =
      category === "FAMILY"
        ? windows.some(
            (w) =>
              w.membershipTypeId === familyTypeId &&
              w.ageTier === null &&
              joiningFeeWindowCovers(w, today),
          )
        : windows.some(
            (w) =>
              w.ageTier !== null &&
              (JOINING_FEE_PER_TIER_TARGETS[category] ?? []).includes(w.ageTier) &&
              joiningFeeWindowCovers(w, today),
          );
    decision.fingerprintParts.push(
      `joining-fee-coverage:${category}:${covered ? "covered" : "absent"}`,
    );
    if (covered) continue;
    if (category === "FAMILY" && !familyTypeId) {
      decision.warnings.push(
        "The bundle carries a FAMILY joining-fee amount but this install has no built-in Family membership type; the family amount was not materialised.",
      );
      continue;
    }
    decision.materialise.push({ category, amountCents });
  }

  if (decision.materialise.length > 0) {
    decision.warnings.push(
      `Joining-fee windows will be created from the bundle's legacy amounts for: ${decision.materialise
        .map((m) => m.category)
        .join(", ")} (no covering JoiningFee window exists on this install). Review the amounts on the fee configuration page after importing.`,
    );
  }
  return decision;
}

/**
 * The legacy-amount fill windows for one fan-out cell: the complement, within
 * [today, +infinity), of the cell's existing JoiningFee windows (#1931 F1). The
 * removed runtime fallback billed the legacy amount on EVERY uncovered date, so
 * every gap must be filled — the leading gap before the earliest window, each
 * inter-window gap, and the open tail after a bounded last window. An existing
 * window's effectiveTo === null covers to infinity (no tail); windows ending
 * before today are irrelevant. Returned windows never overlap an existing one.
 */
function joiningFeeLegacyFillWindows(
  existing: Array<{ effectiveFrom: Date; effectiveTo: Date | null }>,
  today: Date,
): Array<{ effectiveFrom: Date; effectiveTo: Date | null }> {
  const relevant = existing
    .filter((w) => w.effectiveTo === null || w.effectiveTo.getTime() >= today.getTime())
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  const fills: Array<{ effectiveFrom: Date; effectiveTo: Date | null }> = [];
  // `cursor` is the first still-uncovered day, sweeping forward from today.
  let cursor = today;
  let coveredToInfinity = false;
  for (const window of relevant) {
    // Clip a window that started before today to today, so the leading gap is
    // measured from today (nothing joins in the past).
    const start =
      window.effectiveFrom.getTime() > today.getTime() ? window.effectiveFrom : today;
    if (start.getTime() > cursor.getTime()) {
      fills.push({ effectiveFrom: cursor, effectiveTo: addDaysDateOnly(start, -1) });
    }
    if (window.effectiveTo === null) {
      coveredToInfinity = true;
      break; // an open window covers the rest of the line — no later gaps
    }
    const next = addDaysDateOnly(window.effectiveTo, 1);
    if (next.getTime() > cursor.getTime()) cursor = next;
  }
  if (!coveredToInfinity) {
    // Open tail after the last bounded window (or the whole line when there were
    // no relevant windows at all).
    fills.push({ effectiveFrom: cursor, effectiveTo: null });
  }
  return fills;
}

/** The (membershipTypeId, ageTier) cells one category's amount fans out to. */
function joiningFeeFanOutCells(
  category: string,
  membershipTypesByKey: Map<string, { id: string }>,
): Array<{ membershipTypeId: string; ageTier: string | null }> {
  if (category === "FAMILY") {
    const familyTypeId = membershipTypesByKey.get(FAMILY_MEMBERSHIP_TYPE_KEY)?.id;
    return familyTypeId ? [{ membershipTypeId: familyTypeId, ageTier: null }] : [];
  }
  const tiers = JOINING_FEE_PER_TIER_TARGETS[category] ?? [];
  const cells: Array<{ membershipTypeId: string; ageTier: string | null }> = [];
  for (const [key, type] of membershipTypesByKey) {
    if (JOINING_FEE_EXCLUDED_TYPE_KEYS.has(key)) continue;
    for (const tier of tiers) cells.push({ membershipTypeId: type.id, ageTier: tier });
  }
  return cells;
}

/**
 * Materialise the decided categories into JoiningFee windows. Runs inside the
 * apply transaction. Returns the number of rows created.
 */
async function applyJoiningFeeMaterialisation(
  tx: TxDb,
  decision: JoiningFeeMaterialisationDecision,
  membershipTypesByKey: Map<string, { id: string }>,
  today: Date,
): Promise<number> {
  if (decision.materialise.length === 0) return 0;
  const windows: JoiningFeeWindow[] = await tx.joiningFee.findMany({
    select: {
      membershipTypeId: true,
      ageTier: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  });
  let created = 0;
  for (const { category, amountCents } of decision.materialise) {
    for (const cell of joiningFeeFanOutCells(category, membershipTypesByKey)) {
      // Fill EVERY gap this cell leaves uncovered on the today-onward date line
      // with the legacy amount (leading gap, inter-window gaps, and the open
      // tail), never overlapping an existing window — reproducing the removed
      // uncovered-date runtime fallback (#1931 F1).
      const cellWindows = windows.filter(
        (w) =>
          w.membershipTypeId === cell.membershipTypeId && w.ageTier === cell.ageTier,
      );
      for (const fill of joiningFeeLegacyFillWindows(cellWindows, today)) {
        await tx.joiningFee.create({
          data: {
            membershipTypeId: cell.membershipTypeId,
            ageTier: cell.ageTier as never,
            amountCents,
            effectiveFrom: fill.effectiveFrom,
            effectiveTo: fill.effectiveTo,
          },
        });
        created += 1;
      }
    }
  }
  return created;
}

// ---- Export ----------------------------------------------------------------

export const xeroConfigExporter: CategoryExporter = {
  category: "xero-config",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const accounts = await ctx.db.xeroAccountMapping.findMany({
      orderBy: { key: "asc" },
      select: { key: true, code: true, itemCode: true },
    });
    const [itemRows, membershipTypeRows] = await Promise.all([
      ctx.db.xeroItemCodeMapping.findMany({
        orderBy: { category: "asc" },
        select: {
          category: true, ageTier: true, seasonType: true, membershipTypeId: true,
          entranceFeeCategory: true, itemCode: true, amountCents: true,
        },
      }),
      ctx.db.membershipType.findMany({ select: { id: true, key: true } }),
    ]);
    const membershipTypeKeyById = new Map(membershipTypeRows.map((t) => [t.id, t.key]));
    // Emit membership-type-keyed HUT_FEE rows and all JOINING_FEE rows;
    // `membershipTypeId`-less HUT_FEE rows are skipped (#1930, E4 — the #2130
    // STEP 2 contract migration deleted the legacy ones, the skip is kept
    // defensively).
    // ENTRANCE_FEE is not an emitted category — the #1931 migration re-keyed
    // every such row to JOINING_FEE, and it is a rejected import shape (#2131).
    const items = itemRows
      .filter((r) => !(r.category === "HUT_FEE" && !r.membershipTypeId))
      .map((r) => ({
        category: r.category,
        membershipTypeKey: r.membershipTypeId
          ? membershipTypeKeyById.get(r.membershipTypeId) ?? null
          : null,
        ageTier: r.ageTier,
        seasonType: r.seasonType,
        entranceFeeCategory: r.entranceFeeCategory,
        itemCode: r.itemCode,
        amountCents: r.amountCents,
      }));

    const entries: BundleEntry[] = [];
    if (accounts.length > 0 || items.length > 0) {
      entries.push(
        { path: ACCOUNT_FILE, category: "xero-config", rowCount: accounts.length, bytes: strToU8(serialiseCsv([...ACCOUNT_FIELDS], accounts)) },
        { path: ITEM_FILE, category: "xero-config", rowCount: items.length, bytes: strToU8(serialiseCsv([...ITEM_FIELDS], items)) },
      );
    }

    // Stamp the connected Xero org for provenance whenever the category has any
    // content (or an org is connected), so import can warn on a cross-org apply.
    const tenantId = await connectedXeroTenantId(ctx.db);
    if (entries.length > 0 || tenantId) {
      entries.push({
        path: XERO_SOURCE_FILE,
        category: "xero-config",
        rowCount: null,
        bytes: strToU8(JSON.stringify({ tenantId }, null, 2)),
      });
    }
    return entries;
  },
};

/**
 * The #1941 precedence guard. The item-code-amount joining-fee materialisation
 * (#1931 — live behaviour, not old-bundle compat) is SUPERSEDED only when the
 * bundle carries the first-class joining-fee schedule
 * (membership-fees/joining-fees.csv) AND the membership-fees category is actually
 * being applied. If an admin imports xero-config with membership-fees DESELECTED,
 * the membership-fees importer never runs, so the item-code fan-out MUST still
 * run or the joining fees silently vanish (neither path writes them).
 */
function itemCodeJoiningFeeSuperseded(
  files: Map<string, Uint8Array>,
  selectedCategories: ConfigTransferCategory[] | undefined,
): boolean {
  return (
    bundleCarriesJoiningFeeSchedule(files) &&
    (selectedCategories?.includes("membership-fees") ?? false)
  );
}

// ---- Plan ------------------------------------------------------------------

async function planXeroConfig(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const batch = await loadXeroBatch(ctx.db);

  readCsvRows(ctx.files, ACCOUNT_FILE).forEach((raw, i) => {
    const v = new RowValidator(ACCOUNT_FILE, i, errors);
    const key = v.required("key", raw.key);
    if (!v.ok) return;
    const current = batch.accounts.get(key) ?? null;
    fingerprintParts.push(
      `xero-account-mapping:${key}:${current ? hashRow([...ACCOUNT_FIELDS], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, { code: nz(raw.code), itemCode: nz(raw.itemCode) });
    const changed = changedFields(write, current);
    items.push({ entity: "xero-account-mapping", key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
  });

  const parsedItemRows: ParsedItemRow[] = [];
  readCsvRows(ctx.files, ITEM_FILE).forEach((raw, i) => {
    const parsed = parseItemRow(i, raw, errors, batch.membershipTypesByKey);
    if (!parsed) return;
    parsedItemRows.push(parsed);
    const current = batch.items.get(parsed.key) ?? null;
    fingerprintParts.push(
      `xero-item-code-mapping:${parsed.key}:${current ? hashRow(["itemCode", "amountCents"], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, parsed.data);
    const changed = changedFields(write, current);
    items.push({ entity: "xero-item-code-mapping", key: parsed.key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
  });

  // Joining-fee materialisation preview (#1931, E5): surface which categories
  // will fan out into JoiningFee windows, and bind the coverage state into the
  // fingerprint so a concurrent fee-configuration change forces a re-plan.
  // SUPERSEDED by #1941: a bundle carrying the authoritative joining-fee
  // schedule in membership-fees/joining-fees.csv means the item-code-amount
  // fan-out must not also run/duplicate — but ONLY when the membership-fees
  // category is actually being applied (see itemCodeJoiningFeeSuperseded). A
  // bundle without joining-fees.csv, or a bundle imported with membership-fees
  // deselected, keeps the item-code-amount fan-out so its joining fees are not
  // silently dropped.
  if (!itemCodeJoiningFeeSuperseded(ctx.files, ctx.selectedCategories)) {
    const materialisation = await decideJoiningFeeMaterialisation(
      ctx.db,
      parsedItemRows,
      batch.membershipTypesByKey,
      dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest())),
    );
    warnings.push(...materialisation.warnings);
    fingerprintParts.push(...materialisation.fingerprintParts);
    for (const m of materialisation.materialise) {
      items.push({ entity: "joining-fee-window", key: m.category, action: "create" });
    }
  }

  if (items.length > 0) {
    warnings.push("Xero codes are only valid for the connected Xero org — verify after importing.");
  }
  return { items, warnings, errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyXeroConfig(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  const batch = await loadXeroBatch(ctx.tx);

  for (const [i, raw] of readCsvRows(ctx.files, ACCOUNT_FILE).entries()) {
    const v = new RowValidator(ACCOUNT_FILE, i, errors);
    const key = v.required("key", raw.key);
    if (!v.ok) { result.skipped += 1; continue; }
    const current = batch.accounts.get(key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw,
      data: { code: nz(raw.code), itemCode: nz(raw.itemCode) },
      current,
      create: (data) => ctx.tx.xeroAccountMapping.create({ data: { key, ...data } }),
      update: (write) => ctx.tx.xeroAccountMapping.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  const parsedItemRows: ParsedItemRow[] = [];
  for (const [i, raw] of readCsvRows(ctx.files, ITEM_FILE).entries()) {
    const parsed = parseItemRow(i, raw, errors, batch.membershipTypesByKey);
    if (!parsed) { result.skipped += 1; continue; }
    parsedItemRows.push(parsed);
    const current = batch.items.get(parsed.key) ?? null;
    const membershipTypeId = parsed.identity.membershipTypeKey
      ? batch.membershipTypesByKey.get(parsed.identity.membershipTypeKey)?.id ?? null
      : null;
    await applyRow({
      mode: ctx.mode,
      raw,
      data: parsed.data,
      current,
      create: (data) =>
        ctx.tx.xeroItemCodeMapping.create({
          data: {
            category: parsed.identity.category,
            ageTier: parsed.identity.ageTier as never,
            seasonType: parsed.identity.seasonType as never,
            // isMember stays null on the new membership-type key; membershipTypeId
            // carries the HUT_FEE identity (#1930, E4).
            membershipTypeId,
            entranceFeeCategory: parsed.identity.entranceFeeCategory as never,
            ...data,
          },
          // Blue/green runtime-prep (#2130): narrow the implicit RETURNING so
          // this write stops naming the doomed `isMember` column. `applyRow`
          // types create/update as `Promise<unknown>` and discards the result,
          // so `id` is a safe minimal projection.
          select: { id: true },
        }),
      update: (write) =>
        ctx.tx.xeroItemCodeMapping.update({
          where: { id: current!.id },
          data: write,
          select: { id: true },
        }),
      result,
    });
  }

  // Materialise JoiningFee windows from the bundle's JOINING_FEE item-code
  // amounts (#1931, E5): re-derive the same decision the plan previewed (the
  // fingerprint guarantees the coverage state has not drifted) and fan the
  // amounts out per D-R1 inside this transaction. SUPERSEDED by #1941 — when
  // membership-fees/joining-fees.csv is present AND the membership-fees
  // category is being applied it is the authoritative joining-fee schedule, so
  // the item-code-amount fan-out is skipped to avoid duplicating/skewing it
  // (the precedence the plan previewed). With membership-fees deselected the
  // fan-out still runs, so the fees are not silently dropped.
  if (!itemCodeJoiningFeeSuperseded(ctx.files, ctx.selectedCategories)) {
    // The club's calendar day for the fee window this import opens. Read from
    // the PERSISTED club timezone (CT-5, #2869; INV-CONFIG-002) rather than the
    // container's `TZ`. It is a single indexed primary-key read on the shared
    // client, so it does not join this apply transaction; threading the zone
    // through `ApplyContext` would be tidier and belongs with that machinery.
    const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
    const materialisation = await decideJoiningFeeMaterialisation(
      ctx.tx,
      parsedItemRows,
      batch.membershipTypesByKey,
      today,
    );
    result.created += await applyJoiningFeeMaterialisation(
      ctx.tx,
      materialisation,
      batch.membershipTypesByKey,
      today,
    );
  }

  return result;
}

export const xeroConfigImporter: CategoryImporter = {
  category: "xero-config",
  plan: planXeroConfig,
  apply: applyXeroConfig,
};
