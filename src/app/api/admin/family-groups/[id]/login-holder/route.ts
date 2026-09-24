import { type Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { isFullAdmin, memberHoldsPrivilegedRole } from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  countActiveFullAdmins,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
} from "@/lib/admin-account-guards";
import { LOGIN_HOLDER_SIGN_OUT_NOTICE } from "@/lib/admin-family-group-ui-helpers";
import { createAuditLog } from "@/lib/audit";
import { getEffectiveEmail } from "@/lib/member-utils";
import {
  isLoginEmailUniqueConflict,
  MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE,
} from "@/lib/member-email";
import {
  reconcileEmailInheritanceForMemberChange,
  validateInheritEmailSource,
} from "@/lib/member-email-inheritance";
import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

const loginHolderSchema = z.object({
  email: z.string().email(),
  newHolderId: z.string().min(1),
});

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

class LoginHolderRequestError extends Error {
  constructor(
    public status: 404 | 409 | 422,
    message: string
  ) {
    super(message);
  }
}

type GroupMemberForLoginHolder = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  inheritEmailFromId: string | null;
  inheritEmailFrom: { email: string } | null;
  // Role fields feed the #1604/#1622 privileged-target guard, evaluated
  // canLogin-blind via memberHoldsPrivilegedRole.
  role: string | null;
  financeAccessLevel: string | null;
  accessRoles: Prisma.MemberGetPayload<{
    select: { accessRoles: { select: typeof MEMBER_ACCESS_ROLE_SELECT } };
  }>["accessRoles"];
};

/**
 * POST /api/admin/family-groups/[id]/login-holder
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = loginHolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { id: groupId } = await params;
  const requestedEmail = normalizeEmail(parsed.data.email);
  const newHolderId = parsed.data.newHolderId;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const group = await tx.familyGroup.findUnique({
        where: { id: groupId },
        select: {
          id: true,
          memberships: {
            select: {
              member: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  ageTier: true,
                  active: true,
                  canLogin: true,
                  passwordHash: true,
                  passwordChangedAt: true,
                  lastLoginAt: true,
                  inheritEmailFromId: true,
                  inheritEmailFrom: {
                    select: { email: true },
                  },
                  // #2716: the transfer decides who may be given a hand-picked
                  // choice, and that turns on whether the member has a parent
                  // link. Selected explicitly because reading it as `undefined`
                  // would silently classify EVERY cluster member as a hand-pick,
                  // which is the bug this selection exists to prevent.
                  parentMemberId: true,
                  secondaryParentId: true,
                  role: true,
                  financeAccessLevel: true,
                  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
                },
              },
            },
          },
        },
      });

      if (!group) {
        throw new LoginHolderRequestError(404, "Family group not found");
      }

      const members = group.memberships.map((membership) => membership.member);
      const newHolder = members.find((member) => member.id === newHolderId);

      if (!newHolder) {
        throw new LoginHolderRequestError(
          422,
          "New login holder must be a member of this family group"
        );
      }

      if (newHolder.ageTier !== "ADULT") {
        throw new LoginHolderRequestError(422, "New login holder must be an adult");
      }

      if (!newHolder.active) {
        throw new LoginHolderRequestError(422, "New login holder must be active");
      }

      if (
        !newHolder.passwordHash ||
        !hasMemberCompletedAccountSetup({
          passwordChangedAt: newHolder.passwordChangedAt,
          lastLoginAt: newHolder.lastLoginAt,
        })
      ) {
        throw new LoginHolderRequestError(
          422,
          "New login holder has never set a password"
        );
      }

      const membersWithEffectiveEmail = await Promise.all(
        members.map(async (member) => ({
          member,
          effectiveEmail: normalizeEmail(await getEffectiveEmail(member)),
        }))
      );

      const cluster = membersWithEffectiveEmail
        .filter((entry) => entry.effectiveEmail === requestedEmail)
        .map((entry) => entry.member);

      if (cluster.length < 2) {
        throw new LoginHolderRequestError(
          422,
          "Shared-email cluster was not found in this family group"
        );
      }

      if (!cluster.some((member) => member.id === newHolderId)) {
        throw new LoginHolderRequestError(
          422,
          "New login holder does not use the requested shared email"
        );
      }

      const currentHolder = cluster.find((member) => member.canLogin);
      const touchedById = new Map<string, GroupMemberForLoginHolder>();
      for (const member of cluster) {
        touchedById.set(member.id, member);
      }

      // Privileged-target guard (issue #1604/#1622): the transfer flips
      // canLogin false on every cluster member that currently has it except the
      // incoming holder (who ends canLogin true). Only a Full Admin may
      // de-login an account holding a privileged role, evaluated canLogin-blind.
      const deLoginTargets = cluster.filter(
        (member) => member.canLogin && member.id !== newHolderId,
      );
      if (
        deLoginTargets.length > 0 &&
        !isFullAdmin(session.user) &&
        deLoginTargets.some((member) => memberHoldsPrivilegedRole(member))
      ) {
        throw new AdminAccountGuardError(PRIVILEGED_TARGET_GUARD_MESSAGE, 403);
      }

      // Login-email uniqueness (#2385). Inside the cluster this is safe on its
      // own — the outgoing holder's `canLogin: false` write frees the partial
      // index slot before the incoming holder claims it — but a member OUTSIDE
      // this family group may already log in with the address, and nothing here
      // was checking for that. The writes below would then be rejected by
      // `Member_email_login_unique` and reported as a generic 500 with nothing
      // for the admin to act on. Cluster members are excluded because this
      // transaction rewrites their canLogin/email itself.
      const clusterIds = cluster.map((member) => member.id);
      const outsideLoginHolder = await tx.member.findFirst({
        where: {
          email: requestedEmail,
          canLogin: true,
          id: { notIn: clusterIds },
        },
        select: { id: true },
      });
      if (outsideLoginHolder) {
        throw new LoginHolderRequestError(409, MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE);
      }

      if (currentHolder) {
        // Re-saving the SAME holder (the editor pre-selects them) must not
        // switch their login off and on again: the false write alone stamps
        // their revocation time and would sign them out (#3603). Only an
        // outgoing holder loses the login here.
        const holderStays = currentHolder.id === newHolderId;
        await tx.member.update({
          where: { id: currentHolder.id },
          data: {
            ...(holderStays ? {} : { canLogin: false }),
            email: requestedEmail,
            // #2716: pointer and CHOICE together. These are adults sharing one
            // login, pointed at the holder BY HAND. That is now ESTABLISHED
            // rather than assumed — the set is filtered to members with no
            // parent link, above — because the earlier version of this comment
            // claimed "none of them is anyone's parent here" about a set that
            // was selected purely by matching address, and a minor with a stale
            // inherited copy satisfied it. What the choice buys: if the holder's
            // address is ever removed, the cluster's pointers clear and this is
            // what brings them back.
            inheritEmailFromId:
              currentHolder.id === newHolderId ? null : newHolderId,
            inheritEmailChoiceId:
              currentHolder.id === newHolderId ? null : newHolderId,
          },
        });
      }

      await tx.member.update({
        where: { id: newHolderId },
        data: {
          canLogin: true,
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
          email: requestedEmail,
        },
      });

      const validation = await validateInheritEmailSource({
        inheritEmailFromId: newHolderId,
        db: tx,
      });
      if (!validation.ok) {
        throw new LoginHolderRequestError(validation.status, validation.error);
      }

      const otherMembers = cluster.filter(
        (member) => member.id !== newHolderId,
      );

      // #2716: WHO MAY BE GIVEN A CHOICE HERE, and why the cluster is not that
      // set. `cluster` is every family-group member whose EFFECTIVE email
      // matches the requested address — no age test, no parent-link test. The
      // docblock above used to assert "none of them is anyone's parent here",
      // and the code never established it. A minor whose own `email` column
      // still holds a stale copy of the address they used to inherit falls
      // straight into the cluster, and writing a choice for them records a
      // permanent hand-pick at the login holder — who may be their grandparent.
      //
      // That is the routing this whole issue exists to abolish, and it would
      // never converge: a choice is a decision a person made, so the sweep is
      // deliberately forbidden from revisiting it.
      //
      // A member with a parent link therefore keeps their DERIVED inheritance,
      // which the reconcile below re-resolves through the one-hop rule. Only a
      // member with no parent links — an adult genuinely sharing this login, the
      // population the transfer is actually for — is pointed at the holder.
      const handPickIds = otherMembers
        .filter((member) => !member.parentMemberId && !member.secondaryParentId)
        .map((member) => member.id);
      const parentedIds = otherMembers
        .filter((member) => member.parentMemberId || member.secondaryParentId)
        .map((member) => member.id);

      if (handPickIds.length > 0) {
        await tx.member.updateMany({
          where: { id: { in: handPickIds } },
          data: {
            canLogin: false,
            email: requestedEmail,
            inheritEmailFromId: newHolderId,
            inheritEmailChoiceId: newHolderId,
          },
        });
      }

      // The rest lose the login and keep the shared address as their stored
      // copy, but their inheritance is left to the one-hop rule rather than
      // hand-written here.
      if (parentedIds.length > 0) {
        await tx.member.updateMany({
          where: { id: { in: parentedIds } },
          data: { canLogin: false, email: requestedEmail },
        });
        await reconcileEmailInheritanceForMemberChange(tx, parentedIds, {
          trigger: "family-link-change",
          actorMemberId: session.user.id,
        });
      }

      // #2716: this transfer rewrites the ADDRESS on every member of the
      // cluster, so anyone outside it who inherits from one of them — a
      // dependant of a cluster member, say — has to be re-resolved in the same
      // transaction. The cluster's own pointers are recomputed too, which is
      // what proves the writes above are self-consistent rather than assumed to
      // be: if the new holder were not a usable source, the cluster would be
      // cleared here rather than left pointing at a mailbox nobody reads.
      await reconcileEmailInheritanceForMemberChange(tx, clusterIds, {
        trigger: "family-link-change",
        actorMemberId: session.user.id,
      });

      // Last-admin end-state guard (issue #1604/#1622). Counted after the
      // writes above so the read view already reflects both changes this
      // transfer makes to the admin set: the outgoing holder losing canLogin
      // AND the incoming holder gaining it. This is why a raw end-state count is
      // used here rather than the exclude-based wouldRemove* helpers — those
      // model only removals, not the concurrent grant to the new holder. If the
      // transfer would leave zero active, login-enabled Full Admins it rolls
      // back (e.g. the last admin shared a cluster login and the new holder is
      // not an admin); a new holder who is himself a Full Admin keeps the count
      // positive and is allowed.
      if ((await countActiveFullAdmins(tx)) === 0) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_GUARD_MESSAGE, 409);
      }

      const auditDetailsBase = {
        familyGroupId: groupId,
        email: requestedEmail,
        previousHolderId: currentHolder?.id ?? null,
        newHolderId,
      };

      for (const touchedMember of touchedById.values()) {
        await createAuditLog(
          {
            action: "family-group.login-holder-swapped",
            // `family`, not `security`, and the choice is load-bearing twice
            // over (#2581). Readership: `family` evidence needs `support:view`
            // plus `membership:view`, where `security` would put a login
            // transfer behind `support:view` alone. Retention: the action
            // normalises to a string containing "login", so classifying it
            // `security` or `admin` would make `classifyAuditRetention` return
            // `sensitive_access` — a 24-month expiry on the only record of who
            // held a shared family login. `family` keeps it `critical` at seven
            // years, which is what a membership dispute needs.
            category: "family",
            memberId: session.user.id,
            targetId: touchedMember.id,
            entityType: "Member",
            entityId: touchedMember.id,
            details: JSON.stringify({
              ...auditDetailsBase,
              memberId: touchedMember.id,
              ...(currentHolder?.id === touchedMember.id &&
              currentHolder.id !== newHolderId
                ? { sessionNotice: LOGIN_HOLDER_SIGN_OUT_NOTICE }
                : {}),
            }),
          },
          tx
        );
      }

      return {
        previousHolderId: currentHolder?.id ?? null,
        newHolderId,
        touchedMemberIds: Array.from(touchedById.keys()),
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LoginHolderRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof AdminAccountGuardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    // Backstop for the race the pre-check above cannot close (#2385): a
    // concurrent write can claim the address between the check and the writes.
    // The partial unique index is what actually enforces one login per address;
    // this only gives the loser of the race the same explanation the pre-check
    // returns instead of a generic 500.
    if (isLoginEmailUniqueConflict(error)) {
      return NextResponse.json(
        { error: MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE },
        { status: 409 },
      );
    }

    logger.error(
      { err: error, familyGroupId: groupId, newHolderId },
      "Failed to swap family group login holder"
    );
    return NextResponse.json(
      { error: "Failed to swap family group login holder" },
      { status: 500 }
    );
  }
}
