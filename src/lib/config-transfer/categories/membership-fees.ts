import { strToU8 } from "fflate";

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
} from "../import-types";
import { RowValidator, nz, readCsvRows } from "../values";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";

// membership-fees category (#1941, follow-up to #1931/#1932): the first-class
// transfer of the MEMBERSHIP FEE SCHEDULES — joining fees (JoiningFee, #1931/E5)
// and annual membership fees with their invoice-line components
// (MembershipAnnualFee + MembershipAnnualFeeComponent, #1932/E6). Modelled on
// the season-rates precedent (lodge-config): flat CSVs with an explicit natural
// key, deterministic byte-stable export ordering, and upsert-only apply that
// never deletes.
//
//   membership-fees/joining-fees.csv
//     membershipTypeKey, ageTier, effectiveFrom, effectiveTo, amountCents
//     natural key: membershipTypeKey x ageTier x effectiveFrom (a blank ageTier
//     is a flat-fee type's single NULL-tier window, e.g. the built-in Family
//     type). Matches JoiningFee @@unique([membershipTypeId, ageTier,
//     effectiveFrom]).
//   membership-fees/annual-fees.csv
//     membershipTypeKey, ageTier, effectiveFrom, effectiveTo, amountCents,
//     billingBasis, prorationRule
//     natural key: membershipTypeKey x ageTier x effectiveFrom (#2067; a blank
//     ageTier is the flat, whole-type fee). Matches MembershipAnnualFee
//     @@unique([membershipTypeId, ageTier, effectiveFrom]). PER_FAMILY fees must
//     be flat (blank ageTier) — a per-family + per-tier row is a blocking row
//     error, mirroring the API 409 and the DB CHECK.
//   membership-fees/annual-fee-components.csv
//     membershipTypeKey, ageTier, effectiveFrom, label, amountCents, prorate,
//     xeroAccountCode, xeroItemCode, sortOrder
//     natural key: (parent annual fee = membershipTypeKey x ageTier x
//     effectiveFrom) x label. Each component is one Xero invoice line (#1932, E6).
//
// Money stays in integer cents throughout. Referenced membership types must
// already exist on the target (by key) — membership types themselves are not
// transferred by config transfer (they are seeded/managed on the Membership
// Types page); an unknown key is a blocking row error, exactly like the
// season-rates and item-code categories.
//
// Component invariant (#1932, E6), validated at plan time so a malformed bundle
// never reaches a write: a NO_INVOICE annual fee is a zero total with NO
// components; every invoiceable fee carries >=1 component whose amounts sum
// EXACTLY to the fee total. Because billing makes Σ(components) authoritative
// for an invoiceable fee, this is checked TWICE at plan time: once against the
// bundle's own amounts (validateComponentInvariant), and once against the
// EFFECTIVE POST-MERGE component set — the bundle's components PLUS any existing
// target components the bundle does not carry, which upsert-only apply leaves in
// place (validatePostMergeComponentInvariant). A bundle that renames a component
// label would otherwise leave the old row behind and silently double-bill.
//
// PRECEDENCE over the #1931 item-code-amount materialisation: when a bundle
// carries this category's joining-fees.csv AND the membership-fees category is
// actually being applied, the fee amounts are authoritative here, so the
// xero-config item-code-amount fan-out (which materialises JoiningFee windows
// from the item-code amountCents column) must NOT also run — it would duplicate
// or skew the schedule. A bundle without joining-fees.csv, or one imported with
// membership-fees DESELECTED, keeps the fan-out so its joining fees are not
// silently dropped. (Genuinely old pre-#1931 bundles — ENTRANCE_FEE category /
// isMember key — are rejected upstream since #2131.) See
// bundleCarriesJoiningFeeSchedule (consumed by xero-config, gated there on the
// category selection).

const JOINING_FEES_FILE = "membership-fees/joining-fees.csv";
const ANNUAL_FEES_FILE = "membership-fees/annual-fees.csv";
const ANNUAL_FEE_COMPONENTS_FILE = "membership-fees/annual-fee-components.csv";

const JOINING_FEE_FIELDS = [
  "membershipTypeKey",
  "ageTier",
  "effectiveFrom",
  "effectiveTo",
  "amountCents",
] as const;
const ANNUAL_FEE_FIELDS = [
  "membershipTypeKey",
  "ageTier",
  "effectiveFrom",
  "effectiveTo",
  "amountCents",
  "billingBasis",
  "prorationRule",
] as const;
const COMPONENT_FIELDS = [
  "membershipTypeKey",
  "ageTier",
  "effectiveFrom",
  "label",
  "amountCents",
  "prorate",
  "xeroAccountCode",
  "xeroItemCode",
  "sortOrder",
] as const;

const NO_INVOICE = "NO_INVOICE";
const DEFAULT_PRORATION_RULE = "NONE";

/**
 * True when a bundle carries the first-class joining-fee schedule (#1941). It
 * SUPERSEDES the #1931 item-code-amount joining-fee materialisation in
 * xero-config, but ONLY when the membership-fees category is actually being
 * applied — xero-config gates on that (an import that deselects membership-fees
 * must keep the fan-out or joining fees silently vanish). Consumed by
 * xero-config.
 */
export function bundleCarriesJoiningFeeSchedule(
  files: Map<string, Uint8Array>,
): boolean {
  return files.has(JOINING_FEES_FILE);
}

registerEntity({
  entity: "joining-fee",
  category: "membership-fees",
  tier: "key-strong",
  format: "csv",
  file: JOINING_FEES_FILE,
  naturalKey: ["membershipTypeKey", "ageTier", "effectiveFrom"],
  singleton: false,
  fields: [...JOINING_FEE_FIELDS],
});
registerEntity({
  entity: "annual-fee",
  category: "membership-fees",
  tier: "key-strong",
  format: "csv",
  file: ANNUAL_FEES_FILE,
  naturalKey: ["membershipTypeKey", "ageTier", "effectiveFrom"],
  singleton: false,
  fields: [...ANNUAL_FEE_FIELDS],
});
registerEntity({
  entity: "annual-fee-component",
  category: "membership-fees",
  // key-weak: MembershipAnnualFeeComponent has no DB unique on (fee, label); we
  // match by label within a parent fee (like induction's items), upsert-only.
  tier: "key-weak",
  format: "csv",
  file: ANNUAL_FEE_COMPONENTS_FILE,
  naturalKey: ["membershipTypeKey", "ageTier", "effectiveFrom", "label"],
  singleton: false,
  fields: [...COMPONENT_FIELDS],
});

/** date-only (@db.Date): serialise as YYYY-MM-DD. */
function toDateStr(value: Date | null | undefined): string {
  return value ? formatDateOnly(new Date(value)) : "";
}

/**
 * Parent-fee key for a component/fee: membershipTypeKey + ageTier + effective-from
 * (#2067). A blank/NULL ageTier is the flat, whole-type fee. Must include the tier
 * so a component attaches to its own tier's fee, never a sibling tier's.
 */
function parentKey(membershipTypeKey: string, ageTier: string | null, effectiveFrom: Date): string {
  return `${membershipTypeKey}/${ageTier ?? ""}/${toDateStr(effectiveFrom)}`;
}

// ---- Batched current-state loading (shared by plan + apply) -----------------

interface JoiningFeeCurrent {
  id: string;
  amountCents: number;
  effectiveTo: Date | null;
}
interface AnnualFeeCurrent {
  id: string;
  // #2067 finding 2: carried so the cross-row PER_FAMILY/tier mix guard can see
  // existing target rows (type, tier, window) the bundle does not overwrite.
  membershipTypeKey: string;
  ageTier: string | null;
  effectiveFrom: Date;
  amountCents: number;
  billingBasis: string;
  prorationRule: string;
  effectiveTo: Date | null;
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
interface FeesBatch {
  membershipTypeIdByKey: Map<string, string>;
  membershipTypeKeys: Set<string>;
  /** by `${key}/${ageTier??""}/${fromISO}` */
  joiningFees: Map<string, JoiningFeeCurrent>;
  /** by `${key}/${ageTier??""}/${fromISO}` (#2067) */
  annualFees: Map<string, AnnualFeeCurrent>;
  /** by `${key}/${ageTier??""}/${fromISO}/${label}` (last-wins on duplicate labels) */
  components: Map<string, ComponentCurrent>;
  /** by parentKey `${key}/${ageTier??""}/${fromISO}` → ALL existing rows (duplicates kept). */
  componentsByParent: Map<string, ComponentCurrent[]>;
}

async function loadFeesBatch(db: ReadDb): Promise<FeesBatch> {
  const [types, joiningRows, annualRows] = await Promise.all([
    db.membershipType.findMany({ select: { id: true, key: true } }),
    db.joiningFee.findMany({
      select: {
        id: true,
        ageTier: true,
        effectiveFrom: true,
        effectiveTo: true,
        amountCents: true,
        membershipType: { select: { key: true } },
      },
    }),
    db.membershipAnnualFee.findMany({
      select: {
        id: true,
        ageTier: true,
        effectiveFrom: true,
        effectiveTo: true,
        amountCents: true,
        billingBasis: true,
        prorationRule: true,
        membershipType: { select: { key: true } },
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
    }),
  ]);

  const membershipTypeIdByKey = new Map(types.map((t) => [t.key, t.id]));
  const joiningFees = new Map<string, JoiningFeeCurrent>();
  for (const r of joiningRows) {
    const key = `${r.membershipType.key}/${r.ageTier ?? ""}/${toDateStr(r.effectiveFrom)}`;
    joiningFees.set(key, {
      id: r.id,
      amountCents: r.amountCents,
      effectiveTo: r.effectiveTo,
    });
  }
  const annualFees = new Map<string, AnnualFeeCurrent>();
  const components = new Map<string, ComponentCurrent>();
  const componentsByParent = new Map<string, ComponentCurrent[]>();
  for (const fee of annualRows) {
    const pk = parentKey(fee.membershipType.key, fee.ageTier, fee.effectiveFrom);
    annualFees.set(pk, {
      id: fee.id,
      membershipTypeKey: fee.membershipType.key,
      ageTier: fee.ageTier,
      effectiveFrom: fee.effectiveFrom,
      amountCents: fee.amountCents,
      billingBasis: fee.billingBasis,
      prorationRule: fee.prorationRule,
      effectiveTo: fee.effectiveTo,
    });
    const list: ComponentCurrent[] = [];
    for (const c of fee.components) {
      const current: ComponentCurrent = {
        id: c.id,
        label: c.label,
        amountCents: c.amountCents,
        prorate: c.prorate,
        xeroAccountCode: c.xeroAccountCode,
        xeroItemCode: c.xeroItemCode,
        sortOrder: c.sortOrder,
      };
      // last-wins by label (mirrors the key-weak match); the full list below
      // preserves duplicates so the post-merge invariant can see them.
      components.set(`${pk}/${c.label}`, current);
      list.push(current);
    }
    componentsByParent.set(pk, list);
  }

  return {
    membershipTypeIdByKey,
    membershipTypeKeys: new Set(types.map((t) => t.key)),
    joiningFees,
    annualFees,
    components,
    componentsByParent,
  };
}

// ---- Export ----------------------------------------------------------------

export const membershipFeesExporter: CategoryExporter = {
  category: "membership-fees",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const [joiningFees, annualFees] = await Promise.all([
      ctx.db.joiningFee.findMany({
        select: {
          ageTier: true,
          effectiveFrom: true,
          effectiveTo: true,
          amountCents: true,
          membershipType: { select: { key: true } },
        },
      }),
      ctx.db.membershipAnnualFee.findMany({
        select: {
          ageTier: true,
          effectiveFrom: true,
          effectiveTo: true,
          amountCents: true,
          billingBasis: true,
          prorationRule: true,
          membershipType: { select: { key: true } },
          components: {
            select: {
              label: true,
              amountCents: true,
              prorate: true,
              xeroAccountCode: true,
              xeroItemCode: true,
              sortOrder: true,
            },
          },
        },
      }),
    ]);

    // Nothing to carry → emit nothing (the category is simply absent, like
    // xero-config with no mappings).
    if (joiningFees.length === 0 && annualFees.length === 0) return [];

    // Deterministic, install-independent ordering (never DB ids) so
    // export→import→export is byte-stable.
    const joiningRows = joiningFees
      .map((f) => ({
        membershipTypeKey: f.membershipType.key,
        ageTier: f.ageTier ?? "",
        effectiveFrom: toDateStr(f.effectiveFrom),
        effectiveTo: toDateStr(f.effectiveTo),
        amountCents: f.amountCents,
      }))
      .sort(
        (a, b) =>
          a.membershipTypeKey.localeCompare(b.membershipTypeKey) ||
          a.ageTier.localeCompare(b.ageTier) ||
          a.effectiveFrom.localeCompare(b.effectiveFrom),
      );

    const sortedAnnual = [...annualFees].sort(
      (a, b) =>
        a.membershipType.key.localeCompare(b.membershipType.key) ||
        (a.ageTier ?? "").localeCompare(b.ageTier ?? "") ||
        toDateStr(a.effectiveFrom).localeCompare(toDateStr(b.effectiveFrom)),
    );
    const annualRows: Record<string, unknown>[] = [];
    const componentRows: Record<string, unknown>[] = [];
    for (const fee of sortedAnnual) {
      annualRows.push({
        membershipTypeKey: fee.membershipType.key,
        ageTier: fee.ageTier ?? "",
        effectiveFrom: toDateStr(fee.effectiveFrom),
        effectiveTo: toDateStr(fee.effectiveTo),
        amountCents: fee.amountCents,
        billingBasis: fee.billingBasis,
        prorationRule: fee.prorationRule,
      });
      const comps = [...fee.components].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
      );
      for (const c of comps) {
        componentRows.push({
          membershipTypeKey: fee.membershipType.key,
          ageTier: fee.ageTier ?? "",
          effectiveFrom: toDateStr(fee.effectiveFrom),
          label: c.label,
          amountCents: c.amountCents,
          prorate: c.prorate,
          xeroAccountCode: c.xeroAccountCode,
          xeroItemCode: c.xeroItemCode,
          sortOrder: c.sortOrder,
        });
      }
    }

    // Always emit the full trio (header-only when empty) so the presence of the
    // category is self-describing AND joining-fees.csv exists whenever the
    // category is present — that presence is what supersedes the legacy
    // xero-config materialisation.
    return [
      {
        path: JOINING_FEES_FILE,
        category: "membership-fees",
        rowCount: joiningRows.length,
        bytes: strToU8(serialiseCsv([...JOINING_FEE_FIELDS], joiningRows)),
      },
      {
        path: ANNUAL_FEES_FILE,
        category: "membership-fees",
        rowCount: annualRows.length,
        bytes: strToU8(serialiseCsv([...ANNUAL_FEE_FIELDS], annualRows)),
      },
      {
        path: ANNUAL_FEE_COMPONENTS_FILE,
        category: "membership-fees",
        rowCount: componentRows.length,
        bytes: strToU8(serialiseCsv([...COMPONENT_FIELDS], componentRows)),
      },
    ];
  },
};

// ---- Row parsing + strict validation (shared by plan + apply) ---------------

interface ParsedJoiningFee {
  raw: Record<string, string>;
  membershipTypeKey: string;
  ageTier: string | null;
  effectiveFrom: Date;
  key: string;
  data: { amountCents: number; effectiveTo: Date | null };
}
interface ParsedAnnualFee {
  raw: Record<string, string>;
  membershipTypeKey: string;
  ageTier: string | null;
  effectiveFrom: Date;
  key: string;
  parentKey: string;
  billingBasis: string;
  data: {
    amountCents: number;
    effectiveTo: Date | null;
    billingBasis: string;
    prorationRule: string;
  };
}
interface ParsedComponent {
  raw: Record<string, string>;
  membershipTypeKey: string;
  ageTier: string | null;
  effectiveFrom: Date;
  label: string;
  key: string;
  parentKey: string;
  data: {
    amountCents: number;
    prorate: boolean;
    xeroAccountCode: string | null;
    xeroItemCode: string | null;
    sortOrder: number;
  };
}
interface ParsedFees {
  joiningFees: ParsedJoiningFee[];
  annualFees: ParsedAnnualFee[];
  components: ParsedComponent[];
}

function parseMembershipFees(
  files: Map<string, Uint8Array>,
  batch: FeesBatch,
  errors: string[],
  format: ClubFormat,
): ParsedFees {
  const out: ParsedFees = { joiningFees: [], annualFees: [], components: [] };

  readCsvRows(files, JOINING_FEES_FILE).forEach((raw, i) => {
    const v = new RowValidator(JOINING_FEES_FILE, i, errors);
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    if (membershipTypeKey && !batch.membershipTypeKeys.has(membershipTypeKey)) {
      errors.push(
        `${JOINING_FEES_FILE} row ${i + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
      );
    }
    const ageTier = nz(raw.ageTier) === null ? null : v.enum("ageTier", "AgeTier", raw.ageTier);
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const effectiveTo = nz(raw.effectiveTo) === null ? null : v.date("effectiveTo", raw.effectiveTo);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    // #2067 finding 3: NOT_APPLICABLE is the server-managed organisation/school
    // tier — it is never a real fee tier (the API's tier enum excludes it and the
    // resolver short-circuits it to the flat lookup). A compliant bundle can never
    // carry it, so block it as a row error. Guarded on v.ok so a separately
    // malformed enum is reported once.
    if (v.ok && ageTier === "NOT_APPLICABLE") {
      errors.push(
        `${JOINING_FEES_FILE} row ${i + 2}: ageTier — NOT_APPLICABLE is not a valid fee tier; leave ageTier blank for a flat, whole-type fee`,
      );
    }
    if (!v.ok || !batch.membershipTypeKeys.has(membershipTypeKey)) return;
    out.joiningFees.push({
      raw,
      membershipTypeKey,
      ageTier,
      effectiveFrom,
      key: `${membershipTypeKey}/${ageTier ?? ""}/${toDateStr(effectiveFrom)}`,
      data: { amountCents, effectiveTo },
    });
  });

  readCsvRows(files, ANNUAL_FEES_FILE).forEach((raw, i) => {
    const v = new RowValidator(ANNUAL_FEES_FILE, i, errors);
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    if (membershipTypeKey && !batch.membershipTypeKeys.has(membershipTypeKey)) {
      errors.push(
        `${ANNUAL_FEES_FILE} row ${i + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
      );
    }
    const ageTier = nz(raw.ageTier) === null ? null : v.enum("ageTier", "AgeTier", raw.ageTier);
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const effectiveTo = nz(raw.effectiveTo) === null ? null : v.date("effectiveTo", raw.effectiveTo);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    const billingBasis = v.enum("billingBasis", "MembershipFeeBillingBasis", raw.billingBasis);
    const prorationRule =
      nz(raw.prorationRule) === null
        ? DEFAULT_PRORATION_RULE
        : v.enum("prorationRule", "MembershipFeeProrationRule", raw.prorationRule);
    // Decision 1 (#2067): PER_FAMILY fees stay flat-only — a per-family + per-tier
    // row is a blocking row error (mirrors the API 409 and the DB CHECK). Guarded
    // on v.ok so a malformed enum is reported once, not doubled.
    if (v.ok && ageTier !== null && billingBasis === "PER_FAMILY") {
      errors.push(
        `${ANNUAL_FEES_FILE} row ${i + 2}: ageTier — a per-family fee must be flat (blank ageTier); per-age-tier rows are only allowed for per-member or no-invoice fees`,
      );
    }
    // #2067 finding 3: NOT_APPLICABLE is the server-managed organisation/school
    // tier — the fee-configuration API's tier enum excludes it, the resolver
    // short-circuits it to the flat lookup (so a per-tier NOT_APPLICABLE row is a
    // dead row that can never bill), and a public token would advertise a phantom
    // "— Not applicable" fee. A compliant bundle can never carry it, so block it.
    if (v.ok && ageTier === "NOT_APPLICABLE") {
      errors.push(
        `${ANNUAL_FEES_FILE} row ${i + 2}: ageTier — NOT_APPLICABLE is not a valid fee tier; leave ageTier blank for a flat, whole-type fee`,
      );
    }
    if (!v.ok || !batch.membershipTypeKeys.has(membershipTypeKey)) return;
    out.annualFees.push({
      raw,
      membershipTypeKey,
      ageTier,
      effectiveFrom,
      key: parentKey(membershipTypeKey, ageTier, effectiveFrom),
      parentKey: parentKey(membershipTypeKey, ageTier, effectiveFrom),
      billingBasis,
      data: { amountCents, effectiveTo, billingBasis, prorationRule },
    });
  });

  readCsvRows(files, ANNUAL_FEE_COMPONENTS_FILE).forEach((raw, i) => {
    const v = new RowValidator(ANNUAL_FEE_COMPONENTS_FILE, i, errors);
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    if (membershipTypeKey && !batch.membershipTypeKeys.has(membershipTypeKey)) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE} row ${i + 2}: membershipTypeKey — unknown membership type "${membershipTypeKey}"`,
      );
    }
    const ageTier = nz(raw.ageTier) === null ? null : v.enum("ageTier", "AgeTier", raw.ageTier);
    const effectiveFrom = v.date("effectiveFrom", raw.effectiveFrom);
    const label = v.required("label", raw.label);
    const amountCents = v.moneyCents("amountCents", raw.amountCents);
    const prorate = nz(raw.prorate) === null ? true : v.bool("prorate", raw.prorate);
    const sortOrder = nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
    if (!v.ok || !batch.membershipTypeKeys.has(membershipTypeKey)) return;
    out.components.push({
      raw,
      membershipTypeKey,
      ageTier,
      effectiveFrom,
      label,
      key: `${parentKey(membershipTypeKey, ageTier, effectiveFrom)}/${label}`,
      parentKey: parentKey(membershipTypeKey, ageTier, effectiveFrom),
      data: {
        amountCents,
        prorate,
        xeroAccountCode: nz(raw.xeroAccountCode),
        xeroItemCode: nz(raw.xeroItemCode),
        sortOrder,
      },
    });
  });

  validateComponentInvariant(out, errors, format);
  return out;
}

/** Format a list of labels for an error message: `"a", "b"`. */
function quoteLabels(labels: string[]): string {
  return labels.map((l) => `"${l}"`).join(", ");
}

/**
 * The #1932 component invariant, checked against the BUNDLE's own amounts so a
 * malformed bundle never reaches a write: a NO_INVOICE fee is a zero total with
 * no components; an invoiceable fee carries >=1 component summing EXACTLY to the
 * fee amount. Every annual-fee row must travel with its full component set (as
 * the export always emits them). Components whose parent fee is not in the
 * bundle are a blocking error (they cannot be reconciled against a total). A
 * bundle carrying two components with the same (fee window, label) cannot
 * round-trip (no DB unique; apply is last-wins by label) — also blocked here.
 */
function validateComponentInvariant(parsed: ParsedFees, errors: string[], format: ClubFormat): void {
  const componentsByParent = new Map<string, ParsedComponent[]>();
  for (const c of parsed.components) {
    const list = componentsByParent.get(c.parentKey) ?? [];
    list.push(c);
    componentsByParent.set(c.parentKey, list);
  }
  const feeKeys = new Set(parsed.annualFees.map((f) => f.parentKey));

  // FIX-3 (bundle side, #1941): duplicate (fee window, label) within the bundle.
  for (const [parentPk, comps] of componentsByParent) {
    const byLabel = new Map<string, number>();
    for (const c of comps) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);
    const dupes = [...byLabel.entries()].filter(([, n]) => n > 1).map(([l]) => l);
    if (dupes.length > 0) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: annual fee "${parentPk}" carries duplicate component label(s) ${quoteLabels(dupes)} — component labels must be unique within a fee window (the target has no unique constraint, so a duplicate cannot round-trip); rename or remove the duplicate row(s) in the bundle`,
      );
    }
  }

  for (const parentPk of componentsByParent.keys()) {
    if (!feeKeys.has(parentPk)) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: component(s) reference annual fee "${parentPk}" which is not present in ${ANNUAL_FEES_FILE} — a component set must travel with its fee so the total can be reconciled`,
      );
    }
  }

  for (const fee of parsed.annualFees) {
    const comps = componentsByParent.get(fee.parentKey) ?? [];
    if (fee.billingBasis === NO_INVOICE) {
      if (comps.length > 0) {
        errors.push(
          `${ANNUAL_FEE_COMPONENTS_FILE}: no-invoice annual fee "${fee.parentKey}" must not carry components`,
        );
      }
      if (fee.data.amountCents !== 0) {
        errors.push(
          `${ANNUAL_FEES_FILE}: no-invoice annual fee "${fee.parentKey}" must have amountCents 0`,
        );
      }
      continue;
    }
    if (comps.length === 0) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: invoiceable annual fee "${fee.parentKey}" must carry at least one component (in ${ANNUAL_FEE_COMPONENTS_FILE})`,
      );
      continue;
    }
    const sum = comps.reduce((total, c) => total + c.data.amountCents, 0);
    if (sum !== fee.data.amountCents) {
      errors.push(
        `${ANNUAL_FEE_COMPONENTS_FILE}: components for annual fee "${fee.parentKey}" sum to ${formatCents(sum, format)} but the fee amount is ${formatCents(fee.data.amountCents, format)}`,
      );
    }
  }
}

/**
 * The #1932 invariant re-checked against the EFFECTIVE POST-MERGE component set
 * (#1941, FIX-1). Apply is upsert-only and never deletes (ADR-002), so any
 * existing target component whose label the bundle does NOT carry survives the
 * import. Billing makes Σ(components) authoritative for an invoiceable fee, so a
 * leftover orphan silently over/under-bills members (classic case: the bundle
 * renames a component label, e.g. "Base fee" → "Membership base fee", leaving
 * both rows). For every fee window the bundle imports into that ALREADY exists
 * on the target, compute the post-merge set (bundle components upserted by label
 * PLUS leftover DB components) and block if it violates the invariant — Σ ≠ the
 * post-merge fee total, or a NO_INVOICE fee retaining any component. The
 * effective fee total honours the write mode (merge keeps the DB total/basis
 * when the bundle cell is blank), so merge-mode is protected too.
 *
 * This also blocks (FIX-3, target side) a pre-existing fee that already holds
 * duplicate-label components for a window the bundle imports into — a label-keyed
 * upsert cannot reconcile it; the admin must fix it on the Fees page first.
 */
function validatePostMergeComponentInvariant(
  parsed: ParsedFees,
  batch: FeesBatch,
  mode: ImportMode,
  errors: string[],
  format: ClubFormat,
): void {
  const bundleCompsByParent = new Map<string, ParsedComponent[]>();
  for (const c of parsed.components) {
    const list = bundleCompsByParent.get(c.parentKey) ?? [];
    list.push(c);
    bundleCompsByParent.set(c.parentKey, list);
  }

  for (const fee of parsed.annualFees) {
    const currentFee = batch.annualFees.get(fee.key) ?? null;
    const existingComps = batch.componentsByParent.get(fee.parentKey) ?? [];

    // FIX-3 (target side): duplicate labels already on the target for this fee.
    if (currentFee) {
      const byLabel = new Map<string, number>();
      for (const c of existingComps) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);
      const dupes = [...byLabel.entries()].filter(([, n]) => n > 1).map(([l]) => l);
      if (dupes.length > 0) {
        errors.push(
          `${ANNUAL_FEE_COMPONENTS_FILE}: the target's annual fee "${fee.parentKey}" already has duplicate-label component(s) ${quoteLabels(dupes)}, which a label-keyed import cannot reconcile — resolve the duplicate(s) on the Fees page before importing into this fee window`,
        );
      }
    }

    // Only an EXISTING fee can leave orphaned components behind or keep a
    // merge-preserved total; a brand-new fee's post-merge set equals the
    // bundle's, already validated by validateComponentInvariant.
    if (!currentFee) continue;

    // Effective post-merge fee total + billing basis (apply's merge/overwrite
    // semantics: merge keeps the DB value when the bundle cell is blank).
    const effectiveTotal =
      mode === "overwrite" || rawHasValue(fee.raw, "amountCents")
        ? fee.data.amountCents
        : currentFee.amountCents;
    const effectiveBasis =
      mode === "overwrite" || rawHasValue(fee.raw, "billingBasis")
        ? fee.data.billingBasis
        : currentFee.billingBasis;

    const bundleComps = bundleCompsByParent.get(fee.parentKey) ?? [];
    const bundleLabels = new Set(bundleComps.map((c) => c.label));

    // Existing DB components whose labels the bundle does NOT carry: upsert-only
    // apply leaves them in place, so they survive the merge.
    const leftovers = existingComps.filter((c) => !bundleLabels.has(c.label));
    const leftoverLabels = leftovers.map((c) => c.label);

    if (effectiveBasis === NO_INVOICE) {
      // A no-invoice fee must end with zero components. The bundle can't carry
      // any (validateComponentInvariant blocks that), but leftovers would remain.
      if (leftovers.length > 0) {
        errors.push(
          `${ANNUAL_FEE_COMPONENTS_FILE}: importing no-invoice annual fee "${fee.parentKey}" would leave orphaned component(s) ${quoteLabels(leftoverLabels)} on the target (upsert-only import never deletes) — a no-invoice fee must have no components; remove them on the Fees page first`,
        );
      }
      continue;
    }

    // Post-merge sum = each bundle component's effective (merge/overwrite) amount
    // PLUS every leftover DB component the bundle does not carry.
    let sum = 0;
    for (const c of bundleComps) {
      const existing = batch.components.get(c.key) ?? null;
      const eff =
        mode === "overwrite" || rawHasValue(c.raw, "amountCents")
          ? c.data.amountCents
          : existing?.amountCents ?? c.data.amountCents;
      sum += eff;
    }
    for (const c of leftovers) sum += c.amountCents;

    if (sum !== effectiveTotal) {
      if (leftoverLabels.length > 0) {
        errors.push(
          `${ANNUAL_FEE_COMPONENTS_FILE}: importing annual fee "${fee.parentKey}" would leave orphaned component(s) ${quoteLabels(leftoverLabels)} already on the target that the bundle does not carry (upsert-only import never deletes), so its post-merge components sum to ${formatCents(sum, format)} but the fee total is ${formatCents(effectiveTotal, format)} — remove or rename those component(s) on the Fees page before importing`,
        );
      } else {
        errors.push(
          `${ANNUAL_FEE_COMPONENTS_FILE}: after merge the components for annual fee "${fee.parentKey}" sum to ${formatCents(sum, format)} but the fee total would be ${formatCents(effectiveTotal, format)}`,
        );
      }
    }
  }
}

/** Inclusive, open-ended (effectiveTo null = no upper bound) window overlap —
 * the same semantics as authoritative-fees' scheduleOverlapWhere. */
function windowsOverlap(
  a: { effectiveFrom: Date; effectiveTo: Date | null },
  b: { effectiveFrom: Date; effectiveTo: Date | null },
): boolean {
  const aStartsBeforeBEnds = b.effectiveTo === null || a.effectiveFrom <= b.effectiveTo;
  const bStartsBeforeAEnds = a.effectiveTo === null || b.effectiveFrom <= a.effectiveTo;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

function describeWindow(f: { effectiveFrom: Date; effectiveTo: Date | null }): string {
  return `${toDateStr(f.effectiveFrom)}..${f.effectiveTo ? toDateStr(f.effectiveTo) : "open"}`;
}

/**
 * Cross-row PER_FAMILY / per-tier mix guard (#2067, FIX-2). The fee-configuration
 * API refuses a flat PER_FAMILY fee that overlaps ANY per-age-tier fee for the
 * same membership type in BOTH directions (route.ts `mixWhere`): a tiered member
 * would resolve the per-member tier row while a flat-only member resolves the
 * per-family row — an ambiguous pricing mix. The DB GiST EXCLUDE + CHECK
 * DELIBERATELY allow flat+tier coexistence (COALESCE'd tiers never conflict), so
 * they do NOT catch this; only the API did, and config-transfer bypasses the API.
 * Without this a hand-edited bundle carrying `TYPE,,…,PER_FAMILY` plus
 * `TYPE,ADULT,…,PER_MEMBER` in overlapping windows imports cleanly into the exact
 * state the API forbids.
 *
 * Mirrors the API by validating the EFFECTIVE POST-MERGE annual-fee set per type:
 * the bundle's rows (billingBasis + effectiveTo resolved for the write mode) PLUS
 * every existing target row the bundle does not overwrite (upsert-only apply
 * leaves those in place). Overlap uses the API's inclusive, open-ended semantics.
 */
function validatePerFamilyTierMix(
  parsed: ParsedFees,
  batch: FeesBatch,
  mode: ImportMode,
  errors: string[],
): void {
  interface EffectiveFee {
    ageTier: string | null;
    billingBasis: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }
  const byType = new Map<string, EffectiveFee[]>();
  const push = (typeKey: string, fee: EffectiveFee) => {
    const list = byType.get(typeKey) ?? [];
    list.push(fee);
    byType.set(typeKey, list);
  };

  const bundleKeys = new Set(parsed.annualFees.map((f) => f.key));
  // Existing target rows the bundle does NOT overwrite (same natural key) survive
  // the upsert-only apply, so they are part of the post-merge state.
  for (const current of batch.annualFees.values()) {
    const key = parentKey(current.membershipTypeKey, current.ageTier, current.effectiveFrom);
    if (bundleKeys.has(key)) continue;
    push(current.membershipTypeKey, {
      ageTier: current.ageTier,
      billingBasis: current.billingBasis,
      effectiveFrom: current.effectiveFrom,
      effectiveTo: current.effectiveTo,
    });
  }
  // Bundle rows, with billingBasis + effectiveTo resolved for the write mode
  // (merge keeps the DB value when the bundle cell is blank; billingBasis is a
  // required column so it is always the bundle's value, but effectiveTo can be
  // blank). effectiveFrom is the natural key, never merged.
  for (const row of parsed.annualFees) {
    const current = batch.annualFees.get(row.key) ?? null;
    const billingBasis =
      mode === "overwrite" || rawHasValue(row.raw, "billingBasis")
        ? row.data.billingBasis
        : current?.billingBasis ?? row.data.billingBasis;
    const effectiveTo =
      mode === "overwrite" || rawHasValue(row.raw, "effectiveTo")
        ? row.data.effectiveTo
        : current?.effectiveTo ?? row.data.effectiveTo;
    push(row.membershipTypeKey, {
      ageTier: row.ageTier,
      billingBasis,
      effectiveFrom: row.effectiveFrom,
      effectiveTo,
    });
  }

  for (const [typeKey, fees] of byType) {
    const flatPerFamily = fees.filter(
      (f) => f.ageTier === null && f.billingBasis === "PER_FAMILY",
    );
    const perTier = fees.filter((f) => f.ageTier !== null);
    if (flatPerFamily.length === 0 || perTier.length === 0) continue;
    for (const flat of flatPerFamily) {
      for (const tier of perTier) {
        if (windowsOverlap(flat, tier)) {
          errors.push(
            `${ANNUAL_FEES_FILE}: membership type "${typeKey}" would have a flat per-family fee (window ${describeWindow(flat)}) overlapping a per-age-tier ${tier.ageTier} fee (window ${describeWindow(tier)}) — a per-family (flat) fee and per-age-tier fees cannot both be active for one type in overlapping windows (mirrors the fee-configuration API); use one pricing model per window`,
          );
        }
      }
    }
  }
}

// ---- Plan ------------------------------------------------------------------

async function planMembershipFees(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const batch = await loadFeesBatch(ctx.db);
  const parsed = parseMembershipFees(ctx.files, batch, errors, ctx.format);
  // #1941 FIX-1/FIX-3: block imports whose EFFECTIVE post-merge component set
  // would break the Σ(components)=total billing invariant (leftover orphans from
  // a renamed label, or duplicate-label rows the label-keyed upsert can't fix).
  // Runs at plan time and therefore again at the in-lock re-plan.
  validatePostMergeComponentInvariant(parsed, batch, ctx.mode, errors, ctx.format);
  // #2067 FIX-2: block a bundle whose EFFECTIVE post-merge state would put a flat
  // PER_FAMILY fee in an overlapping window with a per-age-tier fee for the same
  // type — the API forbids this mix but the DB constraints allow it, so config
  // transfer must enforce it here. Runs at plan time and again at the in-lock
  // re-plan.
  validatePerFamilyTierMix(parsed, batch, ctx.mode, errors);

  for (const row of parsed.joiningFees) {
    const current = batch.joiningFees.get(row.key) ?? null;
    fingerprintParts.push(
      `joining-fee:${row.key}:${current ? hashRow(["amountCents", "effectiveTo"], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, current);
    items.push({
      entity: "joining-fee",
      key: row.key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  for (const row of parsed.annualFees) {
    const current = batch.annualFees.get(row.key) ?? null;
    fingerprintParts.push(
      `annual-fee:${row.key}:${
        current
          ? hashRow(["amountCents", "effectiveTo", "billingBasis", "prorationRule"], current)
          : "absent"
      }`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, current);
    items.push({
      entity: "annual-fee",
      key: row.key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  for (const row of parsed.components) {
    const current = batch.components.get(row.key) ?? null;
    fingerprintParts.push(
      `annual-fee-component:${row.key}:${
        current
          ? hashRow(
              ["amountCents", "prorate", "xeroAccountCode", "xeroItemCode", "sortOrder"],
              current,
            )
          : "absent"
      }`,
    );
    const write = updateDataForMode(ctx.mode, row.raw, row.data);
    const changed = changedFields(write, current);
    items.push({
      entity: "annual-fee-component",
      key: row.key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  return { items, warnings: [], errors, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyMembershipFees(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive collection only
  const batch = await loadFeesBatch(ctx.tx);
  const parsed = parseMembershipFees(ctx.files, batch, errors, ctx.format);

  // Joining fees (JoiningFee, keyed by type x ageTier x effectiveFrom).
  for (const row of parsed.joiningFees) {
    const membershipTypeId = batch.membershipTypeIdByKey.get(row.membershipTypeKey);
    if (!membershipTypeId) {
      result.skipped += 1;
      continue;
    }
    const current = batch.joiningFees.get(row.key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: (data) =>
        ctx.tx.joiningFee.create({
          data: {
            membershipTypeId,
            ageTier: row.ageTier as never,
            effectiveFrom: row.effectiveFrom,
            ...(data as object),
          } as never,
        }),
      update: (write) => ctx.tx.joiningFee.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  // Annual fees (MembershipAnnualFee, keyed by type x effectiveFrom); keep the
  // resolved fee id per parent so components can attach without re-querying.
  const feeIdByParent = new Map<string, string>();
  for (const row of parsed.annualFees) {
    const membershipTypeId = batch.membershipTypeIdByKey.get(row.membershipTypeKey);
    if (!membershipTypeId) {
      result.skipped += 1;
      continue;
    }
    const current = batch.annualFees.get(row.key) ?? null;
    let feeId = current?.id ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: async (data) => {
        const created = await ctx.tx.membershipAnnualFee.create({
          data: {
            membershipTypeId,
            ageTier: row.ageTier as never,
            effectiveFrom: row.effectiveFrom,
            ...(data as object),
          } as never,
          select: { id: true },
        });
        feeId = created.id;
      },
      update: (write) =>
        ctx.tx.membershipAnnualFee.update({ where: { id: current!.id }, data: write as never }),
      result,
    });
    if (feeId) feeIdByParent.set(row.parentKey, feeId);
  }

  // Annual-fee components (MembershipAnnualFeeComponent, keyed by parent fee +
  // label). Upsert-only (never delete), like induction's nested items — a
  // component the bundle drops is left in place (see the docs' upsert caveat).
  // The plan's post-merge invariant (validatePostMergeComponentInvariant) has
  // already refused any bundle whose leftover orphans would break Σ=total.
  for (const row of parsed.components) {
    const feeId = feeIdByParent.get(row.parentKey);
    if (!feeId) {
      result.skipped += 1;
      continue;
    }
    const current = batch.components.get(row.key) ?? null;
    await applyRow({
      mode: ctx.mode,
      raw: row.raw,
      data: row.data,
      current,
      create: (data) =>
        ctx.tx.membershipAnnualFeeComponent.create({
          data: { membershipAnnualFeeId: feeId, label: row.label, ...(data as object) } as never,
        }),
      update: (write) =>
        ctx.tx.membershipAnnualFeeComponent.update({ where: { id: current!.id }, data: write }),
      result,
    });
  }

  return result;
}

export const membershipFeesImporter: CategoryImporter = {
  category: "membership-fees",
  plan: planMembershipFees,
  apply: applyMembershipFees,
};
