/**
 * Operational AI help assistant configuration — DB-only resolution (#2211,
 * epic #2094 C3).
 *
 * The Anthropic API key lives ONLY in the encrypted IntegrationCredential store
 * (C1, #2079) under provider "anthropic", key "api_key". There is no
 * `ANTHROPIC_API_KEY` env var read for operation — the key is entered in-app on
 * Admin → Integrations and resolved async (a DB fetch, cache-backed by
 * integration-credentials.ts).
 *
 * Exposure contract (#2079): the API key is NEVER returned to a client, logged,
 * or put in an audit row. Setup surfaces read metadata-only state. The key is
 * the highest-privilege secret in this lane — it authorises paid model spend —
 * so it is treated exactly like the Stripe secret key.
 *
 * Deliberate asymmetry vs googleLogin (epic decision): the module toggle has NO
 * enable-gate on a present/verified key. googleLogin locks until a real OAuth
 * round-trip verifies because an unconfigured Google provider renders a visibly
 * broken sign-in path; the AI assistant instead degrades to a structured
 * "not_configured" fallback at the /api/help/chat route, so enabling the module
 * without a key is harmless (curated page help still works). No verify-ping
 * endpoint is shipped (cut per plan option).
 */

import type { IntegrationCredentialNamespace } from "@/lib/integration-credential-namespaces";
import { prisma } from "@/lib/prisma";
import {
  getIntegrationCredentialValue,
  providerNeedsReentry,
} from "@/lib/integration-credentials";

export const ANTHROPIC_PROVIDER = "anthropic" satisfies IntegrationCredentialNamespace;

export const ANTHROPIC_CREDENTIAL_KEYS = {
  apiKey: "api_key",
} as const;

/** The one write-capturable Anthropic credential key (wizard + API allowlist). */
export const ANTHROPIC_WRITABLE_CREDENTIAL_KEYS = [
  ANTHROPIC_CREDENTIAL_KEYS.apiKey,
] as const;

/**
 * The operational Anthropic API key, or `undefined` when the AI assistant is
 * not usable. Returns `undefined` for BOTH not_configured (no key stored) AND
 * needs_reentry (a stored key that fails GCM after an auth-secret rotation) —
 * `getIntegrationCredentialValue` already collapses those to null, so a
 * needs-reentry key can never be handed to the paid provider.
 */
export async function getOperationalAnthropicApiKey(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      ANTHROPIC_PROVIDER,
      ANTHROPIC_CREDENTIAL_KEYS.apiKey,
    )) ?? undefined
  );
}

/** Canonical setup state for the AI assistant key (metadata only). */
export type AiAssistantKeyState = "not_configured" | "saved" | "needs_reentry";

export interface AiAssistantSetupState {
  state: AiAssistantKeyState;
  /** ISO timestamp the key was last written, or null when unconfigured. */
  keySetAt: string | null;
}

/**
 * Metadata-only setup state for the setup/status surfaces and the module
 * availability check. NEVER returns the key value. `saved` means a key is
 * stored AND decrypts; `needs_reentry` means a stored key fails GCM (the auth
 * secret changed) — the shared re-entry aggregate detection path
 * (`providerNeedsReentry`) drives it, so this provider joins the unified
 * "N integrations need credentials re-entered" surface uniformly. A DB error
 * propagates to the caller (which decides how to degrade).
 */
export async function getAiAssistantSetupState(): Promise<AiAssistantSetupState> {
  const [row, needsReentry] = await Promise.all([
    prisma.integrationCredential.findUnique({
      where: {
        provider_key: {
          provider: ANTHROPIC_PROVIDER,
          key: ANTHROPIC_CREDENTIAL_KEYS.apiKey,
        },
      },
      select: { updatedAt: true },
    }),
    providerNeedsReentry(ANTHROPIC_PROVIDER),
  ]);

  const state: AiAssistantKeyState = !row
    ? "not_configured"
    : needsReentry
      ? "needs_reentry"
      : "saved";

  return { state, keySetAt: row?.updatedAt.toISOString() ?? null };
}

/**
 * Whether the AI assistant is available to answer free-text questions: the
 * module is enabled AND a usable (saved, decryptable) key is stored. Consumed by
 * C4 layouts to decide whether to render the free-text ask box. Deliberately
 * does NOT check the monthly budget — a budget-exhausted deployment still shows
 * the box and returns a structured "budget_exhausted" fallback at request time,
 * so the availability signal stays a stable capability flag.
 */
export async function getAiAssistantAvailability(modules: {
  aiAssistant: boolean;
}): Promise<boolean> {
  if (!modules.aiAssistant) return false;
  const { state } = await getAiAssistantSetupState();
  return state === "saved";
}
