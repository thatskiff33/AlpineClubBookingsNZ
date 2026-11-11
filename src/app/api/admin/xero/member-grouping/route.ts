import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, type AgeTier } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { ageTierEnum, canonicalizeAgeTiers } from "@/lib/age-tier-schema";
import {
  getXeroContactGroups,
  getXeroContactGroupCacheLastRefreshedAt,
} from "@/lib/xero-contact-groups";
import { isXeroConnected } from "@/lib/xero-token-store";
import { getXeroGroupingMode } from "@/lib/xero-member-grouping";
import {
  recordXeroMemberGroupingDryRun,
  runXeroMemberGroupingBulkResyncChunk,
  StaleDryRunError,
} from "@/lib/xero-member-grouping-resync";

function requireFinanceEdit(
  session: { user: Parameters<typeof hasAdminAreaAccess>[0] },
): boolean {
  return hasAdminAreaAccess(session.user, {
    area: "finance",
    level: "edit",
  });
}

const forbidden = () =>
  NextResponse.json(
    { error: "Your admin role can view Xero member grouping but cannot make changes." },
    { status: 403 },
  );

const ruleModeEnum = z.enum(["MANAGED", "ACCEPTED"]);
const groupingModeEnum = z.enum(["NONE", "MEMBERSHIP_TYPE", "MEMBERSHIP_TYPE_AND_AGE"]);

const ruleShape = {
  membershipTypeId: z.string().trim().min(1).nullable().optional(),
  // Multi-select tier set (#2093). Omitted / empty = "all age tiers" (the old
  // null "Any age" wildcard). Canonical-sorted and full-set-collapsed on
  // normalize; a duplicate tier in the payload is de-duped there too.
  ageTiers: z.array(ageTierEnum).optional(),
  mode: ruleModeEnum,
  groupId: z.string().trim().min(1).max(100),
  groupName: z.string().trim().min(1).max(255).nullable().optional(),
};

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-mode"), mode: groupingModeEnum }),
  z.object({ action: z.literal("create-rule"), ...ruleShape }),
  z.object({
    action: z.literal("update-rule"),
    id: z.string().min(1),
    ...ruleShape,
    isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal("delete-rule"), id: z.string().min(1) }),
  z.object({ action: z.literal("toggle-rule"), id: z.string().min(1), isActive: z.boolean() }),
  z.object({ action: z.literal("dry-run"), limit: z.number().int().min(1).max(1000).optional() }),
  z.object({
    action: z.literal("bulk-resync"),
    // Server-enforced anchor (#1961): the run must reference a persisted dry-run
    // (`dryRunId`), whose freshness — recent, and still matching the
    // CONTACT_GROUP_FULL_REFRESH cache cursor + active rules — the engine
    // re-validates at execution start. This is the enforcing check; the
    // client-asserted `confirmDryRunReviewed` below is only a UI confirmation.
    dryRunId: z.string().min(1),
    confirmDryRunReviewed: z.literal(true),
    // Capped low: each mismatched member costs ~4 Xero calls, so 100 members
    // is already ~400 calls of the ~5k/day budget in one request.
    limit: z.number().int().min(1).max(100).optional(),
    afterMemberId: z.string().min(1).optional(),
  }),
]);

async function loadConfig() {
  const [mode, rules, groups, lastRefreshedAt, membershipTypes] = await Promise.all([
    getXeroGroupingMode(),
    prisma.xeroContactGroupRule.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        membershipTypeId: true,
        ageTiers: true,
        mode: true,
        groupId: true,
        groupName: true,
        isActive: true,
        sortOrder: true,
        membershipType: { select: { name: true } },
      },
    }),
    getXeroContactGroups().catch(() => []),
    getXeroContactGroupCacheLastRefreshedAt().catch(() => null),
    prisma.membershipType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  const ageTiers: AgeTier[] = ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"];

  return {
    mode,
    rules: rules.map((rule) => ({
      id: rule.id,
      membershipTypeId: rule.membershipTypeId,
      membershipTypeName: rule.membershipType?.name ?? null,
      ageTiers: rule.ageTiers,
      mode: rule.mode,
      groupId: rule.groupId,
      groupName: rule.groupName,
      isActive: rule.isActive,
      sortOrder: rule.sortOrder,
    })),
    groups,
    lastRefreshedAt,
    membershipTypes,
    ageTiers,
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await loadConfig());
}

type RuleFields = {
  membershipTypeId?: string | null;
  ageTiers?: AgeTier[];
  mode: "MANAGED" | "ACCEPTED";
  groupId: string;
  groupName?: string | null;
};

function normalizeRule(input: RuleFields) {
  return {
    membershipTypeId: input.membershipTypeId?.trim() || null,
    // Canonical-sorted + full-set-collapse (#2093, D-B2): empty = "all tiers".
    ageTiers: canonicalizeAgeTiers(input.ageTiers),
    mode: input.mode,
    groupId: input.groupId.trim(),
    groupName: input.groupName?.trim() || null,
  };
}

/**
 * App-side dedupe for a friendly message before the DB partial unique index.
 * The tier set is compared for exact array equality — Prisma's list `equals`
 * is order-sensitive, so both operands must be canonical-sorted (normalizeRule
 * guarantees this for the candidate; stored rows are canonical by construction).
 */
async function isDuplicateRuleShape(
  rule: { membershipTypeId: string | null; ageTiers: AgeTier[]; mode: "MANAGED" | "ACCEPTED"; groupId: string },
  excludeId?: string,
): Promise<boolean> {
  const existing = await prisma.xeroContactGroupRule.findFirst({
    where: {
      membershipTypeId: rule.membershipTypeId,
      ageTiers: { equals: rule.ageTiers },
      mode: rule.mode,
      groupId: rule.groupId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(existing);
}

const duplicateResponse = () =>
  NextResponse.json(
    { error: "A rule with the same membership type, age tiers, mode, and Xero group already exists." },
    { status: 409 },
  );

export async function POST(request: NextRequest) {
  // Explicit finance:view guard — the path-inference default would map ANY
  // POST under /api/admin/xero to finance:edit, which made the dry-run's
  // view-level exception below unreachable (#1934 review). Mutating actions
  // are individually re-checked against finance:edit after parsing.
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // The dry-run needs only finance:view. It reads the local caches to build the
  // diff, but also persists a small provenance row (XeroMemberGroupingDryRun)
  // that the bulk re-sync validates — a view-level audit artefact, not a
  // finance-mutating action. Every other action requires finance:edit.
  if (data.action !== "dry-run" && !requireFinanceEdit(session)) {
    return forbidden();
  }

  try {
    switch (data.action) {
      case "set-mode": {
        await prisma.xeroGroupingSettings.upsert({
          where: { id: "default" },
          update: { mode: data.mode, updatedByMemberId: session.user.id },
          create: { id: "default", mode: data.mode, updatedByMemberId: session.user.id },
        });
        await logAudit({
          action: "XERO_GROUPING_MODE_UPDATED",
          category: "xero",
          memberId: session.user.id,
          details: JSON.stringify({ mode: data.mode }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "create-rule": {
        const rule = normalizeRule(data);
        if (await isDuplicateRuleShape(rule)) return duplicateResponse();
        const created = await prisma.xeroContactGroupRule.create({ data: rule });
        await logAudit({
          action: "XERO_GROUPING_RULE_CREATED",
          category: "xero",
          memberId: session.user.id,
          entityType: "XeroContactGroupRule",
          entityId: created.id,
          details: JSON.stringify({ id: created.id, ...rule }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "update-rule": {
        const rule = normalizeRule(data);
        if (await isDuplicateRuleShape(rule, data.id)) return duplicateResponse();
        await prisma.xeroContactGroupRule.update({
          where: { id: data.id },
          data: { ...rule, ...(data.isActive !== undefined ? { isActive: data.isActive } : {}) },
        });
        await logAudit({
          action: "XERO_GROUPING_RULE_UPDATED",
          category: "xero",
          memberId: session.user.id,
          entityType: "XeroContactGroupRule",
          entityId: data.id,
          details: JSON.stringify({ id: data.id, ...rule }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "toggle-rule": {
        await prisma.xeroContactGroupRule.update({
          where: { id: data.id },
          data: { isActive: data.isActive },
        });
        await logAudit({
          action: "XERO_GROUPING_RULE_TOGGLED",
          category: "xero",
          memberId: session.user.id,
          entityType: "XeroContactGroupRule",
          entityId: data.id,
          details: JSON.stringify({ id: data.id, isActive: data.isActive }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "delete-rule": {
        await prisma.xeroContactGroupRule.delete({ where: { id: data.id } });
        await logAudit({
          action: "XERO_GROUPING_RULE_DELETED",
          category: "xero",
          memberId: session.user.id,
          entityType: "XeroContactGroupRule",
          entityId: data.id,
          details: JSON.stringify({ id: data.id }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "dry-run": {
        // Persist the dry-run's provenance (cache cursor + rules fingerprint +
        // planned digest) so a later bulk re-sync can prove server-side that a
        // recent, still-matching reviewed diff exists (#1961). Returns the id
        // the client threads back into the bulk re-sync.
        const { snapshot, dryRunId } = await recordXeroMemberGroupingDryRun({
          limit: data.limit ?? 500,
          createdByMemberId: session.user.id,
        });
        return NextResponse.json({ snapshot, dryRunId });
      }

      case "bulk-resync": {
        // Admin-triggered, dry-run-gated. Ships as code + runbook this wave.
        // The chunk itself is a no-op under NONE mode, but the per-member sync
        // does NOT check Xero connectivity — without a connection every member
        // would fail individually — so pre-check here and fail cleanly.
        if (!(await isXeroConnected())) {
          return NextResponse.json(
            { error: "Xero is not connected. Connect Xero before running a bulk re-sync." },
            { status: 409 },
          );
        }
        let result;
        try {
          result = await runXeroMemberGroupingBulkResyncChunk({
            dryRunId: data.dryRunId,
            limit: data.limit,
            afterMemberId: data.afterMemberId,
            createdByMemberId: session.user.id,
          });
        } catch (resyncError) {
          // Server-side dry-run freshness rejection (#1961): audit the refusal
          // and tell the admin to re-run the dry-run. `not_found` -> 422 (the
          // referenced dry-run does not exist), everything else -> 409 (a
          // conflict developed since the reviewed diff).
          if (resyncError instanceof StaleDryRunError) {
            // Audit the refusal, but never let an audit-log failure convert the
            // 409/422 into a 500 (which would also lose the reason taxonomy):
            // log-and-continue so the typed rejection always reaches the client.
            try {
              await logAudit({
                action: "XERO_GROUPING_BULK_RESYNC_REJECTED",
                category: "xero",
                memberId: session.user.id,
                details: JSON.stringify({
                  dryRunId: data.dryRunId,
                  reason: resyncError.reason,
                  afterMemberId: data.afterMemberId ?? null,
                }),
              });
            } catch (auditError) {
              logger.error(
                { err: auditError, dryRunId: data.dryRunId },
                "Failed to audit-log XERO_GROUPING_BULK_RESYNC_REJECTED",
              );
            }
            return NextResponse.json(
              { error: resyncError.message, reason: resyncError.reason },
              { status: resyncError.reason === "not_found" ? 422 : 409 },
            );
          }
          throw resyncError;
        }
        await logAudit({
          action: "XERO_GROUPING_BULK_RESYNC",
          category: "xero",
          memberId: session.user.id,
          details: JSON.stringify({
            dryRunId: data.dryRunId,
            processed: result.processed,
            added: result.added,
            removed: result.removed,
            failed: result.failed,
            done: result.done,
            haltedByDailyLimit: result.haltedByDailyLimit,
            nextCursorMemberId: result.nextCursorMemberId,
            afterMemberId: data.afterMemberId ?? null,
          }),
        });
        return NextResponse.json({ result });
      }
    }
  } catch (error) {
    // The DB partial unique index (XeroContactGroupRule_shape_unique) is the
    // last line of defence for concurrent duplicate creates.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return duplicateResponse();
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json({ error: "Rule not found." }, { status: 404 });
    }
    throw error;
  }
}
