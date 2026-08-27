"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { CheckCircle2 } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
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
import { redactSensitiveText } from "@/lib/redact-sensitive-json"
import { summarizeXeroOperation } from "@/lib/xero-operation-summaries"
import { resetXeroOperationsDatasetSearchParams } from "@/lib/admin-dataset-reset-state"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { fetchJson, postJson } from "./api"
import {
  FailureStateChip,
  FilterSelect,
  formatJson,
  OperationStatusChip,
  SectionCard,
  shortId,
  ToneChip,
  type ToggleSection,
} from "./shared"
import type { XeroOperation } from "./types"

export function OperationsPanel({
  connected,
  open,
  onToggle,
  onMessage,
  onRefreshDiagnostics,
  refreshToken,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  onMessage: (message: string) => void
  onRefreshDiagnostics: () => void
  refreshToken: number
}) {
  const { prompt, confirmDialog } = useConfirm()
  // Retry/reset/mark-non-replayable/resolve all write finance-area Xero
  // operations routes; a view-only finance admin browses but cannot act (#1997).
  const canEdit = useAdminAreaEditAccess("finance")
  // #2264 — the example operation type moves under the box; inside it, grey text
  // read as a filter already applied.
  const operationTypeHint = useFieldHint()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Hold the latest searchParams in a ref so syncUrl can preserve the *other*
  // panel's params without taking searchParams as a reactive dependency. If it
  // did, the sibling InboundEventsPanel rewriting the URL would re-trigger this
  // panel's sync (and vice versa), causing the section param to ping-pong
  // forever. Keyed off our own filter state only, the loop cannot form.
  const searchParamsRef = useRef(searchParams)
  useEffect(() => {
    searchParamsRef.current = searchParams
  }, [searchParams])
  const hasOperationsUrlState =
    searchParams.get("section") === "operations" ||
    [
      "opStatus",
      "opEntityType",
      "opLocalModel",
      "opLocalId",
      "opOperationType",
      "opFailureState",
      "opResourceId",
      "opCreatedFrom",
      "opCreatedTo",
      "opPage",
    ].some((key) => searchParams.has(key))
  const [operations, setOperations] = useState<XeroOperation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [statusFilter, setStatusFilter] = useState(searchParams.get("opStatus") || "all")
  const [entityFilter, setEntityFilter] = useState(searchParams.get("opEntityType") || "all")
  const [localModelFilter, setLocalModelFilter] = useState(searchParams.get("opLocalModel") || "all")
  const [localIdFilter, setLocalIdFilter] = useState(searchParams.get("opLocalId") || "")
  const [operationTypeFilter, setOperationTypeFilter] = useState(searchParams.get("opOperationType") || "all")
  const [failureStateFilter, setFailureStateFilter] = useState(searchParams.get("opFailureState") || "all")
  const [resourceIdFilter, setResourceIdFilter] = useState(searchParams.get("opResourceId") || "")
  const [createdFrom, setCreatedFrom] = useState(searchParams.get("opCreatedFrom") || "")
  const [createdTo, setCreatedTo] = useState(searchParams.get("opCreatedTo") || "")
  const [page, setPage] = useState(() => {
    const requested = Number(searchParams.get("opPage") || "1")
    return Number.isInteger(requested) && requested > 0 ? requested : 1
  })
  const [total, setTotal] = useState(0)
  const pageSize = 25
  const [urlSyncEnabled, setUrlSyncEnabled] = useState(hasOperationsUrlState)
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [markingNonReplayableOperationId, setMarkingNonReplayableOperationId] = useState<string | null>(null)
  const [resolvingOperationId, setResolvingOperationId] = useState<string | null>(null)
  const [retryingAllFailed, setRetryingAllFailed] = useState(false)
  const [resettingStale, setResettingStale] = useState(false)

  const syncUrl = useCallback(() => {
    if (!urlSyncEnabled) return

    const currentSearch = searchParamsRef.current.toString()
    const params = new URLSearchParams(currentSearch)
    params.set("section", "operations")

    const setOrDelete = (key: string, value: string, defaultValue = "") => {
      if (value && value !== defaultValue) params.set(key, value)
      else params.delete(key)
    }

    setOrDelete("opStatus", statusFilter, "all")
    setOrDelete("opEntityType", entityFilter, "all")
    setOrDelete("opLocalModel", localModelFilter, "all")
    setOrDelete("opLocalId", localIdFilter)
    setOrDelete("opOperationType", operationTypeFilter, "all")
    setOrDelete("opFailureState", failureStateFilter, "all")
    setOrDelete("opResourceId", resourceIdFilter)
    setOrDelete("opCreatedFrom", createdFrom)
    setOrDelete("opCreatedTo", createdTo)
    setOrDelete("opPage", page > 1 ? String(page) : "")

    const query = params.toString()
    const nextPath = query ? `${pathname}?${query}` : pathname
    const currentPath = currentSearch ? `${pathname}?${currentSearch}` : pathname
    if (nextPath !== currentPath) {
      router.replace(nextPath, { scroll: false })
    }
  }, [
    createdFrom,
    createdTo,
    entityFilter,
    failureStateFilter,
    localIdFilter,
    localModelFilter,
    operationTypeFilter,
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
    entityFilter === "all" &&
    localModelFilter === "all" &&
    localIdFilter === "" &&
    operationTypeFilter === "all" &&
    failureStateFilter === "all" &&
    resourceIdFilter === "" &&
    createdFrom === "" &&
    createdTo === "" &&
    page === 1

  const resetDataset = () => {
    const params = resetXeroOperationsDatasetSearchParams(
      searchParamsRef.current.toString(),
    )
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    setUrlSyncEnabled(true)
    setStatusFilter("all")
    setEntityFilter("all")
    setLocalModelFilter("all")
    setLocalIdFilter("")
    setOperationTypeFilter("all")
    setFailureStateFilter("all")
    setResourceIdFilter("")
    setCreatedFrom("")
    setCreatedTo("")
    setPage(1)
  }

  const fetchOperations = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        entityType: entityFilter,
        direction: "all",
        localModel: localModelFilter,
        localId: localIdFilter,
        operationType: operationTypeFilter,
        failureState: failureStateFilter,
        resourceId: resourceIdFilter,
        page: String(page),
        pageSize: String(pageSize),
      })
      if (createdFrom) params.set("createdFrom", createdFrom)
      if (createdTo) params.set("createdTo", createdTo)
      const data = await fetchJson<{ data?: XeroOperation[]; total?: number }>(`/api/admin/xero/operations?${params.toString()}`, undefined, "Failed to fetch Xero operations")
      setOperations(data.data ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero operation history")
    } finally {
      setLoading(false)
    }
  }, [
    createdFrom,
    createdTo,
    entityFilter,
    failureStateFilter,
    localIdFilter,
    localModelFilter,
    operationTypeFilter,
    page,
    resourceIdFilter,
    statusFilter,
  ])

  useEffect(() => {
    if (connected && open) void fetchOperations()
  }, [connected, fetchOperations, open])

  useEffect(() => {
    if (connected && open && refreshToken !== 0) void fetchOperations()
  }, [connected, fetchOperations, open, refreshToken])

  const retryOperation = async (operationId: string) => {
    setRetryingOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(`/api/admin/xero/operations/${operationId}/retry`, undefined, "Failed to retry Xero operation")
      onMessage(data.message || "Xero operation queued for background retry.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry Xero operation")
    } finally {
      setRetryingOperationId(null)
    }
  }

  const markNonReplayable = async (operationId: string) => {
    const reason = await prompt({
      title: "Mark this Xero operation non-replayable?",
      description: "Why is this operation not safe to replay?",
      inputLabel: "Reason",
      defaultValue: "Reviewed from Xero operations dashboard",
      confirmLabel: "Mark non-replayable",
    })
    if (reason === null) return
    setMarkingNonReplayableOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(
        `/api/admin/xero/operations/${operationId}/mark-non-replayable`,
        { reason },
        "Failed to mark Xero operation non-replayable"
      )
      onMessage(data.message || "Xero operation marked non-replayable.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark Xero operation non-replayable")
    } finally {
      setMarkingNonReplayableOperationId(null)
    }
  }

  const retryAllFailed = async () => {
    setRetryingAllFailed(true)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>("/api/admin/xero/operations/retry-all", undefined, "Failed to queue failed Xero operations")
      onMessage(data.message || "Queued failed Xero operations for retry.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue failed Xero operations")
    } finally {
      setRetryingAllFailed(false)
    }
  }

  const resolveOperation = async (operationId: string) => {
    const reason = await prompt({
      title: "Resolve this Xero operation?",
      description: "How was this resolved in Xero? This drops it off the active failure list.",
      inputLabel: "Reason",
      defaultValue: "Resolved manually in Xero",
      confirmLabel: "Resolve",
    })
    if (reason === null) return
    setResolvingOperationId(operationId)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(
        `/api/admin/xero/operations/${operationId}/resolve`,
        { reason },
        "Failed to resolve Xero operation"
      )
      onMessage(data.message || "Xero operation marked resolved.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve Xero operation")
    } finally {
      setResolvingOperationId(null)
    }
  }

  const resetStaleRunning = async () => {
    setResettingStale(true)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>("/api/admin/xero/operations/reset-stale-running", undefined, "Failed to reset stale running Xero operations")
      onMessage(data.message || "Reset stale running Xero operations.")
      await fetchOperations()
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset stale running Xero operations")
    } finally {
      setResettingStale(false)
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack —
    and outside `SectionCard`, whose children are unmounted while the section is
    collapsed but whose `actions` buttons stay on screen — so the empty wrapper
    an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view Xero operations but cannot retry, reset, or
      resolve them.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
    <SectionCard
      id="xero-section-operations"
      title="Xero Operations"
      description="Recent outbound sync attempts and replayable failures."
      open={open}
      onToggle={(nextOpen) => onToggle("operations", nextOpen)}
      actions={
        <>
          <ViewOnlyActionButton canEdit={canEdit} describeReason={false} size="sm" onClick={() => void retryAllFailed()} disabled={retryingAllFailed}>
            {retryingAllFailed ? "Queueing..." : "Retry Active Failed"}
          </ViewOnlyActionButton>
          <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => void resetStaleRunning()} disabled={resettingStale}>
            {resettingStale ? "Resetting..." : "Reset stale running"}
          </ViewOnlyActionButton>
          <Button variant="outline" size="sm" onClick={() => void fetchOperations()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {confirmDialog}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <details className="rounded-md border bg-muted p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">What do these statuses mean?</summary>
          <ul className="mt-2 space-y-1">
            <li><span className="font-medium">PENDING</span> — queued, waiting for the next sync run. No action needed.</li>
            <li><span className="font-medium">RUNNING</span> — being sent to Xero now. If it stays running for a long time it is stale — use &ldquo;Reset stale running&rdquo; above.</li>
            <li><span className="font-medium">WAITING_PAYMENT</span> — paused until the related payment settles. No action needed.</li>
            <li><span className="font-medium">SUCCEEDED</span> — completed in Xero. No action needed.</li>
            <li><span className="font-medium">PARTIAL</span> — some steps succeeded; retry to finish the rest.</li>
            <li><span className="font-medium">FAILED</span> — could not complete. Open the row for the error, fix the cause if needed, then Retry. Use &ldquo;Retry Active Failed&rdquo; to requeue all replayable failures.</li>
          </ul>
        </details>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <FilterSelect label="Status" value={statusFilter} onValueChange={(value) => { setStatusFilter(value); resetPage() }} values={["all", "FAILED", "PENDING", "PARTIAL", "RUNNING", "WAITING_PAYMENT", "SUCCEEDED"]} />
          <FilterSelect label="Entity" value={entityFilter} onValueChange={(value) => { setEntityFilter(value); resetPage() }} values={["all", "CONTACT", "CONTACT_GROUP", "INVOICE", "PAYMENT", "CREDIT_NOTE", "ALLOCATION", "SUBSCRIPTION"]} />
          <FilterSelect label="Local Model" value={localModelFilter} onValueChange={(value) => { setLocalModelFilter(value); resetPage() }} values={["all", "Member", "Booking", "Payment", "BookingModification", "MemberSubscription"]} />
          <FilterSelect label="Failure" value={failureStateFilter} onValueChange={(value) => { setFailureStateFilter(value); resetPage() }} values={["all", "ACTIVE", "REPAIRED", "SUPERSEDED"]} />
          <DatasetResetButton disabled={isDatasetDefault} onReset={resetDataset} />
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-local-id">Local ID</Label>
            <Input id="xero-op-local-id" value={localIdFilter} onChange={(event) => { setLocalIdFilter(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-operation-type">Operation</Label>
            <Input id="xero-op-operation-type" value={operationTypeFilter === "all" ? "" : operationTypeFilter} onChange={(event) => { setOperationTypeFilter(event.target.value || "all"); resetPage() }} {...operationTypeHint.fieldProps} />
            <FieldHint {...operationTypeHint.hintProps}>Example: CREATE</FieldHint>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-resource-id">Resource ID</Label>
            <Input id="xero-op-resource-id" value={resourceIdFilter} onChange={(event) => { setResourceIdFilter(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-created-from">Created From</Label>
            <Input id="xero-op-created-from" type="date" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); resetPage() }} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="xero-op-created-to">Created To</Label>
            <Input id="xero-op-created-to" type="date" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); resetPage() }} />
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading recent operations...</p>
        ) : operations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Xero operations recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {operations.map((operation) => (
              <OperationItem
                key={operation.id}
                operation={operation}
                canEdit={canEdit}
                retrying={retryingOperationId === operation.id}
                markingNonReplayable={markingNonReplayableOperationId === operation.id}
                resolving={resolvingOperationId === operation.id}
                onRetry={() => void retryOperation(operation.id)}
                onMarkNonReplayable={() => void markNonReplayable(operation.id)}
                onResolve={() => void resolveOperation(operation.id)}
              />
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
    </div>
  )
}

export function OperationItem({
  operation,
  canEdit,
  retrying,
  markingNonReplayable,
  resolving,
  onRetry,
  onMarkNonReplayable,
  onResolve,
}: {
  operation: XeroOperation
  /** Whether the actor may act on the operation (finance edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined
  retrying: boolean
  markingNonReplayable: boolean
  resolving: boolean
  onRetry: () => void
  onMarkNonReplayable: () => void
  onResolve: () => void
}) {
  // `createdAt` is a real INSTANT: shown in the club's persisted zone, so the
  // same operation reads identically wherever the admin is (CT-4, #2870).
  const clubTime = useClubTime()
  const resolved = Boolean(operation.manuallyResolvedAt)
  const isFailedOrPartial = operation.status === "FAILED" || operation.status === "PARTIAL"
  const [showRaw, setShowRaw] = useState(false)
  const summary = summarizeXeroOperation({
    entityType: operation.entityType,
    operationType: operation.operationType,
    requestPayload: operation.requestPayload,
    responsePayload: operation.responsePayload,
  })
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <OperationStatusChip status={operation.status} />
        {resolved ? (
          <ToneChip tone="success" icon={CheckCircle2}>Resolved in Xero</ToneChip>
        ) : operation.failureState ? (
          <FailureStateChip state={operation.failureState} />
        ) : null}
        <span className="text-sm font-medium">{operation.entityType} {operation.operationType}</span>
        <span className="text-xs text-muted-foreground">{clubTime.instantDateTime(requireInstant(operation.createdAt))}</span>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>Direction: {operation.direction}</span>
        <span>Attempt: {operation.attemptCount}</span>
        {operation.localModel ? (
          <span>
            Local:{" "}
            {operation.localUrl ? (
              <a href={operation.localUrl} className="text-primary hover:underline">{operation.localModel} {shortId(operation.localId)}</a>
            ) : (
              `${operation.localModel} ${shortId(operation.localId)}`
            )}
          </span>
        ) : null}
        {operation.xeroObjectId ? (
          <span>
            Xero:{" "}
            {operation.xeroObjectUrl ? (
              <a href={operation.xeroObjectUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {operation.xeroObjectNumber || shortId(operation.xeroObjectId)}
              </a>
            ) : (
              operation.xeroObjectNumber || shortId(operation.xeroObjectId)
            )}
          </span>
        ) : null}
      </div>
      {operation.lastErrorMessage ? (
        <p className="text-sm text-danger">
          {operation.lastErrorCode ? `${operation.lastErrorCode}: ` : ""}
          {redactSensitiveText(operation.lastErrorMessage)}
        </p>
      ) : null}
      {operation.failureStateReason && operation.status === "FAILED" && !resolved ? <p className="text-xs text-muted-foreground">{operation.failureStateReason}</p> : null}
      {resolved ? (
        <p className="text-xs text-success">
          Resolved in Xero{operation.manuallyResolvedReason ? `: ${operation.manuallyResolvedReason}` : ""}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {operation.supported && operation.failureState !== "REPAIRED" && operation.failureState !== "SUPERSEDED" ? (
            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              {retrying ? "Queueing..." : "Retry in background"}
            </ViewOnlyActionButton>
          ) : operation.reason && isFailedOrPartial ? (
            <p className="text-xs text-muted-foreground">{operation.reason}</p>
          ) : null}
          {operation.replayable && isFailedOrPartial ? (
            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={onMarkNonReplayable} disabled={markingNonReplayable}>
              {markingNonReplayable ? "Archiving..." : "Mark non-replayable"}
            </ViewOnlyActionButton>
          ) : null}
          {isFailedOrPartial ? (
            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={onResolve} disabled={resolving}>
              {resolving ? "Resolving..." : "Resolve (fixed in Xero)"}
            </ViewOnlyActionButton>
          ) : null}
        </div>
      )}
      {summary ? (
        <div className="rounded-md bg-muted p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">{summary.title}</p>
            <button
              type="button"
              onClick={() => setShowRaw((value) => !value)}
              className="rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={showRaw}
            >
              {showRaw ? "Hide raw JSON" : "Show raw JSON"}
            </button>
          </div>
          {summary.facts.length > 0 ? (
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {summary.facts.map((fact, index) => (
                <div key={`${fact.label}-${index}`} className="flex gap-1">
                  <dt className="shrink-0 text-muted-foreground">{fact.label}:</dt>
                  <dd className="min-w-0 break-words font-medium text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {showRaw ? <RawPayloads operation={operation} className="mt-3" /> : null}
        </div>
      ) : (
        <details className="rounded-md bg-muted p-2">
          <summary className="cursor-pointer text-xs font-medium text-foreground">View request / response payloads</summary>
          <RawPayloads operation={operation} className="mt-2" />
        </details>
      )}
    </div>
  )
}

function RawPayloads({ operation, className }: { operation: XeroOperation; className?: string }) {
  return (
    <div className={`grid gap-3 lg:grid-cols-2${className ? ` ${className}` : ""}`}>
      <div>
        <p className="mb-1 text-xs font-medium text-foreground">Request</p>
        <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-[11px]">{formatJson(operation.requestPayload)}</pre>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-foreground">Response</p>
        <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-[11px]">{formatJson(operation.responsePayload)}</pre>
      </div>
    </div>
  )
}
