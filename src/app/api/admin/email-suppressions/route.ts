import { requireAdmin } from "@/lib/session-guards";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import { EMAIL_SUPPRESSION_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";

export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return connectionJson(request, await getEmailDeliverabilityTelemetry(), EMAIL_SUPPRESSION_LIST_CONNECTION_SHAPE);
}
