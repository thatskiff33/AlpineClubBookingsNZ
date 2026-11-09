"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { IntegrationWizard } from "@/components/admin/integration-wizard";
import type { WizardStepConfig } from "@/components/admin/integration-wizard";
import {
  useBackupWizardContext,
  type BackupWizardContext,
} from "./use-backup-wizard-context";
import {
  CredentialsStep,
  DestinationStep,
  OperationalStep,
  VerificationStep,
} from "./backup-wizard-steps";

/**
 * The database-backup setup wizard (#2227) — a CONFIG of the reusable, provider-
 * agnostic `IntegrationWizard` shell (built by C2, #2080), giving backups the
 * same guided experience as Stripe/Xero/Google. It supplies the backup-derived
 * context and four steps (S3 credentials, destination, operational toggle, and a
 * real verification run); the shell owns the stepper, gating, resume and the
 * view-only banner frame.
 *
 * The wizard lives under the `support` area (same as /admin/backups). Operational
 * config (enable/retention) needs support edit; the S3 credentials and
 * destination writes additionally require Full Admin, enforced inside the steps
 * and independently by the write routes.
 */
export function BackupSetupWizard() {
  const { context, loading, refresh } = useBackupWizardContext();
  const canEdit = useAdminAreaEditAccess("support");

  const steps = useMemo<WizardStepConfig<BackupWizardContext>[]>(
    () => [
      {
        id: "credentials",
        title: "S3 credentials",
        summary: "Access key + secret",
        isVerified: (ctx) =>
          ctx.accessKeyIdSet && ctx.secretAccessKeySet && !ctx.needsReentry,
        render: (ctx, helpers) => (
          <CredentialsStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "destination",
        title: "Destination",
        summary: "Bucket + region",
        isVerified: (ctx) => Boolean(ctx.bucket),
        render: (ctx, helpers) => (
          <DestinationStep context={ctx} helpers={helpers} />
        ),
      },
      {
        id: "operational",
        title: "Turn it on",
        summary: "Enable + retention",
        isVerified: (ctx) => ctx.enabled,
        // The shell's vouch (#2324) goes only to the steps whose gated controls
        // sit in the wizard's OWN scope (`support`, what the banner states).
        // The credentials and destination steps do NOT get it: those writes
        // additionally need Full Admin, so they keep their own reason.
        render: (ctx, helpers) => (
          <OperationalStep
            context={ctx}
            helpers={helpers}
            ancestorRendersViewOnlyBanner={
              helpers.ancestorRendersViewOnlyBanner
            }
          />
        ),
      },
      {
        id: "verify",
        title: "Verify",
        summary: "Run a real backup",
        isVerified: (ctx) => ctx.verified,
        render: (ctx, helpers) => (
          <VerificationStep
            context={ctx}
            helpers={helpers}
            ancestorRendersViewOnlyBanner={
              helpers.ancestorRendersViewOnlyBanner
            }
          />
        ),
      },
    ],
    [],
  );

  const searchParams = useSearchParams();
  const initialStepId = searchParams.get("step") ?? undefined;

  return (
    <IntegrationWizard<BackupWizardContext>
      wizardId="backup"
      title="Database backup setup"
      description="Enter your S3 credentials, choose the destination, turn on nightly backups, and run a real verification backup — all in-app."
      steps={steps}
      context={context}
      contextLoading={loading}
      onRefresh={refresh}
      canEdit={canEdit}
      initialStepId={initialStepId}
      completion={{
        badgeLabel: "Verified",
        message: "Backups verified",
        hint: "Manage settings and history on the Database Backups page.",
      }}
      viewOnlyBanner={
        <>
          Your admin role can view backup setup, but turning on backups and
          running one requires support edit access (entering the S3 credentials
          and destination requires Full Admin).
        </>
      }
    />
  );
}
