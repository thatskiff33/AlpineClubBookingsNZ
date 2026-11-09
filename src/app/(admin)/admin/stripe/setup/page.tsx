import Link from "next/link";
import { detectLegacyProviderEnv } from "@/lib/xero-config";
import { BackLink } from "@/components/admin/back-link";
import { STRIPE_PROVIDER } from "@/lib/stripe-config";
import { StripeSetupWizard } from "./stripe-setup-wizard";

import { adminHref } from "@/lib/admin-hubs";
const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";

/**
 * Derive the Stripe webhook endpoint URL from NEXTAUTH_URL: `{origin}{path}`.
 * Returns "" when NEXTAUTH_URL is absent/invalid (the wizard then shows guidance
 * to set it) — never a localhost fallback that would break a real deployment.
 */
function getStripeWebhookEndpointUrl(): string {
  const nextAuthUrl = process.env.NEXTAUTH_URL?.trim();
  if (!nextAuthUrl) return "";
  try {
    return `${new URL(nextAuthUrl).origin}${STRIPE_WEBHOOK_PATH}`;
  } catch {
    return "";
  }
}

// Server component: resolves the server-derived setup config (the webhook
// endpoint URL, legacy env detection) once, then renders the interactive wizard.
export default function StripeSetupPage() {
  const webhookEndpointUrl = getStripeWebhookEndpointUrl();
  const legacyEnvVars =
    detectLegacyProviderEnv().find((f) => f.provider === STRIPE_PROVIDER)
      ?.vars ?? [];

  return (
    <div className="max-w-6xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Stripe Setup</h1>
      <p className="mb-6 text-muted-foreground">
        Connect Stripe to take card payments. Day-to-day payment operations live
        on the{" "}
        <Link
          href={adminHref("payments")}
          className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          Payments
        </Link>{" "}
        page.
      </p>

      <StripeSetupWizard
        serverConfig={{ webhookEndpointUrl, legacyEnvVars }}
      />
    </div>
  );
}
