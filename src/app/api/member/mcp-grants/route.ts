import { NextResponse } from "next/server";

import { getAuditRequestContext } from "@/lib/audit";
import {
  approvedMcpScope,
  mcpApprovalDecisionSchema,
  resolveMcpApproval,
} from "@/lib/mcp/approval";
import { recordMcpAudit } from "@/lib/mcp/audit";
import { listMcpConnectionsForMember } from "@/lib/mcp/grants";
import { mcpConnectionMayNotManage, mcpModuleOffResponse } from "@/lib/mcp/http";
import { approveMcpConnection, buildMcpDenyRedirect } from "@/lib/mcp/oauth";
import { checkRateLimit, rateLimitedResponse, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/member/mcp-grants (ALP-653)
 *
 * The AI apps the signed-in member has connected and not yet disconnected.
 */
export async function GET(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  return NextResponse.json({
    connections: await listMcpConnectionsForMember(guard.session.user.id),
  });
}

/**
 * POST /api/member/mcp-grants (ALP-653, `INV-MCP-002`, `INV-MCP-003`)
 *
 * Records the member's answer on the approval screen and says where the
 * browser goes next. The request the member was shown is checked again here,
 * against their session as it is now, before anything is written.
 */
export async function POST(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const { user } = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = mcpApprovalDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const limit = await checkRateLimit(rateLimiters.mcpApprove, user.id);
  if (!limit.success) return rateLimitedResponse(limit);

  const approval = await resolveMcpApproval(parsed.data.params, user);
  if (approval.kind === "refuse") {
    return NextResponse.json({ error: approval.message }, { status: 403 });
  }
  if (approval.kind === "redirect") {
    return NextResponse.json({ redirectTo: approval.location });
  }
  if (parsed.data.decision === "deny") {
    return NextResponse.json({ redirectTo: buildMcpDenyRedirect(approval.request) });
  }

  const approved = await approveMcpConnection({
    request: approval.request,
    memberId: user.id,
    scope: approvedMcpScope(parsed.data.scope, approval),
    settings: approval.settings,
    sessionIssuedAt: approval.signIn.sessionIssuedAt,
    twoFactorVerified: approval.signIn.twoFactorVerified,
  });
  await recordMcpAudit({
    action: "MCP_CONNECTION_APPROVED",
    actorMemberId: user.id,
    subjectMemberId: user.id,
    grantId: approved.grantId,
    severity: "important",
    summary: `Connected the AI app "${approval.request.clientName}"`,
    metadata: {
      clientName: approval.request.clientName,
      redirectHost: approval.request.redirectHost,
      scope: approved.scope,
    },
    request: getAuditRequestContext(request),
  });

  return NextResponse.json({ redirectTo: approved.redirectTo });
}
