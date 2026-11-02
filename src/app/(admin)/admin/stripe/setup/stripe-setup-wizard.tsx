"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { IntegrationWizard } from "@/components/admin/integration-wizard";
import type { WizardStepConfig } from "@/components/admin/integration-wizard";
import {
  credentialsStepVerified,
  useStripeWizardContext,
  type StripeWizardContext,
  type StripeWizardServerConfig,
} from "./use-stripe-wizard-context";
import {
  PortalGuideStep,
  CredentialsStep,
  VerifyConnectionStep,
  WebhookStep,
} from "./stripe-wizard-steps";

/**
 * The Stripe connection wizard (#2082) — a CONFIG of the reusable, provider-
 * agnostic `IntegrationWizard` shell (built by C2, #2080). It supplies the
 * Stripe-derived context and four steps; the shell owns the stepper, gating,
 * resume and the view-only banner frame. The webhook step is optional
 * (skippable with the shared amber pattern) and freshness-scoped.
 */
export function StripeSetupWizard({
  serverConfig,
}: {
  serverConfig: StripeWizardServerConfig;
}) {
  const { context, loading, refresh } = useStripeWizardContext(serverConfig);
  // The wizard lives under the finance area (same as /admin/xero and the shared
  // wizard-progress cursor). Credential writes additionally require Full Admin,
  // enforced inside the credential steps and by the C1 API.
  const canEdit = useAdminAreaEditAccess("finance");

  const steps = useMemo<WizardStepConfig<StripeWizardContext>[]>(
    () => [
      {
        id: "find-keys",
        title: "Find your keys",
        summary: "Where the Stripe keys live",
        isVerified: () => true,
        render: (ctx) => <PortalGuideStep context={ctx} />,
      },
      {
        id: "credentials",
        title: "Enter keys",
        summary: "Secret + publishable",
        isVerified: credentialsStepVerified,
        render: (ctx, helpers) => (
          <CredentialsStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "verify",
        title: "Verify connection",
        summary: "Confirm the right account",
        isVerified: (ctx) => ctx.connected,
        render: (ctx, helpers) => (
          <VerifyConnectionStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "webhook",
        title: "Webhook",
        summary: "Optional — sync payments",
        optional: true,
        isVerified: (ctx) => ctx.webhookVerified,
        render: (ctx, helpers) => <WebhookStep context={ctx} helpers={helpers} />,
      },
    ],
    [],
  );

  const searchParams = useSearchParams();
  const initialStepId = searchParams.get("step") ?? undefined;

  return (
    <IntegrationWizard<StripeWizardContext>
      wizardId="stripe"
      title="Stripe setup"
      description="Enter your Stripe keys, confirm the right account, and connect the payment webhook — all in-app."
      steps={steps}
      context={context}
      contextLoading={loading}
      onRefresh={refresh}
      canEdit={canEdit}
      initialStepId={initialStepId}
      viewOnlyBanner={
        <>
          Your admin role can view Stripe setup, but entering keys and connecting
          the webhook requires finance edit access (entering keys requires Full
          Admin).
        </>
      }
    />
  );
}
