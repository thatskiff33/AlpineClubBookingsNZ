import { NextResponse } from "next/server";

import { parseJsonRequestBody } from "@/lib/api-json";
import { getAuditRequestContext } from "@/lib/audit";
import { recordMcpAudit } from "@/lib/mcp/audit";
import { mcpConnectionMayNotManage, mcpModuleOffResponse } from "@/lib/mcp/http";
import {
  DEFAULT_MCP_SETTINGS,
  loadMcpSettings,
  MCP_SETTINGS_ID,
  MCP_SETTINGS_SELECT,
} from "@/lib/mcp/settings";
import { mcpSettingsUpdateSchema, normaliseMcpAllowedHosts } from "@/lib/mcp/settings-update";
import { prisma } from "@/lib/prisma";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/mcp/settings (ALP-653)
 *
 * Who may connect an AI app, the most a connection may do, and the approved
 * apps. Support view reads them; support edit changes them, after a fresh
 * proof of who they are.
 */
export async function GET(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireAdmin({ permission: { area: "support", level: "view" } });
  if (!guard.ok) return guard.response;

  return NextResponse.json(await loadMcpSettings());
}

export async function PUT(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireAdmin({ permission: { area: "support", level: "edit" } });
  if (!guard.ok) return guard.response;
  // Widening who may hand their account to an AI app is a security setting:
  // the officer proves it is them again first (INV-AUTH-010).
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const actorMemberId = guard.session.user.id;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = mcpSettingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const hosts = normaliseMcpAllowedHosts(parsed.data.allowedRedirectHosts);
  if (!hosts.ok) {
    return NextResponse.json(
      { error: `"${hosts.invalid}" is not a website address. Enter a host such as claude.ai.` },
      { status: 400 },
    );
  }
  const next = {
    membersMayConnect: parsed.data.membersMayConnect,
    officersMayConnect: parsed.data.officersMayConnect,
    maxScope: parsed.data.maxScope,
    allowedRedirectHosts: hosts.hosts,
  };

  // Claim the singleton row before reading its previous values. A transaction
  // alone does not serialize the read before two concurrent upserts.
  const saved = await prisma.$transaction(async (tx) => {
    const previous = await tx.mcpSettings.upsert({
      where: { id: MCP_SETTINGS_ID },
      create: {
        id: MCP_SETTINGS_ID,
        ...DEFAULT_MCP_SETTINGS,
        allowedRedirectHosts: [...DEFAULT_MCP_SETTINGS.allowedRedirectHosts],
      },
      // An actual no-op UPDATE holds the row until the audited write commits.
      update: { id: MCP_SETTINGS_ID },
      select: MCP_SETTINGS_SELECT,
    });
    const updated = await tx.mcpSettings.upsert({
      where: { id: MCP_SETTINGS_ID },
      create: { id: MCP_SETTINGS_ID, ...next, updatedByMemberId: actorMemberId },
      update: { ...next, updatedByMemberId: actorMemberId },
      select: MCP_SETTINGS_SELECT,
    });
    await recordMcpAudit(
      {
        action: "MCP_SETTINGS_UPDATED",
        actorMemberId,
        severity: "important",
        summary: "AI connection settings updated",
        metadata: { previous, next },
        request: getAuditRequestContext(request),
      },
      tx,
    );
    return updated;
  });

  return NextResponse.json(saved);
}
