import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import {
  buildStructuredAuditLogCreateArgs,
  type StructuredAuditEvent,
} from "@/lib/audit";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { clubSeasonYear } from "@/lib/financial-year";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  BULK_LINKED_GUEST_LABEL_LIMIT,
  bulkSummaryAuditOutcome,
  countBulkOutcomes,
  runBulkSeasonalSave,
  type BulkSeasonalMembershipOutcome,
} from "@/lib/bulk-seasonal-save";
import { memberDisplayName } from "@/lib/member-serialization";
import { prisma } from "@/lib/prisma";
import {
  getSeasonalMembershipChangePreview,
  saveSeasonalMembershipAssignment,
  type BulkSeasonalMembershipXeroReconcile,
} from "@/lib/seasonal-membership-assignments";
import {
  serializeSubscriptionCategorySummary,
  subscriptionCategorySummarySelect,
} from "@/lib/subscription-categories";
import { reconcileMembersXeroContactGroups } from "@/lib/xero-contact-groups";

/**
 * #5248: set or clear many members' subscription category for one season in
 * one action. A thin wrapper over the single-member seasonal-membership
 * preview and save (INV-SSOT): each member is previewed and saved with their
 * OWN membership type and apply-from, so only the category moves, and every
 * rule the profile card enforces — the HMAC preview token, no-op suppression,
 * the linked-guest block and the per-member critical audit row — applies here
 * unchanged. This module adds only what a batch needs: per-member skips, one
 * summary audit and one deferred Xero reconcile.
 */

// test seam — the bulk category change summary audit. Each member still gets
// its own critical per-member audit inside saveSeasonalMembershipAssignment.
export const SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION =
  "admin.member.subscription_category_bulk_changed";

// The routes cap ids at 100, so this never truncates a valid request.
const BULK_MEMBER_ID_SAMPLE_LIMIT = 100;

/**
 * Why a selected member is left out of the batch.
 * - `no_membership_type`: no assignment row for that season, so there is no
 *   membership type to carry; assign one from the profile first.
 * - `membership_type_archived`: the member's own type is archived, and the
 *   single-member save refuses to re-save an archived type even unchanged.
 */
export type BulkSubscriptionCategorySkipReason =
  | "archived"
  | "not_found"
  | "no_membership_type"
  | "membership_type_archived";

export type BulkSubscriptionCategoryOutcome = BulkSeasonalMembershipOutcome | "skipped";

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

type BulkDb = typeof prisma;

type CategorySummary = ReturnType<typeof serializeSubscriptionCategorySummary>;

type LinkedGuestBookings = {
  count: number;
  truncatedCount: number;
  list: Array<Record<string, unknown>>;
};

// The slice of the single-member preview this module reads.
type SeasonalPreviewSlice = {
  previousAssignment: { subscriptionCategory: CategorySummary | null } | null;
  newSubscriptionCategory: CategorySummary | null;
  subscriptionCategoryChanged: boolean;
  currentAgeTier: AgeTier;
  resultingAgeTier: AgeTier;
  ageTierChanged: boolean;
  linkedGuestBookings: LinkedGuestBookings;
  currentSeasonSubscription: {
    seasonYear: number;
    status: SubscriptionStatus | "NO_RECORD";
    hasInvoice: boolean;
    xeroInvoiceNumber: string | null;
    paidAt: string | null;
  };
  previewToken: string;
};

/**
 * The target category must be assignable for the WHOLE request: an archived or
 * built-in target, or an unknown id, refuses the batch rather than every row.
 * `null` is Individual and always valid.
 */
async function validateTargetCategory(
  db: BulkDb,
  subscriptionCategoryId: string | null,
): Promise<JsonRouteResult | null> {
  if (subscriptionCategoryId === null) return null;
  const category = await db.subscriptionCategory.findUnique({
    where: { id: subscriptionCategoryId },
    select: subscriptionCategorySummarySelect,
  });
  if (!category) {
    return jsonResult({ error: "Subscription category not found" }, { status: 404 });
  }
  if (!category.isActive) {
    return jsonResult(
      { error: "Archived subscription categories cannot be newly assigned" },
      { status: 409 },
    );
  }
  if (category.isBuiltIn) {
    return jsonResult(
      {
        error:
          "The built-in Individual category cannot be assigned directly — choose Individual (no category) instead.",
      },
      { status: 409 },
    );
  }
  return null;
}

type MemberSeasonState =
  | { kind: "skip"; reason: BulkSubscriptionCategorySkipReason; name: string }
  | {
      kind: "ok";
      name: string;
      membershipTypeId: string;
      applyFrom: string | null;
    };

/**
 * Each selected member's name and the season assignment the change keeps:
 * their own membership type and apply-from. Read in two queries for the batch.
 */
async function loadMemberSeasonStates(
  db: BulkDb,
  ids: string[],
  seasonYear: number,
): Promise<Map<string, MemberSeasonState>> {
  const [members, assignments] = await Promise.all([
    db.member.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, email: true, archivedAt: true },
    }),
    db.seasonalMembershipAssignment.findMany({
      where: { memberId: { in: ids }, seasonYear },
      select: {
        memberId: true,
        membershipTypeId: true,
        applyFrom: true,
        membershipType: { select: { isActive: true } },
      },
    }),
  ]);
  const memberById = new Map(members.map((member) => [member.id, member]));
  const assignmentByMemberId = new Map(
    assignments.map((assignment) => [assignment.memberId, assignment]),
  );

  const states = new Map<string, MemberSeasonState>();
  for (const id of ids) {
    const member = memberById.get(id);
    if (!member) {
      states.set(id, { kind: "skip", reason: "not_found", name: id });
      continue;
    }
    const name = memberDisplayName(member);
    const assignment = assignmentByMemberId.get(id);
    if (member.archivedAt) {
      states.set(id, { kind: "skip", reason: "archived", name });
    } else if (!assignment) {
      states.set(id, { kind: "skip", reason: "no_membership_type", name });
    } else if (!assignment.membershipType.isActive) {
      states.set(id, { kind: "skip", reason: "membership_type_archived", name });
    } else {
      states.set(id, {
        kind: "ok",
        name,
        membershipTypeId: assignment.membershipTypeId,
        applyFrom: assignment.applyFrom ? calendarDateOfDateOnlyInstant(assignment.applyFrom) : null,
      });
    }
  }
  return states;
}

export type BulkSubscriptionCategoryPreviewRow = {
  memberId: string;
  name: string;
  previewToken: string;
  currentCategory: CategorySummary | null;
  newCategory: CategorySummary | null;
  /** True when the save would write: the category moves, or an age-tier drift is repaired. */
  changed: boolean;
  categoryChanged: boolean;
  currentAgeTier: AgeTier;
  resultingAgeTier: AgeTier;
  ageTierChanged: boolean;
  linkedGuestBlocked: boolean;
  linkedGuestBookings: LinkedGuestBookings;
  /**
   * The member's subscription for the chosen season. When it is already paid or
   * invoiced the billing run skips them, so the new category does not change
   * this season's invoice; the dialog says so.
   */
  currentSeasonSubscription: SeasonalPreviewSlice["currentSeasonSubscription"];
};

export async function previewBulkSubscriptionCategory(params: {
  ids: string[];
  seasonYear: number;
  /** `null` clears the category: the member is billed as Individual. */
  subscriptionCategoryId: string | null;
  /** The club's today and current season, read ONCE for the batch by the caller. */
  now: Date;
  clubCurrentSeasonYear: number;
  db?: BulkDb;
}): Promise<JsonRouteResult> {
  const db = params.db ?? prisma;
  const targetError = await validateTargetCategory(db, params.subscriptionCategoryId);
  if (targetError) return targetError;

  const uniqueIds = Array.from(new Set(params.ids));
  const states = await loadMemberSeasonStates(db, uniqueIds, params.seasonYear);

  const skipped: Array<{ memberId: string; name: string; reason: BulkSubscriptionCategorySkipReason }> = [];
  const rows: BulkSubscriptionCategoryPreviewRow[] = [];

  for (const memberId of uniqueIds) {
    const state = states.get(memberId)!;
    if (state.kind === "skip") {
      skipped.push({ memberId, name: state.name, reason: state.reason });
      continue;
    }

    const result = await getSeasonalMembershipChangePreview({
      memberId,
      seasonYear: params.seasonYear,
      membershipTypeId: state.membershipTypeId,
      applyFrom: state.applyFrom,
      subscriptionCategoryId: params.subscriptionCategoryId,
      now: params.now,
      clubCurrentSeasonYear: params.clubCurrentSeasonYear,
      db,
    });
    const status = result.init?.status;
    if (status && status >= 400) {
      const error = (result.body as { error?: string }).error ?? "";
      // A member or type that changed between the batch read and this preview
      // is that member's skip; anything else is a request-level failure.
      if (status === 404 && /member not found/i.test(error)) {
        skipped.push({ memberId, name: state.name, reason: "not_found" });
        continue;
      }
      if (status === 409 && /archived membership types/i.test(error)) {
        skipped.push({ memberId, name: state.name, reason: "membership_type_archived" });
        continue;
      }
      return result;
    }

    const preview = (result.body as { preview: SeasonalPreviewSlice }).preview;
    const flipsToNotApplicable =
      preview.resultingAgeTier === "NOT_APPLICABLE" &&
      preview.currentAgeTier !== "NOT_APPLICABLE";
    rows.push({
      memberId,
      name: state.name,
      previewToken: preview.previewToken,
      currentCategory: preview.previousAssignment?.subscriptionCategory ?? null,
      newCategory: preview.newSubscriptionCategory,
      changed: preview.subscriptionCategoryChanged || preview.ageTierChanged,
      categoryChanged: preview.subscriptionCategoryChanged,
      currentAgeTier: preview.currentAgeTier,
      resultingAgeTier: preview.resultingAgeTier,
      ageTierChanged: preview.ageTierChanged,
      linkedGuestBlocked: flipsToNotApplicable && preview.linkedGuestBookings.count > 0,
      linkedGuestBookings: {
        count: preview.linkedGuestBookings.count,
        truncatedCount: Math.max(
          0,
          preview.linkedGuestBookings.count - BULK_LINKED_GUEST_LABEL_LIMIT,
        ),
        list: preview.linkedGuestBookings.list.slice(0, BULK_LINKED_GUEST_LABEL_LIMIT),
      },
      currentSeasonSubscription: preview.currentSeasonSubscription,
    });
  }

  const changedCount = rows.filter((row) => row.changed).length;
  return jsonResult({
    seasonYear: params.seasonYear,
    subscriptionCategoryId: params.subscriptionCategoryId,
    summary: {
      requested: uniqueIds.length,
      previewed: rows.length,
      changed: changedCount,
      unchanged: rows.length - changedCount,
      skipped: skipped.length,
      ageTierChanges: rows.filter((row) => row.ageTierChanged).length,
      linkedGuestBlocks: rows.filter((row) => row.linkedGuestBlocked).length,
      alreadyBilled: rows.filter(
        (row) =>
          row.categoryChanged &&
          (row.currentSeasonSubscription.status === "PAID" ||
            row.currentSeasonSubscription.hasInvoice),
      ).length,
    },
    members: rows,
    skipped,
  });
}

export type BulkSubscriptionCategoryMemberResult = {
  memberId: string;
  name: string;
  outcome: BulkSubscriptionCategoryOutcome;
  status?: number;
  error?: string;
  skipReason?: BulkSubscriptionCategorySkipReason;
  linkedGuestBookings?: LinkedGuestBookings;
};

const STALE_PREVIEW_ERROR =
  "The subscription category preview is missing or stale. Preview the change again before saving.";

/**
 * Save a previewed bulk category change. Per member it re-reads the season
 * assignment and calls the single-member save with that member's own type and
 * apply-from and the preview token; one member's failure never aborts the rest.
 * Afterwards it writes ONE important-severity summary audit and runs ONE Xero
 * contact-group reconcile, for the current season only, over the members whose
 * age tier the save repaired — today's grouping follows membership type and
 * age tier, not category, so a category-only change has nothing to sync.
 * `changedMemberIds` is returned for a later grouping that does follow category.
 */
export async function bulkSaveSubscriptionCategory(params: {
  ids: string[];
  seasonYear: number;
  subscriptionCategoryId: string | null;
  adminMemberId: string;
  reason: string;
  previewTokens: Record<string, string>;
  request?: StructuredAuditEvent["request"];
  db?: BulkDb;
}): Promise<JsonRouteResult> {
  const reason = params.reason.trim();
  if (!reason) {
    return jsonResult({ error: "Admin reason is required" }, { status: 400 });
  }

  const db = params.db ?? prisma;
  const targetError = await validateTargetCategory(db, params.subscriptionCategoryId);
  if (targetError) return targetError;

  const uniqueIds = Array.from(new Set(params.ids));
  const states = await loadMemberSeasonStates(db, uniqueIds, params.seasonYear);
  const results: BulkSubscriptionCategoryMemberResult[] = [];
  const changedMemberIds: string[] = [];
  const ageTierRepairedMemberIds: string[] = [];

  for (const memberId of uniqueIds) {
    const state = states.get(memberId)!;
    if (state.kind === "skip") {
      results.push({
        memberId,
        name: state.name,
        outcome: "skipped",
        skipReason: state.reason,
      });
      continue;
    }

    const previewToken = params.previewTokens[memberId];
    if (!previewToken) {
      results.push({
        memberId,
        name: state.name,
        outcome: "stale",
        status: 409,
        error: STALE_PREVIEW_ERROR,
      });
      continue;
    }

    const classified = await runBulkSeasonalSave<LinkedGuestBookings>(
      () =>
        saveSeasonalMembershipAssignment({
          memberId,
          seasonYear: params.seasonYear,
          membershipTypeId: state.membershipTypeId,
          applyFrom: state.applyFrom,
          subscriptionCategoryId: params.subscriptionCategoryId,
          adminMemberId: params.adminMemberId,
          reason,
          previewToken,
          request: params.request,
          db,
          skipXeroContactGroupSync: true,
        }),
      { memberId, seasonYear: params.seasonYear, subscriptionCategoryId: params.subscriptionCategoryId },
      "Bulk subscription category save threw for a member (isolated, continuing)",
    );
    results.push({
      memberId,
      name: state.name,
      outcome: classified.outcome,
      status: classified.status,
      ...(classified.error !== undefined ? { error: classified.error } : {}),
      ...(classified.linkedGuestBookings
        ? { linkedGuestBookings: classified.linkedGuestBookings }
        : {}),
    });
    if (classified.outcome === "changed") {
      changedMemberIds.push(memberId);
      if (classified.ageTierChanged) ageTierRepairedMemberIds.push(memberId);
    }
  }

  const outcomeCounts = countBulkOutcomes<BulkSubscriptionCategoryOutcome>(results, [
    "changed",
    "unchanged",
    "stale",
    "blocked_linked_guests",
    "error",
    "skipped",
  ]);


  await db.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION,
      actor: { memberId: params.adminMemberId },
      entity: {
        type: "SeasonalMembershipAssignment",
        id: `bulk-category:${params.seasonYear}:${params.subscriptionCategoryId ?? "individual"}`,
      },
      category: "admin",
      severity: "important",
      outcome: bulkSummaryAuditOutcome(outcomeCounts),
      summary: "Subscription category changed in bulk",
      metadata: {
        seasonYear: params.seasonYear,
        subscriptionCategoryId: params.subscriptionCategoryId,
        adminReason: reason,
        requestedCount: uniqueIds.length,
        outcomeCounts,
        memberIds: uniqueIds.slice(0, BULK_MEMBER_ID_SAMPLE_LIMIT),
      },
      request: params.request,
    }),
  );

  let xeroReconcile: BulkSeasonalMembershipXeroReconcile | null = null;
  if (ageTierRepairedMemberIds.length > 0) {
    const clubCurrentSeasonYear = clubSeasonYear(await readClubTimeZoneOutsideRequest());
    if (params.seasonYear === clubCurrentSeasonYear) {
      const reconcileResult = await reconcileMembersXeroContactGroups(
        ageTierRepairedMemberIds,
        {
          createdByMemberId: params.adminMemberId,
          reason: "subscription_category_bulk",
        },
      );
      xeroReconcile = {
        attempted: ageTierRepairedMemberIds.length,
        succeeded: reconcileResult.processed,
        haltedByDailyLimit: reconcileResult.haltedByDailyLimit,
      };
    }
  }

  return jsonResult({
    seasonYear: params.seasonYear,
    subscriptionCategoryId: params.subscriptionCategoryId,
    requestedCount: uniqueIds.length,
    outcomeCounts,
    results,
    changedMemberIds,
    xeroReconcile,
  });
}
