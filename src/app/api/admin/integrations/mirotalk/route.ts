import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import {
  getMirotalkConfigurationStatus,
  mirotalkMeetingServerMoved,
  readMirotalkStoredSettings,
} from "@/lib/mirotalk-config";
import {
  clearMirotalkSecretsForAddressMove,
  writeMirotalkSettings,
} from "@/lib/mirotalk-config-write";
import {
  MIROTALK_BASE_URL_MAX_LENGTH,
  MIROTALK_CREDENTIAL_LABELS,
  MIROTALK_SETTINGS_ID,
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
 * The three secrets are written on `./credentials`, not here — except that
 * MOVING THE MEETING SERVER CLEARS THEM, which this route does own. They are
 * meaningful only to the MiroTalk instance they were paired with, so a move
 * invalidates them the way it invalidates the Alpine Central Server's API key,
 * and a redirected join link is then left with no stored credential to carry.
 * "Moving" is decided by `mirotalkMeetingServerMoved`, which compares the
 * address IN FORCE on each side rather than the stored column: writing the
 * environment's own address into a box that was empty changes the column and
 * moves nothing, and reading that as a move deleted three secrets nobody can
 * read back (#2940 review, C1).
 * The limit is stated where the helper lives (`clearMirotalkSecretsForAddressMove`):
 * an install that still sets the environment variables falls back to them, so
 * there this is cosmetic; on the install shape `.env.example` recommends it is
 * the whole fix.
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
    // OUTSIDE `settings`, because that object is the form's draft and a
    // timestamp is not editable. `MirotalkStoredSettings.updatedAt` was read
    // from the row and then consumed by nothing (#2940 review, C2), while each
    // secret showed "Last changed" from data fetched on this same request — so
    // the page said when a signing key last moved and not when the address did.
    settingsUpdatedAt: settings.updatedAt,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const memberId = guard.session.user.id;
  if (!isFullAdmin(guard.session.user)) {
    await createAuditLog({
      action: "mirotalk.settings.denied",
      category: "security",
      severity: "important",
      outcome: "failure",
      memberId,
      actorMemberId: memberId,
      entityType: "MirotalkSettings",
      // The constant, not the literal (#2940 review, T4): this is the third
      // file that names this row, and a bare "default" here made the constant's
      // own "one home" claim false.
      entityId: MIROTALK_SETTINGS_ID,
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
  const after = { ...before, baseUrl: draft.baseUrl || null };
  // TWO DIFFERENT QUESTIONS, and conflating them cost three secrets (#2940
  // review, C1). What the ADMIN did is "the box changed", which is what the
  // audit row reports; whether the SERVER moved is what the secret clear is
  // allowed to ask, and on an environment-only install those are not the same
  // event. Writing `MIROTALK_URL`'s own address into the box changes the column
  // from null and moves nothing at all.
  const storedAddressChanged = (before.baseUrl ?? "") !== draft.baseUrl;
  const serverMoved = mirotalkMeetingServerMoved(before, after);
  const changed: string[] = [];
  if (storedAddressChanged) changed.push("meeting server address");
  if (before.presenterEnabled !== draft.presenterEnabled) changed.push("presenter");
  if ((before.tokenLifetime ?? "") !== draft.tokenLifetime) {
    changed.push("join-link lifetime");
  }

  // BEFORE the settings write, not after. The state to avoid is the new address
  // paired with the old server's credentials; clearing first can only produce
  // the old address with no stored credentials, which costs a club unsigned
  // links for the length of one statement. The reverse ordering leaves the
  // dangerous pair live if the clear throws.
  const secretsCleared = serverMoved
    ? await clearMirotalkSecretsForAddressMove({
        actor: { kind: "admin", memberId },
        request: getAuditRequestContext(request),
      })
    : [];

  const settings = await writeMirotalkSettings({
    draft,
    memberId,
    changedFields: changed,
    ...(storedAddressChanged
      ? { addressChange: { from: before.baseUrl, to: draft.baseUrl || null } }
      : {}),
    secretsCleared,
  });

  return NextResponse.json({
    status: await getMirotalkConfigurationStatus(),
    settings: {
      baseUrl: settings.baseUrl ?? "",
      presenterEnabled: settings.presenterEnabled,
      tokenLifetime: settings.tokenLifetime ?? "",
    },
    settingsUpdatedAt: settings.updatedAt,
    // Plain English for the person who just moved the address, because they are
    // the only one who can put the new server's credentials in.
    secretsCleared: secretsCleared.length
      ? `The meeting server address changed, so the stored ${secretsCleared
          .map((key) => MIROTALK_CREDENTIAL_LABELS[key].toLowerCase())
          .join(", ")} ${secretsCleared.length === 1 ? "was" : "were"} cleared — they only mean anything to the server they were set for. Enter the new server's values below.`
      : null,
  });
}
