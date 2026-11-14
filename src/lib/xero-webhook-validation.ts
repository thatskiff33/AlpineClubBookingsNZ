/**
 * Xero webhook intent-to-receive (ITR) receipt sink + freshness-scoped verify
 * (#2081, C3).
 *
 * Xero validates a new webhook subscription with an "intent to receive" request:
 * a POST whose body carries an EMPTY `events: []` array, signed with the webhook
 * signing key. The receiver must echo a 200 when the HMAC matches (401
 * otherwise). Because the per-event inbound-event recorder only runs inside the
 * per-event loop, a valid ITR ping would otherwise leave NO observable trace —
 * so the setup wizard could never prove the round-trip worked.
 *
 * This module is that observable trace: on a valid-signature empty-events POST
 * the webhook route records a marker (one row per provider) stamped with the
 * receipt time AND a non-reversible fingerprint of the webhook key that signed
 * it. The wizard then polls a verify endpoint that goes green ONLY when:
 *
 *   1. a marker exists whose `keyFingerprint` matches the CURRENTLY stored
 *      webhook key (so a marker recorded under a previous/replaced key can never
 *      satisfy a new verify — replacing the key re-arms verification), AND
 *   2. that marker's `validatedAt` is strictly newer than the operator's
 *      server-issued verify-start instant (so a stale marker from an EARLIER
 *      verification can never satisfy a fresh verify — the green state always
 *      corresponds to a live round-trip the operator just triggered).
 *
 * PRODUCTION-PARITY: the marker is written by the real `/api/webhooks/xero`
 * route after its real `getOperationalXeroWebhookKey()` resolve + HMAC check, so
 * a green verify provably exercises the same resolver/HMAC path production uses.
 *
 * EXPOSURE CONTRACT (#2079): the webhook key is NEVER stored or returned here —
 * only its SHA-256 fingerprint is persisted, and only booleans/timestamps leave
 * the server.
 */

import type { IntegrationCredentialNamespace } from "@/lib/integration-credential-namespaces";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { getOperationalXeroWebhookKey } from "@/lib/xero-config";

/** Provider namespace for the Xero ITR marker row. */
export const XERO_WEBHOOK_PROVIDER = "xero" satisfies IntegrationCredentialNamespace;

/**
 * The verify poll window must comfortably exceed C1's credential cache TTL
 * (CACHE_TTL_MS = 45s in integration-credentials.ts). After a webhook-key write
 * in one web slot, another web slot or the cron-leader may still hold the old
 * (or absent) key for up to that TTL, so a valid ITR delivered to a cold process
 * can be briefly rejected until its cache expires. A window well past the TTL
 * ensures a genuine round-trip still lands green. 30 polls x 3s = 90s > 45s.
 */
export const WEBHOOK_VERIFY_POLL_INTERVAL_MS = 3_000;
export const WEBHOOK_VERIFY_MAX_POLLS = 30;
export const WEBHOOK_VERIFY_WINDOW_MS =
  WEBHOOK_VERIFY_POLL_INTERVAL_MS * WEBHOOK_VERIFY_MAX_POLLS;

/**
 * Non-reversible fingerprint of a webhook key. SHA-256 over a domain-separated
 * label + the key, hex-encoded. Used to bind an ITR marker to a key identity
 * without ever persisting or exposing the key itself.
 */
export function computeWebhookKeyFingerprint(webhookKey: string): string {
  return createHash("sha256")
    .update(`xero-webhook-key-fingerprint:v1:${webhookKey}`)
    .digest("hex");
}

/**
 * Record (upsert) the ITR marker for the current webhook key. Called by the
 * webhook route ONLY after a valid-signature empty-events POST. Idempotent: one
 * row per provider, its `validatedAt`/`keyFingerprint` overwritten each time.
 */
export async function recordXeroWebhookValidation(
  webhookKey: string,
  now: Date = new Date(),
): Promise<void> {
  const keyFingerprint = computeWebhookKeyFingerprint(webhookKey);
  await prisma.webhookValidationReceipt.upsert({
    where: { provider: XERO_WEBHOOK_PROVIDER },
    create: {
      provider: XERO_WEBHOOK_PROVIDER,
      validatedAt: now,
      keyFingerprint,
    },
    update: {
      validatedAt: now,
      keyFingerprint,
    },
  });
}

/**
 * Freshness-scoped verify check — the single source for BOTH the wizard's Verify
 * poll and the persistent amber badge (via one endpoint, one DB read).
 *
 *   - `verified` is the persistent badge state: a marker matches the CURRENTLY
 *     stored key's fingerprint (replacing the key flips this to false = re-arm).
 *     Freshness-by-time is NOT applied to it — the badge reflects the standing
 *     subscription state.
 *   - `freshVerified` is the per-verify gate: green ONLY when the key matches AND
 *     the marker was recorded strictly after `sinceMs` (the server-issued
 *     verify-start), so a stale marker can never satisfy a fresh verify.
 *
 * `serverNow` lets the client anchor verify-start to the server clock rather
 * than its own; `keyMatches`/`lastValidatedAt` are for diagnostics.
 */
export interface XeroWebhookFreshVerifyResult {
  webhookKeyConfigured: boolean;
  /** Persistent match (key fingerprint) — independent of freshness. */
  verified: boolean;
  /** Fresh match: key matches AND marker is newer than sinceMs. */
  freshVerified: boolean;
  keyMatches: boolean;
  lastValidatedAt: string | null;
  serverNow: number;
}

export async function checkXeroWebhookFreshVerify(
  sinceMs: number | null,
  now: number = Date.now(),
): Promise<XeroWebhookFreshVerifyResult> {
  const [webhookKey, receipt] = await Promise.all([
    getOperationalXeroWebhookKey(),
    prisma.webhookValidationReceipt.findUnique({
      where: { provider: XERO_WEBHOOK_PROVIDER },
    }),
  ]);

  if (!webhookKey) {
    return {
      webhookKeyConfigured: false,
      verified: false,
      freshVerified: false,
      keyMatches: false,
      lastValidatedAt: null,
      serverNow: now,
    };
  }

  const fingerprint = computeWebhookKeyFingerprint(webhookKey);
  const keyMatches =
    Boolean(receipt) && receipt!.keyFingerprint === fingerprint;
  const fresh =
    keyMatches &&
    sinceMs !== null &&
    receipt!.validatedAt.getTime() > sinceMs;

  return {
    webhookKeyConfigured: true,
    verified: keyMatches,
    freshVerified: fresh,
    keyMatches,
    lastValidatedAt: keyMatches ? receipt!.validatedAt.toISOString() : null,
    serverNow: now,
  };
}
