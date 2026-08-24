"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { fetchJson } from "./api"
import { BudgetStatusChip, budgetTone, SectionCard, toneFillClass, type ToggleSection } from "./shared"
import type { XeroUsageSummary } from "./types"

export function UsagePanel({
  connected,
  open,
  onToggle,
  refreshToken,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  refreshToken: number
}) {
  // Both stamps here are real INSTANTS — when Xero last rate-limited us, and
  // when a call failed. They project through the club's persisted zone, never
  // the viewer's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime()
  const [usage, setUsage] = useState<XeroUsageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const fetchUsage = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setUsage(await fetchJson<XeroUsageSummary>("/api/admin/xero/usage", undefined, "Failed to fetch Xero API usage"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero API usage")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected && open && !usage && !loading) void fetchUsage()
  }, [connected, fetchUsage, loading, open, usage])

  useEffect(() => {
    if (connected && open && refreshToken !== 0) void fetchUsage()
  }, [connected, fetchUsage, open, refreshToken])

  return (
    <SectionCard
      id="xero-section-usage"
      title="Xero API Budget"
      description="Daily call volume, hotspots, rate limits, and recent failures from local metering."
      open={open}
      onToggle={(nextOpen) => onToggle("usage", nextOpen)}
      actions={<Button variant="outline" size="sm" onClick={() => void fetchUsage()} disabled={loading}>{loading ? "Refreshing..." : "Refresh Usage"}</Button>}
    >
      {error ? <p className="mb-3 text-sm text-danger">{error}</p> : null}
      {loading && !usage ? (
        <p className="text-sm text-muted-foreground">Loading usage summary...</p>
      ) : usage ? (
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-4">
            <UsageStat label="Calls Today" value={usage.today.totalCalls} detail={`of ${usage.budget.limit} daily budget`} />
            <UsageStat label="Successful" value={usage.today.successfulCalls} detail={`Failed: ${usage.today.failedCalls}`} />
            <UsageStat label="Rate Limits" value={usage.today.dayRateLimitHits + usage.today.minuteRateLimitHits} detail={`Day: ${usage.today.dayRateLimitHits} - Minute: ${usage.today.minuteRateLimitHits}`} />
            <div className="rounded-md border p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
              <div className="mt-1 flex items-center gap-2">
                <BudgetStatusChip status={usage.today.budgetStatus} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Last rate limit: {usage.today.lastRateLimitAt ? clubTime.instantDateTime(requireInstant(usage.today.lastRateLimitAt)) : "none"}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>Budget progress</span>
              <span>{Math.round(usage.today.usagePercent * 100)}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-muted">
              <div className={`h-full ${toneFillClass(budgetTone(usage.today.budgetStatus))}`} style={{ width: `${Math.min(usage.today.usagePercent * 100, 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">Thresholds: {usage.budget.thresholds.map((threshold) => threshold.callCount).join(" / ")} calls</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <BucketList title="Top Operations" empty="No Xero calls recorded yet today." buckets={usage.byOperation} />
            <BucketList title="Top Workflows" empty="No workflow hotspots recorded yet today." buckets={usage.topWorkflows} />
          </div>
          <div className="rounded-md border p-3">
            <p className="mb-2 text-sm font-medium">Recent Failures</p>
            {usage.recentFailures.length > 0 ? (
              <div className="space-y-3">
                {usage.recentFailures.map((failure) => (
                  <div key={failure.id} className="rounded-md bg-muted p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{failure.workflow ?? failure.operation}</span>
                      <span className="text-xs text-muted-foreground">{clubTime.instantDateTime(requireInstant(failure.createdAt))}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {failure.operation} - {failure.resourceType}
                      {failure.statusCode ? ` - HTTP ${failure.statusCode}` : ""}
                      {failure.rateLimitCategory ? ` - rate limit ${failure.rateLimitCategory}` : ""}
                    </p>
                    {failure.errorMessage ? <p className="mt-2 text-xs text-danger">{failure.errorMessage}</p> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No failed Xero calls recorded yet today.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No Xero usage data recorded yet.</p>
      )}
    </SectionCard>
  )
}

function UsageStat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function BucketList({ title, empty, buckets }: { title: string; empty: string; buckets: Array<{ label: string; count: number }> }) {
  return (
    <div className="rounded-md border p-3">
      <p className="mb-2 text-sm font-medium">{title}</p>
      {buckets.length > 0 ? (
        <div className="space-y-2 text-sm">
          {buckets.map((bucket) => (
            <div key={bucket.label} className="flex items-center justify-between gap-3">
              <span className="truncate">{bucket.label}</span>
              <span className="text-muted-foreground">{bucket.count} calls</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  )
}
