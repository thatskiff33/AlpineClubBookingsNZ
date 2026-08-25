/**
 * Operational Xero configuration — DB-only resolution (#2079).
 *
 * Xero client id/secret, the webhook key, and the wrapped token-encryption key
 * all live ONLY in the encrypted IntegrationCredential store. The legacy
 * `XERO_*` credential env vars are no longer read for operation — they are
 * detected and flagged for removal (see detectLegacyProviderEnv). The OAuth
 * redirect URI derives from NEXTAUTH_URL (no localhost fallback).
 *
 * Resolution is async (a DB fetch, cache-backed by integration-credentials.ts);
 * key derivation itself stays synchronous.
 */

import { randomBytes } from "crypto";
import {
  ensureGeneratedCredential,
  getIntegrationCredentialValue,
  resolveIntegrationCredential,
} from "@/lib/integration-credentials";
import { readEnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
import { XERO_TOKEN_KEY_LABEL } from "@/lib/integration-crypto";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const XERO_PROVIDER = "xero";
export const XERO_CREDENTIAL_KEYS = {
  clientId: "client_id",
  clientSecret: "client_secret",
  webhookKey: "webhook_key",
  tokenKey: "token_key",
} as const;

export const XERO_REPORT_OAUTH_SCOPES = {
  profitAndLoss: "accounting.reports.profitandloss.read",
  balanceSheet: "accounting.reports.balancesheet.read",
  bankSummary: "accounting.reports.banksummary.read",
} as const;

export const XERO_REQUIRED_REPORT_OAUTH_SCOPES = Object.values(
  XERO_REPORT_OAUTH_SCOPES,
);

const OPERATIONAL_XERO_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
  // Required by the finance dashboard sync. Existing tokens keep their old
  // scopes until Xero is reconnected from the admin panel, so a one-time
  // re-consent is needed when this list changes.
  ...XERO_REQUIRED_REPORT_OAUTH_SCOPES,
  "offline_access",
] as const;

const XERO_CALLBACK_PATH = "/api/admin/xero/callback";

// xero-node defaults its OAuth-layer HTTP timeout (identity.xero.com
// discovery and token requests) to 3500ms, which is tight enough that a
// routine slow round trip fails the whole client build.
const DEFAULT_XERO_HTTP_TIMEOUT_MS = 10_000;

function getXeroHttpTimeoutMs(): number {
  // Operational tuning, not a credential — stays an env var.
  const raw = readEnv("XERO_HTTP_TIMEOUT_MS");
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_XERO_HTTP_TIMEOUT_MS;
}

/**
 * Derive the Xero OAuth redirect URI from NEXTAUTH_URL: `{origin}{callback}`.
 * Returns "" when NEXTAUTH_URL is absent/invalid (the config is then plainly
 * unconfigured — never a silent localhost fallback that would break a real
 * deployment).
 */
export function getOperationalXeroRedirectUri(): string {
  const nextAuthUrl = readEnv("NEXTAUTH_URL");
  if (!nextAuthUrl) return "";
  try {
    return `${new URL(nextAuthUrl).origin}${XERO_CALLBACK_PATH}`;
  } catch {
    return "";
  }
}

/**
 * True only for an https:// origin whose host is not localhost/loopback — the
 * single condition under which Xero can actually deliver a webhook (and its
 * intent-to-receive ping) to this deployment. Shared by the setup page and the
 * webhook verify-status route so the wizard step and the persistent amber badge
 * agree on whether webhooks are verifiable here.
 */
export function isPublicHttpsOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      host !== "[::1]" &&
      !host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Whether this deployment can verify Xero webhooks at all: derived from the
 * NEXTAUTH_URL-backed redirect origin (public HTTPS, non-localhost). When false,
 * a webhook key can be stored but the intent-to-receive ping can never arrive,
 * so the wizard defaults to Skip and the badge softens to an informational note.
 *
 * The mock-Xero E2E harness is the deliberate exception: its ITR trigger POSTs
 * the real webhook route from inside the container, so no public HTTPS origin
 * is needed — with the mock active (never in a real deployment), webhooks are
 * verifiable and the wizard's verify path is exercised end to end.
 */
function xeroMockHarnessActive(): boolean {
  // Mirrors isXeroMockActive() (xero-mock-endpoint.ts) — duplicated here
  // because importing it would form the cycle xero-config -> xero-mock-endpoint
  // -> xero-token-store -> xero-config. Same double gate: env origin set AND
  // not a real production runtime.
  //
  // The DECLARATION half is not duplicated — both copies read the one canonical
  // parser, which is a leaf and forms no cycle (ENV-SAFETY 3, #3036;
  // INV-CONFIG-003). What remains duplicated is the build-mode/slot-name
  // backstop underneath it; see `isRealProductionRuntime` for why that backstop
  // stays rather than being collapsed onto the resolver.
  if (readEnvironmentRoleDeclaration().kind === "production") return false;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.APP_RUNTIME_ROLE !== "staging"
  ) {
    return false;
  }
  return Boolean(process.env.XERO_MOCK_API_ORIGIN?.trim());
}

export function getXeroWebhooksVerifiable(): boolean {
  if (xeroMockHarnessActive()) return true;
  const redirectUri = getOperationalXeroRedirectUri();
  const origin = redirectUri ? new URL(redirectUri).origin : "";
  return isPublicHttpsOrigin(origin);
}

export interface OperationalXeroConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  scopes: string[];
  httpTimeout: number;
}

/**
 * Operational Xero client config, resolved from the DB. Missing credentials
 * resolve to "" (an unconfigured client that constructs but cannot connect),
 * mirroring the previous env-absent behaviour.
 */
export async function getOperationalXeroConfig(): Promise<OperationalXeroConfig> {
  const [clientId, clientSecret] = await Promise.all([
    getIntegrationCredentialValue(XERO_PROVIDER, XERO_CREDENTIAL_KEYS.clientId),
    getIntegrationCredentialValue(
      XERO_PROVIDER,
      XERO_CREDENTIAL_KEYS.clientSecret,
    ),
  ]);
  return {
    clientId: clientId ?? "",
    clientSecret: clientSecret ?? "",
    redirectUris: [getOperationalXeroRedirectUri()],
    scopes: [...OPERATIONAL_XERO_OAUTH_SCOPES],
    httpTimeout: getXeroHttpTimeoutMs(),
  };
}

/**
 * The operational Xero token-encryption key (64-hex / 32 bytes) used by
 * xero-token-store to encrypt OAuth tokens at rest. It is a random 32-byte key
 * WRAPPED under the HKDF-derived `xero-token-key:v1` key and stored in the
 * credential table — so `XERO_ENCRYPTION_KEY` no longer exists.
 *
 * Auto-generates on first use when the strength gate permits (the very act of
 * encrypting/decrypting Xero tokens means Xero is in use); returns `undefined`
 * when the gate blocks — token-key generation NO-OPS, it never throws. When the
 * key is unreadable after an auth-secret change it is replaced with a fresh one
 * so a reconnect can proceed (the tokens it protected are already unrecoverable
 * by design — no silent import of the dropped env key).
 */
export async function getOperationalXeroEncryptionKey(): Promise<
  string | undefined
> {
  const value = await ensureGeneratedCredential({
    provider: XERO_PROVIDER,
    key: XERO_CREDENTIAL_KEYS.tokenKey,
    label: XERO_TOKEN_KEY_LABEL,
    generate: () => randomBytes(32).toString("hex"),
  });
  return value ?? undefined;
}

/**
 * Read the stored Xero token-encryption key WITHOUT ever generating one. For
 * side-effect-free status/readiness checks (a status read must never mutate the
 * DB, unlike getOperationalXeroEncryptionKey which regenerates a dead key).
 * Returns `undefined` when the key is missing OR unreadable (auth secret
 * changed) — the caller then reports the tokens as needing re-entry. The value
 * is only ever used server-side to test-decrypt a token row; it is never
 * returned to a client.
 */
export async function peekOperationalXeroEncryptionKey(): Promise<
  string | undefined
> {
  const resolution = await resolveIntegrationCredential(
    XERO_PROVIDER,
    XERO_CREDENTIAL_KEYS.tokenKey,
  );
  return resolution.status === "configured" ? resolution.value : undefined;
}

/**
 * Dedicated resolver for the Xero webhook HMAC key. Async DB fetch; returns
 * `undefined` when unconfigured. The webhook route stays FAIL-CLOSED on a
 * missing key (no key ⇒ reject, never accept).
 */
export async function getOperationalXeroWebhookKey(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      XERO_PROVIDER,
      XERO_CREDENTIAL_KEYS.webhookKey,
    )) ?? undefined
  );
}

// ---------------------------------------------------------------------------
// Legacy provider env detection (extensible — C4/C5/C6 add their names)
// ---------------------------------------------------------------------------

/**
 * Provider credential env vars that are NO LONGER honoured. Detected so a loud
 * readiness warning can name the exact vars ("configured in-app now — re-enter
 * there, then remove these from the environment"). Never read for operation.
 * NOTE: bootstrap-class vars (AUTH_SECRET, DATABASE_URL, NEXTAUTH_URL, SMTP/SES)
 * are out of scope and must never appear here.
 */
export const LEGACY_PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  xero: [
    "XERO_CLIENT_ID",
    "XERO_CLIENT_SECRET",
    "XERO_ENCRYPTION_KEY",
    "XERO_WEBHOOK_KEY",
    "XERO_REDIRECT_URI",
  ],
  // Stripe credentials are captured in-app now (#2082); the publishable key is
  // delivered at runtime from the store, so its old NEXT_PUBLIC_* build-time var
  // is legacy too. All three are detected-and-warned, never read for operation.
  stripe: [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  ],
  // Google sign-in credentials are captured in-app now (#2087). The two legacy
  // GOOGLE_CLIENT_* vars are detected-and-warned, never read for operation.
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  // Backup configuration moved to the encrypted store in-app (#2095, C6); every
  // BACKUP_* value is detected-and-warned, never read for operation. The ONE
  // exception is BACKUP_CRON_SCHEDULE (cron-leader timing, not club config),
  // which stays in the environment and is deliberately absent from this list.
  backup: [
    "BACKUP_ENABLED",
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_REGION",
    "BACKUP_S3_ACCESS_KEY_ID",
    "BACKUP_S3_SECRET_ACCESS_KEY",
    "BACKUP_RETENTION_DAYS",
    "BACKUP_RESTORE_VALIDATION_URL",
  ],
};

export interface LegacyProviderEnvFinding {
  provider: string;
  vars: string[];
}

/**
 * Which providers still have legacy credential env vars set, and exactly which
 * vars. Pure — reads from the supplied env (defaults to process.env). Empty
 * when nothing legacy is present.
 */
export function detectLegacyProviderEnv(
  env: Record<string, string | undefined> = process.env,
): LegacyProviderEnvFinding[] {
  const findings: LegacyProviderEnvFinding[] = [];
  for (const [provider, names] of Object.entries(LEGACY_PROVIDER_ENV_VARS)) {
    const present = names.filter((name) => {
      const value = env[name]?.trim();
      return Boolean(value);
    });
    if (present.length > 0) findings.push({ provider, vars: present });
  }
  return findings;
}
