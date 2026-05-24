import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";
import {
  getParentEmailSourceId,
  resolveParentNotificationSourceId,
} from "@/lib/member-parent-links";
import logger from "@/lib/logger";

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

async function hasAncestorMember(
  tx: TransactionClient,
  parentMemberIds: Array<string | null>,
  possibleAncestorId: string
) {
  const seen = new Set<string>();
  const stack = parentMemberIds.filter((id): id is string => Boolean(id));

  while (stack.length > 0) {
    const currentParentId = stack.pop()!;
    if (currentParentId === possibleAncestorId) {
      return true;
    }

    if (seen.has(currentParentId)) {
      continue;
    }
    seen.add(currentParentId);

    const parent = await tx.member.findUnique({
      where: { id: currentParentId },
      select: { parentMemberId: true, secondaryParentId: true },
    });
    if (parent?.parentMemberId) {
      stack.push(parent.parentMemberId);
    }
    if (parent?.secondaryParentId) {
      stack.push(parent.secondaryParentId);
    }
  }

  return false;
}

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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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
      const parent = await tx.member.findUnique({
        where: { id: parentId },
        select: {
          id: true,
          ageTier: true,
          active: true,
          archivedAt: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritEmailFromId: true,
          familyGroupMemberships: {
            select: { familyGroupId: true },
          },
        },
      });

      if (!parent) {
        throw new LinkDependentError("Parent member not found", 404);
      }
      if (parent.ageTier !== "ADULT" || !parent.active || parent.archivedAt) {
        throw new LinkDependentError(
          "Dependants can only be linked under active adult members",
          422
        );
      }

      const target = await tx.member.findUnique({
        where: { id: data.memberId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritEmailFromId: true,
          parent: {
            select: { id: true, inheritEmailFromId: true },
          },
          secondaryParent: {
            select: { id: true, inheritEmailFromId: true },
          },
          canLogin: true,
          archivedAt: true,
          dependents: {
            select: { id: true },
            take: 1,
          },
          secondaryDependents: {
            select: { id: true },
            take: 1,
          },
        },
      });

      if (!target) {
        throw new LinkDependentError("Member to link not found", 404);
      }
      if (target.archivedAt) {
        throw new LinkDependentError("Archived members cannot be linked into family groups", 422);
      }
      if (target.id === parent.id) {
        throw new LinkDependentError("A member cannot be their own dependant", 422);
      }
      if (
        target.parentMemberId === parent.id ||
        target.secondaryParentId === parent.id
      ) {
        throw new LinkDependentError("This member is already linked to that parent", 422);
      }
      if (target.parentMemberId && target.secondaryParentId) {
        throw new LinkDependentError("This member already has two parents linked", 422);
      }
      if (
        await hasAncestorMember(
          tx,
          [parent.parentMemberId, parent.secondaryParentId],
          target.id
        )
      ) {
        throw new LinkDependentError("Cannot link a parent or ancestor as a dependant", 422);
      }
      if ((target.dependents?.length ?? 0) > 0 || (target.secondaryDependents?.length ?? 0) > 0) {
        throw new LinkDependentError("This member already has dependants and cannot be linked under another member", 422);
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
      const resolvedExplicitInheritEmailFromId =
        explicitInheritEmailFromId !== undefined
          ? resolveParentNotificationSourceId(
              parentLinksAfterSave,
              explicitInheritEmailFromId
            )
          : undefined;

      if (resolvedExplicitInheritEmailFromId === undefined && explicitInheritEmailFromId) {
        throw new LinkDependentError(
          "Notification email recipient must be one of this member's linked parents",
          422
        );
      }

      const inheritEmailFromId =
        resolvedExplicitInheritEmailFromId !== undefined
          ? resolvedExplicitInheritEmailFromId
          : data.inheritEmail
            ? getParentEmailSourceId(parent)
            : undefined;

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
        } else {
          updateData.inheritParentEmail = false;
          updateData.inheritEmailFrom = { disconnect: true };
        }
      } else if (data.inheritEmail) {
        const fallbackInheritEmailFromId = getParentEmailSourceId(parent);
        const validation = await validateInheritEmailSource(
          {
            memberId: target.id,
            inheritEmailFromId: fallbackInheritEmailFromId!,
          },
          tx
        );
        if (!validation.ok) {
          throw new LinkDependentError(validation.error, validation.status);
        }

        updateData.inheritParentEmail = true;
        updateData.inheritEmailFrom = { connect: { id: fallbackInheritEmailFromId! } };
      }

      if (data.disableLogin) {
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
              role: "MEMBER",
            },
            update: {},
          })
        )
      );

      await tx.auditLog.create({
        data: {
          action: "member.dependent.link",
          memberId: session.user.id,
          targetId: target.id,
          details: JSON.stringify({
            parentMemberId: parent.id,
            linkType,
            inheritEmail: data.inheritEmail,
            inheritEmailFromId: inheritEmailFromId ?? target.inheritEmailFromId,
            disableLogin: data.disableLogin,
            addToFamilyGroupIds,
          }),
        },
      });

      return updated;
    });

    return NextResponse.json({ member: linkedMember });
  } catch (error) {
    if (error instanceof LinkDependentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error }, "Failed to link dependant");
    return NextResponse.json({ error: "Failed to link dependant" }, { status: 500 });
  }
}
