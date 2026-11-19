import { NextResponse } from "next/server";
import { z } from "zod";

import { adminListPage, adminListPageQueryFields } from "@/lib/admin-list-page";

import { listMcpConnectionsForAdmin } from "@/lib/mcp/grants";
import { mcpConnectionMayNotManage, mcpModuleOffResponse } from "@/lib/mcp/http";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/mcp/grants (ALP-653)
 *
 * Every AI app connection in the club that is still in use: whose it is,
 * which app, and when it was last used.
 */
export async function GET(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;
  const notHere = mcpConnectionMayNotManage(request);
  if (notHere) return notHere;

  const guard = await requireAdmin({ permission: { area: "support", level: "view" } });
  if (!guard.ok) return guard.response;

  const parsed = z.object({ ...adminListPageQueryFields }).safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
  }
  const { page, pageSize } = parsed.data;
  const { connections, total } = await listMcpConnectionsForAdmin({ page, pageSize });
  return NextResponse.json({ connections, ...adminListPage({ page, pageSize, total }) });
}
