import { NextResponse } from "next/server";

import { getAuditRequestContext } from "@/lib/audit";
import { recordMcpAudit } from "@/lib/mcp/audit";
import { endMcpGrants, MCP_GRANT_END_REASONS } from "@/lib/mcp/grants";
import { mcpConnectionMayNotManage, mcpModuleOffResponse } from "@/lib/mcp/http";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * DELETE /api/member/mcp-grants/[id] (ALP-653, `INV-MCP-004`)
 *
 * The member disconnects one of their own AI apps. Someone else's connection,
 * and one that has already ended, both answer 404 and change nothing.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;
  const { id } = await params;

  const ended = await endMcpGrants({ id, memberId }, MCP_GRANT_END_REASONS.memberRevoked);
  if (ended === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await recordMcpAudit({
    action: "MCP_CONNECTION_REVOKED",
    actorMemberId: memberId,
    subjectMemberId: memberId,
    grantId: id,
    summary: "Disconnected an AI app",
    metadata: { reason: MCP_GRANT_END_REASONS.memberRevoked },
    request: getAuditRequestContext(request),
  });
  return NextResponse.json({ ok: true });
}
