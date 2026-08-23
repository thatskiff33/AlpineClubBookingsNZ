"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { fetchJson, postJson } from "./api"
import { SectionCard, type ToggleSection } from "./shared"
import type { MembershipSyncMode, SyncResult, XeroHealthSnapshot } from "./types"

export function MembershipSyncPanel({
  connected,
  open,
  onToggle,
  syncing,
  setSyncing,
  setSyncResult,
  onRefreshDiagnostics,
  refreshToken,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  syncing: string | null
  setSyncing: (syncing: string | null) => void
  setSyncResult: (result: SyncResult | null) => void
  onRefreshDiagnostics: () => void
  refreshToken: number
}) {
  // Both stamps below are real INSTANTS (a cron start, a refresh completion), so
  // they are projected through the club's persisted zone rather than the
  // viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime()
  const [lastRefresh, setLastRefresh] = useState<XeroHealthSnapshot["lastMembershipRefresh"] | null>(null)
  const [error, setError] = useState("")

  const fetchLastRefresh = useCallback(async () => {
    setError("")
    try {
      const data = await fetchJson<XeroHealthSnapshot>("/api/admin/xero/health", undefined, "Failed to fetch Xero health")
      setLastRefresh(data.lastMembershipRefresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load membership refresh state")
    }
  }, [])

  useEffect(() => {
    if (connected && open) void fetchLastRefresh()
  }, [connected, fetchLastRefresh, open])

  useEffect(() => {
    if (connected && open && refreshToken !== 0) void fetchLastRefresh()
  }, [connected, fetchLastRefresh, open, refreshToken])

  const syncMemberships = async (mode: MembershipSyncMode = "incremental") => {
    setSyncing(mode === "backfill" ? "memberships-backfill" : "memberships")
    setSyncResult(null)
    setError("")
    try {
      const data = await postJson<SyncResult>(`/api/admin/xero/sync-memberships?mode=${mode}`, undefined, "Sync failed")
      setSyncResult(data)
      await fetchLastRefresh()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Membership sync failed")
    } finally {
      setSyncing(null)
    }
  }

  return (
    <SectionCard
      id="xero-section-membershipSync"
      title="Membership Status Refresh"
      description="Check Xero invoices for active members and refresh the current season membership state."
      open={open}
      onToggle={(nextOpen) => onToggle("membershipSync", nextOpen)}
      actions={
        <>
          <Button variant="outline" onClick={() => void syncMemberships("backfill")} disabled={syncing !== null}>
            {syncing === "memberships-backfill" ? "Repairing..." : "Run Repair Backfill"}
          </Button>
          <Button onClick={() => void syncMemberships("incremental")} disabled={syncing !== null}>
            {syncing === "memberships" ? "Refreshing..." : "Run Incremental Refresh"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <p className="text-sm text-muted-foreground">This runs automatically as a daily cron job. Only members already linked to Xero contacts can be refreshed.</p>
        <p className="text-sm text-muted-foreground">Incremental refresh is the normal low-API-cost path. Repair backfill is manual only and rechecks linked members whose local season status still looks stale.</p>
        <div className="rounded-md border bg-muted p-3 text-sm">
          <p>
            <span className="text-muted-foreground">Last refresh:</span>{" "}
            {lastRefresh?.at ? clubTime.instantDateTime(requireInstant(lastRefresh.at)) : "No refresh recorded yet"}
          </p>
          {lastRefresh?.lastCronStartedAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Cron started {clubTime.instantDateTime(requireInstant(lastRefresh.lastCronStartedAt))}
              {lastRefresh.lastCronStatus ? ` - ${lastRefresh.lastCronStatus}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </SectionCard>
  )
}
