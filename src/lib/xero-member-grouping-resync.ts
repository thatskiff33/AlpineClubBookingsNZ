/**
 * Xero member grouping — mode-driven dry-run snapshot + bulk re-sync (E8, #1934).
 *
 * The snapshot generalises the old age-tier mismatch snapshot
 * (`getXeroContactGroupMismatchSnapshot`) to the mode model: it recomputes,
 * purely from the local caches, which members would have a group add/remove
 * under the current mode + active rules, plus a call-budget estimate. It NEVER
 * calls Xero.
 *
 * The bulk re-sync is admin-triggered only and, in this wave, ships as code +
 * runbook (never executed against live Xero). A run is mandatory-preceded by a
 * dry-run. It is:
 *  - cache-first pre-filtered: only members the snapshot flags are touched
 *    (reuse of the #1441 cache-recompute precedent);
 *  - chunked + resumable via a member-id cursor;
 *  - rate-limited by the existing withXeroRetry/callXeroApi 429 minute/day
 *    classification inside `syncManagedXeroContactGroupForMember`;
 *  - per-member failures are ledgered (inside the per-member sync) and
 *    non-fatal to the run; a daily-limit stop is surfaced so the run resumes;
 *  - members without a Xero contact are reported as skipped, never omitted.
 *
 * It NEVER advances the CONTACT delta-sync watermark; the per-member sync only
 * refreshes the contact/group caches (which dual-write the CONTACT_GROUP_CACHE
 * cursor per #1443). The CONTACT_GROUP_FULL_REFRESH cursor stays the
 * authoritative group-cache staleness signal.
 */

import { createHash } from "node:crypto";
import type { AgeTier, XeroMemberGroupingMode } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { syncManagedXeroContactGroupForMember } from "@/lib/xero-contact-groups";
import {
  loadXeroGroupingContext,
  planMemberGroupingSync,
  resolveMemberGroupingsForMembers,
  type XeroGroupingContext,
  type XeroGroupRef,
} from "@/lib/xero-member-grouping";

// Staleness authority for the snapshot: the FULL rebuild cursor. The shared
// CONTACT_GROUP_CACHE cursor is also bumped by per-contact reconciliation
// (member link/import, inbound webhooks, post-sync refreshes), so it almost
// always looks fresh and would under-report how stale the whole cached
// group-membership snapshot is (#1443).
const CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE = "CONTACT_GROUP_FULL_REFRESH";
const DEFAULT_XERO_SYNC_SCOPE = "default";

// ---------------------------------------------------------------------------
// Server-side dry-run freshness (#1961)
// ---------------------------------------------------------------------------

/**
 * Wall-clock window a freshly-recorded dry-run stays valid to *start* a bulk
 * re-sync. Only enforced on the initiating chunk (afterMemberId absent) — once a
 * run is in progress, resumes (including a next-day resume after a Xero
 * daily-limit halt) are guarded by the far stronger cache-cursor + rules
 * fingerprint equality instead, which the re-sync never advances itself, so a
 * legitimate multi-day resume is not forced back through review.
 */
const DRY_RUN_INITIAL_FRESHNESS_MS = 30 * 60 * 1000;

/**
 * Self-bounding retention for the {@link recordXeroMemberGroupingDryRun} audit
 * table (#1961). Recorded dry-runs are only useful within the 30-minute initial
 * window (and for the lifetime of an in-progress resume), so rows far older than
 * that are pruned opportunistically on each new dry-run — no dedicated cron,
 * mirroring `cron-job-run.ts`/`audit-retention.ts`. 7 days is generous headroom
 * over the freshness window and any realistic multi-day daily-limit resume.
 */
const DRY_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type DryRunFreshnessFailure =
  | "not_found"
  | "not_started"
  | "already_started"
  | "expired"
  | "cache_cursor_changed"
  | "rules_changed"
  | "plan_changed";

/**
 * Thrown by the bulk re-sync engine when the referenced dry-run cannot be
 * confirmed fresh (or the run cannot be validly initiated/resumed) at execution
 * start. The route maps `not_found` to 422 and every other reason to 409, and
 * audit-logs the rejection.
 */
export class StaleDryRunError extends Error {
  readonly reason: DryRunFreshnessFailure;
  constructor(reason: DryRunFreshnessFailure, message: string) {
    super(message);
    this.name = "StaleDryRunError";
    this.reason = reason;
  }
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Fingerprint-compatibility serialization of a rule's tier set (#2093, D-B5).
 * The historical tuple element was the SCALAR rule.ageTier, so to keep the
 * fingerprint byte-identical across the scalar->array migration this back-maps
 * for FINGERPRINT PURPOSES ONLY (storage stays canonical-sorted arrays):
 *  - `[]`      -> null   (the migrated "Any age" rule — WITHOUT this the first
 *                         post-deploy resync would see every existing rule churn
 *                         and do a spurious full regroup),
 *  - `[X]`     -> "X"    (the single-tier rule — same as the old scalar),
 *  - `[X, Y…]` -> the canonical-sorted array (a genuinely new 2+-tier shape).
 */
function fingerprintAgeTiers(ageTiers: AgeTier[]): AgeTier | AgeTier[] | null {
  // The scalar back-map reads the single tier itself, so "exactly one" is a
  // first with no rest rather than a count that licenses a later read; the
  // three fingerprint shapes are unchanged (#2800).
  const [firstTier, ...laterTiers] = ageTiers;
  if (firstTier === undefined) return null;
  if (laterTiers.length === 0) return firstTier;
  // Deliberate lexicographic sort (not CANONICAL_AGE_TIER_ORDER): it only needs
  // to be deterministic, and it is harmless — this branch is reached only by a
  // genuinely-new 2+-tier rule, which has no historical scalar fingerprint to
  // stay byte-compatible with. Do not "fix" it to the canonical order.
  return [...ageTiers].sort();
}

/**
 * Stable fingerprint of the grouping *decision inputs*: the mode plus every
 * active rule's grouping-relevant fields (type slot, tier slot, kind, target
 * group, sort order — NOT the display-only groupName or the row id, so a
 * delete+recreate of an identically-shaped rule is correctly treated as
 * unchanged). Any add/edit/toggle/delete of an active rule, or a mode switch,
 * moves this fingerprint. Derived from a single already-loaded context so the
 * fingerprint and the plan it guards observe the same rule snapshot.
 */
export function computeXeroGroupingRulesFingerprint(
  context: XeroGroupingContext,
): string {
  const rules = context.activeRules
    .map(
      (rule) =>
        [
          rule.membershipTypeId,
          fingerprintAgeTiers(rule.ageTiers),
          rule.kind,
          rule.groupId,
          rule.sortOrder,
        ] as const,
    )
    .map((tuple) => JSON.stringify(tuple))
    .sort();
  return stableDigest([context.mode, rules]);
}

/**
 * Stable digest of the concrete planned add/remove operations (per member,
 * remove-ids sorted, ordered by member id). Two dry-runs with the same planned
 * changes produce the same digest regardless of iteration order.
 */
function computePlannedDigest(mismatches: MemberGroupingDiffEntry[]): string {
  const ops = mismatches
    .map(
      (entry) =>
        [
          entry.memberId,
          entry.addGroupId,
          [...entry.removeGroupIds].sort(),
        ] as const,
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
  return stableDigest(ops);
}

export interface MemberGroupingDiffEntry {
  memberId: string;
  memberName: string;
  memberEmail: string;
  ageTier: AgeTier;
  xeroContactId: string;
  managedGroup: XeroGroupRef | null;
  addGroupId: string | null;
  removeGroupIds: string[];
}

/**
 * Information-only residue: a member no rule matches (e.g. a NOT_APPLICABLE
 * organisation) who nevertheless sits in managed-universe group(s). The sync
 * and bulk re-sync NEVER write to these members — the entry exists so the
 * admin can see them (parity with the retired age-tier snapshot) and clean
 * them up in Xero deliberately.
 */
export interface MemberGroupingInformationalEntry {
  memberId: string;
  memberName: string;
  memberEmail: string;
  ageTier: AgeTier;
  xeroContactId: string;
  /** Managed-universe groups the member sits in although no rule matches. */
  unexpectedManagedGroupIds: string[];
}

export interface MemberGroupingSnapshot {
  mode: XeroMemberGroupingMode;
  cacheReady: boolean;
  lastRefreshedAt: string | null;
  /**
   * Fingerprint of the mode + active rules this snapshot was computed against
   * (#1961). Persisted with a recorded dry-run and re-checked by the bulk
   * re-sync so a rule/mode change since review is rejected.
   */
  rulesFingerprint: string;
  /** Digest of the full planned add/remove operations (before any limit slice). */
  plannedDigest: string;
  activeRuleCount: number;
  membersConsidered: number;
  mismatchCount: number;
  addCount: number;
  removeCount: number;
  /** Rough upper bound of Xero calls a full re-sync of the mismatches costs. */
  estimatedXeroCalls: number;
  skippedNoContact: Array<{ memberId: string; memberName: string }>;
  mismatches: MemberGroupingDiffEntry[];
  /** Count of {@link informational} entries (before any limit slicing). */
  informationalCount: number;
  /** Parked members in managed groups — surfaced, never written to. */
  informational: MemberGroupingInformationalEntry[];
}

function memberName(member: { firstName: string; lastName: string; email: string }): string {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

/**
 * Pure per-member Xero-call estimate for a planned change: getContact +
 * (add?1:0) + removes + a post-write getContact refresh.
 */
function estimateCallsFor(entry: MemberGroupingDiffEntry): number {
  return 1 + (entry.addGroupId ? 1 : 0) + entry.removeGroupIds.length + 1;
}

/**
 * Mode-driven dry-run snapshot. Recomputes from the local caches only.
 */
export async function getXeroMemberGroupingSnapshot(options?: {
  limit?: number;
}): Promise<MemberGroupingSnapshot> {
  const [context, cursor] = await Promise.all([
    loadXeroGroupingContext(),
    prisma.xeroSyncCursor.findUnique({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
      select: { lastSuccessfulSyncAt: true },
    }),
  ]);

  const base = {
    mode: context.mode,
    activeRuleCount: context.activeRules.length,
    rulesFingerprint: computeXeroGroupingRulesFingerprint(context),
  };

  // cacheReady tracks the same FULL-refresh cursor: the snapshot enumerates
  // EVERY linked member against the membership cache, which only a full
  // "Refresh Xero Groups" rebuild fully populates — per-contact reconciliation
  // alone is not enough to trust a population-wide diff.
  if (!cursor?.lastSuccessfulSyncAt) {
    return {
      ...base,
      cacheReady: false,
      lastRefreshedAt: null,
      plannedDigest: computePlannedDigest([]),
      membersConsidered: 0,
      mismatchCount: 0,
      addCount: 0,
      removeCount: 0,
      estimatedXeroCalls: 0,
      skippedNoContact: [],
      mismatches: [],
      informationalCount: 0,
      informational: [],
    };
  }

  const lastRefreshedAt = cursor.lastSuccessfulSyncAt.toISOString();

  // NONE mode: the sync is a total no-op, so there is never a diff.
  if (context.mode === "NONE") {
    return {
      ...base,
      cacheReady: true,
      lastRefreshedAt,
      plannedDigest: computePlannedDigest([]),
      membersConsidered: 0,
      mismatchCount: 0,
      addCount: 0,
      removeCount: 0,
      estimatedXeroCalls: 0,
      skippedNoContact: [],
      mismatches: [],
      informationalCount: 0,
      informational: [],
    };
  }

  const members = await prisma.member.findMany({
    where: { active: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      xeroContactId: true,
    },
  });

  const withContact = members.filter(
    (member): member is typeof member & { xeroContactId: string } =>
      Boolean(member.xeroContactId),
  );
  const skippedNoContact = members
    .filter((member) => !member.xeroContactId)
    .map((member) => ({ memberId: member.id, memberName: memberName(member) }));

  const contactIds = withContact.map((member) => member.xeroContactId);
  const memberships = contactIds.length
    ? await prisma.xeroContactGroupMembershipCache.findMany({
        where: { contactId: { in: contactIds }, group: { is: { status: "ACTIVE" } } },
        select: { contactId: true, contactGroupId: true },
      })
    : [];
  const groupIdsByContactId = new Map<string, string[]>();
  for (const row of memberships) {
    const list = groupIdsByContactId.get(row.contactId) ?? [];
    list.push(row.contactGroupId);
    groupIdsByContactId.set(row.contactId, list);
  }

  // Re-read the FULL-refresh cursor AFTER the membership-cache read and anchor
  // the snapshot's freshness to THIS value, not the earlier one (#1961 FIX 2).
  // The membership rows and the cursor come from two separate queries, so a
  // refreshXeroContactGroupCache commit can land between them — pairing the old
  // cursor with post-refresh membership rows. Anchoring to the later cursor read
  // means such an interleave surfaces as a cursor value that no longer equals the
  // recorded dry-run's cacheCursorAt, so assertDryRunFresh's cursor-equality
  // check rejects it (cache_cursor_changed) instead of silently running against
  // unreviewed membership. If the refresh cursor vanished mid-flight (it should
  // not), fall back to the initial read.
  const cursorAfterMembership = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: { lastSuccessfulSyncAt: true },
  });
  const effectiveRefreshedAt = (
    cursorAfterMembership?.lastSuccessfulSyncAt ?? cursor.lastSuccessfulSyncAt
  ).toISOString();

  const resolutions = await resolveMemberGroupingsForMembers({
    members: withContact.map((member) => ({ id: member.id, ageTier: member.ageTier })),
    context,
  });

  const mismatches: MemberGroupingDiffEntry[] = [];
  const informational: MemberGroupingInformationalEntry[] = [];
  let addCount = 0;
  let removeCount = 0;
  let estimatedXeroCalls = 0;

  for (const member of withContact) {
    const resolution = resolutions.get(member.id);
    if (!resolution) continue;
    const currentGroupIds = groupIdsByContactId.get(member.xeroContactId) ?? [];

    // Parked members (no matching rule, e.g. NOT_APPLICABLE organisations)
    // get no add/remove plan — but when they sit in managed-universe groups
    // they are surfaced informationally, matching the retired age-tier
    // snapshot and the runbook's "expected residue". The bulk re-sync never
    // touches them (it iterates `mismatches` only).
    if (resolution.skippedReason) {
      const universe = new Set(resolution.managedUniverse);
      const unexpectedManagedGroupIds = currentGroupIds.filter((id) =>
        universe.has(id),
      );
      if (unexpectedManagedGroupIds.length > 0) {
        informational.push({
          memberId: member.id,
          memberName: memberName(member),
          memberEmail: member.email,
          ageTier: member.ageTier,
          xeroContactId: member.xeroContactId,
          unexpectedManagedGroupIds,
        });
      }
      continue;
    }

    const plan = planMemberGroupingSync({
      resolution,
      currentGroupIds,
    });
    if (plan.isNoop) continue;

    const entry: MemberGroupingDiffEntry = {
      memberId: member.id,
      memberName: memberName(member),
      memberEmail: member.email,
      ageTier: member.ageTier,
      xeroContactId: member.xeroContactId,
      managedGroup: plan.managedGroup,
      addGroupId: plan.groupToAdd?.id ?? null,
      removeGroupIds: plan.groupIdsToRemove,
    };
    mismatches.push(entry);
    if (entry.addGroupId) addCount += 1;
    removeCount += entry.removeGroupIds.length;
    estimatedXeroCalls += estimateCallsFor(entry);
  }

  return {
    ...base,
    cacheReady: true,
    lastRefreshedAt: effectiveRefreshedAt,
    plannedDigest: computePlannedDigest(mismatches),
    membersConsidered: withContact.length,
    mismatchCount: mismatches.length,
    addCount,
    removeCount,
    estimatedXeroCalls,
    skippedNoContact,
    mismatches:
      typeof options?.limit === "number"
        ? mismatches.slice(0, Math.max(1, options.limit))
        : mismatches,
    informationalCount: informational.length,
    informational:
      typeof options?.limit === "number"
        ? informational.slice(0, Math.max(1, options.limit))
        : informational,
  };
}

// ---------------------------------------------------------------------------
// Recorded dry-run (server-side provenance, #1961)
// ---------------------------------------------------------------------------

export interface RecordedDryRunResult {
  snapshot: MemberGroupingSnapshot;
  /**
   * Id of the persisted dry-run to hand to the bulk re-sync, or null when the
   * group cache has never been refreshed (no cursor to anchor freshness to — the
   * admin must refresh the cache first, so no re-sync could run anyway).
   */
  dryRunId: string | null;
}

/**
 * Run the dry-run snapshot AND persist its provenance (#1961): the mode, the
 * CONTACT_GROUP_FULL_REFRESH cache cursor it was computed against, a fingerprint
 * of the active rules, a digest of the planned changes, and the headline counts.
 * The bulk re-sync references the returned id and re-validates it at execution
 * start, so "never re-sync without a recent, still-matching reviewed diff" holds
 * server-side regardless of what the client asserts.
 */
export async function recordXeroMemberGroupingDryRun(options: {
  limit?: number;
  createdByMemberId?: string;
}): Promise<RecordedDryRunResult> {
  const snapshot = await getXeroMemberGroupingSnapshot({ limit: options.limit });

  // No full-refresh cursor yet: nothing to anchor freshness to and no re-sync
  // can run, so skip persistence and let the UI prompt for a cache refresh.
  if (!snapshot.lastRefreshedAt) {
    return { snapshot, dryRunId: null };
  }

  const record = await prisma.xeroMemberGroupingDryRun.create({
    data: {
      mode: snapshot.mode,
      cacheCursorAt: new Date(snapshot.lastRefreshedAt),
      rulesFingerprint: snapshot.rulesFingerprint,
      plannedDigest: snapshot.plannedDigest,
      mismatchCount: snapshot.mismatchCount,
      addCount: snapshot.addCount,
      removeCount: snapshot.removeCount,
      createdByMemberId: options.createdByMemberId ?? null,
    },
    select: { id: true },
  });

  // Self-bounding retention (#1961): opportunistically prune dry-run rows far
  // older than any freshness/resume window so the table never needs a dedicated
  // cron (mirrors cron-job-run.ts pruneCronRuns / audit-retention.ts). Best
  // effort — a prune failure must never fail recording the dry-run just made.
  try {
    const cutoff = new Date(Date.now() - DRY_RUN_RETENTION_MS);
    const { count } = await prisma.xeroMemberGroupingDryRun.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      logger.info(
        { deletedCount: count },
        "Pruned old Xero member-grouping dry-run rows",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to prune old Xero member-grouping dry-run rows");
  }

  return { snapshot, dryRunId: record.id };
}

/**
 * Confirm the referenced dry-run is fresh enough to (start or continue) a bulk
 * re-sync, against a snapshot freshly recomputed at execution start. The
 * snapshot re-reads the CONTACT_GROUP_FULL_REFRESH cursor AFTER its membership
 * read (see {@link getXeroMemberGroupingSnapshot}), so the cursor-equality check
 * below reflects the same (or newer) Xero-cache state as the plan it guards — a
 * mid-snapshot cache refresh surfaces as a cursor mismatch here rather than a
 * silent old-cursor/new-membership pairing. Rejections:
 * - `not_found`: no such dry-run (absent / never recorded).
 * - `not_started`: resume chunk (afterMemberId present) against a dry-run that
 *   was never initiated (server-set `startedAt` is null) — a forged resume that
 *   would otherwise skip the initiating-only checks below.
 * - `cache_cursor_changed`: the group cache was refreshed since the dry-run
 *   (its recorded cursor no longer equals the live CONTACT_GROUP_FULL_REFRESH
 *   cursor) — the reviewed diff was computed against different Xero truth.
 * - `rules_changed`: the mode or an active rule changed since the dry-run.
 * - `expired` / `plan_changed`: initiating chunk only — the dry-run is older
 *   than the wall-clock window, or the concrete planned operations no longer
 *   match the reviewed set (e.g. a member's tier/type drifted). Resume chunks
 *   skip these two: the plan legitimately shrinks as members are processed and
 *   a daily-limit resume may span days, while the cursor + rules equality above
 *   still forbids resuming across any rule/cache change.
 * Note: whether a request is a resume is derived SERVER-side — a resume is only
 * accepted against a `startedAt`-marked run, and an initiate only against an
 * unmarked one (claimed by the caller). It is never taken on the client's word.
 */
async function assertDryRunFresh(params: {
  dryRunId: string;
  snapshot: MemberGroupingSnapshot;
  isResume: boolean;
  now: Date;
}): Promise<void> {
  const record = await prisma.xeroMemberGroupingDryRun.findUnique({
    where: { id: params.dryRunId },
    select: {
      createdAt: true,
      startedAt: true,
      cacheCursorAt: true,
      rulesFingerprint: true,
      plannedDigest: true,
    },
  });

  if (!record) {
    throw new StaleDryRunError(
      "not_found",
      "No matching dry-run was found. Run a dry-run and review the diff before re-syncing.",
    );
  }

  // A resume is only legitimate against a run that was actually initiated (its
  // server-set startedAt is stamped). A resume request (afterMemberId present)
  // whose dry-run was never started is a forged/hand-crafted cursor trying to
  // skip the initiating-only expired/plan_changed checks — reject it.
  if (params.isResume && record.startedAt === null) {
    throw new StaleDryRunError(
      "not_started",
      "This bulk re-sync was never started, so it cannot be resumed. Run a dry-run and start the re-sync from the beginning.",
    );
  }

  const liveCursorAt = params.snapshot.lastRefreshedAt
    ? new Date(params.snapshot.lastRefreshedAt).getTime()
    : null;
  if (liveCursorAt === null || record.cacheCursorAt.getTime() !== liveCursorAt) {
    throw new StaleDryRunError(
      "cache_cursor_changed",
      "The Xero group cache was refreshed since this dry-run. Re-run the dry-run and review the diff before re-syncing.",
    );
  }

  if (record.rulesFingerprint !== params.snapshot.rulesFingerprint) {
    throw new StaleDryRunError(
      "rules_changed",
      "The grouping mode or rules changed since this dry-run. Re-run the dry-run and review the diff before re-syncing.",
    );
  }

  if (!params.isResume) {
    if (
      params.now.getTime() - record.createdAt.getTime() >
      DRY_RUN_INITIAL_FRESHNESS_MS
    ) {
      throw new StaleDryRunError(
        "expired",
        "This dry-run is too old. Re-run the dry-run and review the diff before re-syncing.",
      );
    }
    if (record.plannedDigest !== params.snapshot.plannedDigest) {
      throw new StaleDryRunError(
        "plan_changed",
        "The planned changes differ from the reviewed dry-run. Re-run the dry-run and review the diff before re-syncing.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Bulk re-sync
// ---------------------------------------------------------------------------

export interface BulkResyncRunOptions {
  /**
   * The persisted dry-run this run is authorised against (#1961). The engine
   * re-validates freshness against it at execution start and throws
   * {@link StaleDryRunError} when it is absent/stale — the server-side guarantee
   * that a reviewed, still-matching diff exists, independent of the client.
   */
  dryRunId: string;
  /** Chunk size — how many mismatched members to process this call. */
  limit?: number;
  /** Resume: process members whose id sorts strictly after this cursor. */
  afterMemberId?: string;
  createdByMemberId?: string;
  /** Test seam for the wall-clock freshness window. */
  now?: Date;
}

export interface BulkResyncRunResult {
  mode: XeroMemberGroupingMode;
  processed: number;
  added: number;
  removed: number;
  noop: number;
  failed: number;
  failures: Array<{ memberId: string; error: string }>;
  /** Cursor to pass as afterMemberId to continue; null when the run is done. */
  nextCursorMemberId: string | null;
  done: boolean;
  /** Set when a Xero daily limit halted the run mid-way (resume tomorrow). */
  haltedByDailyLimit: boolean;
}

// Conservative default: ~4 Xero calls per mismatched member means a chunk of
// 25 stays well inside the per-minute budget and gives the admin frequent
// resume checkpoints. The route caps explicit limits at 100.
const DEFAULT_BULK_CHUNK = 25;

/**
 * Execute one chunk of a bulk re-sync. Cache-first pre-filtered to the members
 * the dry-run snapshot flags, ordered by member id so the cursor is stable.
 * Per-member failures are recorded and non-fatal; a Xero daily-limit halts the
 * chunk early (resume by re-calling with the returned cursor). Requires a fresh
 * persisted dry-run (`options.dryRunId`): freshness is enforced server-side here
 * ({@link assertDryRunFresh}), not left to a client-asserted flag (#1961).
 */
export async function runXeroMemberGroupingBulkResyncChunk(
  options: BulkResyncRunOptions,
): Promise<BulkResyncRunResult> {
  const context = await loadXeroGroupingContext();
  const chunkSize = Math.max(1, options.limit ?? DEFAULT_BULK_CHUNK);

  const result: BulkResyncRunResult = {
    mode: context.mode,
    processed: 0,
    added: 0,
    removed: 0,
    noop: 0,
    failed: 0,
    failures: [],
    nextCursorMemberId: null,
    done: true,
    haltedByDailyLimit: false,
  };

  // NONE mode never touches Xero — a total no-op with no plan to review, so it
  // short-circuits before any freshness check (there is nothing to gate).
  if (context.mode === "NONE") {
    return result;
  }

  // Cache-first pre-filter: recompute the full mismatch set, then window it by
  // the resume cursor + chunk size. This keeps the run touching ONLY mismatched
  // members, never the whole population. Information-only entries (parked
  // members no rule matches) live in `snapshot.informational` and are
  // deliberately NOT iterated — the bulk run never writes to them.
  const snapshot = await getXeroMemberGroupingSnapshot();

  // Whether this is a resume is derived SERVER-side, not from the client-asserted
  // afterMemberId alone (#1961). afterMemberId present ⇒ the caller intends a
  // resume, which assertDryRunFresh accepts ONLY against a run whose server-set
  // startedAt is already stamped (a forged first-call resume is rejected
  // `not_started`); afterMemberId absent ⇒ an initiating chunk, which must win
  // the status-guarded claim below before it may run.
  const isResume = Boolean(options.afterMemberId);
  const now = options.now ?? new Date();

  // Server-side dry-run freshness enforcement (#1961). Re-validate at execution
  // start against THIS snapshot — whose cursor is re-read after its membership
  // read, so a rule edit or cache refresh that races the run is caught here and
  // (for later chunks) on every resume. Throws StaleDryRunError, which the route
  // maps to 409/422 and audit-logs.
  await assertDryRunFresh({
    dryRunId: options.dryRunId,
    snapshot,
    isResume,
    now,
  });

  if (!isResume) {
    // Initiating chunk: atomically CLAIM the dry-run by stamping startedAt,
    // guarded on startedAt = null. A lost claim (count 0) means a run was already
    // initiated from this dry-run (a double-initiate — concurrent, or a retry
    // after the first chunk already started). Reject it: no chunk executes on a
    // lost initiate claim, so the status-guarded claim runs zero side effects
    // before it can fail. The legit UI flow initiates exactly once and then
    // resumes WITH afterMemberId, so it never re-initiates and never trips this;
    // an admin who genuinely needs to restart re-runs the dry-run (a fresh,
    // startedAt-null row). Per-member op-key dedup (#1354 partial unique index)
    // remains the idempotency backstop for the residual, unserialized case of
    // concurrent RESUMES sharing one already-started dry-run.
    const claim = await prisma.xeroMemberGroupingDryRun.updateMany({
      where: { id: options.dryRunId, startedAt: null },
      data: { startedAt: now },
    });
    if (claim.count === 0) {
      throw new StaleDryRunError(
        "already_started",
        "A bulk re-sync was already started from this dry-run. Run a new dry-run and review the diff before starting again.",
      );
    }
  }

  const ordered = snapshot.mismatches
    .slice()
    .sort((left, right) => left.memberId.localeCompare(right.memberId));
  const pending = options.afterMemberId
    ? ordered.filter((entry) => entry.memberId.localeCompare(options.afterMemberId!) > 0)
    : ordered;
  const chunk = pending.slice(0, chunkSize);

  for (const entry of chunk) {
    try {
      const syncResult = await syncManagedXeroContactGroupForMember(entry.memberId, {
        createdByMemberId: options.createdByMemberId,
      });
      result.processed += 1;
      result.added += syncResult.addedGroupIds.length;
      result.removed += syncResult.removedGroupIds.length;
      if (
        syncResult.addedGroupIds.length === 0 &&
        syncResult.removedGroupIds.length === 0
      ) {
        result.noop += 1;
      }
      result.nextCursorMemberId = entry.memberId;
    } catch (error) {
      if (error instanceof XeroDailyLimitError) {
        // Halt this chunk cleanly; the cursor stays at the last completed member
        // so a later resume picks up here.
        result.haltedByDailyLimit = true;
        result.done = false;
        logger.warn(
          { memberId: entry.memberId },
          "Xero member grouping bulk re-sync halted by daily API limit",
        );
        return result;
      }
      // Per-member failure is ledgered inside the sync; record + continue.
      result.failed += 1;
      result.failures.push({
        memberId: entry.memberId,
        error: error instanceof Error ? error.message : String(error),
      });
      result.nextCursorMemberId = entry.memberId;
      logger.error(
        { err: error, memberId: entry.memberId },
        "Xero member grouping bulk re-sync: member failed (continuing)",
      );
    }
  }

  result.done = pending.length <= chunk.length;
  if (result.done) {
    result.nextCursorMemberId = null;
  }
  return result;
}
