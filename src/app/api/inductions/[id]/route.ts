import { NextRequest, NextResponse } from "next/server";
import {
  canSignOff,
  getInductionById,
  inductionSignerContext,
  memberInductionView,
  resolveSignerRole,
} from "@/lib/induction";
import { INDUCTION_SIGN_OFF_DECLARATION } from "@/lib/induction-checklist-template";
import { requireActiveSession } from "@/lib/session-guards";
import { MEMBER_INDUCTION_CONNECTION_SHAPE } from "@/lib/connection-shapes-lodge-life";
import { inductionIdParamsSchema } from "@/lib/induction-params";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

const NOT_FOUND = () =>
  NextResponse.json({ error: "Induction not found" }, { status: 404 });

/**
 * One induction, for its inductee or someone who may sign it off.
 *
 * Also the AI app action `get_induction` (ALP-796): a connection reads only
 * the member's own induction. Another member's answers 404, as an unknown id
 * does, so a connection never acts as a nominator, hut leader or admin.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const parsedParams = inductionIdParamsSchema.safeParse(await params);
  if (!parsedParams.success) return NOT_FOUND();
  const { id } = parsedParams.data;

  const memberId = guard.session.user.id;
  const viaConnection = arrivesAsMcpConnection(req);
  const ctx = await inductionSignerContext(req, guard.session.user);

  const induction = await getInductionById(id);
  if (!induction) return NOT_FOUND();

  const isInductee = induction.memberId === memberId;
  if (viaConnection && !isInductee) return NOT_FOUND();
  const assignedIds = induction.assignedSigners.map((signer) => signer.memberId);
  const role = resolveSignerRole(ctx, induction.application, assignedIds);
  if (!isInductee && !role) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const eligibility = canSignOff(induction, ctx);
  return connectionJson(
    req,
    {
      induction: memberInductionView(induction),
      declaration: INDUCTION_SIGN_OFF_DECLARATION,
      viewer: {
        isInductee,
        canSign: eligibility.allowed,
        role: eligibility.role ?? null,
        reason: eligibility.reason ?? null,
      },
    },
    MEMBER_INDUCTION_CONNECTION_SHAPE,
  );
}
