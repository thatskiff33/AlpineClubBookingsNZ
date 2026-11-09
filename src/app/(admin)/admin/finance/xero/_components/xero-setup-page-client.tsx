"use client"

import Link from "next/link"
import { BackLink } from "@/components/admin/back-link"
import { XeroSetupWizard } from "../setup/xero-setup-wizard"
import type { XeroWizardServerConfig } from "../setup/use-xero-wizard-context"
import { WebhookAmberBadge } from "./webhook-amber-badge"
import { useXeroConnection } from "../_hooks/use-xero-connection"
import { adminHref } from "@/lib/admin-hubs";

/**
 * Xero Setup page body (#2080/#2081). The guided wizard is the whole setup
 * surface: credential entry, connect, webhooks, account mapping, and the
 * one-time contact import all live in its steps (the wizard's mapping/import
 * steps embed MappingsPanel/SetupPanels, so the page must NOT also render
 * them below — that duplicated every panel for a connected club). Day-to-day
 * syncing, operations, and usage stay on /admin/xero.
 */
export function XeroSetupPageClient({
  serverConfig,
}: {
  serverConfig: XeroWizardServerConfig
}) {
  const { status } = useXeroConnection()
  const connected = status?.connected === true

  return (
    <div className="max-w-6xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Xero Setup</h1>
      <p className="mb-2 text-muted-foreground">
        Connect Xero, configure account and item mappings, and run one-time contact import and linking.
      </p>
      <p className="mb-6 text-sm">
        Day-to-day syncing, operations, and usage live on the{" "}
        <Link
          href={adminHref("xero")}
          className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          Xero Sync
        </Link>{" "}
        page.
      </p>

      <WebhookAmberBadge connected={connected} />

      <div className="mb-6">
        <XeroSetupWizard serverConfig={serverConfig} />
      </div>
    </div>
  )
}
