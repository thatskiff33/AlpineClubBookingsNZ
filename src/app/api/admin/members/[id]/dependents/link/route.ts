import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { createAuditLog } from "@/lib/audit";
import { isFullAdmin, memberHoldsPrivilegedRole } from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { requireAdmin } from "@/lib/session-guards";
import {
  DEPENDENT_LINK_CANDIDATE_SELECT,
  DEPENDENT_LINK_INELIGIBILITY_ERRORS,
  DEPENDENT_PARENT_LINK_ERRORS,
  DEPENDENT_PARENT_STATE_SELECT,
  dependentLinkBlockers,
  dependentParentStateBlocker,
} from "@/lib/dependent-link-eligibility";
import { prisma } from "@/lib/prisma";
import {
  reconcileEmailInheritanceForMemberChange,
  validateInheritEmailSource,
} from "@/lib/member-email-inheritance";
import {
  describeChildSideDepth,
  describeParentSideDepth,
} from "@/lib/member-family-link-depth";
import {
  matchParentLinkIdForNotification,
  NO_INHERITABLE_EMAIL_SOURCE_MESSAGE,
  resolveInheritedEmailSourceId,
} from "@/lib/member-parent-links";
import logger from "@/lib/logger";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";

const linkDependentSchema = z.object({
  memberId: z.string().min(1, "Member is required"),
  inheritEmail: z.boolean(),
  disableLogin: z.boolean(),
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  addToFamilyGroupIds: z.array(z.string()).default([]),
});

class LinkDependentError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422
  ) {
    super(message);
  }
}

type TransactionClient = Prisma.TransactionClient;

async function validateDisableLoginDoesNotOrphanSharedEmail(
  tx: TransactionClient,
  member: { id: string; email: string; canLogin: boolean }
) {
  if (!member.canLogin) {
    return;
  }

  const sharedEmailMemberCount = await tx.member.count({
    where: {
      email: member.email,
      id: { not: member.id },
    },
  });
  if (sharedEmailMemberCount === 0) {
    return;
  }

  const otherLoginHolder = await tx.member.findFirst({
    where: {
      email: member.email,
      id: { not: member.id },
      canLogin: true,
    },
    select: { id: true },
  });

  if (!otherLoginHolder) {
    throw new LinkDependentError(
      "Cannot disable login because this member is the only login holder for a shared email. Swap the login holder first.",
      422
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: parentId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = linkDependentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const data = parsed.data;
  const addToFamilyGroupIds = Array.from(new Set(data.addToFamilyGroupIds));

  try {
    const linkedMember = await prisma.$transaction(async (tx) => {
      // INV-LOCK-002/003: existing-member parent writes compose the lifecycle
      // tier followed by the complete sorted partner tier. The guarded rows are
      // first read below only after both pairs of locks are held.
      await acquireMemberLifecycleLocks(tx, [parentId, data.memberId]);
      await acquireMemberPartnerLinkLocks(tx, [parentId, data.memberId]);

      const parent = await tx.member.findUnique({
        where: { id: parentId },
        select: {
          id: true,
          // #2282: `ageTier` is deliberately not selected here. Nothing on this
          // route may branch on the parent's age again — the email source is
          // resolved and validated by `resolveInheritedEmailSourceId` /
          // `validateInheritEmailSource`, which read the age of whoever they
          // land on for themselves — so its absence makes a re-introduced age
          // gate fail to compile rather than pass review. The one surviving
          // rule about who the parent IS (an organisation or school account is
          // not a person) rides in on the shared state select, classified by
          // ROLE: `NOT_APPLICABLE` is the age-EXEMPT tier and age-exempt humans
          // carry it too (#1440, #2106).
          ...DEPENDENT_PARENT_STATE_SELECT,
          // The parent's own parent columns are NOT selected: the ancestry and
          // depth answers come from describeParentSideDepth below, which reads
          // them itself, and a second copy here would invite a stale one.
          inheritEmailFromId: true,
          familyGroupMemberships: {
            select: { familyGroupId: true },
          },
        },
      });

      if (!parent) {
        throw new LinkDependentError("Parent member not found", 404);
      }
      // #2282: age does NOT gate recording parentage. A 16 or 17 year old can
      // genuinely be a parent, and refusing the link left the club recording
      // the child as parentless or hanging them off a grandparent — both of
      // which misstate who the parent is. `active` and `archivedAt` stay,
      // because they are about whether the record is CURRENT, not about
      // capacity to take responsibility, and an organisation/school ACCOUNT
      // stays refused because it is not a person at all. The responsibility
      // functions keep
      // their own adult gates further down this route (the email-inheritance
      // source, resolved and validated below) and elsewhere; a young parent who
      // cannot be the contact of record is the correct outcome, and the
      // transitive resolver routes the child's mail on up to the nearest adult.
      const parentStateBlocker = dependentParentStateBlocker(parent);
      if (parentStateBlocker) {
        throw new LinkDependentError(
          DEPENDENT_PARENT_LINK_ERRORS[parentStateBlocker],
          422
        );
      }

      const target = await tx.member.findUnique({
        where: { id: data.memberId },
        select: {
          // #2254: the eligibility predicate's own columns come from the shared
          // select, so trimming one here cannot silently disarm a guard below.
          // Its graph-shaped guards (cycle + generation cap) take the walk
          // results below as a required argument, for the same reason.
          ...DEPENDENT_LINK_CANDIDATE_SELECT,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          inheritEmailFromId: true,
          parent: {
            select: { id: true, inheritEmailFromId: true },
          },
          secondaryParent: {
            select: { id: true, inheritEmailFromId: true },
          },
          canLogin: true,
          // Role fields feed the #1604/#1622 privileged-target guard, evaluated
          // canLogin-blind via memberHoldsPrivilegedRole.
          role: true,
          financeAccessLevel: true,
          accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        },
      });

      if (!target) {
        throw new LinkDependentError("Member to link not found", 404);
      }
      // #2254: the row-level guards below and the admin candidate SEARCH
      // (`dependentLinkEligibleFor`) are now one predicate — see
      // src/lib/dependent-link-eligibility.ts — so the search can never offer a
      // candidate this route rejects, nor hide one it would accept.
      //
      // #2255: the two graph-shaped guards (is the candidate an ancestor of the
      // parent, and would the merged chain exceed four generations) are computed
      // here, inside the transaction, so they read this write's own view. Both
      // walks are level-bounded and cycle-safe; see member-family-link-depth.ts.
      const [parentSide, childSide] = await Promise.all([
        describeParentSideDepth(tx, parent.id),
        describeChildSideDepth(tx, target.id),
      ]);
      const blockers = dependentLinkBlockers(parent.id, target, {
        parentAncestorIds: parentSide.ancestorIds,
        parentAncestorGenerations: parentSide.ancestorGenerations,
        candidateDescendantGenerations: childSide.descendantGenerations,
      });

      if (blockers[0]) {
        throw new LinkDependentError(
          DEPENDENT_LINK_INELIGIBILITY_ERRORS[blockers[0]],
          422
        );
      }

      if (data.disableLogin) {
        await validateDisableLoginDoesNotOrphanSharedEmail(tx, target);
      }

      const parentFamilyGroupIds = new Set(
        parent.familyGroupMemberships.map((membership) => membership.familyGroupId)
      );
      const invalidFamilyGroupIds = addToFamilyGroupIds.filter(
        (familyGroupId) => !parentFamilyGroupIds.has(familyGroupId)
      );
      if (invalidFamilyGroupIds.length > 0) {
        throw new LinkDependentError(
          "Dependants can only be added to family groups the parent belongs to",
          422
        );
      }

      const linkType = target.parentMemberId ? "SECONDARY" : "PRIMARY";
      const updateData: Prisma.MemberUpdateInput =
        linkType === "PRIMARY"
          ? { parent: { connect: { id: parent.id } } }
          : { secondaryParent: { connect: { id: parent.id } } };

      const explicitInheritEmailFromId =
        Object.prototype.hasOwnProperty.call(data, "inheritEmailFromId")
          ? data.inheritEmailFromId?.trim() || null
          : undefined;
      const parentLinksAfterSave = [
        ...(target.parent ? [target.parent] : []),
        ...(target.secondaryParent ? [target.secondaryParent] : []),
        parent,
      ];
      // #2255: the notification mailbox is resolved by walking UP from the
      // chosen parent to the nearest ancestor who can actually receive mail,
      // and the TERMINAL result is what gets stored — inheritance stays flat at
      // any depth, so every reader keeps its single `inheritEmailFrom` join.
      //
      // Three distinct states, and the difference matters: `undefined` means
      // "leave the member's existing inheritance alone", `null` means "the admin
      // asked for the member's own email", and an id means "store this mailbox".
      let inheritEmailFromId: string | null | undefined;
      if (explicitInheritEmailFromId !== undefined) {
        const selectedParentId = matchParentLinkIdForNotification(
          parentLinksAfterSave,
          explicitInheritEmailFromId
        );
        if (selectedParentId === undefined) {
          throw new LinkDependentError(
            "Notification email recipient must be one of this member's linked parents",
            422
          );
        }
        inheritEmailFromId = selectedParentId
          ? (await resolveInheritedEmailSourceId(tx, selectedParentId)).sourceId
          : null;
        if (selectedParentId && !inheritEmailFromId) {
          throw new LinkDependentError(
            NO_INHERITABLE_EMAIL_SOURCE_MESSAGE,
            422
          );
        }
      } else if (data.inheritEmail) {
        inheritEmailFromId = (
          await resolveInheritedEmailSourceId(tx, parent.id)
        ).sourceId;
        if (!inheritEmailFromId) {
          throw new LinkDependentError(NO_INHERITABLE_EMAIL_SOURCE_MESSAGE, 422);
        }
      }

      if (inheritEmailFromId !== undefined) {
        if (inheritEmailFromId) {
          const validation = await validateInheritEmailSource(
            {
              memberId: target.id,
              inheritEmailFromId,
            },
            tx
          );
          if (!validation.ok) {
            throw new LinkDependentError(validation.error, validation.status);
          }

          updateData.inheritParentEmail = true;
          updateData.inheritEmailFrom = { connect: { id: inheritEmailFromId } };
          // #2716: the pointer and the CHOICE are written together. Under one
          // hop they are the same member — the chosen parent IS the mailbox —
          // but they are stored separately because they answer different
          // questions later: the pointer is who receives mail today, the choice
          // is who the admin picked, and only the choice survives that parent's
          // address being removed and brought back.
          updateData.inheritEmailChoice = { connect: { id: inheritEmailFromId } };
        } else {
          updateData.inheritParentEmail = false;
          updateData.inheritEmailFrom = { disconnect: true };
          updateData.inheritEmailChoice = { disconnect: true };
        }
      }

      if (data.disableLogin) {
        // Admin-account guards (issue #1604/#1622): linking a member as a
        // dependent with disableLogin flips canLogin false on an existing
        // account — the same de-login class the #1604 guards protect. Guard only
        // a real true→false flip (an already non-login target is a no-op echo),
        // inside this transaction so the last-admin count sees its read view.
        if (target.canLogin) {
          if (!isFullAdmin(session.user) && memberHoldsPrivilegedRole(target)) {
            throw new AdminAccountGuardError(
              PRIVILEGED_TARGET_GUARD_MESSAGE,
              403,
            );
          }
          if (await wouldRemoveLastFullAdmin(tx, target.id)) {
            throw new AdminAccountGuardError(LAST_FULL_ADMIN_GUARD_MESSAGE, 409);
          }
        }
        updateData.canLogin = false;
      }

      const updated = await tx.member.update({
        where: { id: target.id },
        data: updateData,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritEmailFromId: true,
          canLogin: true,
        },
      });

      // #2821: linking an EXISTING ADULT as somebody's dependant makes that
      // adult stop being a usable email source at this moment — they now
      // inherit, and `isUsableEmailSource` refuses a member who does. Their own
      // dependants therefore hold pointers at somebody the rule no longer
      // permits, and nothing re-resolved them. This is the ordering hazard
      // `reconcileEmailInheritanceForMemberChange` documents: settle the
      // member's own pointer first, then judge everyone who depends on them.
      // One call does both.
      await reconcileEmailInheritanceForMemberChange(tx, [target.id], {
        trigger: "family-link-change",
        actorMemberId: session.user.id,
      });

      await Promise.all(
        addToFamilyGroupIds.map((familyGroupId) =>
          tx.familyGroupMember.upsert({
            where: {
              familyGroupId_memberId: {
                familyGroupId,
                memberId: target.id,
              },
            },
            create: {
              familyGroupId,
              memberId: target.id,
            },
            update: {},
            // Result discarded — narrow the implicit RETURNING (#2130 house rule).
            select: { id: true },
          })
        )
      );

      // Through `createAuditLog` rather than `tx.auditLog.create` (#2581) —
      // same reason as the unlink route: the hand-built literal bypassed
      // `buildAuditLogCreateData`, so this row got no metadata sanitisation, no
      // `retentionClass` and no `expiresAt`. The `tx` client keeps the write
      // inside the link's own transaction.
      await createAuditLog(
        {
          action: "member.dependent.link",
          category: "family",
          memberId: session.user.id,
          targetId: target.id,
          entityType: "Member",
          entityId: target.id,
          details: JSON.stringify({
            parentMemberId: parent.id,
            linkType,
            inheritEmail: data.inheritEmail,
            inheritEmailFromId: inheritEmailFromId ?? target.inheritEmailFromId,
            disableLogin: data.disableLogin,
            addToFamilyGroupIds,
          }),
        },
        tx
      );

      return updated;
    });

    return NextResponse.json({ member: linkedMember });
  } catch (error) {
    if (error instanceof LinkDependentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof AdminAccountGuardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logger.error({ err: error }, "Failed to link dependant");
    return NextResponse.json({ error: "Failed to link dependant" }, { status: 500 });
  }
}
