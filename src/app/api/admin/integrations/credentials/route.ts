import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { getAuditRequestContext } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import { setIntegrationCredential } from "@/lib/integration-credentials";
import { WeakAuthSecretError } from "@/lib/integration-crypto";
import { deleteXeroTokens } from "@/lib/xero-token-store";
import { XERO_CREDENTIAL_KEYS, XERO_PROVIDER } from "@/lib/xero-config";
import {
  STRIPE_PROVIDER,
  STRIPE_WRITABLE_CREDENTIAL_KEYS,
  clearStripeWebhookVerified,
} from "@/lib/stripe-config";
import {
  BACKUP_CREDENTIAL_KEYS,
  BACKUP_PROVIDER,
  BACKUP_SECRET_CREDENTIAL_KEYS,
  isValidRestoreValidationUrl,
} from "@/lib/backup-config";
import {
  GOOGLE_PROVIDER,
  GOOGLE_WRITABLE_CREDENTIAL_KEYS,
  clearGoogleVerified,
} from "@/lib/google-config";
import {
  ANTHROPIC_PROVIDER,
  ANTHROPIC_WRITABLE_CREDENTIAL_KEYS,
} from "@/lib/ai-assistant-config";
import {
  DIAGNOSTICS_PROVIDER,
  DIAGNOSTICS_WRITABLE_CREDENTIAL_KEYS,
} from "@/lib/ai-diagnostics-config";
import {
  SERVERNZ_PROVIDER,
  SERVERNZ_WRITABLE_CREDENTIAL_KEYS,
} from "@/lib/servernz-config";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

// POST /api/admin/integrations/credentials — write-only credential setter.
//
// Full Admin only (epic decision 4; precedent requireFullAdminForConfigTransfer)
// plus the repo's standard admin-mutation protections (authenticated
// same-origin session, JSON body). Values are NEVER returned — the response
// confirms metadata only. Audit entries are metadata-only (no value, no body).
//
// Exposure contract (#2079): no plaintext or ciphertext/iv/authTag in the
// response, the log lines, or the audit row.

/**
 * Allowlist of credentials this endpoint may write, per provider. Prevents
 * arbitrary (provider, key) rows and keys the verify-reset behaviour. C4/C5/C6
 * extend this with their providers.
 */
const WRITABLE_CREDENTIALS: Record<string, readonly string[]> = {
  [XERO_PROVIDER]: [
    XERO_CREDENTIAL_KEYS.clientId,
    XERO_CREDENTIAL_KEYS.clientSecret,
    XERO_CREDENTIAL_KEYS.webhookKey,
  ],
  [STRIPE_PROVIDER]: [...STRIPE_WRITABLE_CREDENTIAL_KEYS],
  [GOOGLE_PROVIDER]: [...GOOGLE_WRITABLE_CREDENTIAL_KEYS],
  // Backup S3 access key/secret + the restore-validation shadow DSN (#2095, C6):
  // write-only secrets, Full Admin. The non-secret destination (bucket/region)
  // and operational config (enabled/retention) are written on the backups
  // config route, not here.
  [BACKUP_PROVIDER]: [...BACKUP_SECRET_CREDENTIAL_KEYS],
  // AI help assistant Anthropic API key (#2211, C3): a single write-only secret,
  // Full Admin. No verify-reset branch below — unlike Google/Stripe there is no
  // verified marker to drop (the verify-ping endpoint was cut per plan); the
  // key's own needs-reentry state is derived live from the encrypted store.
  [ANTHROPIC_PROVIDER]: [...ANTHROPIC_WRITABLE_CREDENTIAL_KEYS],
  // AI Diagnostics DEDICATED Anthropic API key (AID-2, #2371): a SEPARATE
  // write-only secret under its own provider namespace ("anthropic-diagnostics"),
  // Full Admin. Deliberately distinct from the page-help ANTHROPIC_PROVIDER key
  // above so the two are never shared or confused — a diagnostics deployment can
  // point at a separate Anthropic workspace/key. Same shape as the page-help key:
  // no verify-reset marker; the needs-reentry state is derived live from the
  // encrypted store. Reachable whether or not the aiDiagnostics module is on, so
  // the credential can be entered before the module is enabled.
  [DIAGNOSTICS_PROVIDER]: [...DIAGNOSTICS_WRITABLE_CREDENTIAL_KEYS],
  // Alpine Central Server (ServerNZ) API key: a single write-only secret, Full
  // Admin. No verify-reset marker; the needs-reentry state is derived live from
  // the encrypted store. Reachable whether or not the module is enabled so the
  // key can be entered during setup.
  [SERVERNZ_PROVIDER]: [...SERVERNZ_WRITABLE_CREDENTIAL_KEYS],
};

// GET /api/admin/integrations/credentials?provider=xero — METADATA-ONLY status.
//
// Any admin may read the set/not-set status so area admins keep visibility
// (epic decision 4); only Full Admins can WRITE (POST below). The response
// carries NO value or ciphertext/iv/authTag — only whether each key is set, its
// set-at timestamp, and secretSource. Exposure contract (#2079).
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const provider = new URL(request.url).searchParams.get("provider") ?? "";
  const allowedKeys = WRITABLE_CREDENTIALS[provider];
  if (!allowedKeys) {
    return NextResponse.json(
      { error: "Unknown provider." },
      { status: 400 },
    );
  }

  // Select METADATA COLUMNS ONLY — never ciphertext/iv/authTag/value.
  const rows = await prisma.integrationCredential.findMany({
    where: { provider, key: { in: [...allowedKeys] } },
    select: { key: true, secretSource: true, updatedAt: true },
  });

  const credentials: Record<
    string,
    { set: boolean; setAt: string; secretSource: string }
  > = {};
  for (const row of rows) {
    credentials[row.key] = {
      set: true,
      setAt: row.updatedAt.toISOString(),
      secretSource: row.secretSource,
    };
  }

  return NextResponse.json({ provider, credentials });
}

const bodySchema = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
  // A credential value; capped to a sane length. Never logged, never returned.
  value: z.string().min(1).max(4096),
});

async function requireFullAdmin() {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false as const, response: guard.response };
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Full admin access is required." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, memberId: guard.session.user.id };
}

/**
 * Verify-reset (epic decision 6): a credential write clears the provider's
 * verified/connected state and re-arms verification. For Xero, changing the
 * client id/secret invalidates the OAuth app the stored tokens belong to, so
 * the tokens are dropped and the operator must reconnect. Changing only the
 * webhook key does NOT drop tokens (that surfaces as a webhook amber badge in a
 * later lane).
 */
async function applyVerifyReset(provider: string, key: string): Promise<void> {
  if (
    provider === XERO_PROVIDER &&
    (key === XERO_CREDENTIAL_KEYS.clientId ||
      key === XERO_CREDENTIAL_KEYS.clientSecret)
  ) {
    await deleteXeroTokens();
  }
  // Stripe (epic decision 6): writing ANY Stripe credential — secret,
  // publishable, or the signing secret — drops the webhook-verified marker so a
  // green webhook badge can never survive a credential swap. The connection
  // check itself is live-derived (no persisted verified flag to reset).
  if (provider === STRIPE_PROVIDER) {
    await clearStripeWebhookVerified();
  }
  // Google (epic decision 6 / D2): writing either Google credential drops the
  // verified marker so the module re-locks until a fresh OAuth round-trip
  // verifies. The verified state is a stored marker (no live-derived check).
  if (provider === GOOGLE_PROVIDER) {
    await clearGoogleVerified();
  }
}

export async function POST(request: Request) {
  const guard = await requireFullAdmin();
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

  const { provider, key, value } = parsed.data;
  const allowedKeys = WRITABLE_CREDENTIALS[provider];
  if (!allowedKeys || !allowedKeys.includes(key)) {
    return NextResponse.json(
      { error: "Unknown provider or credential key." },
      { status: 400 },
    );
  }

  // Capture-time gate for the restore-validation DSN (#2095 MAJOR-2): it carries
  // a password passed to psql, so it must be a parseable postgres:// URI. A
  // keyword-form conninfo or malformed URI would keep the password on argv (and
  // in any persisted error), so it is rejected with a clear message here.
  if (
    provider === BACKUP_PROVIDER &&
    key === BACKUP_CREDENTIAL_KEYS.restoreValidationUrl &&
    !isValidRestoreValidationUrl(value)
  ) {
    return NextResponse.json(
      {
        error:
          "The restore-validation URL must be a postgres:// or postgresql:// connection URI (for example postgresql://user:password@host:5432/shadow_db).",
      },
      { status: 400 },
    );
  }

  let result;
  try {
    // The store writes the audit row itself, inside the same transaction as the
    // secret (#2723) — this route used to write it two awaits later, so a crash
    // in between left a rewritten credential with no evidence of who did it.
    // The request context travels in so the row keeps its id, IP and user agent.
    result = await setIntegrationCredential({
      provider,
      key,
      value,
      actor: { kind: "admin", memberId: guard.memberId },
      // The form posts the value it wants stored; there is no read-modify-write
      // here for a second Full Admin to make stale.
      expect: { expect: "any" },
      request: getAuditRequestContext(request),
    });
  } catch (error) {
    if (error instanceof WeakAuthSecretError) {
      // Plain-English capture-time gate message; safe to surface (no secret).
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Never echo the request body / value in the error.
    logger.error(
      { provider, key, err: error instanceof Error ? error.name : "unknown" },
      "Failed to store integration credential",
    );
    return NextResponse.json(
      { error: "Could not store the credential." },
      { status: 500 },
    );
  }

  await applyVerifyReset(provider, key);

  // Response confirms metadata only — the value is never returned.
  return NextResponse.json({
    ok: true,
    provider: result.provider,
    key: result.key,
    setAt: result.updatedAt.toISOString(),
  });
}
