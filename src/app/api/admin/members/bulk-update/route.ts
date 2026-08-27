import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";
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
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
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
import {
  DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE,
  isDeletedAccountRecord,
} from "@/lib/deleted-account";

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
        // #2620: the anonymisation marker the reactivate guard below reads. An
        // approved deletion rewrites the password hash to a sentinel and the
        // email to `@deleted.invalid` and stamps NEITHER cancelledAt nor
        // archivedAt, so without these two columns the guard cannot see that
        // the selected row is an erased account.
        passwordHash: true,
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    });

    const existingIds = new Set(existingMembers.map((m) => m.id));
    const notFound = ids.filter((id) => !existingIds.has(id)).length;

    if (action === "reactivate") {
      // #2620, checked FIRST because it is the terminal state and the refusal
      // must name it: an approved deletion request anonymises the member and
      // leaves `active: false` as the ONLY thing between the erased person and
      // a working session (canLogin, googleSub, emailVerified and the access
      // roles all survive today). It writes neither archivedAt nor cancelledAt,
      // so the refusal below never covered it — and because a deleted row is
      // `active: false, cancelledAt: null` it lands in the members list's
      // Inactive filter alongside genuinely deactivated members, so an officer
      // undoing a mistaken bulk deactivate could restore an erased account by
      // accident. Deletion is never reversible from a bulk action.
      const deletedMember = existingMembers.find((member) =>
        isDeletedAccountRecord(member),
      );
      if (deletedMember) {
        return NextResponse.json(
          { error: DELETED_ACCOUNT_BULK_REACTIVATE_MESSAGE },
          { status: 409 },
        );
      }

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
      // `Booking.checkIn` is `@db.Date`, so this "future booking" cut-off is a calendar
      // day from the PERSISTED club timezone (CT-4, #2870), re-encoded to UTC midnight
      // for the bound (INV-DATE-026).
      const today = dateOnlyInstantOf((await clubTime()).today());
      // ONE season for the whole batch, from the club's PERSISTED zone (CT-4,
      // #2870). Read once outside the loop: an age tier decides a price band, so
      // a bulk run must never be able to judge two members in two seasons.
      const clubCurrentSeasonYear = clubSeasonYear((await clubTime()).zone);
      const clubCurrentSeasonStart = getSeasonStartDate(clubCurrentSeasonYear);
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
          clubCurrentSeasonYear,
        );
        const dobDerivedTier = member.dateOfBirth
          ? await computeAgeTier(member.dateOfBirth, clubCurrentSeasonStart)
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

    // #3123 / INV-LOCK-004 — ONE club day for the whole bulk transaction,
    // resolved before it opens. Two reasons, and both matter here: reading the
    // club's persisted timezone is a `clubTimeSettings.findUnique`, which
    // inside this transaction would take a second pooled connection while the
    // global cohort key, every affected lodge key and the member lifecycle
    // keys are held; and a bulk action touching dozens of members must judge
    // every one of them against the same day, which per-member reads
    // straddling club midnight would not.
    const clubTodayForBulk = await clubTodayDateOnlyInstant();

    // Perform update in transaction
    const result = await prisma.$transaction(async (tx) => {
      if (sweepLockMemberIds.length > 0) {
        await acquireFuturePartnerSharedAllocationLocks(tx, sweepLockMemberIds, clubTodayForBulk);
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

      // #2576 §8. A BULK DEACTIVATE IS THE FIRST CHANGE CLASS THE OWNER NAMES —
      // "membership becoming inactive" — and it can strip the qualifying adult host
      // from a confirmed booking en masse. The evaluator half already worked (an
      // inactive member stops qualifying); nothing recorded the obligation to look
      // at the bookings that had been relying on them, so those bookings went
      // silently non-compliant with no incident, no owner email and no officer-queue
      // entry. Recorded per member inside this transaction so the deactivation and
      // the obligation commit together; never refuses the deactivation.
      if (action === "deactivate" || action === "reactivate") {
        for (const memberId of idsToUpdate) {
          await enqueueHostingCoverageReevaluationForMember(
            memberId,
            tx,
            clubTodayForBulk,
            {
              cause: "SYSTEM_CHANGE",
              actorMemberId: currentUserId,
            },
          );
        }
      }
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
          if (reconciledAgeTier !== undefined) {
            await enqueueHostingCoverageReevaluationForMember(
              member.id,
              tx,
              clubTodayForBulk,
              {
                cause: "SYSTEM_CHANGE",
                actorMemberId: currentUserId,
              },
            );
            // #2821: an age tier decides whether this member may be anybody's
            // contact of record (`isUsableEmailSource` requires ADULT), so an
            // ORG grant that forces N/A — or a revoke that restores a person
            // tier — has to re-resolve their dependants' pointers. In the same
            // transaction, so a rolled-back grant rolls the re-resolution back
            // with it.
            await reconcileEmailInheritanceForMemberChange(tx, [member.id], {
              // An ORG grant forcing N/A, or a revoke restoring a person tier:
              // an age-tier eligibility change the acting admin caused (#2822).
              trigger: "lifecycle-eligibility-change",
              actorMemberId: currentUserId,
            });
          }
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
              today: clubTodayForBulk,
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
            today: clubTodayForBulk,
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

    // #2576 §8: settle what the deactivation recorded, now it has committed.
    // Unfiltered, because a bulk action spans owners and lodges by definition.
    if (
      action === "deactivate" ||
      action === "reactivate" ||
      ageTierReconById.size > 0
    ) {
      await settleHostingCoverageAfterCommit({ limit: 50 });
    }

    // Audit log for each affected member. Both branches file `admin`
    // (`INV-PRIV-012`), because an officer editing SOMEBODY ELSE'S member record
    // is one business domain — administration of that record — however many
    // screens reach it.
    //
    // WHAT THIS REPLACED, and why the earlier reasoning was wrong (#2755).
    // #2581 decision 6 read this as several affected domains and split it:
    // `member.bulk-set-role` changes what a member is permitted to do, so
    // `security`; `member.bulk-deactivate` / `-reactivate` change the account
    // itself, so `account`. Read on its own that is defensible. Read against the
    // rest of the tree it was not, because the SAME two acts performed from the
    // member detail page wrote `admin` (`admin.member.updated` /
    // `.deactivated` / `.reactivated`, `src/lib/admin-member-detail-service.ts`)
    // — so one business act was filed three ways according to which screen the
    // officer happened to open. That is initiator reasoning wearing a different
    // hat, and it is the defect #2581's own rule exists to forbid.
    //
    // WHY THE JOIN IS `admin` AND NOT `account`. `account` and `security` are
    // both member-visible and both these rows reach the subject member's own
    // timeline, so unifying on either would publish an officer's edits of a
    // member's record to that member. Note HOW they reach it, because it is not
    // what it looks like: these two writers pass NO `subjectMemberId` at all —
    // only `memberId` (the officer) and `targetId` (the member) — and arrive
    // through `buildMemberAuditLogWhere`'s null-subject `targetId` leg
    // (`src/lib/audit-query.ts`). "It has no subject member" is therefore not a
    // reason to think a re-classification here is invisible; `INV-PRIV-012`
    // states the real predicate. Whether a member should see a given event is
    // meant to become a separate explicit declaration at the writing site,
    // denied by default: #2695 DECIDED that on 9 Aug 2026 and it is NOT BUILT
    // YET, so until it lands the category is the only lever there is and these
    // two events are simply invisible to the member. `admin` is the join that
    // changes no member's readership in the widening direction.
    //
    // ONE SIDE EFFECT WORTH NAMING, so nobody reads it as a fix. #2695's
    // acceptance criterion 5 asks that `member.bulk-deactivate` stop exposing
    // another member's name and email to a member's own timeline — the `details`
    // sentence below carries both, and the acting officer's own timeline shows
    // it. This change makes that true by removing the row from the member-visible
    // query, NOT by gating the free text: `audit-query.ts` still decides
    // `details` on a shape test rather than an audience test. #2695 is still
    // needed.
    //
    // WHAT IT DOES COST, stated rather than glossed: these two sites NARROW.
    // A member could see a bulk deactivation of their own account on their own
    // activity list and saw nothing when an officer did the same thing from the
    // member page; now they see neither. And `admin` is read with `support:view`
    // alone while `account` needs `membership:view` too, so a support-only
    // operator gains these rows — which is exactly the gate the member-page
    // equivalent already answered to. Rows already written keep their stored
    // category, so nothing is withdrawn from a member who has already seen it;
    // whether to rewrite them is #2763, and the answer is not obvious, because
    // rewriting WOULD withdraw rows a member can see today.
    //
    // STILL TWO CALLS WITH LITERAL CATEGORIES, not one call with a conditional.
    // The census contract pins that no production writer picks its category with
    // a conditional expression, because the one that used to do so picked by WHO
    // ACTED (`actor.onBehalf ? "admin" : "account"`). The branch survives the
    // unification because the two `details` strings genuinely differ — the
    // set-role branch records the roles assigned — and collapsing it would
    // silently drop that from the club's audit trail.
    for (const member of existingMembers) {
      if (idsToUpdate.includes(member.id)) {
        if (action === "set-role") {
          logAudit({
            action: `member.bulk-${action}`,
            category: "admin",
            memberId: currentUserId,
            targetId: member.id,
            entityType: "Member",
            entityId: member.id,
            details: `Bulk ${action}: ${member.firstName} ${member.lastName} (${member.email}) -> ${accessRoles?.join(", ") ?? role}`,
          });
        } else {
          logAudit({
            action: `member.bulk-${action}`,
            category: "admin",
            memberId: currentUserId,
            targetId: member.id,
            entityType: "Member",
            entityId: member.id,
            details: `Bulk ${action}: ${member.firstName} ${member.lastName} (${member.email})`,
          });
        }
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
    const hostingRetry = hostingCoverageParticipantRetryResponse(error);
    if (hostingRetry) return hostingRetry;
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
