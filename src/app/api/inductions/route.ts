import {
  canSignOff,
  getInductionForMember,
  inductionSignerContext,
  listInductionsAwaitingSignOff,
  memberInductionView,
} from "@/lib/induction";
import { requireActiveSession } from "@/lib/session-guards";
import { MEMBER_OWN_INDUCTION_CONNECTION_SHAPE } from "@/lib/connection-shapes-lodge-life";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

/**
 * The member's own induction, and the inductions they may sign off.
 *
 * Also the AI app action `get_my_induction` (ALP-796): a connection reads the
 * member's own induction only. It is never a signer, so the awaiting list is
 * not read for it, and signing off stays on the website (a declaration).
 */
export async function GET(request: Request) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;
  const viaConnection = arrivesAsMcpConnection(request);
  const ctx = await inductionSignerContext(request, guard.session.user);

  const [ownRaw, awaiting] = await Promise.all([
    getInductionForMember(memberId),
    viaConnection ? Promise.resolve([]) : listInductionsAwaitingSignOff(ctx),
  ]);

  return connectionJson(
    request,
    {
      own: ownRaw ? memberInductionView(ownRaw) : null,
      awaiting: awaiting.map((induction) => ({
        id: induction.id,
        kind: induction.kind,
        createdAt: induction.createdAt,
        requiredSignOffs: induction.requiredSignOffs,
        signOffCount: induction._count.signOffs,
        member: {
          firstName: induction.member.firstName,
          lastName: induction.member.lastName,
        },
      })),
      signer: {
        isAdmin: ctx.isAdmin,
        isHutLeader: ctx.isHutLeader,
        canSignOwn: ownRaw ? canSignOff(ownRaw, ctx).allowed : false,
      },
    },
    MEMBER_OWN_INDUCTION_CONNECTION_SHAPE,
  );
}
