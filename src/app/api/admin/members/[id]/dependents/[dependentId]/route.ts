import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getParentEmailSourceId } from "@/lib/member-parent-links";
import logger from "@/lib/logger";

class UnlinkDependentError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422
  ) {
    super(message);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; dependentId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: parentId, dependentId } = await params;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const parent = await tx.member.findUnique({
        where: { id: parentId },
        select: { id: true, inheritEmailFromId: true },
      });
      if (!parent) {
        throw new UnlinkDependentError("Parent member not found", 404);
      }

      const dependent = await tx.member.findUnique({
        where: { id: dependentId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritParentEmail: true,
          inheritEmailFromId: true,
          parent: {
            select: { id: true, inheritEmailFromId: true },
          },
          secondaryParent: {
            select: { id: true, inheritEmailFromId: true },
          },
        },
      });
      if (!dependent) {
        throw new UnlinkDependentError("Dependent member not found", 404);
      }
      const isPrimaryParent = dependent.parentMemberId === parent.id;
      const isSecondaryParent = dependent.secondaryParentId === parent.id;
      if (!isPrimaryParent && !isSecondaryParent) {
        throw new UnlinkDependentError(
          "This member is not linked as a dependant of that parent",
          422
        );
      }

      const parentEmailSourceIds = [parent.id, parent.inheritEmailFromId].filter(
        (sourceId): sourceId is string => Boolean(sourceId)
      );
      const shouldClearEmailInheritance =
        dependent.inheritParentEmail &&
        dependent.inheritEmailFromId !== null &&
        parentEmailSourceIds.includes(dependent.inheritEmailFromId);
      const remainingParent = isPrimaryParent
        ? dependent.secondaryParent
        : dependent.parent;
      const nextEmailSourceId = shouldClearEmailInheritance
        ? getParentEmailSourceId(remainingParent)
        : dependent.inheritEmailFromId;

      const updateData = {
        ...(isPrimaryParent
          ? dependent.secondaryParentId
            ? {
                parent: { connect: { id: dependent.secondaryParentId } },
                secondaryParent: { disconnect: true },
              }
            : { parent: { disconnect: true } }
          : { secondaryParent: { disconnect: true } }),
        ...(shouldClearEmailInheritance
          ? nextEmailSourceId
            ? {
                inheritParentEmail: true,
                inheritEmailFrom: { connect: { id: nextEmailSourceId } },
              }
            : {
                inheritParentEmail: false,
                inheritEmailFrom: { disconnect: true },
              }
          : {}),
      };

      const updated = await tx.member.update({
        where: { id: dependent.id },
        data: updateData,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritParentEmail: true,
          inheritEmailFromId: true,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "member.dependent.unlink",
          memberId: session.user.id,
          targetId: dependent.id,
          details: JSON.stringify({
            parentMemberId: parent.id,
            linkType: isPrimaryParent ? "PRIMARY" : "SECONDARY",
            promotedSecondaryParent: isPrimaryParent && Boolean(dependent.secondaryParentId),
            clearedEmailInheritance: shouldClearEmailInheritance,
            nextEmailSourceId,
          }),
        },
      });

      return {
        updated,
        clearedEmailInheritance: shouldClearEmailInheritance,
        promotedSecondaryParent: isPrimaryParent && Boolean(dependent.secondaryParentId),
      };
    });

    return NextResponse.json({
      member: result.updated,
      clearedEmailInheritance: result.clearedEmailInheritance,
      promotedSecondaryParent: result.promotedSecondaryParent,
    });
  } catch (error) {
    if (error instanceof UnlinkDependentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error, parentId, dependentId }, "Failed to unlink dependant");
    return NextResponse.json({ error: "Failed to unlink dependant" }, { status: 500 });
  }
}
