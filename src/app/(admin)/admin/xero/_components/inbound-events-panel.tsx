"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { DatasetResetButton } from "@/components/admin/dataset-reset-button"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { resetXeroInboundDatasetSearchParams } from "@/lib/admin-dataset-reset-state"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { fetchJson, postJson } from "./api"
import {
  FilterSelect,
  formatJson,
  inboundEventActionLabel,
  OperationStatusChip,
  SectionCard,
  shortId,
  type ToggleSection,
} from "./shared"
import type { XeroInboundEvent } from "./types"

export function InboundEventsPanel({
  connected,
  open,
  onToggle,
  onMessage,
  onRefreshOperations,
  onRefreshDiagnostics,
  refreshToken,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  onMessage: (message: string) => void
  onRefreshOperations: () => void
  onRefreshDiagnostics: () => void
  refreshToken: number
}) {
  // Replay writes the finance-area inbound-events replay route; a view-only
  // finance admin browses the events but cannot replay them (#1997).
  const canEdit = useAdminAreaEditAccess("finance")
  // #2264 — the example event type moves under the box; inside it, grey text
  // read as a filter already applied.
  const eventTypeHint = useFieldHint()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Hold the latest searchParams in a ref so syncUrl can preserve the *other*
  // panel's params without taking searchParams as a reactive dependency. If it
  // did, the sibling OperationsPanel rewriting the URL would re-trigger this
  // panel's sync (and vice versa), causing the section param to ping-pong
  // forever. Keyed off our own filter state only, the loop cannot form.
  const searchParamsRef = useRef(searchParams)
  useEffect(() => {
    searchParamsRef.current = searchParams
  }, [searchParams])
  const hasInboundUrlState =
    searchParams.get("section") === "inbound" ||
    [
      "inStatus",
      "inEventCategory",
      "inLocalModel",
      "inLocalId",
      "inResourceId",
      "inEventType",
      "inCreatedFrom",
      "inCreatedTo",
      "inPage",
    ].some((key) => searchParams.has(key))
  // Received and processed stamps are real INSTANTS, rendered in the club's
  // persisted zone rather than the viewer's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime()
  const [events, setEvents] = useState<XeroInboundEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState(searchParams.get("inStatus") || "all")
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get("inEventCategory") || "all")
  const [localModelFilter, setLocalModelFilter] = useState(searchParams.get("inLocalModel") || "all")
  const [localIdFilter, setLocalIdFilter] = useState(searchParams.get("inLocalId") || "")
  const [resourceIdFilter, setResourceIdFilter] = useState(searchParams.get("inResourceId") || "")
  const [eventTypeFilter, setEventTypeFilter] = useState(searchParams.get("inEventType") || "all")
  const [createdFrom, setCreatedFrom] = useState(searchParams.get("inCreatedFrom") || "")
  const [createdTo, setCreatedTo] = useState(searchParams.get("inCreatedTo") || "")
  const [page, setPage] = useState(() => {
    const requested = Number(searchParams.get("inPage") || "1")
    return Number.isInteger(requested) && requested > 0 ? requested : 1
  })
  const [total, setTotal] = useState(0)
  const pageSize = 25
  const [urlSyncEnabled, setUrlSyncEnabled] = useState(hasInboundUrlState)
  const [replayingEventId, setReplayingEventId] = useState<string | null>(null)

  const syncUrl = useCallback(() => {
    if (!urlSyncEnabled) return

    const currentSearch = searchParamsRef.current.toString()
    const params = new URLSearchParams(currentSearch)
    params.set("section", "inbound")
    const setOrDelete = (key: string, value: string, defaultValue = "") => {
      if (value && value !== defaultValue) params.set(key, value)
      else params.delete(key)
    }

    setOrDelete("inStatus", statusFilter, "all")
    setOrDelete("inEventCategory", categoryFilter, "all")
    setOrDelete("inLocalModel", localModelFilter, "all")
    setOrDelete("inLocalId", localIdFilter)
    setOrDelete("inResourceId", resourceIdFilter)
    setOrDelete("inEventType", eventTypeFilter, "all")
    setOrDelete("inCreatedFrom", createdFrom)
    setOrDelete("inCreatedTo", createdTo)
    setOrDelete("inPage", page > 1 ? String(page) : "")

    const query = params.toString()
    const nextPath = query ? `${pathname}?${query}` : pathname
    const currentPath = currentSearch ? `${pathname}?${currentSearch}` : pathname
    if (nextPath !== currentPath) {
      router.replace(nextPath, { scroll: false })
    }
  }, [
    categoryFilter,
    createdFrom,
    createdTo,
    eventTypeFilter,
    localIdFilter,
    localModelFilter,
    page,
    pathname,
    resourceIdFilter,
    router,
    statusFilter,
    urlSyncEnabled,
  ])

  useEffect(() => {
    syncUrl()
  }, [syncUrl])

  const resetPage = () => {
    setUrlSyncEnabled(true)
    setPage(1)
  }

  const isDatasetDefault =
    statusFilter === "all" &&
    categoryFilter === "all" &&
    localModelFilter === "all" &&
    localIdFilter === "" &&
    resourceIdFilter === "" &&
    eventTypeFilter === "all" &&
    createdFrom === "" &&
    createdTo === "" &&
    page === 1

  const resetDataset = () => {
    const params = resetXeroInboundDatasetSearchParams(
      searchParamsRef.current.toString(),
    )
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    setUrlSyncEnabled(true)
    setStatusFilter("all")
    setCategoryFilter("all")
    setLocalModelFilter("all")
    setLocalIdFilter("")
    setResourceIdFilter("")
    setEventTypeFilter("all")
    setCreatedFrom("")
    setCreatedTo("")
    setPage(1)
  }

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        eventCategory: categoryFilter,
        source: "all",
        localModel: localModelFilter,
        localId: localIdFilter,
        resourceId: resourceIdFilter,
        eventType: eventTypeFilter,
        page: String(page),
        pageSize: String(pageSize),
      })
      if (createdFrom) params.set("createdFrom", createdFrom)
      if (createdTo) params.set("createdTo", createdTo)
      const data = await fetchJson<{ data?: XeroInboundEvent[]; total?: number }>(`/api/admin/xero/inbound-events?${params.toString()}`, undefined, "Failed to fetch Xero inbound events")
      setEvents(data.data ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero inbound events")
    } finally {
      setLoading(false)
    }
  }, [
    categoryFilter,
    createdFrom,
    createdTo,
    eventTypeFilter,
    localIdFilter,
    localModelFilter,
    page,
    resourceIdFilter,
    statusFilter,
  ])

  useEffect(() => {
    if (connected && open) void fetchEvents()
  }, [connected, fetchEvents, open])

  useEffect(() => {
    if (connected && open && refreshToken !== 0) void fetchEvents()
  }, [connected, fetchEvents, open, refreshToken])

  const replay = async (eventId: string) => {
    setReplayingEventId(eventId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(`/api/admin/xero/inbound-events/${eventId}/replay`, undefined, "Failed to replay Xero inbound event")
      onMessage(data.message || "Xero inbound event replayed.")
      await fetchEvents()
      onRefreshOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replay Xero inbound event")
    } finally {
      setReplayingEventId(null)
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-4`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view Xero inbound events but cannot replay them.
    </AdminViewOnlySectionBanner>
  )

  return (
    <SectionCard
      id="xero-section-inbound"
      title="Inbound Events"
      description="Stored webhook events and their reconciliation state."
      open={open}
      onToggle={(nextOpen) => onToggle("inbound", nextOpen)}
      actions={<Button variant="outline" size="sm" onClick={() => void fetchEvents()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</Button>}
    >
      {viewOnlyBanner}
      <div className="space-y-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <details className="rounded-md border bg-muted p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">What do these statuses mean?</summary>
          <ul className="mt-2 space-y-1">
            <li><span className="font-medium">RECEIVED</span> — webhook stored, waiting to be processed. No action needed.</li>
            <li><span className="font-medium">PROCESSING</span> — being reconciled now. If it stays here for a long time it is stuck; check System Health.</li>
            <li><span className="font-medium">PROCESSED</span> — reconciled into the local records. No action needed.</li>
            <li><span className="font-medium">FAILED</span> — could not be reconciled. Open the row for the error, then use Replay to try again once the cause is resolved.</li>
          </ul>
        </details>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <FilterSelect label="Status" value={statusFilter} onValueChange={(value) => { setStatusFilter(value); resetPage() }} values={["all", "FAILED", "RECEIVED", "PROCESSING", "PROCESSED"]} />
          <FilterSelect label="Category" value={categoryFilter} onValueChange={(value) => { setCategoryFilter(value); resetPage() }} values={["all", "CONTACT", "INVOICE", "PAYMENT", "CREDIT_NOTE"]} />
          <FilterSelect label="Local Model" value={localModelFilter} onValueChange={(value) => { setLocalModelFilter(value); resetPage() }} values={["all", "Member", "Booking", "Payment", "BookingModification", "MemberSubscription"]} />
          <DatasetResetButton disabled={isDatasetDefault} onReset={resetDataset} />
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-in-local-id">Local ID</Label>
            <Input id="xero-in-local-id" value={localIdFilter} onChange={(event) => { setLocalIdFilter(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-in-resource-id">Resource ID</Label>
            <Input id="xero-in-resource-id" value={resourceIdFilter} onChange={(event) => { setResourceIdFilter(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-in-event-type">Event Type</Label>
            <Input id="xero-in-event-type" value={eventTypeFilter === "all" ? "" : eventTypeFilter} onChange={(event) => { setEventTypeFilter(event.target.value || "all"); resetPage() }} {...eventTypeHint.fieldProps} />
            <FieldHint {...eventTypeHint.hintProps}>Example: UPDATE</FieldHint>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-in-created-from">Created From</Label>
            <Input id="xero-in-created-from" type="date" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-in-created-to">Created To</Label>
            <Input id="xero-in-created-to" type="date" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); resetPage() }} />
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading stored inbound events...</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stored inbound events found.</p>
        ) : (
          <div className="space-y-3">
            {events.map((event) => (
              <div key={event.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <OperationStatusChip status={event.status} />
                  <span className="text-sm font-medium">{event.eventCategory ?? "UNKNOWN"} {event.eventType}</span>
                  <span className="text-xs text-muted-foreground">{clubTime.instantDateTime(requireInstant(event.createdAt))}</span>
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>Source: {event.source}</span>
                  <span>Correlation: <code>{shortId(event.correlationKey)}</code></span>
                  {event.resourceId ? (
                    <span>
                      Resource:{" "}
                      {event.xeroObjectUrl ? (
                        <a href={event.xeroObjectUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{shortId(event.resourceId)}</a>
                      ) : shortId(event.resourceId)}
                    </span>
                  ) : null}
                  {event.processedAt ? <span>Processed: {clubTime.instantDateTime(requireInstant(event.processedAt))}</span> : null}
                </div>
                {event.errorMessage ? <p className="text-sm text-danger">{event.errorMessage}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => void replay(event.id)} disabled={!event.canReplay || replayingEventId === event.id}>
                    {replayingEventId === event.id ? "Replaying..." : inboundEventActionLabel(event.status)}
                  </ViewOnlyActionButton>
                  {!event.canReplay ? <p className="text-xs text-muted-foreground">This event is currently being processed.</p> : null}
                </div>
                <details className="rounded-md bg-muted p-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">View stored payload</summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded border bg-background p-2 text-[11px]">{formatJson(event.payload)}</pre>
                </details>
              </div>
            ))}
          </div>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} of {total}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { setUrlSyncEnabled(true); setPage((value) => value - 1) }}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page * pageSize >= total} onClick={() => { setUrlSyncEnabled(true); setPage((value) => value + 1) }}>Next</Button>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  )
}
