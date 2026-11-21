import { NextResponse } from "next/server";

import { getAuditRequestContext } from "@/lib/audit";
import { recordMcpAudit } from "@/lib/mcp/audit";
import { endMcpGrant, MCP_GRANT_END_REASONS } from "@/lib/mcp/grants";
import { mcpConnectionMayNotManage, mcpModuleOffResponse } from "@/lib/mcp/http";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * DELETE /api/admin/mcp/grants/[id] (ALP-653, `INV-MCP-004`)
 *
 * An officer disconnects a member's AI app. A connection that has already
 * ended answers 404 and nothing is written.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireAdmin({ permission: { area: "support", level: "edit" } });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const grant = await prisma.mcpGrant.findUnique({
    where: { id },
    select: { memberId: true, client: { select: { name: true } } },
  });
  if (!grant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const ended = await endMcpGrant(id, MCP_GRANT_END_REASONS.adminRevoked);
  if (ended === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await recordMcpAudit({
    action: "MCP_CONNECTION_REVOKED",
    actorMemberId: guard.session.user.id,
    subjectMemberId: grant.memberId,
    grantId: id,
    severity: "important",
    summary: `An officer disconnected the AI app "${grant.client.name}"`,
    metadata: { reason: MCP_GRANT_END_REASONS.adminRevoked, clientName: grant.client.name },
    request: getAuditRequestContext(request),
  });
  return NextResponse.json({ ok: true });
}
