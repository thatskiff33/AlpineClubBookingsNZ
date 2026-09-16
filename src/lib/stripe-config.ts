/**
 * Operational Stripe configuration — DB-only resolution (#2082, Lane D).
 *
 * The Stripe secret key, publishable key, and webhook signing secret live ONLY
 * in the encrypted IntegrationCredential store (C1, #2079). The legacy
 * `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` env vars are no longer read for
 * operation — they are detected and flagged for removal (see
 * `detectLegacyProviderEnv` in xero-config.ts). Resolution is async (a DB fetch,
 * cache-backed by integration-credentials.ts).
 *
 * Exposure contract (#2079): the secret key and webhook secret are NEVER
 * returned to a client, logged, or put in an audit row. The PUBLISHABLE key is
 * the one value that may travel to the browser (it is not secret) — but even
 * that is delivered at runtime from the store, never inlined at build time.
 */

import { prisma } from "@/lib/prisma";
import {
  deleteIntegrationCredential,
  getIntegrationCredentialValue,
  providerNeedsReentry,
  setIntegrationCredential,
} from "@/lib/integration-credentials";
import type {
  CredentialActor,
  CredentialRequestContext,
} from "@/lib/integration-credential-actor";

export const STRIPE_PROVIDER = "stripe";

export const STRIPE_CREDENTIAL_KEYS = {
  secretKey: "secret_key",
  publishableKey: "publishable_key",
  webhookSecret: "webhook_secret",
} as const;

/** The three write-capturable Stripe credential keys (wizard + API allowlist). */
export const STRIPE_WRITABLE_CREDENTIAL_KEYS = [
  STRIPE_CREDENTIAL_KEYS.secretKey,
  STRIPE_CREDENTIAL_KEYS.publishableKey,
  STRIPE_CREDENTIAL_KEYS.webhookSecret,
] as const;

/**
 * Non-secret marker key recording that a Stripe TEST-MODE webhook event was
 * received AND signature-verified through the exact production resolver/HMAC
 * path. Stored in the same encrypted store (its value is an ISO timestamp — not
 * secret) so verify-reset and the needs-reentry aggregate treat it uniformly.
 * It is NEVER in the credential write allowlist — only the webhook route writes
 * it, and it is dropped by verify-reset whenever any Stripe credential changes.
 */
export const STRIPE_WEBHOOK_VERIFIED_KEY = "webhook_verified";

// ---------------------------------------------------------------------------
// Operational resolvers (async DB fetch, C1 cache-backed)
// ---------------------------------------------------------------------------

/** The operational Stripe secret key, or `undefined` when unconfigured. */
export async function getOperationalStripeSecretKey(): Promise<string | undefined> {
  return (
    (await getIntegrationCredentialValue(
      STRIPE_PROVIDER,
      STRIPE_CREDENTIAL_KEYS.secretKey,
    )) ?? undefined
  );
}

/** The operational Stripe publishable key, or `undefined` when unconfigured. */
export async function getOperationalStripePublishableKey(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      STRIPE_PROVIDER,
      STRIPE_CREDENTIAL_KEYS.publishableKey,
    )) ?? undefined
  );
}

/**
 * Dedicated resolver for the Stripe webhook signing secret. Async DB fetch;
 * returns `undefined` when unconfigured. The webhook route stays FAIL-CLOSED on
 * a missing/unreadable secret (no secret ⇒ reject, never accept), exactly per
 * the C1 webhook-key rule.
 */
export async function getOperationalStripeWebhookSecret(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      STRIPE_PROVIDER,
      STRIPE_CREDENTIAL_KEYS.webhookSecret,
    )) ?? undefined
  );
}

// ---------------------------------------------------------------------------
// Webhook-verified marker (freshness-scoped, verify-reset on credential change)
// ---------------------------------------------------------------------------

/**
 * THE FRESHNESS RULE, one home. A verified marker counts only while it is at
 * least as new as the credential it attests to; a signing-secret swap makes the
 * secret newer and the marker stops counting even before verify-reset physically
 * removes it. `getStripeSetupState` reports it and `recordStripeWebhookVerified`
 * decides whether there is anything to record, so it is written once.
 */
function markerIsFresh(
  markerAt: Date | undefined,
  attestedAt: Date | undefined,
): boolean {
  return Boolean(
    markerAt && attestedAt && markerAt.getTime() >= attestedAt.getTime(),
  );
}

/** The two `updatedAt`s the freshness rule needs, in one query. */
async function readWebhookMarkerFreshness(): Promise<{
  markerAt: Date | undefined;
  secretAt: Date | undefined;
}> {
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: STRIPE_PROVIDER,
      key: {
        in: [STRIPE_CREDENTIAL_KEYS.webhookSecret, STRIPE_WEBHOOK_VERIFIED_KEY],
      },
    },
    select: { key: true, updatedAt: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.updatedAt]));
  return {
    markerAt: byKey.get(STRIPE_WEBHOOK_VERIFIED_KEY),
    secretAt: byKey.get(STRIPE_CREDENTIAL_KEYS.webhookSecret),
  };
}

/**
 * Record that a Stripe TEST-MODE webhook event verified. Best-effort: a weak
 * auth secret (WeakAuthSecretError) or any store error must NEVER break webhook
 * processing, so this swallows failures.
 *
 * IT WRITES ONLY WHEN THE ANSWER WOULD CHANGE (#2723). The webhook route calls
 * this on EVERY signature-verified test-mode event, before idempotency handling,
 * so a replay or a retry storm arrives here many times over. Since #2723 every
 * credential mutation mints a `security`/`important` audit row, which is kept
 * for seven years — and a row per delivery of a freshness timestamp buries the
 * secret changes an operator actually came to the log for. This is the same
 * reasoning that keeps a no-op delete out of the log.
 *
 * So the marker is stamped when it is missing or stale, and skipped when it is
 * already fresh. Nothing observable changes: the only reader is the freshness
 * rule above, which cannot tell "stamped once after the secret was written" from
 * "re-stamped on every event since". Verify-reset deletes the marker on any
 * credential write, so the next event after a swap re-stamps it — exactly one
 * audit row per genuine verification, instead of one per delivery.
 */
export async function recordStripeWebhookVerified(
  when: Date = new Date(),
): Promise<void> {
  try {
    const { markerAt, secretAt } = await readWebhookMarkerFreshness();
    if (markerIsFresh(markerAt, secretAt)) return;
    await setIntegrationCredential({
      provider: STRIPE_PROVIDER,
      key: STRIPE_WEBHOOK_VERIFIED_KEY,
      value: when.toISOString(),
      actor: { kind: "system", actor: "stripe-webhook-verify" },
      // Latest-wins by design, and this is the marker's only writer (#2723).
      expect: { expect: "any" },
    });
  } catch {
    // Never let marker persistence affect the webhook response.
  }
}

/**
 * Drop the webhook-verified marker (verify-reset on any Stripe credential write).
 *
 * THE ACTOR IS THE CALLER'S, and required — see `clearGoogleVerified` for the
 * reasoning. The one caller is the admin credential-write route, and this clear
 * is part of that administrator's action, not a background job's.
 */
export async function clearStripeWebhookVerified(
  actor: CredentialActor,
  request?: CredentialRequestContext,
): Promise<void> {
  await deleteIntegrationCredential({
    provider: STRIPE_PROVIDER,
    key: STRIPE_WEBHOOK_VERIFIED_KEY,
    actor,
    // As for Google: the credential the marker attested to has changed, so a
    // marker re-stamped meanwhile must go too.
    expect: { expect: "any" },
    request,
  });
}

export interface StripeSetupState {
  /** Secret key stored (metadata only — never the value). */
  secretKeySet: boolean;
  /** Publishable key stored. */
  publishableKeySet: boolean;
  /** Webhook signing secret stored. */
  webhookSecretSet: boolean;
  /** Any stored Stripe credential fails to decrypt (the auth secret changed). */
  needsReentry: boolean;
  /**
   * A webhook test event verified AND the marker is fresh — i.e. it was recorded
   * at or after the current webhook secret was last written. A signing-secret
   * swap makes the secret newer than the marker, so the badge drops to amber
   * even before verify-reset physically removes the marker.
   */
  webhookVerified: boolean;
}

/**
 * Metadata-only Stripe setup state for the wizard/status surfaces and readiness.
 * NEVER returns any credential value. A DB error propagates to the caller (which
 * decides how to degrade). The webhook-verified freshness rule is applied here so
 * every surface agrees.
 */
export async function getStripeSetupState(): Promise<StripeSetupState> {
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: STRIPE_PROVIDER,
      key: {
        in: [
          STRIPE_CREDENTIAL_KEYS.secretKey,
          STRIPE_CREDENTIAL_KEYS.publishableKey,
          STRIPE_CREDENTIAL_KEYS.webhookSecret,
          STRIPE_WEBHOOK_VERIFIED_KEY,
        ],
      },
    },
    select: { key: true, updatedAt: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.updatedAt]));

  const webhookVerified = markerIsFresh(
    byKey.get(STRIPE_WEBHOOK_VERIFIED_KEY),
    byKey.get(STRIPE_CREDENTIAL_KEYS.webhookSecret),
  );

  return {
    secretKeySet: byKey.has(STRIPE_CREDENTIAL_KEYS.secretKey),
    publishableKeySet: byKey.has(STRIPE_CREDENTIAL_KEYS.publishableKey),
    webhookSecretSet: byKey.has(STRIPE_CREDENTIAL_KEYS.webhookSecret),
    needsReentry: await providerNeedsReentry(STRIPE_PROVIDER),
    webhookVerified,
  };
}
