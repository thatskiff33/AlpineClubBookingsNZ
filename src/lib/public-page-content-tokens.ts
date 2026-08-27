import "server-only";

import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
} from "@/lib/club-time";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { APP_CURRENCY } from "@/config/operational";
import { normalizeCancellationRule } from "@/lib/cancellation-rules";
import { resolvePolicyRowsForLodge } from "@/lib/lodges";
import {
  hostingModeIsActive,
  resolveAdultMemberHostingPolicy,
  type AdultMemberHostingPolicyLike,
} from "@/lib/policies/adult-member-hosting";
import { prisma } from "@/lib/prisma";
import { collapseHutFeeColumns, type HutFeeColumn } from "@/lib/public-hut-fee-columns";

export type PublicMoney = { amountCents: number; label: string };
export type PublicTokenLodge = { name: string; slug: string };

// Generic grouped-fee view model shared by the joining-fee and annual-fee
// embeds (#1933, E7). A group is one titled block (a membership type or a fee
// family); each row is one labelled amount. Public names only — never ids or
// provider codes. (The optional `audience` qualifier was removed in #2129: hut
// fees were its only producer and they now render as a real table.)
export type PublicFeeRow = { label: string; fee: PublicMoney };
export type PublicFeeGroup = { heading: string; rows: PublicFeeRow[] };

// Tabular fee view model for the public {{hut-fees}} embed (#2129). Each table
// is one lodge x season; `columns` are the collapsed membership-type rate
// columns and each row is one age tier (or, transposed by `group-by=age`, one
// membership type). A NULL cell means that column carries no rate for that row
// and renders as an em dash — never as a zero or another column's price.
export type PublicFeeTableRow = { label: string; cells: Array<PublicMoney | null> };
export type PublicFeeTable = {
  heading: string;
  /** Header for the leading (row-label) column, e.g. "Age" or "Membership type". */
  rowHeading: string;
  columns: string[];
  rows: PublicFeeTableRow[];
  /**
   * True when at least one rate column collapses several identically-priced
   * membership types (its heading lists them, e.g. "Full Member, Life"). The
   * renderer shows a one-line explanation only then, so a multi-name heading
   * does not read to a visitor as a rendering glitch. Survives the `group-by=age`
   * transpose, where the collapsed names become row labels instead.
   */
  collapsedColumns: boolean;
};

export type PublicBookingPolicy = {
  lodge: PublicTokenLodge | null;
  hold: string | null;
  periods: Array<{ name: string; dateRange: string; hold: string | null }>;
  minimumStays: Array<{
    name: string;
    dateRange: string;
    minimumNights: number;
    triggerDays: string;
    /**
     * Plain-language exception-capacity sentence, or `null` while the exception
     * workflow is unshipped. See `PUBLIC_EXCEPTION_CAPACITY_COPY_ENABLED`.
     */
    capacityHandling: string | null;
  }>;
  groupDiscount: string | null;
  /**
   * Plain-language adult-member hosting sentence (#2364), or null when the club
   * (or this lodge) does not ask for one. Copy only — never the policy id,
   * version or capacity mode.
   */
  adultMemberHosting: string | null;
};

export type PublicCancellationPolicy = {
  lodge: PublicTokenLodge | null;
  tiers: Array<{ description: string }>;
  periods: Array<{ name: string; dateRange: string; tiers: Array<{ description: string }> }>;
};

type PublicCancellationRuleInput = Parameters<typeof normalizeCancellationRule>[0];

function money(amountCents: number): PublicMoney {
  return {
    amountCents,
    label: new Intl.NumberFormat("en-NZ", {
      style: "currency",
      currency: APP_CURRENCY,
    }).format(amountCents / 100),
  };
}

type PublicContentGate = "membershipTypes" | "entranceFees" | "hutFees" | "annualFees" | "bookingPolicySummary" | "cancellationPolicy";

async function isPublicContentEnabled(gate: PublicContentGate): Promise<boolean> {
  const settings = await prisma.publicContentSettings.findUnique({
    where: { id: "default" },
    select: { [gate]: true },
  });
  return settings?.[gate] === true;
}

/**
 * "1 Jun 2026 to 31 Aug 2026" — the season/period edges a public page names.
 *
 * Every `startDate`/`endDate` this is handed is `DateTime @db.Date`, so each is
 * a stored calendar day and takes no timezone at all (`INV-DATE-026`). It used
 * to build its own formatter and project them through a hard-coded
 * `Pacific/Auckland` — not `APP_TIME_ZONE`, so one club's zone was baked into
 * every adopter's public fee page (`INV-CONFIG-001`).
 *
 * NOTHING IS COMPOSED. `HOUSE_SHAPES.date` via `formatClubDate` is the declared
 * whole shape and is byte-identical to the hand-rolled options for `en-NZ`
 * (measured, all 1,461 days of 2024-2027). " to " stays a literal: it is copy,
 * and `formatRange` would give an en dash and collapse a shared year.
 */
function dateRange(start: Date, end: Date): string {
  const from = formatClubDate(calendarDateOfDateOnlyInstant(start));
  const to = formatClubDate(calendarDateOfDateOnlyInstant(end));
  return `${from} to ${to}`;
}

function sentenceCase(value: string): string {
  const text = value.replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeCancellationTerms(rawRule: PublicCancellationRuleInput): string {
  const rule = normalizeCancellationRule(rawRule);
  const cardFee = rule.fixedFeeCents > 0 ? ` less a ${money(rule.fixedFeeCents).label} fee` : "";
  const creditFee = rule.creditFixedFeeCents > 0 ? ` less a ${money(rule.creditFixedFeeCents).label} fee` : "";
  const differs = rule.refundPercentage !== rule.creditRefundPercentage || rule.fixedFeeCents !== rule.creditFixedFeeCents;
  return differs
    ? `${rule.refundPercentage}% card refund${cardFee}; ${rule.creditRefundPercentage}% credit refund${creditFee}`
    : `${rule.refundPercentage}% refund${cardFee}`;
}

/**
 * Mirrors getRefundTier's descending threshold semantics without suggesting
 * that a zero-day tier applies after check-in. Every schedule ends with the
 * explicit no-refund result used when daysUntilCheckIn is negative.
 */
export function describePublicCancellationRules(
  rawRules: PublicCancellationRuleInput[],
): Array<{ description: string }> {
  const rules = rawRules
    .map(normalizeCancellationRule)
    .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay);
  if (rules.length === 0) return [];
  // Array#sort is stable: equal thresholds retain persisted order, matching
  // getRefundTier. Keep the first and discard unreachable dirty duplicates.
  const seenThresholds = new Set<number>();
  const reachableRules = rules.filter((rule) => {
    if (seenThresholds.has(rule.daysBeforeStay)) return false;
    seenThresholds.add(rule.daysBeforeStay);
    return true;
  });
  const rows = reachableRules.map((rule, index) => {
    const previous = reachableRules[index - 1];
    const range = index === 0
      ? `${rule.daysBeforeStay} or more days before check-in`
      : `${rule.daysBeforeStay}–${Math.max(rule.daysBeforeStay, previous.daysBeforeStay - 1)} days before check-in`;
    return { description: `${range}: ${describeCancellationTerms(rule)}` };
  });
  const lowest = reachableRules.at(-1)?.daysBeforeStay;
  if (lowest !== undefined && lowest > 0) {
    const range = lowest === 1
        ? "0 days before check-in"
        : `0–${lowest - 1} days before check-in`;
    rows.push({ description: `${range}: no refund` });
  }
  rows.push({ description: "After check-in: no refund" });
  return rows;
}

async function findPublicLodge(slug: string): Promise<PublicTokenLodge & { id: string } | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;
  return prisma.lodge.findFirst({
    where: { slug: normalized, active: true },
    select: { id: true, name: true, slug: true },
  });
}

async function publicLodges(slug?: string): Promise<Array<PublicTokenLodge & { id: string }>> {
  if (slug !== undefined) {
    const lodge = await findPublicLodge(slug);
    return lodge ? [lodge] : [];
  }
  return prisma.lodge.findMany({
    where: { active: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, slug: true },
  });
}

// Active effective-dated window helper (from <= today <= to-or-open).
function activeWindow(today: Date) {
  return {
    effectiveFrom: { lte: today },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
  };
}

async function loadAgeTierLabels(): Promise<Map<string, { label: string; sortOrder: number }>> {
  const ageTiers = await prisma.ageTierSetting.findMany({
    orderBy: [{ sortOrder: "asc" }, { minAge: "asc" }],
    select: { tier: true, label: true, sortOrder: true },
  });
  return new Map(ageTiers.map((tier) => [tier.tier, { label: tier.label.trim() || sentenceCase(tier.tier), sortOrder: tier.sortOrder }]));
}

const ageLabel = (
  tiers: Map<string, { label: string; sortOrder: number }>,
  tier: string | null,
): string => (tier === null ? "All ages" : tiers.get(tier)?.label || sentenceCase(tier));
const ageSort = (
  tiers: Map<string, { label: string; sortOrder: number }>,
  tier: string | null,
): number => (tier === null ? Number.MAX_SAFE_INTEGER : tiers.get(tier)?.sortOrder ?? Number.MAX_SAFE_INTEGER);

export type PublicJoiningFeeOptions = { typeKey?: string; byAge?: boolean };

/**
 * Public joining fees, grouped either by membership type (default) or by age
 * tier (byAge). Reads only publicly-listed active membership types; an unknown
 * or unlisted `typeKey` yields the empty state (never another type's data).
 */
export async function loadPublicJoiningFees(
  options: PublicJoiningFeeOptions = {},
): Promise<PublicFeeGroup[]> {
  if (!(await isPublicContentEnabled("entranceFees"))) return [];
  const today = await clubTodayDateOnlyInstant();
  const [types, tiers] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, publiclyListed: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        ageGroupsApply: true,
        joiningFees: {
          where: activeWindow(today),
          orderBy: [{ effectiveFrom: "desc" }],
          select: { ageTier: true, amountCents: true },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const listed = options.typeKey
    ? types.filter((type) => type.key.toLowerCase() === options.typeKey!.toLowerCase())
    : types;
  if (listed.length === 0) return [];

  // Current amount per (type, tier): rows are effectiveFrom desc, so the first
  // seen per tier is current. A flat (non-age) type keys on the null tier.
  type Cell = { typeName: string; tier: string | null; amountCents: number };
  const cells: Cell[] = [];
  for (const type of listed) {
    const seen = new Set<string>();
    for (const row of type.joiningFees) {
      const key = row.ageTier ?? "FLAT";
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push({ typeName: type.name, tier: type.ageGroupsApply ? row.ageTier : null, amountCents: row.amountCents });
    }
  }
  if (cells.length === 0) return [];

  if (options.byAge) {
    // Group by age tier; rows are membership types.
    const byTier = new Map<string, { tier: string | null; rows: PublicFeeRow[] }>();
    for (const cell of cells) {
      const key = cell.tier ?? "FLAT";
      const group = byTier.get(key) ?? { tier: cell.tier, rows: [] };
      group.rows.push({ label: cell.typeName, fee: money(cell.amountCents) });
      byTier.set(key, group);
    }
    return [...byTier.values()]
      .sort((a, b) => ageSort(tiers, a.tier) - ageSort(tiers, b.tier))
      .map((group) => ({ heading: ageLabel(tiers, group.tier), rows: group.rows }));
  }

  // Default: group by membership type; rows are age tiers.
  const byType = new Map<string, PublicFeeRow[]>();
  const order: string[] = [];
  for (const cell of cells) {
    if (!byType.has(cell.typeName)) { byType.set(cell.typeName, []); order.push(cell.typeName); }
    byType.get(cell.typeName)!.push({ label: ageLabel(tiers, cell.tier), fee: money(cell.amountCents) });
  }
  return order.map((typeName) => ({
    heading: typeName,
    rows: byType.get(typeName)!.slice().sort((a, b) =>
      ageSort(tiers, tierForLabel(tiers, a.label)) - ageSort(tiers, tierForLabel(tiers, b.label))),
  }));
}

// Reverse a rendered age label back to its tier key for row ordering. Only used
// to keep the default (by-type) rows in the configured age order.
function tierForLabel(
  tiers: Map<string, { label: string; sortOrder: number }>,
  label: string,
): string | null {
  if (label === "All ages") return null;
  for (const [tier, meta] of tiers) if (meta.label === label) return tier;
  return null;
}

export type PublicAnnualFeeOptions = { typeKey?: string; components?: boolean };

/**
 * Public annual membership fees (#2067 per-tier). By default one "Annual
 * membership fees" group lists the current total per publicly-listed type ×
 * age tier as "Type — TierLabel" rows; a flat (NULL-tier) fee, or any fee on a
 * type whose `ageGroupsApply` is false, collapses to a plain "Type" row
 * (mirroring loadPublicJoiningFees). `components` opts into the E6 per-component
 * breakdown (one group per type × tier). Rows are deduped to the current
 * (latest effectiveFrom) fee per tier; a tier whose current fee is NO_INVOICE,
 * and types with no current fee, are omitted. Gated by the dedicated annualFees
 * double-opt-in (D-R4). Unknown/unlisted `typeKey` → empty state.
 */
export async function loadPublicAnnualFees(
  options: PublicAnnualFeeOptions = {},
): Promise<PublicFeeGroup[]> {
  if (!(await isPublicContentEnabled("annualFees"))) return [];
  const today = await clubTodayDateOnlyInstant();
  const [types, tiers] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, publiclyListed: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        ageGroupsApply: true,
        annualFees: {
          where: activeWindow(today),
          orderBy: { effectiveFrom: "desc" },
          select: {
            ageTier: true,
            amountCents: true,
            billingBasis: true,
            components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { label: true, amountCents: true } },
          },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const listed = options.typeKey
    ? types.filter((type) => type.key.toLowerCase() === options.typeKey!.toLowerCase())
    : types;
  if (listed.length === 0) return [];

  // Current fee per (type, tier): rows are effectiveFrom desc, so the first seen
  // per tier is current. A flat (non-age) type keys on the null tier. A tier
  // whose current fee is NO_INVOICE is omitted (marked seen, then skipped) so an
  // older invoiceable row never resurfaces.
  type Cell = {
    typeName: string;
    tier: string | null;
    amountCents: number;
    components: Array<{ label: string; amountCents: number }>;
  };
  const cells: Cell[] = [];
  for (const type of listed) {
    const typeCells: Cell[] = [];
    const seen = new Set<string>();
    for (const row of type.annualFees) {
      const dedupeKey = row.ageTier ?? "FLAT";
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (row.billingBasis === "NO_INVOICE") continue;
      typeCells.push({
        typeName: type.name,
        tier: type.ageGroupsApply ? row.ageTier : null,
        amountCents: row.amountCents,
        components: row.components,
      });
    }
    // Age order within the type; a flat/collapsed (null) row sorts last.
    typeCells.sort((a, b) => ageSort(tiers, a.tier) - ageSort(tiers, b.tier));
    cells.push(...typeCells);
  }
  if (cells.length === 0) return [];

  const rowLabel = (cell: Cell) =>
    cell.tier === null ? cell.typeName : `${cell.typeName} — ${ageLabel(tiers, cell.tier)}`;

  if (options.components) {
    // One group per type × tier; rows are the fee's invoice-line components.
    return cells
      .map((cell) => ({
        heading: rowLabel(cell),
        rows: (cell.components.length > 0
          ? cell.components.map((component) => ({ label: component.label, fee: money(component.amountCents) }))
          : [{ label: "Annual membership fee", fee: money(cell.amountCents) }]),
      }))
      .filter((group) => group.rows.length > 0);
  }

  // Default: a single group of "Type — TierLabel" → total rows.
  return [{
    heading: "Annual membership fees",
    rows: cells.map((cell) => ({ label: rowLabel(cell), fee: money(cell.amountCents) })),
  }];
}

export type PublicHutFeeOptions = { typeKey?: string; groupBy?: Set<"type" | "age"> };

type AgeTierLabels = Map<string, { label: string; sortOrder: number }>;

/** Build one lodge x season rate table from its collapsed rate columns. */
function hutFeeTable(
  heading: string,
  columns: HutFeeColumn[],
  tiers: AgeTierLabels,
): PublicFeeTable | null {
  if (columns.length === 0) return null;
  const tierKeys = [...new Set(columns.flatMap((column) => [...column.prices.keys()]))]
    .sort((a, b) => ageSort(tiers, a) - ageSort(tiers, b));
  if (tierKeys.length === 0) return null;
  return {
    heading,
    rowHeading: "Age",
    columns: columns.map((column) => column.heading),
    collapsedColumns: columns.some((column) => column.typeNames.length > 1),
    rows: tierKeys.map((tier) => ({
      label: ageLabel(tiers, tier),
      cells: columns.map((column) => {
        const cents = column.prices.get(tier);
        return cents === undefined ? null : money(cents);
      }),
    })),
  };
}

/** Swap axes so membership types are rows and age tiers are columns. */
function transposeFeeTable(table: PublicFeeTable): PublicFeeTable {
  return {
    heading: table.heading,
    rowHeading: "Membership type",
    columns: table.rows.map((row) => row.label),
    collapsedColumns: table.collapsedColumns,
    rows: table.columns.map((column, columnIndex) => ({
      label: column,
      cells: table.rows.map((row) => row.cells[columnIndex] ?? null),
    })),
  };
}

/**
 * Public hut nightly fees, sourced from the authoritative
 * `MembershipTypeSeasonRate` rows (#2129 — the legacy member/non-member
 * `SeasonRate` table was dropped in step 2).
 *
 * Each active season of each public lodge renders as one table: age tiers are
 * the rows and **membership-type rate columns** are the columns. A membership
 * type earns a column only when it is active, publicly listed, and actually
 * carries rate rows for that season; types whose full price map is identical
 * collapse into one shared column headed by their names (see
 * `collapseHutFeeColumns`). A type with `ageGroupsApply=false` contributes a
 * single "All ages" row. A cell with no matching rate renders as an em dash.
 *
 * Options (semantics changed in #2129 — see docs/PUBLIC_PAGE_CONTENT_TOKENS.md):
 * - `typeKey` now genuinely **filters** to that one publicly-listed type's
 *   column; before #2129 it only validated that the key existed. An unknown or
 *   unlisted key still yields the empty state (fail closed), never another
 *   type's rates.
 * - `groupBy=type` **splits**: a season becomes one single-column table per
 *   membership-type column; before #2129 it split a season into Member and
 *   Non-member groups.
 * - `groupBy=age` **orients**: it transposes the single table so membership
 *   types are the rows and age tiers the columns. It does NOT split. Before
 *   #2129 it did nothing at all.
 *
 * Those two are deliberately asymmetric — one splits, one orients — and this
 * embed's `group-by=age` also differs from `{{joining-fees}}`'s `by-age`, which
 * GROUPS (one block per age tier, headed by the tier, with membership types as
 * its rows — see `loadPublicJoiningFees`). Here, one table per tier would emit
 * a degenerate single-row table for every tier a club runs, which reads worse
 * on a public page than one transposed grid. Keep the asymmetry documented
 * rather than "fixed": it is a rendering choice, not an oversight.
 *
 * `groupBy=type+age` composes both — each single-column table is then
 * transposed into a single-ROW table. That is legal but degenerate, and
 * documented as such in docs/PUBLIC_PAGE_CONTENT_TOKENS.md rather than rejected,
 * since it is harmless and rejecting it would need a new failure mode.
 */
export async function loadPublicHutFees(
  slug?: string,
  options: PublicHutFeeOptions = {},
): Promise<PublicFeeTable[]> {
  if (!(await isPublicContentEnabled("hutFees"))) return [];
  const lodges = await publicLodges(slug);
  if (lodges.length === 0) return [];
  let onlyTypeId: string | undefined;
  if (options.typeKey) {
    const known = await prisma.membershipType.findFirst({
      where: { isActive: true, publiclyListed: true, key: { equals: options.typeKey, mode: "insensitive" } },
      select: { id: true },
    });
    if (!known) return [];
    onlyTypeId = known.id;
  }
  const [seasons, tiers] = await Promise.all([
    prisma.season.findMany({
      where: { active: true, lodgeId: { in: lodges.map((lodge) => lodge.id) } },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: {
        lodgeId: true,
        name: true,
        startDate: true,
        endDate: true,
        membershipTypeRates: {
          where: {
            membershipType: { isActive: true, publiclyListed: true },
            ...(onlyTypeId ? { membershipTypeId: onlyTypeId } : {}),
          },
          orderBy: [{ ageTier: "asc" }],
          select: {
            ageTier: true,
            pricePerNightCents: true,
            membershipType: { select: { id: true, name: true, sortOrder: true, ageGroupsApply: true } },
          },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const splitByType = options.groupBy?.has("type") ?? false;
  const byAge = options.groupBy?.has("age") ?? false;
  const tables: PublicFeeTable[] = [];
  for (const { id, name: lodgeName } of lodges) {
    for (const season of seasons.filter((row) => row.lodgeId === id)) {
      const seasonTitle = `${lodgeName} — ${season.name} (${dateRange(season.startDate, season.endDate)}) nightly rates`;
      const byType = new Map<string, { id: string; name: string; sortOrder: number; ageGroupsApply: boolean; rates: Array<{ ageTier: string | null; pricePerNightCents: number }> }>();
      for (const rate of season.membershipTypeRates ?? []) {
        const type = rate.membershipType;
        const entry = byType.get(type.id) ?? { ...type, rates: [] };
        entry.rates.push({ ageTier: rate.ageTier, pricePerNightCents: rate.pricePerNightCents });
        byType.set(type.id, entry);
      }
      const columns = collapseHutFeeColumns([...byType.values()]);
      if (columns.length === 0) continue;
      const built = splitByType
        ? columns.map((column) => hutFeeTable(`${seasonTitle} · ${column.heading}`, [column], tiers))
        : [hutFeeTable(seasonTitle, columns, tiers)];
      for (const table of built) {
        if (!table) continue;
        tables.push(byAge ? transposeFeeTable(table) : table);
      }
    }
  }
  return tables;
}

/**
 * Whether `{{booking-policies}}` publishes the exception-capacity sentence.
 *
 * OFF for the #2363 foundation release, deliberately. The sentences describe a
 * workflow that does not exist yet: a member who trips a minimum-stay rule today
 * is simply refused, with no way to request an exception at all, so telling the
 * public what happens to capacity "while the club reviews it" advertises a
 * button nobody can press. The whole pipeline behind it stays wired — the loader
 * still selects `capacityMode`, the copy still lives in `exceptionCapacityCopy`,
 * and the renderer still handles a present sentence — so #2365 turns this on in
 * one line, as a deliberate act, once the review flow ships.
 *
 * The ADMIN card is unaffected: it has always stated the stored mode, and an
 * operator configuring the rule needs to see what they chose.
 *
 * Typed `boolean` rather than left as the literal `false` so the branch below
 * stays a real conditional to the compiler and the linter.
 */
const PUBLIC_EXCEPTION_CAPACITY_COPY_ENABLED: boolean = false;

/** The published sentence for each capacity mode (#2363, surfaced by #2365). */
function exceptionCapacityCopy(mode: "HOLD" | "NO_HOLD"): string {
  return mode === "HOLD"
    ? "If an exception is requested, the requested capacity is held while the club reviews it, for up to 7 days and never past the start of the first night requested."
    : "An exception request does not reserve capacity until the club approves it.";
}

export async function loadPublicBookingPolicy(slug?: string): Promise<PublicBookingPolicy | null> {
  if (!(await isPublicContentEnabled("bookingPolicySummary"))) return null;
  const lodge = slug === undefined ? null : await findPublicLodge(slug);
  if (slug !== undefined && !lodge) return null;
  const today = await clubTodayDateOnlyInstant();
  const [defaults, periods, minimumStays, discount, hostingRows] = await Promise.all([
    prisma.bookingDefaults.findUnique({
      where: { id: "default" },
      select: { nonMemberHoldEnabled: true, nonMemberHoldDays: true },
    }),
    prisma.bookingPeriod.findMany({
      where: {
        active: true,
        ...(lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null }),
      },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: {
        name: true, startDate: true, endDate: true, nonMemberHoldEnabled: true,
        nonMemberHoldDays: true, lodgeId: true,
      },
    }),
    prisma.minimumStayPolicy.findMany({
      where: {
        active: true,
        ...(lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null }),
      },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: { name: true, startDate: true, endDate: true, minimumNights: true, triggerDays: true, capacityMode: true, lodgeId: true },
    }),
    prisma.groupDiscountSetting.findUnique({
      where: { id: "default" },
      select: { enabled: true, minGroupSize: true, summerOnly: true },
    }),
    // #2364. Both candidate rows for this page's scope; the resolver below picks
    // between them. Without a lodge in the URL only the club-wide row applies,
    // which is the same rule the periods and minimum-stay reads above follow.
    prisma.adultMemberHostingPolicy.findMany({
      where: lodge
        ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] }
        : { lodgeId: null },
      select: {
        id: true,
        scopeKey: true,
        lodgeId: true,
        mode: true,
        capacityMode: true,
        version: true,
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: true,
      },
    }),
  ]);
  const effectivePeriods = (lodge ? resolvePolicyRowsForLodge(periods, lodge.id) : periods).filter((period) => period.endDate >= today);
  const effectiveMinimumStays = (lodge ? resolvePolicyRowsForLodge(minimumStays, lodge.id) : minimumStays).filter((policy) => policy.endDate >= today);
  const holdText = (enabled: boolean, days: number) => enabled
    ? `Non-member bookings may be held provisionally for up to ${days} ${days === 1 ? "day" : "days"}.`
    : "Non-member bookings are not held provisionally.";
  return {
    lodge: lodge ? { name: lodge.name, slug: lodge.slug } : null,
    hold: defaults ? holdText(defaults.nonMemberHoldEnabled, defaults.nonMemberHoldDays) : null,
    periods: effectivePeriods.map((period) => ({
      name: period.name,
      dateRange: dateRange(period.startDate, period.endDate),
      hold: holdText(period.nonMemberHoldEnabled, period.nonMemberHoldDays),
    })),
    minimumStays: effectiveMinimumStays.map((policy) => ({
      name: policy.name,
      dateRange: dateRange(policy.startDate, policy.endDate),
      minimumNights: policy.minimumNights,
      triggerDays: policy.triggerDays.length === 0
        ? "all check-in days"
        : policy.triggerDays.map((day) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "").filter(Boolean).join(", "),
      capacityHandling: PUBLIC_EXCEPTION_CAPACITY_COPY_ENABLED
        ? exceptionCapacityCopy(policy.capacityMode)
        : null,
    })),
    // Type-neutral copy (#1933, E7): the E4 re-key means "member rate" is no
    // longer a single binary, so describe the outcome without naming a type.
    groupDiscount: discount?.enabled
      ? `${discount.summerOnly ? "Summer groups" : "Groups"} of ${discount.minGroupSize} or more are charged the discounted group nightly rate.`
      : null,
    adultMemberHosting: publicAdultMemberHostingCopy(hostingRows, lodge?.id ?? null),
  };
}

/**
 * The public sentence for the adult-member hosting rule (#2364), or null.
 *
 * Says what the rule IS, because it is in force today and a prospective visitor
 * planning a stay needs to know it — that is different from the minimum-stay
 * `capacityHandling` sentence beside it, which stays off because it describes an
 * exception workflow nobody can use until #2365. This copy is careful to stop at
 * the same line: it says the club looks at such a booking, and does NOT invite
 * anyone to request an exception or promise an outcome.
 *
 * Nothing internal is published: no policy id, version, capacity mode, or the
 * fact that a scope override exists at all.
 *
 * A page with no lodge in its URL is answered by the club-wide row alone, so a
 * lodge-specific relaxation never softens the club's stated rule on a page that
 * is not about that lodge. `resolveAdultMemberHostingPolicy` refuses an
 * unresolvable scope, which for a public page is a refusal to render rather than
 * a wrong sentence — so the club-wide case (no lodge) resolves rows directly.
 */
function publicAdultMemberHostingCopy(
  rows: AdultMemberHostingPolicyLike[],
  lodgeId: string | null,
): string | null {
  // A page with no lodge is resolved against a sentinel that matches no lodge
  // row, so the club-wide row and the built-in default are the only possible
  // answers — the same reading the previous direct row lookup gave, and it also
  // yields the resolved host-scope set the copy below needs.
  const resolved = resolveAdultMemberHostingPolicy(rows, lodgeId ?? "__club-wide__");
  if (!hostingModeIsActive(resolved.mode)) return null;

  // WORDED FOR THE SCOPES ACTUALLY IN FORCE, so the public sentence cannot
  // promise a narrower rule than the club applies. A club on the built-in default
  // takes the first branch; the second is the honest public wording once same-owner
  // coverage is switched on, and it deliberately does not mention accounts or
  // bookings — a public page is read by people who have neither.
  const coverage =
    resolved.hostScopes.sameBooking && !resolved.hostScopes.sameBookingOwner
      ? "to stay with an adult member on the same booking"
      : "to be covered by an adult member staying at the lodge";

  // The consequence, and nothing beyond it. Still no invitation to request an
  // exception and no promise of an outcome — see the note above.
  return resolved.mode === "ADMIN_REVIEW_REQUIRED"
    ? `Non-member guests are asked ${coverage}. A booking without one is still ` +
        "made, and the club looks at it."
    : `Non-member guests are asked ${coverage}. A booking without one is not ` +
        "confirmed until it is corrected or the club decides otherwise.";
}

export async function loadPublicCancellationPolicy(slug?: string): Promise<PublicCancellationPolicy | null> {
  if (!(await isPublicContentEnabled("cancellationPolicy"))) return null;
  const lodge = slug === undefined ? null : await findPublicLodge(slug);
  if (slug !== undefined && !lodge) return null;
  const [rows, periods] = await Promise.all([
    prisma.cancellationPolicy.findMany({
      where: lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null },
      orderBy: { daysBeforeStay: "desc" },
      select: {
        daysBeforeStay: true,
        refundPercentage: true,
        creditRefundPercentage: true,
        fixedFeeCents: true,
        creditFixedFeeCents: true,
        lodgeId: true,
      },
    }),
    prisma.bookingPeriod.findMany({
      where: {
        active: true,
        ...(lodge ? { OR: [{ lodgeId: lodge.id }, { lodgeId: null }] } : { lodgeId: null }),
      },
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: { name: true, startDate: true, endDate: true, cancellationRules: true, lodgeId: true },
    }),
  ]);
  const effectiveRows = lodge ? resolvePolicyRowsForLodge(rows, lodge.id) : rows;
  const today = await clubTodayDateOnlyInstant();
  const effectivePeriods = (lodge ? resolvePolicyRowsForLodge(periods, lodge.id) : periods).filter((period) => period.endDate >= today);
  return {
    lodge: lodge ? { name: lodge.name, slug: lodge.slug } : null,
    tiers: describePublicCancellationRules(effectiveRows),
    periods: effectivePeriods.map((period) => ({
      name: period.name,
      dateRange: dateRange(period.startDate, period.endDate),
      tiers: Array.isArray(period.cancellationRules)
        ? describePublicCancellationRules(period.cancellationRules as unknown as PublicCancellationRuleInput[])
        : [],
    })),
  };
}
