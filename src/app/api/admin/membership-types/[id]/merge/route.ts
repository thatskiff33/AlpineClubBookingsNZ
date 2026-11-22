import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import type { AgeTier, Prisma } from "@prisma/client";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { serializeMembershipType } from "@/lib/membership-types";
import {
  isOrganisationMember,
  resolveAccessRoleTokens,
} from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// Same shape the collection/[id] routes use so serializeMembershipType and the
// merge guards see age tiers and the current assignment count.
const membershipTypeSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  publicDescription: true,
  publiclyListed: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  allowedAgeTiers: {
    select: { ageTier: true },
    orderBy: { ageTier: "asc" },
  },
  _count: { select: { assignments: true, annualFees: true } },
} satisfies Prisma.MembershipTypeSelect;

const paramsSchema = z.object({
  id: z.string().min(1),
});

const mergeSchema = z
  .object({
    targetId: z.string().trim().min(1),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      {
        error: "Invalid route parameters",
        details: parsedParams.error.flatten(),
      },
      { status: 400 },
    );
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = mergeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const sourceId = parsedParams.data.id;
  const targetId = parsed.data.targetId;

  // A type can never be merged into itself: it would delete the type we are
  // reassigning onto and orphan every assignment.
  if (sourceId === targetId) {
    return NextResponse.json(
      { error: "A membership type cannot be merged into itself." },
      { status: 400 },
    );
  }

  const [source, target] = await Promise.all([
    prisma.membershipType.findUnique({
      where: { id: sourceId },
      select: membershipTypeSelect,
    }),
    prisma.membershipType.findUnique({
      where: { id: targetId },
      select: membershipTypeSelect,
    }),
  ]);

  if (!source) {
    return NextResponse.json(
      { error: "Source membership type not found" },
      { status: 404 },
    );
  }

  // Mirror the DELETE guard: built-in types are structural and can never be
  // deleted, so they can never be a merge source (the merge deletes the source).
  if (source.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in membership types cannot be merged or deleted" },
      { status: 409 },
    );
  }

  if ((source._count?.annualFees ?? 0) > 0) {
    return NextResponse.json(
      { error: "Membership types with fee history cannot be merged. Archive the source type instead." },
      { status: 409 },
    );
  }

  if (!target) {
    return NextResponse.json(
      { error: "Target membership type not found" },
      { status: 404 },
    );
  }

  // Reassigning onto an archived type would silently move members onto a type
  // that is no longer assignable, so require an active target (isActive === false
  // is the archived state in this schema).
  if (!target.isActive) {
    return NextResponse.json(
      {
        error:
          "Archived membership types cannot be a merge target. Reactivate the target type first.",
      },
      { status: 409 },
    );
  }

  // Age-tier compatibility: every affected member's current age tier must be
  // allowed by the target type. #2106: a member whose own tier is N/A merges
  // cleanly ONLY if the target type also allows N/A (FORCED or ALLOWED). The
  // sole exception is organisation members — their N/A is a GLOBAL org force
  // (#1440), independent of the type's allowed tiers, so they merge onto any
  // target regardless of whether it lists N/A.
  const sourceAssignments = await prisma.seasonalMembershipAssignment.findMany({
    where: { membershipTypeId: sourceId },
    select: {
      id: true,
      memberId: true,
      seasonYear: true,
      member: {
        select: {
          ageTier: true,
          role: true,
          accessRoles: { select: { role: true } },
        },
      },
    },
  });

  const targetAllowedAgeTiers = new Set<AgeTier>(
    target.allowedAgeTiers.map((tier) => tier.ageTier),
  );
  const offendingAgeTiers = new Set<AgeTier>();
  for (const assignment of sourceAssignments) {
    const ageTier = assignment.member.ageTier;
    if (ageTier === "NOT_APPLICABLE") {
      // A target that permits N/A accepts any N/A member (org or not).
      if (targetAllowedAgeTiers.has("NOT_APPLICABLE")) {
        continue;
      }
      // Target does not permit N/A: org members are still exempt (their N/A is a
      // global org force, independent of the type's tiers); a non-org N/A member
      // is stranded and blocks the merge.
      const isOrg = isOrganisationMember({
        accessRoleTokens: resolveAccessRoleTokens(assignment.member),
        legacyRole: assignment.member.role,
      });
      if (!isOrg) {
        offendingAgeTiers.add("NOT_APPLICABLE");
      }
      continue;
    }
    if (!targetAllowedAgeTiers.has(ageTier)) {
      offendingAgeTiers.add(ageTier);
    }
  }
  if (offendingAgeTiers.size > 0) {
    const offending = [...offendingAgeTiers]
      .map((tier) => (tier === "NOT_APPLICABLE" ? "N/A" : tier))
      .join(", ");
    return NextResponse.json(
      {
        error: `Target type "${target.name}" does not allow age tier(s) ${offending} held by affected members. Add the tier(s) to the target's allowed age tiers or reassign those members before merging.`,
      },
      { status: 409 },
    );
  }

  // Pending roll-forward guard: N/A. Roll-forward runs synchronously inside a
  // single transaction (see rollForwardSeasonalMembershipAssignments) and never
  // persists a "pending" record that a delete could corrupt. Reassigning
  // already-created assignments onto the target keeps every rolled-forward row
  // intact, so there is no pending state to block on.

  // Snapshot of exactly which assignments/members are being moved, so the merge
  // is traceable and reversible. reassignedCount (below) stays the authoritative
  // total; this list is capped to keep the audit metadata bounded.
  const REASSIGNED_AUDIT_SAMPLE_LIMIT = 500;
  const reassignedAssignments = sourceAssignments
    .slice(0, REASSIGNED_AUDIT_SAMPLE_LIMIT)
    .map((assignment) => ({
      assignmentId: assignment.id,
      memberId: assignment.memberId,
      seasonYear: assignment.seasonYear,
    }));

  const reassignedCount = await prisma.$transaction(async (tx) => {
    const reassigned = await tx.seasonalMembershipAssignment.updateMany({
      where: { membershipTypeId: sourceId },
      data: { membershipTypeId: targetId },
    });

    // Audit the reassignment + deletion as one MEMBERSHIP_TYPE_MERGED record.
    // Xero coherence note: the deleted source type's XeroContactGroupRule rows
    // cascade-delete with it, shrinking the managed universe. Members already in
    // those groups are never removed by the system (E8, #1934); reconciliation is
    // by the admin Xero member-grouping dry-run + bulk re-sync.
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_MERGED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: sourceId },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Membership type merged and deleted",
        metadata: {
          sourceId,
          sourceKey: source.key,
          sourceName: source.name,
          targetId,
          targetKey: target.key,
          targetName: target.name,
          reassignedCount: reassigned.count,
          reassignedAssignments,
          reassignedAssignmentsTruncated:
            sourceAssignments.length > reassignedAssignments.length,
          xeroReconciliation: "admin-grouping-resync",
        },
        request: getAuditRequestContext(request),
      }),
    );

    // Source now has zero assignments, so the DELETE constraint (no seasonal
    // assignments) is satisfied — reuse the exact delete semantics.
    await tx.membershipType.delete({ where: { id: sourceId } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: sourceId },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership type deleted via merge",
        metadata: {
          previousMembershipType: serializeMembershipType(source),
          mergedIntoId: targetId,
          mergedIntoName: target.name,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return reassigned.count;
  });

  revalidatePath("/", "layout");
  return NextResponse.json({
    ok: true,
    reassignedCount,
    sourceId,
    targetId,
  });
}
