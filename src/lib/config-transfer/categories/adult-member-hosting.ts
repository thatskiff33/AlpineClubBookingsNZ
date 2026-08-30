import { strFromU8, strToU8 } from "fflate";
import type {
  AdultMemberHostingMode,
  PolicyExceptionCapacityMode,
} from "@prisma/client";

import { ConfigTransferBundleError, type BundleEntry } from "../bundle";
import { parseCsv, serialiseCsv } from "../csv";
import type { ExportContext } from "../export-types";
import {
  changedFields,
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { registerEntity } from "../registry";
import {
  ADULT_MEMBER_HOST_SCOPES,
  type AdultMemberHostScope,
} from "@/lib/booking-policy-exceptions";
import {
  enabledHostScopeList,
  hostScopeSetIsEmpty,
} from "@/lib/policies/adult-member-hosting";
import { enqueueActiveHostingIncidentPolicyReconciliation } from "@/lib/adult-member-hosting-policy-reconciliation";
import { folderLodgeSlug, lodgeFolderSegments } from "./lodge-config";
import { asStr, RowValidator } from "../values";

/**
 * Adult-member hosting policy transfer (#2364).
 *
 * Carried inside the existing `booking-policies` category and following its
 * replace-set contract exactly: one row per scope, a scope present in the target
 * but absent from the file is DELETED (shown as such in the dry run), and a
 * header-only file intentionally clears every scope back to the built-in
 * defaults — club-wide off, lodges inheriting.
 *
 * Deleting a scope's row is not the same as disabling the rule, and the
 * difference is deliberate: an absent club row means "the club never decided",
 * which resolves to off, while a stored DISABLED row means "the club decided
 * off". Both behave identically today; only the second survives as a decision an
 * admin can see they made.
 */

export const ADULT_MEMBER_HOSTING_FILE =
  "booking-policies/adult-member-hosting.csv";

const FIELDS = ["scope", "mode", "capacityMode", "hostScopes"] as const;
const DATA_FIELDS = [
  "mode",
  "capacityMode",
  "hostScopeSameBooking",
  "hostScopeSameBookingOwner",
  // #3037. Every scope column belongs here. This list is what `hashRow` digests
  // into the plan's fingerprint, which is how an apply notices that the target
  // moved after the operator read the dry run — so a column left out means a
  // concurrent scope-set change between plan and apply is invisible and the
  // apply proceeds against a target it no longer describes. (`changedFields`
  // reads the parsed write-data's own keys rather than this list, so
  // update-versus-unchanged is not what this constant decides.)
  "hostScopeSameGroupTrip",
] as const;

/**
 * The host-qualification scope set as ONE cell (#2569 §2).
 *
 * A `|`-separated list of enabled scope names, or BLANK for the explicit inherit
 * option — a lodge following the club, or a club that never decided. One cell
 * rather than one column per scope because the database holds the columns to
 * all-NULL or all-set: separate cells could disagree with that in a hand-edited
 * file, and the importer would then have to guess which half the operator meant.
 *
 * Blank round-trips as blank, so exporting and re-importing a club that has never
 * touched the second dimension changes nothing — which is what keeps a transfer
 * from silently broadening a policy (§15).
 */
const HOST_SCOPE_CELL_SEPARATOR = "|";

function serialiseHostScopes(policy: {
  hostScopeSameBooking: boolean | null;
  hostScopeSameBookingOwner: boolean | null;
  hostScopeSameGroupTrip: boolean | null;
}): string {
  // The #2569 pair decides whether the row is an explicit set at all; the #3037
  // column is read as OFF when it is NULL, exactly as the evaluator reads it. A
  // decided row with NULL there — what a draining previous colour writes —
  // therefore exports as the set it really means, and re-importing that cell
  // writes an explicit `false` rather than reasserting the NULL.
  if (
    policy.hostScopeSameBooking === null ||
    policy.hostScopeSameBookingOwner === null
  ) {
    return "";
  }
  return enabledHostScopeList({
    sameBooking: policy.hostScopeSameBooking,
    sameBookingOwner: policy.hostScopeSameBookingOwner,
    sameGroupTrip: policy.hostScopeSameGroupTrip === true,
  }).join(HOST_SCOPE_CELL_SEPARATOR);
}

type HostScopeColumns = {
  hostScopeSameBooking: boolean | null;
  hostScopeSameBookingOwner: boolean | null;
  hostScopeSameGroupTrip: boolean | null;
};

const INHERITED_HOST_SCOPE_COLUMNS: HostScopeColumns = {
  hostScopeSameBooking: null,
  hostScopeSameBookingOwner: null,
  hostScopeSameGroupTrip: null,
};

/**
 * Parse the cell, pushing a sentence per problem rather than throwing.
 *
 * Refuses in the DRY RUN exactly what the admin route refuses on save: an unknown
 * name — which is how a bundle written against the removed `ANY_MEMBER_AT_LODGE`
 * or `NOMINATED_HOST` scopes is caught — a duplicate, and an empty explicit set. A
 * transfer is the one path that could otherwise write a setting the UI will not let
 * an operator choose, so the two refusals are kept deliberately identical.
 */
function parseHostScopeCell(
  raw: unknown,
  file: string,
  rowNumber: number,
  errors: string[],
): HostScopeColumns | null {
  const cell = asStr(raw).trim();
  if (cell === "") return INHERITED_HOST_SCOPE_COLUMNS;

  const names = cell.split(HOST_SCOPE_CELL_SEPARATOR).map((part) => part.trim());
  const seen = new Set<AdultMemberHostScope>();
  for (const name of names) {
    if (!ADULT_MEMBER_HOST_SCOPES.includes(name as AdultMemberHostScope)) {
      errors.push(
        `${file} row ${rowNumber}: hostScopes — "${name}" is not one of ${ADULT_MEMBER_HOST_SCOPES.join(", ")}`,
      );
      return null;
    }
    const scope = name as AdultMemberHostScope;
    if (seen.has(scope)) {
      errors.push(`${file} row ${rowNumber}: hostScopes — duplicate ${scope}`);
      return null;
    }
    seen.add(scope);
  }

  const scopes = {
    sameBooking: seen.has("SAME_BOOKING"),
    sameBookingOwner: seen.has("SAME_BOOKING_OWNER"),
    sameGroupTrip: seen.has("SAME_GROUP_TRIP"),
  };
  if (hostScopeSetIsEmpty(scopes)) {
    errors.push(
      `${file} row ${rowNumber}: hostScopes — leave the cell blank to inherit; an explicit set must name at least one scope`,
    );
    return null;
  }
  return {
    hostScopeSameBooking: scopes.sameBooking,
    hostScopeSameBookingOwner: scopes.sameBookingOwner,
    hostScopeSameGroupTrip: scopes.sameGroupTrip,
  };
}

registerEntity({
  entity: "adult-member-hosting-policy",
  category: "booking-policies",
  // The database DOES enforce one row per scope (unique scopeKey), so unlike
  // its minimum-stay sibling this key is strong.
  tier: "key-strong",
  format: "csv",
  file: ADULT_MEMBER_HOSTING_FILE,
  naturalKey: ["scope"],
  singleton: false,
  fields: [...FIELDS],
});

type HostingData = {
  mode: AdultMemberHostingMode;
  capacityMode: PolicyExceptionCapacityMode;
} & HostScopeColumns;

type CurrentHosting = HostingData & {
  id: string;
  scopeKey: string;
  lodgeId: string | null;
  scope: "club-wide" | `lodge:${string}`;
  version: number;
};

type ParsedHosting = {
  scope: "club-wide" | `lodge:${string}`;
  lodgeSlug: string | null;
  data: HostingData;
};

function lodgeScope(slug: string): `lodge:${string}` {
  return `lodge:${slug}`;
}

function bundledLodgeSlugs(ctx: PlanContext): Set<string> {
  if (!ctx.selectedCategories?.includes("lodge-config")) return new Set();
  return new Set(
    lodgeFolderSegments(ctx.files)
      .map((segment) => folderLodgeSlug(ctx.files, segment))
      .filter((slug): slug is string => slug !== null),
  );
}

async function loadCurrent(db: ReadDb): Promise<{
  byScope: Map<string, CurrentHosting>;
  lodgeIdBySlug: Map<string, string>;
  errors: string[];
}> {
  const [lodges, policies] = await Promise.all([
    db.lodge.findMany({ select: { id: true, slug: true } }),
    db.adultMemberHostingPolicy.findMany({
      select: {
        id: true,
        scopeKey: true,
        lodgeId: true,
        mode: true,
        capacityMode: true,
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: true,
        hostScopeSameGroupTrip: true,
        version: true,
      },
    }),
  ]);
  const lodgeIdBySlug = new Map(lodges.map((lodge) => [lodge.slug, lodge.id]));
  const lodgeSlugById = new Map(lodges.map((lodge) => [lodge.id, lodge.slug]));
  const byScope = new Map<string, CurrentHosting>();
  const errors: string[] = [];
  for (const policy of policies) {
    const slug = policy.lodgeId ? lodgeSlugById.get(policy.lodgeId) : null;
    if (policy.lodgeId && !slug) {
      errors.push(
        `The adult-member hosting policy references missing lodge id ${policy.lodgeId}; repair the data before transfer.`,
      );
      continue;
    }
    const scope = slug ? lodgeScope(slug) : "club-wide";
    byScope.set(scope, { ...policy, scope });
  }
  return { byScope, lodgeIdBySlug, errors };
}

function parseHosting(
  ctx: PlanContext | ApplyContext,
  knownLodgeSlugs: Set<string>,
  errors: string[],
): ParsedHosting[] {
  const parsed: ParsedHosting[] = [];
  const bytes = ctx.files.get(ADULT_MEMBER_HOSTING_FILE);
  if (!bytes) {
    errors.push(`${ADULT_MEMBER_HOSTING_FILE} is missing`);
    return parsed;
  }
  let rows: Record<string, string>[];
  try {
    const csv = parseCsv(strFromU8(bytes), { strictColumnCount: true });
    const exactHeader =
      csv.headers.length === FIELDS.length &&
      csv.headers.every((header, index) => header === FIELDS[index]);
    if (!exactHeader) {
      errors.push(
        `${ADULT_MEMBER_HOSTING_FILE}: header must be exactly ${FIELDS.join(",")}`,
      );
      return parsed;
    }
    rows = csv.rows;
  } catch (error) {
    errors.push(
      `${ADULT_MEMBER_HOSTING_FILE}: ${error instanceof Error ? error.message : "invalid CSV"}`,
    );
    return parsed;
  }

  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const v = new RowValidator(ADULT_MEMBER_HOSTING_FILE, index, errors);
    const scopeCell = v.required("scope", raw.scope);
    const mode = v.enum("mode", "AdultMemberHostingMode", raw.mode);
    const capacityMode = v.enum(
      "capacityMode",
      "PolicyExceptionCapacityMode",
      raw.capacityMode,
    );
    let rowValid = v.ok;

    let scope: ParsedHosting["scope"] = "club-wide";
    let lodgeSlug: string | null = null;
    if (scopeCell === "club-wide") {
      scope = "club-wide";
    } else if (scopeCell.startsWith("lodge:") && scopeCell.length > 6) {
      lodgeSlug = scopeCell.slice(6);
      scope = lodgeScope(lodgeSlug);
    } else {
      errors.push(
        `${ADULT_MEMBER_HOSTING_FILE} row ${index + 2}: scope — expected "club-wide" or "lodge:<slug>"`,
      );
      rowValid = false;
    }
    if (lodgeSlug !== null && !knownLodgeSlugs.has(lodgeSlug)) {
      errors.push(
        `${ADULT_MEMBER_HOSTING_FILE} row ${index + 2}: scope — lodge slug "${lodgeSlug}" does not exist in the target or selected lodge-config bundle`,
      );
      rowValid = false;
    }
    // The database CHECK refuses this too; refusing it in the dry run means the
    // admin sees a sentence instead of a failed apply.
    if (lodgeSlug === null && asStr(raw.mode) === "INHERIT") {
      errors.push(
        `${ADULT_MEMBER_HOSTING_FILE} row ${index + 2}: mode — the club-wide scope cannot inherit; use DISABLED or ADMIN_REVIEW_REQUIRED`,
      );
      rowValid = false;
    }
    if (seen.has(scope)) {
      errors.push(`${ADULT_MEMBER_HOSTING_FILE}: duplicate row for ${scope}`);
      rowValid = false;
    }
    seen.add(scope);
    const hostScopes = parseHostScopeCell(
      raw.hostScopes,
      ADULT_MEMBER_HOSTING_FILE,
      index + 2,
      errors,
    );
    if (hostScopes === null) rowValid = false;
    if (!rowValid || hostScopes === null) return;
    parsed.push({
      scope,
      lodgeSlug,
      data: {
        mode: mode as AdultMemberHostingMode,
        capacityMode: capacityMode as PolicyExceptionCapacityMode,
        ...hostScopes,
      },
    });
  });
  return parsed.sort((a, b) => a.scope.localeCompare(b.scope));
}

export async function exportAdultMemberHosting(
  ctx: ExportContext,
): Promise<BundleEntry> {
  const current = await loadCurrent(ctx.db);
  if (current.errors.length > 0) {
    throw new ConfigTransferBundleError(current.errors[0]);
  }
  const rows = [...current.byScope.values()]
    .sort((a, b) => a.scope.localeCompare(b.scope))
    .map((policy) => ({
      scope: policy.scope,
      mode: policy.mode,
      capacityMode: policy.capacityMode,
      hostScopes: serialiseHostScopes(policy),
    }));
  // Always emit the header, even for an empty set: absence means "category not
  // carried", a header-only file is the intentional clear.
  return {
    path: ADULT_MEMBER_HOSTING_FILE,
    category: "booking-policies",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...FIELDS], rows)),
  };
}

export async function planAdultMemberHosting(
  ctx: PlanContext,
): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  if (!ctx.files.has(ADULT_MEMBER_HOSTING_FILE)) {
    errors.push(
      `${ADULT_MEMBER_HOSTING_FILE} is required when booking-policies is selected; use a header-only file to intentionally clear every scope.`,
    );
    return { items, warnings: [], errors, fingerprintParts };
  }

  const current = await loadCurrent(ctx.db);
  errors.push(...current.errors);
  const knownLodgeSlugs = new Set(current.lodgeIdBySlug.keys());
  for (const slug of bundledLodgeSlugs(ctx)) knownLodgeSlugs.add(slug);
  const parsed = parseHosting(ctx, knownLodgeSlugs, errors);
  // A replace-set may classify deletions only after the whole incoming set is
  // valid, or a malformed file would look like an intentional clear.
  if (errors.length > 0) {
    return { items, warnings: [], errors, fingerprintParts };
  }
  const parsedScopes = new Set<string>(parsed.map((row) => row.scope));

  for (const policy of [...current.byScope.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    fingerprintParts.push(
      `adult-member-hosting-policy:${policy.id}:${policy.version}:${hashRow(
        [...DATA_FIELDS, "scopeKey", "lodgeId"],
        policy,
      )}`,
    );
  }
  for (const row of parsed) {
    const lodgeId =
      row.lodgeSlug === null
        ? null
        : (current.lodgeIdBySlug.get(row.lodgeSlug) ?? null);
    fingerprintParts.push(
      `adult-member-hosting-policy-lodge:${row.scope}:${lodgeId ?? "pending"}`,
    );
    const existing = current.byScope.get(row.scope) ?? null;
    const changed = changedFields(row.data, existing);
    items.push({
      entity: "adult-member-hosting-policy",
      key: row.scope,
      action: existing ? (changed.length ? "update" : "unchanged") : "create",
      changedFields: changed.length ? changed : undefined,
    });
  }
  for (const [scope] of current.byScope) {
    if (parsedScopes.has(scope)) continue;
    items.push({
      entity: "adult-member-hosting-policy",
      key: scope,
      action: "delete",
    });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  return { items, warnings: [], errors, fingerprintParts };
}

export async function applyAdultMemberHosting(
  ctx: ApplyContext,
  result: CategoryApplyResult,
): Promise<void> {
  if (!ctx.files.has(ADULT_MEMBER_HOSTING_FILE)) {
    throw new Error(`${ADULT_MEMBER_HOSTING_FILE} is required`);
  }
  const current = await loadCurrent(ctx.tx);
  if (current.errors.length > 0) {
    throw new ConfigTransferBundleError(current.errors[0]);
  }
  const errors: string[] = [];
  const parsed = parseHosting(
    ctx,
    new Set(current.lodgeIdBySlug.keys()),
    errors,
  );
  if (errors.length > 0) throw new Error(errors[0]);
  const parsedScopes = new Set<string>(parsed.map((row) => row.scope));
  let hostingPolicyChanged = false;

  for (const row of parsed) {
    const existing = current.byScope.get(row.scope) ?? null;
    const lodgeId =
      row.lodgeSlug === null
        ? null
        : current.lodgeIdBySlug.get(row.lodgeSlug);
    if (row.lodgeSlug !== null && !lodgeId) {
      throw new Error(`Lodge ${row.scope} was not created before booking policies`);
    }
    if (!existing) {
      await ctx.tx.adultMemberHostingPolicy.create({
        data: {
          scopeKey: lodgeId ?? "club-wide",
          lodgeId: lodgeId ?? null,
          version: 1,
          ...row.data,
        },
        select: { id: true },
      });
      result.created += 1;
      hostingPolicyChanged = true;
      continue;
    }
    const changed = changedFields(row.data, existing);
    if (changed.length === 0) {
      result.unchanged += 1;
      continue;
    }
    const updated = await ctx.tx.adultMemberHostingPolicy.updateMany({
      where: { id: existing.id, version: existing.version },
      data: { ...row.data, version: existing.version + 1 },
    });
    if (updated.count !== 1) {
      throw new Error(
        `The adult-member hosting policy for ${row.scope} changed during import`,
      );
    }
    result.updated += 1;
    hostingPolicyChanged = true;
  }

  for (const [scope, existing] of current.byScope) {
    if (parsedScopes.has(scope)) continue;
    const deleted = await ctx.tx.adultMemberHostingPolicy.deleteMany({
      where: { id: existing.id, version: existing.version },
    });
    if (deleted.count !== 1) {
      throw new Error(
        `The adult-member hosting policy for ${scope} changed during import`,
      );
    }
    result.deleted += 1;
    hostingPolicyChanged = true;
  }

  if (hostingPolicyChanged) {
    await enqueueActiveHostingIncidentPolicyReconciliation(
      {
        beforePolicies: [...current.byScope.values()],
      },
      ctx.tx,
    );
  }
}
