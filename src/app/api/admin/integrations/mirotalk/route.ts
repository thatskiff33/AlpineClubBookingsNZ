import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import {
  getMirotalkConfigurationStatus,
  readMirotalkStoredSettings,
  writeMirotalkSettings,
} from "@/lib/mirotalk-config";
import {
  MIROTALK_BASE_URL_MAX_LENGTH,
  MIROTALK_TOKEN_LIFETIME_MAX_LENGTH,
  validateMirotalkBaseUrl,
  validateMirotalkTokenLifetime,
} from "@/lib/mirotalk-settings-shared";

/**
 * The NON-SECRET half of the club's MiroTalk configuration (#2940).
 *
 * GET  — metadata-only status: what is in force, and whether each value comes
 *        from this screen, from the environment fallback, or is derived. Any
 *        admin who can see the Integrations hub may read it. It returns no
 *        secret value, and cannot: `MirotalkSecretStatus` has no field one fits
 *        into.
 * PUT  — save the staged settings. FULL ADMIN.
 *
 * The three secrets are written on `./credentials`, not here.
 *
 * WHY THE WHOLE WRITE IS FULL ADMIN, where the Alpine Central Server route
 * gates only its base URL that way. There, the other field is an ordinary
 * operational toggle. Here there is no such field: the address is where a
 * freshly signed host token is sent, the presenter flag decides whether
 * whoever clicks a link arrives with host powers over the meeting, and the
 * lifetime decides how long a forwarded link keeps working. All three are
 * capability settings, and `finance: edit` admits any custom role matrix
 * carrying it — a Treasurer-shaped role, not just a Full Admin. Splitting the
 * gate would mean deciding which of three security settings a Treasurer may
 * change, and the honest answer is none of them.
 */

const bodySchema = z
  .object({
    // "" is not a rejected value: it is how a club CLEARS a setting and
    // returns that field to the environment fallback. There is no other way
    // back, and a club that sets an address once has to be able to undo it.
    baseUrl: z.string().trim().max(MIROTALK_BASE_URL_MAX_LENGTH),
    // null means "not set here", which is what the nullable column stores and
    // what the environment fallback reads. It is NOT the same as false.
    presenterEnabled: z.boolean().nullable(),
    tokenLifetime: z.string().trim().max(MIROTALK_TOKEN_LIFETIME_MAX_LENGTH),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const [status, settings] = await Promise.all([
    getMirotalkConfigurationStatus(),
    readMirotalkStoredSettings(),
  ]);

  return NextResponse.json({
    status,
    // What is STORED, which is what the form edits — distinct from what is in
    // force. A blank field with "using MIROTALK_URL" beside it is the state
    // this separation exists to render.
    settings: {
      baseUrl: settings.baseUrl ?? "",
      presenterEnabled: settings.presenterEnabled,
      tokenLifetime: settings.tokenLifetime ?? "",
    },
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const memberId = guard.session.user.id;
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    await createAuditLog({
      action: "mirotalk.settings.denied",
      category: "security",
      severity: "important",
      outcome: "failure",
      memberId,
      actorMemberId: memberId,
      entityType: "MirotalkSettings",
      entityId: "default",
      summary:
        "Refused a non-Full-Admin attempt to change the video-meeting settings",
    });
    return NextResponse.json(
      { error: "Full admin access is required to change these settings." },
      { status: 403 },
    );
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const draft = { ...parsed.data };
  if (draft.baseUrl) {
    const check = validateMirotalkBaseUrl(draft.baseUrl);
    if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 400 });
    draft.baseUrl = check.value;
  }
  if (draft.tokenLifetime) {
    const check = validateMirotalkTokenLifetime(draft.tokenLifetime);
    if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 400 });
    draft.tokenLifetime = check.value;
  }

  // Named so the audit row says WHICH setting moved. The values themselves are
  // not secret, but the field names are what an operator reading the log needs
  // and the row stays readable without them.
  const before = await readMirotalkStoredSettings();
  const changed: string[] = [];
  if ((before.baseUrl ?? "") !== draft.baseUrl) changed.push("meeting server address");
  if (before.presenterEnabled !== draft.presenterEnabled) changed.push("presenter");
  if ((before.tokenLifetime ?? "") !== draft.tokenLifetime) {
    changed.push("join-link lifetime");
  }

  const settings = await writeMirotalkSettings({
    draft,
    memberId,
    changedFields: changed,
  });

  return NextResponse.json({
    status: await getMirotalkConfigurationStatus(),
    settings: {
      baseUrl: settings.baseUrl ?? "",
      presenterEnabled: settings.presenterEnabled,
      tokenLifetime: settings.tokenLifetime ?? "",
    },
  });
}
