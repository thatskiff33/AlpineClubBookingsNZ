import { getAgeTierSettings } from "@/lib/age-tier";
import { AGE_GROUPS_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { connectionJson } from "@/lib/mcp-connection-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const settings = await getAgeTierSettings();
  return connectionJson(request, { settings }, AGE_GROUPS_CONNECTION_SHAPE);
}
