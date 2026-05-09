import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { getEffectiveEmail } from "@/lib/member-utils";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";
import { hasMemberCompletedAccountSetup } from "@/lib/password-reset";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";

const SESSION_LAG_WARNING =
  "The previous holder's session may remain valid for up to 8 hours after the swap.";

const loginHolderSchema = z.object({
  email: z.string().email(),
  newHolderId: z.string().min(1),
});

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

class LoginHolderRequestError extends Error {
  constructor(
    public status: 404 | 422,
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
};

/**
 * POST /api/admin/family-groups/[id]/login-holder
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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

      if (currentHolder) {
        await tx.member.update({
          where: { id: currentHolder.id },
          data: {
            canLogin: false,
            email: requestedEmail,
            inheritEmailFromId:
              currentHolder.id === newHolderId ? null : newHolderId,
          },
        });
      }

      await tx.member.update({
        where: { id: newHolderId },
        data: {
          canLogin: true,
          inheritEmailFromId: null,
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

      const otherMemberIds = cluster
        .filter((member) => member.id !== newHolderId)
        .map((member) => member.id);

      if (otherMemberIds.length > 0) {
        await tx.member.updateMany({
          where: { id: { in: otherMemberIds } },
          data: {
            canLogin: false,
            email: requestedEmail,
            inheritEmailFromId: newHolderId,
          },
        });
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
            memberId: session.user.id,
            targetId: touchedMember.id,
            details: JSON.stringify({
              ...auditDetailsBase,
              memberId: touchedMember.id,
              ...(currentHolder?.id === touchedMember.id &&
              currentHolder.id !== newHolderId
                ? { sessionLagWarning: SESSION_LAG_WARNING }
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
