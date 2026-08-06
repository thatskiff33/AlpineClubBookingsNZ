import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { ROLE_VALUES } from "@/lib/member-roles";
import {
  accessRoleChangeRequiresFullAdmin,
  accessRolesFromCompatibilityFields,
  isFullAdmin,
  isOrganisationMember,
  legacyRoleFromAccessRoles,
  memberHoldsPrivilegedRole,
  normalizeAssignableAccessRoleTokens,
  resolveAccessRoleTokens,
  storedAccessRolesForFullAdminGate,
} from "@/lib/access-roles";
import {
  loadFutureLinkedGuestBookingsForMember,
  loadMemberCurrentSeasonTypeExemption,
  resolveEnforcedAgeTier,
} from "@/lib/age-tier-enforcement";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getTodayDateOnly } from "@/lib/date-only";
import { getSeasonYear } from "@/lib/utils";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_BULK_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveAllFullAdmins,
} from "@/lib/admin-account-guards";
import {
  accessRoleAssignmentRowsFromTokens,
  findUnknownAccessRoleTokens,
  loadAccessRoleDefinitions,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import {
  financeAccessLevelFromMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";

const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one member ID is required").max(100),
  action: z.enum(["deactivate", "reactivate", "set-role"]),
  role: z.enum(ROLE_VALUES).optional(),
  accessRoles: z.array(z.string().trim().min(1).max(120)).optional(),
}).refine(
  (data) =>
    data.action !== "set-role" ||
    data.role !== undefined ||
    data.accessRoles !== undefined,
  { message: "Role is required for set-role action", path: ["role"] }
);

/**
 * POST /api/admin/members/bulk-update
 * Bulk update members (deactivate, reactivate, or change role).
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bulkUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { ids, action, role, accessRoles } = parsed.data;
  const currentUserId = session.user.id;

  const roleDefinitions = await loadAccessRoleDefinitions(prisma);
  if (accessRoles !== undefined) {
    const unknownTokens = findUnknownAccessRoleTokens(
      accessRoles,
      roleDefinitions,
    );
    if (unknownTokens.length > 0) {
      return NextResponse.json(
        { error: `Unknown access role: ${unknownTokens.join(", ")}` },
        { status: 400 },
      );
    }
  }

  const selfAdminAccessPreserved =
    accessRoles !== undefined
      ? normalizeAssignableAccessRoleTokens(accessRoles, {
          canLogin: true,
        }).includes("ADMIN")
      : role === "ADMIN";

  // Self-protection checks
  if (action === "deactivate" && ids.includes(currentUserId)) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 }
    );
  }

  if (
    action === "set-role" &&
    !selfAdminAccessPreserved &&
    ids.includes(currentUserId)
  ) {
    return NextResponse.json(
      { error: "You cannot demote your own admin account" },
      { status: 400 }
    );
  }

  try {
    // Find existing members
    const existingMembers = await prisma.member.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        financeAccessLevel: true,
        canLogin: true,
        cancelledAt: true,
        archivedAt: true,
        ageTier: true,
        dateOfBirth: true,
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    });

    const existingIds = new Set(existingMembers.map((m) => m.id));
    const notFound = ids.filter((id) => !existingIds.has(id)).length;

    if (action === "reactivate") {
      const blockedMember = existingMembers.find(
        (member) => member.archivedAt || member.cancelledAt,
      );
      if (blockedMember) {
        return NextResponse.json(
          {
            error: blockedMember.archivedAt
              ? "Archived members cannot be reactivated from bulk update"
              : "Cancelled members cannot be reactivated from bulk update",
          },
          { status: 409 },
        );
      }
    }

    // Build update data based on action
    let updateData: Record<string, unknown>;
    switch (action) {
      case "deactivate":
        updateData = { active: false };
        break;
      case "reactivate":
        updateData = { active: true };
        break;
      case "set-role":
        updateData = {};
        break;
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // Filter out current user for self-protection
    let idsToUpdate = [...existingIds].filter((id) => {
      if (action === "deactivate" && id === currentUserId) return false;
      if (action === "set-role" && !selfAdminAccessPreserved && id === currentUserId) return false;
      return true;
    });

    let setRoleTargets =
      action === "set-role"
        ? existingMembers
            .filter((candidate) => idsToUpdate.includes(candidate.id))
            .map((member) => ({
              member,
              nextAccessRoles:
                accessRoles !== undefined
                  ? normalizeAssignableAccessRoleTokens(accessRoles, {
                      canLogin: member.canLogin,
                    })
                  : accessRolesFromCompatibilityFields({
                      role,
                      financeAccessLevel:
                        role === "LODGE" ? "NONE" : member.financeAccessLevel,
                      canLogin: member.canLogin,
                    }),
            }))
        : [];

    // Full Admin gate (issue #1012): only a Full Admin may grant or revoke
    // privileged access roles. Compare both the effective roles
    // (canLogin-aware) and the stored role fields (canLogin-blind) so a
    // scoped admin can neither change live privileged access nor park a
    // dormant elevated role for later activation.
    if (
      !isFullAdmin(session.user) &&
      setRoleTargets.some(({ member, nextAccessRoles }) => {
        const storedAfter =
          accessRoles !== undefined
            ? normalizeAssignableAccessRoleTokens(accessRoles, {
                canLogin: true,
              })
            : accessRolesFromCompatibilityFields({
                role,
                financeAccessLevel:
                  role === "LODGE" ? "NONE" : member.financeAccessLevel,
                canLogin: true,
              });
        return (
          accessRoleChangeRequiresFullAdmin(
            resolveAccessRoleTokens(member),
            nextAccessRoles,
          ) ||
          accessRoleChangeRequiresFullAdmin(
            storedAccessRolesForFullAdminGate(member),
            storedAfter,
          )
        );
      })
    ) {
      return NextResponse.json(
        { error: "Only a Full Admin can change member access roles" },
        { status: 403 },
      );
    }

    // Privileged-target guard (issue #1604): only a Full Admin may
    // bulk-deactivate accounts that hold (or dormantly store) a privileged
    // access role, consistent with the #1012 role gate above.
    if (
      action === "deactivate" &&
      !isFullAdmin(session.user) &&
      existingMembers.some(
        (member) =>
          idsToUpdate.includes(member.id) && memberHoldsPrivilegedRole(member),
      )
    ) {
      return NextResponse.json(
        { error: PRIVILEGED_TARGET_GUARD_MESSAGE },
        { status: 403 },
      );
    }

    // #2106: a bulk set-role that grants or revokes ORG must reconcile the
    // member's age tier. Granting ORG forces N/A (and sweeps future
    // shared-double placements when leaving ADULT, #1756); revoking ORG restores
    // a DOB-derived tier (else ADULT) unless a FORCED/ALLOWED current-season
    // membership type keeps N/A. Computed here (reads) and applied inside the
    // transaction.
    const ageTierReconById = new Map<string, AgeTier>();
    // #2106 owner decision (MAJOR-5b): an ORG grant that flips a non-N/A member
    // TO N/A is blocked while they are a linked guest on someone else's future
    // booking (N/A members are not bookable guests). Reported as a per-member
    // failure (like `notFound`) so the rest of the batch still applies, rather
    // than failing the whole request.
    const blockedLinkedGuestMembers: Array<{
      memberId: string;
      memberName: string;
      linkedGuestCount: number;
    }> = [];
    if (action === "set-role") {
      const today = getTodayDateOnly();
      for (const { member, nextAccessRoles } of setRoleTargets) {
        const wasOrg = isOrganisationMember({
          accessRoleTokens: resolveAccessRoleTokens(member),
          legacyRole: member.role,
        });
        const willBeOrg = isOrganisationMember({
          accessRoleTokens: nextAccessRoles,
          legacyRole:
            accessRoles !== undefined
              ? legacyRoleFromAccessRoles(nextAccessRoles)
              : role!,
        });
        if (wasOrg === willBeOrg) {
          continue;
        }
        const typeExemption = await loadMemberCurrentSeasonTypeExemption(
          prisma,
          member.id,
          getSeasonYear(),
        );
        const dobDerivedTier = member.dateOfBirth
          ? await computeAgeTier(
              member.dateOfBirth,
              getSeasonStartDate(getSeasonYear()),
            )
          : "ADULT";
        const resolved = resolveEnforcedAgeTier({
          isOrganisation: willBeOrg,
          typeExemption,
          currentAgeTier: member.ageTier,
          restorePersonTier: dobDerivedTier,
        });
        if (resolved.ok && resolved.ageTier !== member.ageTier) {
          if (
            member.ageTier !== "NOT_APPLICABLE" &&
            resolved.ageTier === "NOT_APPLICABLE"
          ) {
            const linkedGuestBookings =
              await loadFutureLinkedGuestBookingsForMember(
                prisma,
                member.id,
                today,
              );
            if (linkedGuestBookings.length > 0) {
              blockedLinkedGuestMembers.push({
                memberId: member.id,
                memberName:
                  `${member.firstName} ${member.lastName}`.trim() ||
                  member.email,
                linkedGuestCount: linkedGuestBookings.length,
              });
              continue;
            }
          }
          ageTierReconById.set(member.id, resolved.ageTier);
        }
      }
    }

    // Drop the linked-guest-blocked members from the batch entirely — like a
    // not-found id, they are simply not acted on and reported back to the caller.
    if (blockedLinkedGuestMembers.length > 0) {
      const blockedIds = new Set(
        blockedLinkedGuestMembers.map((entry) => entry.memberId),
      );
      idsToUpdate = idsToUpdate.filter((id) => !blockedIds.has(id));
      setRoleTargets = setRoleTargets.filter(
        (target) => !blockedIds.has(target.member.id),
      );
    }

    // #1756: shared-double placements swept by a deactivate or an ORG grant that
    // leaves ADULT, collected inside the transaction and alerted on after commit.
    const sweptSharesByMember: Array<{
      memberId: string;
      reason: "member_deactivated" | "member_age_tier_changed";
      swept: SweptPartnerSharedAllocation[];
    }> = [];
    const sweepLockMemberIds =
      action === "deactivate"
        ? idsToUpdate
        : setRoleTargets
            .filter(({ member }) => {
              const reconciledAgeTier = ageTierReconById.get(member.id);
              return (
                reconciledAgeTier !== undefined &&
                member.ageTier === "ADULT" &&
                reconciledAgeTier !== "ADULT"
              );
            })
            .map(({ member }) => member.id);

    // Perform update in transaction
    const result = await prisma.$transaction(async (tx) => {
      if (sweepLockMemberIds.length > 0) {
        await acquireFuturePartnerSharedAllocationLocks(tx, sweepLockMemberIds);
        await acquireMemberLifecycleLocks(tx, sweepLockMemberIds);
      }
      // Last-admin end-state guard (issue #1604): evaluate the whole set, not
      // per row, so a bulk deactivate that collectively removes every
      // remaining Full Admin fails as a whole. Counted inside the transaction
      // for the mutation's read view.
      if (
        action === "deactivate" &&
        (await wouldRemoveAllFullAdmins(tx, idsToUpdate))
      ) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_BULK_GUARD_MESSAGE);
      }

      const updateResult =
        action === "set-role"
          ? { count: idsToUpdate.length }
          : await tx.member.updateMany({
              where: { id: { in: idsToUpdate } },
              data: updateData,
            });
      if (action === "set-role") {
        for (const { member, nextAccessRoles } of setRoleTargets) {
          const reconciledAgeTier = ageTierReconById.get(member.id);
          await tx.member.update({
            where: { id: member.id },
            data: {
              role:
                accessRoles !== undefined
                  ? legacyRoleFromAccessRoles(nextAccessRoles)
                  : role!,
              financeAccessLevel:
                accessRoles !== undefined
                  ? financeAccessLevelFromMatrix(
                      getAdminPermissionMatrix({
                        accessRoles: accessRoleAssignmentRowsFromTokens(
                          nextAccessRoles,
                          roleDefinitions,
                        ),
                        canLogin: true,
                      }),
                    )
                  : role === "LODGE"
                    ? "NONE"
                    : member.financeAccessLevel,
              // #2106: force N/A on ORG grant / restore a person tier on revoke.
              ...(reconciledAgeTier !== undefined
                ? { ageTier: reconciledAgeTier }
                : {}),
            },
          });
          // #1756: an ORG grant that moves the member off ADULT breaks the
          // double-bed sharing precondition, so sweep their future shared-double
          // placements in the same transaction.
          if (
            reconciledAgeTier !== undefined &&
            member.ageTier === "ADULT" &&
            reconciledAgeTier !== "ADULT"
          ) {
            const swept = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
              memberId: member.id,
              reason: "member_age_tier_changed",
              db: tx,
            });
            if (swept.length > 0) {
              sweptSharesByMember.push({
                memberId: member.id,
                reason: "member_age_tier_changed",
                swept,
              });
            }
          }
          const assignmentRows = accessRoleAssignmentRowsFromTokens(
            nextAccessRoles,
            roleDefinitions,
          );
          await tx.memberAccessRole.deleteMany({
            where: { memberId: member.id },
          });
          if (assignmentRows.length > 0) {
            await tx.memberAccessRole.createMany({
              data: assignmentRows.map((row) => ({
                memberId: member.id,
                role: row.role,
                roleDefinitionId: row.roleDefinitionId,
                assignedByMemberId: currentUserId,
              })),
              skipDuplicates: true,
            });
          }
        }
      }
      // Remove family group memberships for deactivated members
      if (action === "deactivate") {
        await tx.familyGroupMember.deleteMany({
          where: { memberId: { in: idsToUpdate } },
        });
        // Billing-family removal sweep (#1932, E6): deactivated members leave all
        // families in this transaction, so clear any billing-family selection.
        await tx.member.updateMany({
          where: { id: { in: idsToUpdate }, billingFamilyGroupId: { not: null } },
          data: { billingFamilyGroupId: null },
        });
        // #1756: deactivation breaks the double-bed sharing precondition, so
        // sweep each member's future shared-double placements in the same
        // transaction (idempotent; a member holding no shares is a no-op).
        // The removed second occupants return to the awaiting-allocation
        // queue; admins are alerted per affected member after commit.
        for (const memberId of idsToUpdate) {
          const swept = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
            memberId,
            reason: "member_deactivated",
            db: tx,
          });
          if (swept.length > 0) {
            sweptSharesByMember.push({
              memberId,
              reason: "member_deactivated",
              swept,
            });
          }
        }
      }
      return updateResult;
    });

    for (const { memberId, reason, swept } of sweptSharesByMember) {
      const member = existingMembers.find((m) => m.id === memberId);
      // Post-commit, fire-and-forget: a failed alert only loses the nudge —
      // the sweep committed with the member update and both bookings carry
      // audit rows.
      sendAdminPartnerShareSweptAlert({
        memberName: member
          ? `${member.firstName} ${member.lastName}`.trim()
          : memberId,
        partnerName: partnerShareSweepCounterpartNames(swept, memberId),
        reason: describePartnerSharedSweepReason(reason),
        nights: partnerShareSweepNights(swept),
      }).catch((err) => {
        logger.error(
          { err, memberId, sweptCount: swept.length },
          "Failed to send partner share sweep alert",
        );
      });
    }

    // Audit log for each affected member
    for (const member of existingMembers) {
      if (idsToUpdate.includes(member.id)) {
        logAudit({
          action: `member.bulk-${action}`,
          memberId: currentUserId,
          targetId: member.id,
          details: `Bulk ${action}: ${member.firstName} ${member.lastName} (${member.email})${action === "set-role" ? ` -> ${accessRoles?.join(", ") ?? role}` : ""}`,
        });
      }
    }

    return NextResponse.json({
      updated: result.count,
      notFound,
      // #2106 (MAJOR-5b): members skipped because an ORG grant would make them
      // N/A while they hold future linked-guest bookings. Empty when none.
      blockedLinkedGuests: blockedLinkedGuestMembers,
    });
  } catch (error) {
    if (error instanceof AdminAccountGuardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error({ err: error }, "Failed to bulk update members");
    return NextResponse.json({ error: "Failed to bulk update members" }, { status: 500 });
  }
}
