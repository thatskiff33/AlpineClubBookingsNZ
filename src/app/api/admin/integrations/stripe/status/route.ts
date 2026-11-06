import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { getStripe } from "@/lib/stripe";
import { getStripeSetupState } from "@/lib/stripe-config";
import logger from "@/lib/logger";

// GET /api/admin/integrations/stripe/status — metadata-only Stripe setup state.
//
// Any admin may read status so area admins keep visibility (epic decision 4);
// only Full Admins can WRITE credentials (the C1 credentials API). This route
// NEVER returns any credential value — only booleans, the connected account's
// DISPLAY name/email (the right-account confirmation, safe to show), and the
// freshness-scoped webhook-verified flag. Exposure contract (#2079).

const ACCOUNT_LOOKUP_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Stripe account lookup timed out")), ms),
    ),
  ]);
}

interface StripeAccountSummary {
  connected: boolean;
  accountName: string | null;
  accountEmail: string | null;
}

/**
 * Live right-account confirmation: retrieve the Stripe account the secret key
 * belongs to and surface a human-readable name. Never throws — a bad/inactive
 * key simply reads as not connected. No secret material is returned.
 */
async function resolveConnectedAccount(): Promise<StripeAccountSummary> {
  try {
    const stripe = await getStripe();
    const account = await withTimeout(
      stripe.accounts.retrieveCurrent(),
      ACCOUNT_LOOKUP_TIMEOUT_MS,
    );
    const displayName =
      account.settings?.dashboard?.display_name ??
      account.business_profile?.name ??
      account.email ??
      account.id;
    return {
      connected: true,
      accountName: displayName ?? null,
      accountEmail: account.email ?? null,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.name : "unknown" },
      "Stripe account lookup failed",
    );
    return { connected: false, accountName: null, accountEmail: null };
  }
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let state;
  try {
    state = await getStripeSetupState();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "Failed to resolve Stripe setup state",
    );
    return NextResponse.json(
      { error: "Could not resolve Stripe status." },
      { status: 500 },
    );
  }

  // Only attempt the live account read when a readable secret key exists. An
  // unreadable webhook secret alone does not stop it (#98).
  const account =
    state.secretKeySet && !state.keysNeedReentry
      ? await resolveConnectedAccount()
      : { connected: false, accountName: null, accountEmail: null };

  return NextResponse.json({
    secretKeySet: state.secretKeySet,
    publishableKeySet: state.publishableKeySet,
    webhookSecretSet: state.webhookSecretSet,
    needsReentry: state.needsReentry,
    keysNeedReentry: state.keysNeedReentry,
    webhookSecretNeedsReentry: state.webhookSecretNeedsReentry,
    connected: account.connected,
    accountName: account.accountName,
    accountEmail: account.accountEmail,
    webhookVerified: state.webhookVerified,
  });
}
