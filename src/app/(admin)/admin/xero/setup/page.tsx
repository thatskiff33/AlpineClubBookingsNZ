import {
  detectLegacyProviderEnv,
  getOperationalXeroRedirectUri,
  getXeroWebhooksVerifiable,
} from "@/lib/xero-config";
import { clubFormatValues } from "@/lib/club-format-server";
import { clubChargeCurrencyCode } from "@/lib/stripe-charge-currency";
import { XeroSetupPageClient } from "../_components/xero-setup-page-client";

// Server component: resolves the server-derived setup config (the C1 redirect
// URI, legacy env detection) once, then renders the interactive client body.
// The guided wizard (#2080) is the credential-entry + connect surface; it
// supersedes the interim credentials section from C1.
export default async function XeroSetupPage() {
  const redirectUri = getOperationalXeroRedirectUri();
  const companyUrl = redirectUri ? new URL(redirectUri).origin : "";
  const legacyEnvVars =
    detectLegacyProviderEnv().find((f) => f.provider === "xero")?.vars ?? [];

  // Webhook delivery URL + whether this deployment can validate webhooks at all.
  // Xero only reaches a PUBLIC HTTPS origin; a localhost/plain-HTTP deployment
  // (typical dev/self-host-behind-tunnel-not-yet) can store a key but can never
  // receive the intent-to-receive ping, so the step there defaults to Skip.
  const webhookDeliveryUrl = companyUrl ? `${companyUrl}/api/webhooks/xero` : "";
  // Shared derivation (src/lib/xero-config) so the wizard step, this page, and
  // the verify-status route / amber badge all agree on verifiability.
  const webhooksVerifiable = getXeroWebhooksVerifiable();
  // The currency cards are actually charged in (#3633), for the Connect step's
  // base-currency warning: resolved here, through the same rule the setup list
  // uses, because the browser's club-format context carries only the display
  // currency and cannot tell a stored-but-unusable currency (no card charged,
  // so nothing to warn about) from a usable one.
  const clubChargeCurrency = clubChargeCurrencyCode(await clubFormatValues());

  return (
    <XeroSetupPageClient
      serverConfig={{
        redirectUri,
        companyUrl,
        legacyEnvVars,
        webhookDeliveryUrl,
        webhooksVerifiable,
        clubChargeCurrencyCode: clubChargeCurrency,
      }}
    />
  );
}
