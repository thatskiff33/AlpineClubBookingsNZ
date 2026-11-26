import { requireAdmin } from "@/lib/session-guards";
import { getRuntimeStatus } from "@/lib/health-check";
import { RUNTIME_STATUS_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-system";
import { connectionJson } from "@/lib/mcp-connection-request";

export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  return connectionJson(request, getRuntimeStatus(), RUNTIME_STATUS_CONNECTION_SHAPE);
}
