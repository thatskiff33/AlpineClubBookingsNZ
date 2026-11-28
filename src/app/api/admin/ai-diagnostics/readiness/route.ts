import { requireAdmin } from "@/lib/session-guards";
import { DIAGNOSTICS_READINESS_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-ai";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  getDiagnosticsReadiness,
  readDiagnosticsModuleFlag,
} from "@/lib/ai-diagnostics-config";

// GET /api/admin/ai-diagnostics/readiness — metadata-only setup readiness for the
// AI Diagnostics product (AID-2, #2371; SELECT-only database role added by AID-5,
// #2374).
//
// DELIBERATELY REACHABLE WHILE THE MODULE IS OFF: this endpoint is exempted from
// the aiDiagnostics feature-route gate (config/feature-routes.ts) so an admin can
// see what still needs configuring — the module being off, no dedicated Anthropic
// key stored, no monthly budget set, or the dedicated SELECT-only database role
// not yet provisioned — and complete setup BEFORE enabling the paid product. It
// spends nothing, exposes NO secret value, and enforces its own support-area admin
// permission.
//
// The database gate VERIFIES privileges with the server rather than trusting that
// `AI_DIAGNOSTICS_DATABASE_URL` is set (ADR-007), so this response can distinguish
// "not provisioned yet" from "provisioned but over-privileged". It reports a state
// only: never the connection string, the password, or the role name.
//
// Fail-closed: getDiagnosticsReadiness returns ready:false with a resolve_error
// blocker on any DB fault rather than throwing, so a diagnostics surface never
// treats an unknown state as ready.
//
// The module flag is read through readDiagnosticsModuleFlag (#2803), the SAME
// tri-state reader the diagnostics readiness tool uses, so this endpoint and that
// tool cannot disagree about a club's module state. When the settings read fails,
// `moduleEnabled` is null and the blocker is `module_flags_unreadable` rather than
// `module_off` — a screen must render that as "could not check", never as "off".
export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const readiness = await getDiagnosticsReadiness({
    aiDiagnostics: await readDiagnosticsModuleFlag(),
  });

  return connectionJson(request, readiness, DIAGNOSTICS_READINESS_CONNECTION_SHAPE);
}
