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
import { cn } from "@/lib/utils";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import type {
  XeroRecordActivityData,
  XeroRecordActivityOperation,
} from "@/lib/xero-record-types";

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
      return "bg-green-600 text-white"
    case "PARTIAL":
      return "bg-amber-500 text-white"
    case "FAILED":
      return "bg-red-600 text-white"
    case "PENDING":
      return "bg-slate-600 text-white"
    case "RUNNING":
      return "bg-blue-600 text-white"
    default:
      return ""
  }
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? null, null, 2)
}

function shortId(value: string | null | undefined) {
  if (!value) {
    return "-"
  }

  return value.length > 12 ? `${value.slice(0, 12)}...` : value
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "-"
  }

  return new Date(value).toLocaleString("en-NZ")
}

function OperationItem({
  operation,
  compact,
  onRetry,
  onRequeue,
  retrying,
  queueing,
}: {
  operation: XeroRecordActivityOperation
  compact: boolean
  onRetry: (operationId: string) => Promise<void>
  onRequeue: (operationId: string) => Promise<void>
  retrying: boolean
  queueing: boolean
}) {
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
              <Link href={operation.localUrl} className="text-blue-600 hover:underline">
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
                className="inline-flex items-center gap-1 text-blue-600 hover:underline"
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
        <p className="text-sm text-red-700">
          {operation.lastErrorCode ? `${operation.lastErrorCode}: ` : ""}
          {operation.lastErrorMessage}
        </p>
      )}

      {!compact && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {operation.supported ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onRetry(operation.id)}
                  disabled={retrying || queueing}
                >
                  {retrying ? "Retrying..." : "Retry"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onRequeue(operation.id)}
                  disabled={retrying || queueing}
                >
                  {queueing ? "Queueing..." : "Requeue"}
                </Button>
              </>
            ) : operation.reason && (operation.status === "FAILED" || operation.status === "PARTIAL") ? (
              <p className="text-xs text-muted-foreground">{operation.reason}</p>
            ) : null}
          </div>

          <details className="rounded-md bg-slate-50 p-2">
            <summary className="cursor-pointer text-xs font-medium text-slate-700">
              View request / response payloads
            </summary>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-slate-700">Request</p>
                <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">
                  {formatJson(operation.requestPayload)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-slate-700">Response</p>
                <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">
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
  const [data, setData] = useState<XeroRecordActivityData | null>(initialData)
  const [loading, setLoading] = useState(!initialData)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [queueingOperationId, setQueueingOperationId] = useState<string | null>(null)

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
      const payload = await res.json()
      if (!res.ok) {
        throw new Error(payload.error || "Failed to retry Xero operation")
      }

      setMessage(payload.message || "Xero operation retried.")
      await loadActivity(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry Xero operation")
    } finally {
      setRetryingOperationId(null)
    }
  }

  async function handleRequeue(operationId: string) {
    setQueueingOperationId(operationId)
    setMessage(null)
    setError(null)

    try {
      const res = await fetch(`/api/admin/xero/operations/${operationId}/requeue`, {
        method: "POST",
      })
      const payload = await res.json()
      if (!res.ok) {
        throw new Error(payload.error || "Failed to queue Xero operation retry")
      }

      setMessage(payload.message || "Xero operation queued for background retry.")
      await loadActivity(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue Xero operation retry")
    } finally {
      setQueueingOperationId(null)
    }
  }

  const activityUrl = buildXeroRecordActivityUrl(localModel, localId)
  const visibleOperations = compact ? data?.operations.slice(0, 5) ?? [] : data?.operations ?? []
  const visibleLinks = compact ? data?.links.filter((link) => link.active).slice(0, 4) ?? [] : data?.links ?? []

  if (compact) {
    return (
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
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {message}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-slate-500">Loading Xero activity...</p>
          ) : !data ? (
            <p className="text-sm text-slate-500">No Xero activity recorded for this member yet.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Operations</p>
                  <p className="text-lg font-semibold text-slate-900">{data.summary.totalOperations}</p>
                </div>
                <div className="rounded-lg border bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Failed</p>
                  <p className="text-lg font-semibold text-red-700">{data.summary.failedOperations}</p>
                </div>
                <div className="rounded-lg border bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Pending</p>
                  <p className="text-lg font-semibold text-slate-900">{data.summary.pendingOperations}</p>
                </div>
                <div className="rounded-lg border bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Active Links</p>
                  <p className="text-lg font-semibold text-slate-900">{data.summary.activeLinks}</p>
                </div>
              </div>

              {visibleLinks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current Xero Links</p>
                  <div className="flex flex-wrap gap-2">
                    {visibleLinks.map((link) => (
                      <a
                        key={link.id}
                        href={link.xeroObjectUrl ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-blue-700 hover:bg-blue-50"
                      >
                        {link.role}
                        <span className="text-slate-500">•</span>
                        {link.xeroObjectNumber || shortId(link.xeroObjectId)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recent Operations</p>
                {visibleOperations.length === 0 ? (
                  <p className="text-sm text-slate-500">No Xero operations recorded yet.</p>
                ) : (
                  <div className="space-y-2">
                    {visibleOperations.map((operation) => (
                      <OperationItem
                        key={operation.id}
                        operation={operation}
                        compact
                        onRetry={handleRetry}
                        onRequeue={handleRequeue}
                        retrying={retryingOperationId === operation.id}
                        queueing={queueingOperationId === operation.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
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
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {message}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-slate-500">Loading Xero activity...</p>
          ) : !data ? (
            <p className="text-sm text-slate-500">No Xero activity recorded for this record yet.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Total Operations</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{data.summary.totalOperations}</p>
                </div>
                <div className="rounded-lg border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Failed</p>
                  <p className="mt-1 text-2xl font-semibold text-red-700">{data.summary.failedOperations}</p>
                </div>
                <div className="rounded-lg border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Pending / Running</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{data.summary.pendingOperations}</p>
                </div>
                <div className="rounded-lg border bg-slate-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Active Links</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{data.summary.activeLinks}</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Scope</p>
                <div className="flex flex-wrap gap-2">
                  {data.scopeRecords.map((record) => (
                    <Link
                      key={`${record.localModel}:${record.localId}`}
                      href={buildXeroRecordActivityUrl(record.localModel, record.localId)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs",
                        record.localModel === localModel && record.localId === localId
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "text-slate-700 hover:bg-slate-50"
                      )}
                    >
                      {record.relation}: {record.label}
                    </Link>
                  ))}
                </div>
              </div>

              {data.relatedRecords.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Related Records</p>
                  <div className="flex flex-wrap gap-2">
                    {data.relatedRecords.map((record) => (
                      <Link
                        key={`${record.localModel}:${record.localId}`}
                        href={record.url ?? buildXeroRecordActivityUrl(record.localModel, record.localId)}
                        className="rounded-full border px-3 py-1 text-xs text-slate-700 hover:bg-slate-50"
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
            <p className="text-sm text-slate-500">Loading Xero links...</p>
          ) : !data || data.links.length === 0 ? (
            <p className="text-sm text-slate-500">No Xero object links recorded for this scope yet.</p>
          ) : (
            <div className="space-y-3">
              {data.links.map((link) => (
                <div key={link.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{link.role}</Badge>
                    <Badge variant="outline">{link.xeroObjectType}</Badge>
                    <Badge
                      variant="secondary"
                      className={link.active ? "bg-green-100 text-green-800 border-green-200" : "bg-slate-100 text-slate-700"}
                    >
                      {link.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-sm text-slate-600">
                    <span>
                      Local:{" "}
                      {link.localUrl ? (
                        <Link href={link.localUrl} className="text-blue-600 hover:underline">
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
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
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
            <p className="text-sm text-slate-500">Loading Xero operations...</p>
          ) : !data || data.operations.length === 0 ? (
            <p className="text-sm text-slate-500">No Xero operations recorded for this scope yet.</p>
          ) : (
            <div className="space-y-3">
              {data.operations.map((operation) => (
                <OperationItem
                  key={operation.id}
                  operation={operation}
                  compact={false}
                  onRetry={handleRetry}
                  onRequeue={handleRequeue}
                  retrying={retryingOperationId === operation.id}
                  queueing={queueingOperationId === operation.id}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
