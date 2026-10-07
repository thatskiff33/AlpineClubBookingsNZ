import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { createAuditLog } from "@/lib/audit";
import {
  loadServerNzSettings,
  updateServerNzSettings,
  validateCentralServerBaseUrl,
} from "@/lib/servernz-settings";
import { clearServerNzApiKey } from "@/lib/servernz-config";

// POST /api/admin/alpine-server/settings — save the NON-secret ServerNZ
// connection settings (base URL and per-shared-item enable flags). The API key
// itself goes through the encrypted-credential route, not here.
//
// TWO different gates, on purpose (see the Full-Admin note on `baseUrl` below):
// the per-item enable flag is finance-area edit, the same audience as the rest
// of the Integrations hub; the base URL is Full Admin.

const bodySchema = z
  .object({
    baseUrl: z.string().trim().max(500).optional(),
    otherLodgesEnabled: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const changingBaseUrl = parsed.data.baseUrl !== undefined;

  // The base URL is where `servernz-api.ts` sends the stored API key as a
  // bearer token, so whoever can move it can read a secret they were never
  // entitled to. Writing that key is Full-Admin-only (the credential route's
  // own `requireFullAdmin`), and `finance: edit` admits any custom role matrix
  // carrying it — a Treasurer-shaped role, not just a Full Admin. Leaving the
  // destination at `finance: edit` would therefore hand that role the key by
  // redirection: point it at a host they control, enable the sync, collect the
  // Authorization header. Every other provider pins its endpoint in code, which
  // is why Full-Admin-on-the-key alone was sufficient for them and is not here.
  if (changingBaseUrl && !isFullAdmin(guard.session.user)) {
    await createAuditLog({
      action: "alpine_server.settings.base_url_denied",
      category: "security",
      severity: "important",
      outcome: "failure",
      memberId: guard.session.user.id,
      entityType: "ServerNzSettings",
      entityId: "default",
      summary: "Refused a non-Full-Admin attempt to change the Alpine Central Server address",
    });
    return NextResponse.json(
      { error: "Full admin access is required to change the central server address." },
      { status: 403 },
    );
  }

  if (changingBaseUrl && parsed.data.baseUrl !== "") {
    const check = validateCentralServerBaseUrl(parsed.data.baseUrl as string);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason }, { status: 400 });
    }
    parsed.data.baseUrl = check.value;
  }

  const before = await loadServerNzSettings();
  const settings = await updateServerNzSettings({
    baseUrl: parsed.data.baseUrl,
    otherLodgesEnabled: parsed.data.otherLodgesEnabled,
    updatedByMemberId: guard.session.user.id,
  });

  // Moving the destination invalidates the key held for the old one. The key was
  // issued by a specific central server and means nothing to a different one, so
  // this costs an admin nothing they would not have had to do anyway — and it is
  // what makes the Full-Admin gate above robust rather than merely correct: even
  // if a future edit widens that gate again, a redirected sync has no credential
  // left to leak.
  let apiKeyCleared = false;
  if (changingBaseUrl && before.baseUrl !== settings.baseUrl) {
    await clearServerNzApiKey({
      kind: "admin",
      memberId: guard.session.user.id,
    });
    apiKeyCleared = true;
  }

  await createAuditLog({
    action: "alpine_server.settings.update",
    category: "admin",
    severity: "info",
    outcome: "success",
    memberId: guard.session.user.id,
    entityType: "ServerNzSettings",
    entityId: "default",
    summary: "Updated Alpine Central Server settings",
    details:
      `changed: ${Object.keys(parsed.data).join(", ") || "none"}` +
      (apiKeyCleared ? "; stored API key cleared because the server address moved" : ""),
  });

  return NextResponse.json({
    baseUrl: settings.baseUrl,
    otherLodgesEnabled: settings.otherLodgesEnabled,
    apiKeyCleared,
  });
}
