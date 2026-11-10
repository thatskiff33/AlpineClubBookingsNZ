"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { IntegrationWizard } from "@/components/admin/integration-wizard";
import type { WizardStepConfig } from "@/components/admin/integration-wizard";
import {
  useXeroWizardContext,
  type XeroWizardContext,
  type XeroWizardServerConfig,
} from "./use-xero-wizard-context";
import { CreateAppStep, CredentialsStep, ConnectStep } from "./xero-wizard-steps";
import {
  WebhooksStep,
  MappingStep,
  FinishStep,
} from "./xero-completion-steps";

/**
 * The Xero connection wizard (#2080) — a CONFIG of the reusable, provider-
 * agnostic `IntegrationWizard` shell. It supplies the Xero-derived context and
 * the three steps; the shell owns the stepper, gating, resume and the view-only
 * banner frame. C4 (Stripe) / C5 (Google) reuse the same shell with their own
 * context + steps.
 */
export function XeroSetupWizard({
  serverConfig,
}: {
  serverConfig: XeroWizardServerConfig;
}) {
  const { context, loading, refresh } = useXeroWizardContext(serverConfig);
  // The wizard lives under the finance area (same as /admin/xero). Credential
  // writes additionally require Full Admin, enforced inside the credentials step.
  const canEdit = useAdminAreaEditAccess("finance");

  // Steps are declared as data; each verifies against live server truth.
  const steps = useMemo<WizardStepConfig<XeroWizardContext>[]>(
    () => [
      {
        id: "create-app",
        title: "Create your Xero app",
        summary: "Copy exact values into the portal",
        // Instructions step — nothing to verify, so it never blocks Continue.
        isVerified: () => true,
        render: (ctx) => <CreateAppStep context={ctx} />,
      },
      {
        id: "credentials",
        title: "Enter credentials",
        summary: "Client ID + secret",
        isVerified: (ctx) =>
          ctx.credentials.client_id.set && ctx.credentials.client_secret.set,
        render: (ctx, helpers) => (
          <CredentialsStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "connect",
        title: "Connect",
        summary: "Authorise the right organisation",
        isVerified: (ctx) => ctx.connected && !ctx.needsReentry,
        render: (ctx, helpers) => <ConnectStep context={ctx} helpers={helpers} />,
      },
      {
        id: "webhooks",
        title: "Webhooks",
        summary: "Real-time updates (optional)",
        // Optional/skippable (epic decision 5): passes when verified OR skipped;
        // skipping leaves the persistent amber badge until later verification.
        // Provider-specific skip copy for the shell's skip affordance (#2080 C2);
        // the shell owns the Skip action, so the step body renders no skip button.
        optional: {
          skipLabel: "Skip for now",
          skipDescription:
            "You can add webhooks later — the scheduled sync keeps payments up to date meanwhile.",
        },
        isVerified: (ctx) => ctx.webhookVerified,
        render: (ctx, helpers) => <WebhooksStep context={ctx} helpers={helpers} />,
      },
      {
        id: "mapping",
        title: "Account mapping",
        summary: "Map accounts & item codes",
        // Configuration step — sensible defaults apply when left unset, so it
        // never blocks finishing.
        isVerified: () => true,
        render: (ctx) => <MappingStep context={ctx} />,
      },
      {
        id: "finish",
        title: "Import & finish",
        summary: "One-time import + summary",
        isVerified: () => true,
        render: (ctx) => <FinishStep context={ctx} />,
      },
    ],
    [],
  );

  // Deep-link support: a readiness "blocked" link or the modules "Set up" CTA can
  // target a step via ?step=; the shell clamps it to the furthest reachable step.
  const searchParams = useSearchParams();
  const initialStepId = searchParams.get("step") ?? undefined;

  return (
    <IntegrationWizard<XeroWizardContext>
      wizardId="xero"
      title="Xero setup"
      description="Create a Xero app, enter its credentials, and connect your organisation — all in-app."
      steps={steps}
      context={context}
      contextLoading={loading}
      onRefresh={refresh}
      canEdit={canEdit}
      initialStepId={initialStepId}
      // The wizard connects Xero, but account/item mappings and contact import
      // still follow below — so the final state must read as "connected, more to
      // configure", never "the whole integration is done" (#2080 UX-F9).
      completion={{
        badgeLabel: "Complete",
        message: "Setup complete",
        hint: "Day-to-day syncing, operations, and usage live on the Xero Sync page.",
      }}
      viewOnlyBanner={
        <>
          Your admin role can view Xero setup, but changing credentials and
          connecting requires finance edit access (entering credentials requires
          Full Admin).
        </>
      }
    />
  );
}
