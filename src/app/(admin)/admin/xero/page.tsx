"use client"

import { useEffect, useState, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

interface XeroStatus {
  connected: boolean
  tenantId: string | null
  tokenExpiresAt: string | null
}

interface SyncResult {
  total?: number
  matched?: number
  updated?: number
  checked?: number
  errors?: number
  message?: string
}

export default function XeroPage() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<XeroStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState("")

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/xero/status")
      if (!res.ok) throw new Error("Failed to fetch status")
      const data = await res.json()
      setStatus(data)
    } catch {
      setError("Failed to load Xero connection status")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    const connected = searchParams.get("connected")
    const errorParam = searchParams.get("error")
    if (connected === "true") {
      fetchStatus()
    }
    if (errorParam) {
      setError(decodeURIComponent(errorParam))
    }
  }, [searchParams, fetchStatus])

  const handleConnect = () => {
    window.location.href = "/api/admin/xero/connect"
  }

  const handleDisconnect = async () => {
    if (!confirm("Are you sure you want to disconnect Xero? This will remove all stored tokens.")) {
      return
    }
    try {
      const res = await fetch("/api/admin/xero/disconnect", { method: "POST" })
      if (!res.ok) throw new Error("Failed to disconnect")
      setStatus({ connected: false, tenantId: null, tokenExpiresAt: null })
      setSyncResult(null)
    } catch {
      setError("Failed to disconnect Xero")
    }
  }

  const handleSyncContacts = async () => {
    setSyncing("contacts")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/sync-contacts", { method: "POST" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Sync failed")
      }
      const data = await res.json()
      setSyncResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Contact sync failed")
    } finally {
      setSyncing(null)
    }
  }

  const handleSyncMemberships = async () => {
    setSyncing("memberships")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/sync-memberships", { method: "POST" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Sync failed")
      }
      const data = await res.json()
      setSyncResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Membership sync failed")
    } finally {
      setSyncing(null)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Xero Integration</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-2">Xero Integration</h1>
      <p className="text-muted-foreground mb-6">
        Connect to Xero for automatic invoice creation, membership verification, and contact sync.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {searchParams.get("connected") === "true" && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">
          Xero connected successfully!
        </div>
      )}

      {/* Connection Status */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Connection Status
            {status?.connected ? (
              <Badge variant="default" className="bg-green-600">Connected</Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {status?.connected
              ? "Xero is connected and ready for syncing."
              : "Connect your Xero organisation to enable accounting integration."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status?.connected ? (
            <div className="space-y-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Tenant ID:</span>{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  {status.tenantId}
                </code>
              </div>
              {status.tokenExpiresAt && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Token expires:</span>{" "}
                  {new Date(status.tokenExpiresAt).toLocaleString("en-NZ")}
                  <span className="text-muted-foreground ml-1">(auto-refreshes)</span>
                </div>
              )}
              <Button variant="destructive" size="sm" onClick={handleDisconnect}>
                Disconnect Xero
              </Button>
            </div>
          ) : (
            <Button onClick={handleConnect}>Connect Xero</Button>
          )}
        </CardContent>
      </Card>

      {/* Sync Operations - only show when connected */}
      {status?.connected && (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Contact Sync</CardTitle>
              <CardDescription>
                Import contacts from Xero and match them with local members by email address.
                This links Xero contact IDs to member records for invoice creation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleSyncContacts}
                disabled={syncing !== null}
              >
                {syncing === "contacts" ? "Syncing..." : "Sync Contacts from Xero"}
              </Button>
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Membership Status Refresh</CardTitle>
              <CardDescription>
                Check Xero invoices for all active members and update their subscription status
                for the current season year. This runs automatically as a daily cron job.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleSyncMemberships}
                disabled={syncing !== null}
              >
                {syncing === "memberships" ? "Refreshing..." : "Refresh Membership Statuses"}
              </Button>
            </CardContent>
          </Card>

          {/* Sync Results */}
          {syncResult && (
            <Card>
              <CardHeader>
                <CardTitle>Sync Results</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  {syncResult.message && <p>{syncResult.message}</p>}
                  {syncResult.total !== undefined && (
                    <p>
                      <span className="text-muted-foreground">Total Xero contacts:</span>{" "}
                      {syncResult.total}
                    </p>
                  )}
                  {syncResult.matched !== undefined && (
                    <p>
                      <span className="text-muted-foreground">Matched to members:</span>{" "}
                      {syncResult.matched}
                    </p>
                  )}
                  {syncResult.updated !== undefined && (
                    <p>
                      <span className="text-muted-foreground">Records updated:</span>{" "}
                      {syncResult.updated}
                    </p>
                  )}
                  {syncResult.checked !== undefined && (
                    <p>
                      <span className="text-muted-foreground">Members checked:</span>{" "}
                      {syncResult.checked}
                    </p>
                  )}
                  {syncResult.errors !== undefined && syncResult.errors > 0 && (
                    <p className="text-red-600">
                      <span className="text-muted-foreground">Errors:</span>{" "}
                      {syncResult.errors}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Separator className="my-6" />

          <div className="text-sm text-muted-foreground space-y-2">
            <h3 className="font-medium text-foreground">How it works</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>
                <strong>Invoice creation:</strong> When a booking is confirmed and paid,
                an invoice is automatically created in Xero with line items per guest.
              </li>
              <li>
                <strong>Credit notes:</strong> When a booking is cancelled and refunded,
                a credit note is created against the original invoice.
              </li>
              <li>
                <strong>Membership verification:</strong> A daily cron job checks Xero
                invoices to verify each member&apos;s subscription is paid for the current season.
              </li>
              <li>
                <strong>Contact sync:</strong> Members are matched to Xero contacts by email.
                New contacts are created automatically when invoices are generated.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
