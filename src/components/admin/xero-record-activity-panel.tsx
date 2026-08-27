"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatRedactedJson,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { cn } from "@/lib/utils";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import type {
  XeroRecordActivityData,
  XeroRecordActivityOperation,
} from "@/lib/xero-record-types";
import { useClubTime } from "@/components/club-time-provider";

interface XeroRecordActivityPanelProps {
  localModel: string
  localId: string
  initialData?: XeroRecordActivityData | null
  compact?: boolean
  className?: string
}

function operationStatusClass(status: string) {
  switch (status) {
    case "SUCCEEDED":
      return "bg-success text-success-foreground"
    case "PARTIAL":
      return "bg-warning text-warning-foreground"
    case "FAILED":
      return "bg-danger text-danger-foreground"
    case "PENDING":
      // Neutral "queued" state: a solid foreground-on-background chip that
      // inverts with the theme (no raw slate), distinct from the four coloured
      // role fills above/below.
      return "bg-foreground text-background"
    case "RUNNING":
      return "bg-info text-info-foreground"
    default:
      return ""
  }
}

function formatJson(value: unknown) {
  return formatRedactedJson(value)
}

function shortId(value: string | null | undefined) {
  if (!value) {
    return "-"
  }

  return value.length > 12 ? `${value.slice(0, 12)}...` : value
}

/**
 * A Xero sync stamp, read against the CLUB's day and with no seconds (#2264).
 *
 * The stamp is a real INSTANT, so it projects through the club's PERSISTED
 * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. Same
 * shape as before - only the zone's AUTHORITY moved. A hook because that setting
 * reaches the browser as data through `ClubTimeProvider` and is no longer a
 * module constant.
 */
function useXeroTimestampFormatter() {
  const clubTime = useClubTime()
  return (value: string | null | undefined) =>
    value ? clubTime.instantDateTime(new Date(value)) : "-"
}

function OperationItem({
  operation,
  compact,
  onRetry,
  retrying,
  canEdit,
}: {
  operation: XeroRecordActivityOperation
  compact: boolean
  onRetry: (operationId: string) => Promise<void>
  retrying: boolean
  canEdit: boolean | undefined
}) {
  const formatTimestamp = useXeroTimestampFormatter()
  return (
    <div className={cn("rounded-md border p-3", compact ? "space-y-2" : "space-y-3")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" className={operationStatusClass(operation.status)}>
          {operation.status}
        </Badge>
        <span className="text-sm font-medium">
          {operation.entityType} {operation.operationType}
        </span>
        <span className="text-xs text-muted-foreground">{formatTimestamp(operation.createdAt)}</span>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>Direction: {operation.direction}</span>
        <span>Attempt: {operation.attemptCount}</span>
        {operation.localModel && (
          <span>
            Local:{" "}
            {operation.localUrl ? (
              <Link href={operation.localUrl} className="text-info-11 hover:underline">
                {operation.localLabel ?? `${operation.localModel} ${shortId(operation.localId)}`}
              </Link>
            ) : (
              operation.localLabel ?? `${operation.localModel} ${shortId(operation.localId)}`
            )}
          </span>
        )}
        {operation.xeroObjectId && (
          <span>
            Xero:{" "}
            {operation.xeroObjectUrl ? (
              <a
                href={operation.xeroObjectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-info-11 hover:underline"
              >
                {operation.xeroObjectNumber || shortId(operation.xeroObjectId)}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              operation.xeroObjectNumber || shortId(operation.xeroObjectId)
            )}
          </span>
        )}
      </div>

      {operation.lastErrorMessage && (
        <p className="text-sm text-danger-11">
          {operation.lastErrorCode ? `${operation.lastErrorCode}: ` : ""}
          {redactSensitiveText(operation.lastErrorMessage)}
        </p>
      )}

      {!compact && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {operation.supported ? (
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                onClick={() => void onRetry(operation.id)}
                disabled={retrying}
              >
                {retrying ? "Queueing..." : "Retry in background"}
              </ViewOnlyActionButton>
            ) : operation.reason && (operation.status === "FAILED" || operation.status === "PARTIAL") ? (
              <p className="text-xs text-muted-foreground">{operation.reason}</p>
            ) : null}
          </div>

          <details className="rounded-md bg-muted p-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              View request / response payloads
            </summary>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Request</p>
                <pre className="max-h-64 overflow-auto rounded border bg-card p-2 text-[11px]">
                  {formatJson(operation.requestPayload)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Response</p>
                <pre className="max-h-64 overflow-auto rounded border bg-card p-2 text-[11px]">
                  {formatJson(operation.responsePayload)}
                </pre>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

export function XeroRecordActivityPanel({
  localModel,
  localId,
  initialData = null,
  compact = false,
  className,
}: XeroRecordActivityPanelProps) {
  const formatTimestamp = useXeroTimestampFormatter()
  // Record-scoped Xero retry/replay are finance-area writes; a finance:view
  // admin sees the activity read-only (#1940). The retry/replay routes enforce
  // finance:edit.
  const canEdit = useAdminAreaEditAccess("finance")
  const [data, setData] = useState<XeroRecordActivityData | null>(initialData)
  const [loading, setLoading] = useState(!initialData)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [replayingInboundEventId, setReplayingInboundEventId] = useState<string | null>(null)

  const loadActivity = useCallback(async (showLoading: boolean) => {
    if (showLoading) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }

    try {
      const res = await fetch(
        `/api/admin/xero/records/${encodeURIComponent(localModel)}/${encodeURIComponent(localId)}`
      )
      const payload = await res.json()
      if (!res.ok) {
        throw new Error(payload.error || "Failed to load Xero activity")
      }

      setData(payload.data ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Xero activity")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [localId, localModel])

  useEffect(() => {
    if (initialData) {
      setData(initialData)
      setLoading(false)
      return
    }

    void loadActivity(true)
  }, [initialData, loadActivity])

  async function handleRetry(operationId: string) {
    setRetryingOperationId(operationId)
    setMessage(null)
    setError(null)

    try {
      const res = await fetch(`/api/admin/xero/operations/${operationId}/retry`, {
        method: "POST",
      })
      if (res.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON)
      }
      const payload = await res.json()
      if (!res.ok) {
        throw new Error(payload.error || "Failed to retry Xero operation")
      }

      setMessage(payload.message || "Xero operation queued for background retry.")
      await loadActivity(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry Xero operation")
    } finally {
      setRetryingOperationId(null)
    }
  }

  async function handleReplayInboundEvent(eventId: string) {
    setReplayingInboundEventId(eventId)
    setMessage(null)
    setError(null)

    try {
      const res = await fetch(`/api/admin/xero/inbound-events/${eventId}/replay`, {
        method: "POST",
      })
      if (res.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON)
      }
      const payload = await res.json()
      if (!res.ok) {
        throw new Error(payload.error || "Failed to replay Xero inbound event")
      }

      setMessage(payload.message || "Xero inbound event replayed.")
      await loadActivity(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replay Xero inbound event")
    } finally {
      setReplayingInboundEventId(null)
    }
  }

  function inboundEventActionLabel(status: string) {
    return status === "PROCESSED" ? "Replay" : "Retry"
  }

  const activityUrl = buildXeroRecordActivityUrl(localModel, localId)
  const visibleOperations = compact ? data?.operations.slice(0, 5) ?? [] : data?.operations ?? []
  const visibleLinks = compact ? data?.links.filter((link) => link.active).slice(0, 4) ?? [] : data?.links ?? []

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout. The compact and
    full layouts below are two renderings of the SAME section, so they share one
    banner rather than declaring one each.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view Xero activity but cannot retry or replay
      operations. Finance edit access is required.
    </AdminViewOnlySectionBanner>
  )

  if (compact) {
    return (
      <div>
        {viewOnlyBanner}
      <Card className={className}>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base font-medium">Xero Activity</CardTitle>
            <CardDescription>Recent sync operations, invoices, and contact links for this member.</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={activityUrl}>Full Activity</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {message && (
            <div className="rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
              {message}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
              {error}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading Xero activity...</p>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">No Xero activity recorded for this member yet.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-5">
                <div className="rounded-lg border bg-muted p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Operations</p>
                  <p className="text-lg font-semibold text-foreground">{data.summary.totalOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Failed</p>
                  <p className="text-lg font-semibold text-danger-11">{data.summary.failedOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Partial</p>
                  <p className="text-lg font-semibold text-warning-11">{data.summary.partialOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending / Running</p>
                  <p className="text-lg font-semibold text-foreground">{data.summary.pendingOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Active Links</p>
                  <p className="text-lg font-semibold text-foreground">{data.summary.activeLinks}</p>
                </div>
              </div>

              {visibleLinks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current Xero Links</p>
                  <div className="flex flex-wrap gap-2">
                    {visibleLinks.map((link) => (
                      <a
                        key={link.id}
                        href={link.xeroObjectUrl ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-info-11 hover:bg-info-3"
                      >
                        {link.role}
                        <span className="text-muted-foreground">•</span>
                        {link.xeroObjectNumber || shortId(link.xeroObjectId)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Operations</p>
                {visibleOperations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No Xero operations recorded yet.</p>
                ) : (
                  <div className="space-y-2">
                    {visibleOperations.map((operation) => (
                      <OperationItem
                        key={operation.id}
                        operation={operation}
                        compact
                        onRetry={handleRetry}
                        retrying={retryingOperationId === operation.id}
                        canEdit={canEdit}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      </div>
    )
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className={cn("space-y-6", className)}>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>Record-Scoped Xero Activity</CardTitle>
            <CardDescription>
              Operations and object links for {data?.rootRecord.label ?? "this record"} and its included Xero scope.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadActivity(false)} disabled={refreshing}>
            <RefreshCw className={cn("h-4 w-4", refreshing ? "animate-spin" : "")} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {message && (
            <div className="rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
              {message}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
              {error}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading Xero activity...</p>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">No Xero activity recorded for this record yet.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-5">
                <div className="rounded-lg border bg-muted p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Operations</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground">{data.summary.totalOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Failed</p>
                  <p className="mt-1 text-2xl font-semibold text-danger-11">{data.summary.failedOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Partial</p>
                  <p className="mt-1 text-2xl font-semibold text-warning-11">{data.summary.partialOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending / Running</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground">{data.summary.pendingOperations}</p>
                </div>
                <div className="rounded-lg border bg-muted p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Active Links</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground">{data.summary.activeLinks}</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Scope</p>
                <div className="flex flex-wrap gap-2">
                  {data.scopeRecords.map((record) => (
                    <Link
                      key={`${record.localModel}:${record.localId}`}
                      href={buildXeroRecordActivityUrl(record.localModel, record.localId)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs",
                        record.localModel === localModel && record.localId === localId
                          ? "border-foreground bg-foreground text-background"
                          : "text-muted-foreground hover:bg-accent"
                      )}
                    >
                      {record.relation}: {record.label}
                    </Link>
                  ))}
                </div>
              </div>

              {data.relatedRecords.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Related Records</p>
                  <div className="flex flex-wrap gap-2">
                    {data.relatedRecords.map((record) => (
                      <Link
                        key={`${record.localModel}:${record.localId}`}
                        href={record.url ?? buildXeroRecordActivityUrl(record.localModel, record.localId)}
                        className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
                      >
                        {record.relation}: {record.label}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Xero Object Links</CardTitle>
          <CardDescription>
            Canonical invoice, credit note, contact, and allocation links already attached to this record scope.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading Xero links...</p>
          ) : !data || data.links.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Xero object links recorded for this scope yet.</p>
          ) : (
            <div className="space-y-3">
              {data.links.map((link) => (
                <div key={link.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{link.role}</Badge>
                    <Badge variant="outline">{link.xeroObjectType}</Badge>
                    <Badge
                      variant="secondary"
                      className={link.active ? "bg-success-3 text-success-11 border-success-6" : "bg-muted text-muted-foreground"}
                    >
                      {link.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
                    <span>
                      Local:{" "}
                      {link.localUrl ? (
                        <Link href={link.localUrl} className="text-info-11 hover:underline">
                          {link.localLabel ?? `${link.localModel} ${shortId(link.localId)}`}
                        </Link>
                      ) : (
                        link.localLabel ?? `${link.localModel} ${shortId(link.localId)}`
                      )}
                    </span>
                    <span>
                      Xero:{" "}
                      {link.xeroObjectUrl ? (
                        <a
                          href={link.xeroObjectUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-info-11 hover:underline"
                        >
                          {link.xeroObjectNumber || shortId(link.xeroObjectId)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        link.xeroObjectNumber || shortId(link.xeroObjectId)
                      )}
                    </span>
                    <span>Recorded: {formatTimestamp(link.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operations</CardTitle>
          <CardDescription>
            {data && data.summary.totalOperations > data.operations.length
              ? `Showing the latest ${data.operations.length} of ${data.summary.totalOperations} operations in this scope.`
              : "Latest Xero sync attempts for this scope."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading Xero operations...</p>
          ) : !data || data.operations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Xero operations recorded for this scope yet.</p>
          ) : (
            <div className="space-y-3">
              {data.operations.map((operation) => (
                  <OperationItem
                    key={operation.id}
                    operation={operation}
                    compact={false}
                    onRetry={handleRetry}
                    retrying={retryingOperationId === operation.id}
                    canEdit={canEdit}
                  />
                ))}
              </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inbound Events</CardTitle>
          <CardDescription>
            Stored Xero webhook events that match the current record scope. Replay them here after
            handler changes or to retry a failed reconciliation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading stored inbound events...</p>
          ) : !data || data.inboundEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stored inbound events matched this scope yet.</p>
          ) : (
            <div className="space-y-3">
              {data.inboundEvents.map((event) => (
                <div key={event.id} className="rounded-md border p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="default" className={operationStatusClass(event.status)}>
                      {event.status}
                    </Badge>
                    <span className="text-sm font-medium">
                      {event.eventCategory ?? "UNKNOWN"} {event.eventType}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatTimestamp(event.createdAt)}</span>
                  </div>

                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span>Source: {event.source}</span>
                    <span>
                      Correlation: <code>{shortId(event.correlationKey)}</code>
                    </span>
                    {event.resourceId && (
                      <span>
                        Resource:{" "}
                        {event.xeroObjectUrl ? (
                          <a
                            href={event.xeroObjectUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-info-11 hover:underline"
                          >
                            {shortId(event.resourceId)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          shortId(event.resourceId)
                        )}
                      </span>
                    )}
                    {event.processedAt && <span>Processed: {formatTimestamp(event.processedAt)}</span>}
                  </div>

                  {event.errorMessage && (
                    <p className="text-sm text-danger-11">{event.errorMessage}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      onClick={() => void handleReplayInboundEvent(event.id)}
                      disabled={!event.canReplay || replayingInboundEventId === event.id}
                    >
                      {replayingInboundEventId === event.id
                        ? "Replaying..."
                        : inboundEventActionLabel(event.status)}
                    </ViewOnlyActionButton>
                    {!event.canReplay && (
                      <p className="text-xs text-muted-foreground">
                        This event is currently being processed.
                      </p>
                    )}
                  </div>

                  <details className="rounded-md bg-muted p-2">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                      View stored payload
                    </summary>
                    <div className="mt-2">
                      <pre className="max-h-64 overflow-auto rounded border bg-card p-2 text-[11px]">
                        {formatJson(event.payload)}
                      </pre>
                    </div>
                  </details>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  )
}
