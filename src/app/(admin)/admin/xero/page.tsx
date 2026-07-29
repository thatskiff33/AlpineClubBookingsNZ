"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useClubIdentity } from "@/components/club-identity-provider"
import { buildPathWithSearch } from "@/lib/internal-return-path"
import {
  ConnectionStatusPanel,
  ContactSyncPanel,
  GoToXeroButton,
  HealthAndDiagnosticsPanels,
  InboundEventsPanel,
  MembershipSyncPanel,
  OperationsPanel,
  SyncResultsPanel,
  UsagePanel,
  xeroLinkState,
} from "./_components/panels"
import { Message } from "./_components/message"
import { WebhookAmberBadge } from "./_components/webhook-amber-badge"
import { SECTION_DEFAULTS, type SectionKey, type SyncResult } from "./_components/types"
import { useXeroConnection } from "./_hooks/use-xero-connection"
import { useXeroOrgShortCode } from "@/hooks/use-xero-org-short-code"

export default function XeroPage() {
  const club = useClubIdentity()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentXeroPath = buildPathWithSearch(pathname, searchParams.toString())
  const {
    status,
    loading,
    error,
    setError,
    connectSuccess,
    setConnectSuccess,
    sectionOpen,
    setSectionState,
    scrollToSection,
    handleConnect,
    handleDisconnect,
  } = useXeroConnection()
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [operationMessage, setOperationMessage] = useState("")
  const [diagnosticsRefreshToken, setDiagnosticsRefreshToken] = useState(0)
  const [operationsRefreshToken, setOperationsRefreshToken] = useState(0)
  const [usageRefreshToken, setUsageRefreshToken] = useState(0)

  const connected = status?.connected === true
  // Org short code for the "Go to Xero" deep links. Only read once connected,
  // and served from the server-side org cache, so a cold cache costs at most
  // one live getOrganisations call per server process per 12 hours (a minute
  // while that read is failing) and every later page load costs none (#2261).
  const { shortCode: orgShortCode, loading: orgShortCodeLoading } =
    useXeroOrgShortCode(connected)
  const refreshDiagnostics = () => setDiagnosticsRefreshToken((value) => value + 1)
  const refreshOperations = () => setOperationsRefreshToken((value) => value + 1)
  const publishMessage = (message: string) => {
    setOperationMessage(message)
    if (message) setUsageRefreshToken((value) => value + 1)
  }

  useEffect(() => {
    const section = searchParams.get("section")
    if (section && section in SECTION_DEFAULTS) {
      setSectionState(section as SectionKey, true)
    }
  }, [searchParams, setSectionState])

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-bold">Xero Sync</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl p-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Xero Sync</h1>
        <GoToXeroButton
          state={xeroLinkState(status)}
          shortCode={orgShortCode}
          shortCodeLoading={orgShortCodeLoading}
        />
      </div>
      <p className="mb-2 text-muted-foreground">
        Monitor the Xero connection, run contact and membership syncs, and review operations and usage.
      </p>
      <p className="mb-6 text-sm">
        Account mappings and initial setup live on the{" "}
        <Link
          href="/admin/xero/setup"
          className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          Xero Setup
        </Link>{" "}
        page.
      </p>

      {error && <Message tone="error" message={error} onDismiss={() => setError("")} />}
      {operationMessage && <Message tone="success" message={operationMessage} onDismiss={() => setOperationMessage("")} />}
      {connectSuccess && <Message tone="success" message="Xero connected successfully!" onDismiss={() => setConnectSuccess(false)} />}

      <WebhookAmberBadge connected={connected} />

      <ConnectionStatusPanel status={status} onConnect={handleConnect} onDisconnect={handleDisconnect} />

      {connected && (
        <>
          <HealthAndDiagnosticsPanels
            connected={connected}
            shortCode={orgShortCode}
            currentXeroPath={currentXeroPath}
            healthOpen={sectionOpen.health}
            contactGroupMismatchesOpen={sectionOpen.contactGroupMismatches}
            contactLinkMismatchesOpen={sectionOpen.contactLinkMismatches}
            onToggle={setSectionState}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            refreshToken={diagnosticsRefreshToken}
            scrollToSection={scrollToSection}
          />
          <OperationsPanel
            connected={connected}
            open={sectionOpen.operations}
            onToggle={setSectionState}
            onMessage={publishMessage}
            onRefreshDiagnostics={refreshDiagnostics}
            refreshToken={operationsRefreshToken}
          />
          <InboundEventsPanel
            connected={connected}
            open={sectionOpen.inbound}
            onToggle={setSectionState}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            onRefreshDiagnostics={refreshDiagnostics}
            refreshToken={0}
          />
          <ContactSyncPanel
            connected={connected}
            open={sectionOpen.contactSync}
            onToggle={setSectionState}
            clubName={club.name}
            syncing={syncing}
            setSyncing={setSyncing}
            setSyncResult={setSyncResult}
            onMessage={publishMessage}
            onRefreshOperations={refreshOperations}
            onRefreshDiagnostics={refreshDiagnostics}
          />
          <MembershipSyncPanel
            connected={connected}
            open={sectionOpen.membershipSync}
            onToggle={setSectionState}
            syncing={syncing}
            setSyncing={setSyncing}
            setSyncResult={setSyncResult}
            onRefreshDiagnostics={refreshDiagnostics}
            refreshToken={diagnosticsRefreshToken}
          />
          <SyncResultsPanel syncResult={syncResult} shortCode={orgShortCode} currentXeroPath={currentXeroPath} />
          <UsagePanel connected={connected} open={sectionOpen.usage} onToggle={setSectionState} refreshToken={usageRefreshToken} />
        </>
      )}
    </div>
  )
}
