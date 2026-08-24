"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { SemanticTone } from "@/lib/chip-tones"
import type { LucideIcon } from "lucide-react"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { ToneChip } from "./shared"
import type { XeroConnectionProbe, XeroStatus, XeroTokenHealth } from "./types"

// Presentation for each probed health state. reconnect_required / rate_limited
// are warnings (actionable), error is a hard failure.
const HEALTH_PRESENTATION: Record<
  XeroTokenHealth,
  { tone: SemanticTone; icon: LucideIcon; label: string; showReconnect: boolean }
> = {
  ok: { tone: "success", icon: CheckCircle2, label: "Connection healthy", showReconnect: false },
  reconnect_required: {
    tone: "warning",
    icon: AlertTriangle,
    label: "Reconnect required",
    showReconnect: true,
  },
  rate_limited: {
    tone: "warning",
    icon: AlertTriangle,
    label: "Xero daily limit reached",
    showReconnect: false,
  },
  error: { tone: "danger", icon: XCircle, label: "Connection check failed", showReconnect: false },
}

export function ConnectionStatusPanel({
  status,
  onConnect,
  onDisconnect,
  canEdit = true,
}: {
  status: XeroStatus | null
  onConnect: () => void
  onDisconnect: () => void
  /**
   * Tri-state finance-edit access for the connect/reconnect/disconnect controls
   * (#2080 review): `undefined` while the session resolves (disabled, neutral),
   * `false` view-only (disabled), `true` may edit. Defaults to `true` so the
   * standalone Xero page — which does its own gating — is unchanged. The wizard
   * passes the real value and relies on its own view-only banner to explain.
   */
  canEdit?: boolean | undefined
}) {
  // The token expiry is a real INSTANT, shown in the club's persisted zone so
  // an admin abroad reads the same moment as one at the lodge (CT-4, #2870).
  const clubTime = useClubTime()
  const { confirm, confirmDialog } = useConfirm()
  // Disabled until we positively know editing is allowed, so the resolving
  // window (undefined) is a neutral disabled state, matching ViewOnlyActionButton.
  const editDisabled = canEdit !== true
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<XeroConnectionProbe | null>(null)
  const [probeError, setProbeError] = useState(false)

  // Click-only (#2105): the live probe never runs on mount or a poll — only
  // when the admin presses "Check connection".
  async function handleCheckConnection() {
    setProbing(true)
    setProbeError(false)
    try {
      const res = await fetch("/api/admin/xero/status?probe=1")
      if (!res.ok) throw new Error("probe failed")
      const data = await res.json()
      setProbe((data.probe as XeroConnectionProbe) ?? null)
    } catch {
      setProbe(null)
      setProbeError(true)
    } finally {
      setProbing(false)
    }
  }

  const presentation = probe ? HEALTH_PRESENTATION[probe.tokenHealth] : null

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Connection Status
          {status?.connected ? (
            <ToneChip tone="success" icon={CheckCircle2}>
              Connected
            </ToneChip>
          ) : (
            <ToneChip tone="neutral" icon={Circle}>
              Not Connected
            </ToneChip>
          )}
        </CardTitle>
        <CardDescription>
          {status?.connected
            ? "Xero is connected for operational syncs. Finance report scope readiness is verified by finance sync diagnostics; reconnect Xero if report syncs fail with missing-scope guidance."
            : "Connect your Xero organisation to enable accounting integration."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status?.connected ? (
          <div className="space-y-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Tenant ID:</span>{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{status.tenantId}</code>
            </div>
            {status.tokenExpiresAt ? (
              <div className="text-sm">
                <span className="text-muted-foreground">Token expires:</span>{" "}
                {clubTime.instantDateTime(requireInstant(status.tokenExpiresAt))}
                <span className="ml-1 text-muted-foreground">(auto-refreshes)</span>
              </div>
            ) : null}

            {/* Live connection-health check. The green "Connected" chip above
                reflects token-row presence only; this button actually exercises
                the refresh + a cheap org read (#2105). */}
            <div className="space-y-2 rounded-md border border-border bg-muted p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCheckConnection}
                  disabled={probing}
                >
                  {probing ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                      Checking…
                    </>
                  ) : (
                    "Check connection"
                  )}
                </Button>
                {presentation ? (
                  <ToneChip tone={presentation.tone} icon={presentation.icon}>
                    {presentation.label}
                  </ToneChip>
                ) : null}
                {presentation?.showReconnect ? (
                  <Button type="button" size="sm" onClick={onConnect} disabled={editDisabled}>
                    Reconnect
                  </Button>
                ) : null}
              </div>
              {probeError ? (
                <p className="text-xs text-danger-11">
                  Couldn&apos;t check the connection. Please try again.
                </p>
              ) : null}
              {probe?.lastErrorMessage ? (
                <p className="text-xs text-muted-foreground">
                  Most recent Xero error:{" "}
                  <code className="rounded bg-muted px-1 py-0.5">{probe.lastErrorMessage}</code>
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Verifies the Xero token can still be refreshed. Runs only when you press the button.
              </p>
            </div>

            {confirmDialog}
            <Button
              variant="destructive"
              size="sm"
              disabled={editDisabled}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Disconnect Xero?",
                    description:
                      "Invoicing, payment reconciliation, subscription (paid-status) detection, and finance syncs that rely on Xero will stop until you reconnect. Your data inside Xero is not changed.",
                    confirmLabel: "Disconnect",
                    destructive: true,
                  })
                ) {
                  onDisconnect()
                }
              }}
            >
              Disconnect Xero
            </Button>
            <p className="text-xs text-muted-foreground">
              Disconnecting stops invoicing, reconciliation, subscription detection,
              and finance syncs until you reconnect. It does not change anything
              inside Xero.
            </p>
          </div>
        ) : status?.needsReentry ? (
          // Tokens exist but no longer decrypt — the auth secret / encryption
          // key changed (e.g. the #2079 env→DB upgrade). This is a reconnect,
          // not a first-time connect.
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Stored Xero tokens can no longer be read because the encryption
                key (derived from the app auth secret) changed. Reconnect Xero to
                re-authorise — no data inside Xero is affected.
              </span>
            </div>
            <Button onClick={onConnect} disabled={editDisabled}>Reconnect Xero</Button>
          </div>
        ) : (
          <Button onClick={onConnect} disabled={editDisabled}>Connect Xero</Button>
        )}
      </CardContent>
    </Card>
  )
}
