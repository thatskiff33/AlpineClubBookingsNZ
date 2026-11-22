import { NextRequest, NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveInheritedEmailSourceId } from "@/lib/member-parent-links";
import logger from "@/lib/logger";
import { dependentRouteParamsSchema } from "@/lib/admin-membership-api/members";
import { connectionJson } from "@/lib/mcp-connection-request";
import { DEPENDENT_UNLINKED_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-members";

class UnlinkDependentError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422
  ) {
    super(message);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; dependentId: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const parsedParams = dependentRouteParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 }
    );
  }
  const { id: parentId, dependentId } = parsedParams.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const parent = await tx.member.findUnique({
        where: { id: parentId },
        // The parent's own email source is no longer read: provenance is
        // decided by the dependant's `inheritParentEmail` flag, not by matching
        // the stored pointer against this parent's one-hop source.
        select: { id: true },
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
          inheritEmailChoiceId: true,
          // Only the id is used — the resolver reads the parent's own row
          // itself, from the transaction's own view.
          parent: { select: { id: true } },
          secondaryParent: { select: { id: true } },
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

      // PROVENANCE, not identity (#2255). This used to ask "does the stored
      // pointer name this parent, or this parent's own source?" — a ONE-HOP
      // test. Since the write side resolves transitively, a derived pointer now
      // routinely names an ancestor two or more hops up (link a child under a
      // grandparent whose address is a placeholder and the stored source is the
      // GREAT-grandparent). That pointer failed the one-hop test, so unlinking
      // left the member with no parent link at all and a permanent inheritance
      // from someone they are no longer connected to — while the response and
      // the audit entry both said `clearedEmailInheritance: false`, as if that
      // were the correct outcome.
      //
      // WHAT DECIDES THIS IS WHO THE DECISION NAMED, not the provenance flag.
      //
      // The rule used to gate on `inheritParentEmail`, on the stated grounds
      // that "a manually-chosen source sets it false". Review established that
      // it does not: the admin member-edit hand-pick writes the pointer and
      // choice WITHOUT touching the flag, which carries `@default(true)`, so a
      // hand-picked guardian is indistinguishable from a derived pointer by that
      // flag alone. This PR's own migration says so in as many words and uses an
      // ancestry test instead. Gating on the flag therefore silently replaced an
      // admin's hand-picked guardian with a parent on the next unlink — the
      // consent question this feature must not answer by itself.
      //
      // #2716: the CHOICE counts, not just the pointer. A dependant whose chosen
      // parent has temporarily lost their address holds a live choice beside a
      // NULL pointer, and unlinking that parent has to retire the decision —
      // testing the pointer alone would leave the choice naming a member who is
      // no longer a parent, resolving to nobody forever while the audit entry
      // reports nothing was cleared.
      //
      // So: retire the decision exactly when the decision named the parent being
      // unlinked. A hand-picked guardian is never that member, so it survives. A
      // pointer naming somebody who is neither parent is the retired transitive
      // shape, which the migration re-seated and the daily sweep converges; it
      // is deliberately not special-cased here.
      const unlinkedParentId = isPrimaryParent
        ? dependent.parentMemberId
        : dependent.secondaryParentId;
      const decisionSourceId =
        dependent.inheritEmailChoiceId ?? dependent.inheritEmailFromId;
      const shouldClearEmailInheritance =
        decisionSourceId !== null && decisionSourceId === unlinkedParentId;
      const remainingParent = isPrimaryParent
        ? dependent.secondaryParent
        : dependent.parent;
      // Re-resolve through the same transitive resolver the link route uses, so
      // a dependant who falls back onto a middle-generation parent with no
      // mailbox of their own lands on that parent's nearest reachable ancestor
      // rather than on nothing. A one-hop read here would silently clear it.
      const nextEmailSourceId = shouldClearEmailInheritance
        ? remainingParent
          ? (await resolveInheritedEmailSourceId(tx, remainingParent.id)).sourceId
          : null
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
        // #2716: the CHOICE moves with the pointer. Unlinking a parent retires
        // the decision that named them, and the remaining parent — if there is
        // one and they can receive mail — becomes the new choice. Where nobody
        // remains, both columns clear: a derived choice must name a current
        // parent, so keeping one that names the parent just removed would leave
        // a decision that can never resolve.
        ...(shouldClearEmailInheritance
          ? nextEmailSourceId
            ? {
                inheritParentEmail: true,
                inheritEmailFrom: { connect: { id: nextEmailSourceId } },
                inheritEmailChoice: { connect: { id: nextEmailSourceId } },
              }
            : {
                inheritParentEmail: false,
                inheritEmailFrom: { disconnect: true },
                inheritEmailChoice: { disconnect: true },
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

      // Through `createAuditLog` rather than `tx.auditLog.create` (#2581).
      // A hand-built `data` literal skips `buildAuditLogCreateData` entirely,
      // so this row used to get no metadata sanitisation and — because
      // retention is derived only when a category, severity or retention class
      // is present — no `retentionClass` and no `expiresAt` either, i.e. kept
      // forever. The `tx` client is still passed, so the row is still written
      // inside the unlink's own transaction and still rolls back with it.
      await createAuditLog(
        {
          action: "member.dependent.unlink",
          category: "family",
          memberId: session.user.id,
          targetId: dependent.id,
          entityType: "Member",
          entityId: dependent.id,
          details: JSON.stringify({
            parentMemberId: parent.id,
            linkType: isPrimaryParent ? "PRIMARY" : "SECONDARY",
            promotedSecondaryParent: isPrimaryParent && Boolean(dependent.secondaryParentId),
            clearedEmailInheritance: shouldClearEmailInheritance,
            nextEmailSourceId,
          }),
        },
        tx
      );

      return {
        updated,
        clearedEmailInheritance: shouldClearEmailInheritance,
        promotedSecondaryParent: isPrimaryParent && Boolean(dependent.secondaryParentId),
      };
    });

    return connectionJson(
      req,
      {
        member: result.updated,
        clearedEmailInheritance: result.clearedEmailInheritance,
        promotedSecondaryParent: result.promotedSecondaryParent,
      },
      DEPENDENT_UNLINKED_CONNECTION_SHAPE,
    );
  } catch (error) {
    if (error instanceof UnlinkDependentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error, parentId, dependentId }, "Failed to unlink dependant");
    return NextResponse.json({ error: "Failed to unlink dependant" }, { status: 500 });
  }
}
