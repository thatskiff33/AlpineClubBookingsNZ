"use client"

import { useCallback, useEffect, useState } from "react"
import { useConfirm } from "@/components/confirm-dialog"
import { useClubFormat } from "@/components/club-format-provider"
import { ViewOnlyActionButton, type AncestorViewOnlyBannerProps } from "@/components/admin/view-only-action"
import { formatCents } from "@/lib/utils"
import { fetchJson, postJson } from "./api"
import { shortId } from "./shared"
import type { VoidedRefundRequestNote } from "./types"

/**
 * #4214 (owner decision): the refund requests whose own Xero credit note was
 * voided in Xero with nothing live replacing it, each with "Raise a fresh
 * credit note" - the one way such a note is raised again. Nothing raises one
 * automatically, and no Retry does. Renders nothing while the list is empty.
 */
export function VoidedRequestNotesPanel({
  canEdit,
  refreshToken,
  onMessage,
  onChanged,
  ancestorRendersViewOnlyBanner = false,
}: {
  /** Finance edit (tri-state, #2065): a view-only admin sees the list but cannot act. */
  canEdit: boolean | undefined
  refreshToken: number
  onMessage: (message: string) => void
  onChanged: () => void
} & AncestorViewOnlyBannerProps) {
  const format = useClubFormat()
  const { confirm, confirmDialog } = useConfirm()
  const [requests, setRequests] = useState<VoidedRefundRequestNote[]>([])
  const [loadError, setLoadError] = useState("")
  const [actionError, setActionError] = useState("")
  const [raisingKey, setRaisingKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ data?: VoidedRefundRequestNote[] }>(
        "/api/admin/xero/operations/voided-request-notes",
        undefined,
        "Failed to load voided refund request notes",
      )
      setRequests(data.data ?? [])
      setLoadError("")
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load voided refund request notes")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const raise = async (request: VoidedRefundRequestNote) => {
    const amount = request.amountCents === null ? "" : ` for ${formatCents(request.amountCents, format)}`
    const ok = await confirm({
      title: "Raise a fresh credit note?",
      description: `This queues a new Xero credit note${amount} for this refund request, replacing the one voided in Xero. Only do this if the note was voided by mistake and the money really went back.`,
      confirmLabel: "Raise a fresh credit note",
    })
    if (!ok) return
    const key = `${request.paymentId}:${request.refundRequestId}`
    setRaisingKey(key)
    setActionError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>(
        "/api/admin/xero/operations/voided-request-notes/reraise",
        { paymentId: request.paymentId, refundRequestId: request.refundRequestId },
        "Failed to queue a fresh credit note",
      )
      onMessage(data.message || "A fresh credit note is queued for Xero.")
      onChanged()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to queue a fresh credit note")
    } finally {
      setRaisingKey(null)
      await load()
    }
  }

  if (requests.length === 0 && !loadError && !actionError) return null

  return (
    <section aria-labelledby="xero-voided-request-notes-heading" className="space-y-2 rounded-md border border-warning-6 bg-warning-3 p-3">
      {confirmDialog}
      <h3 id="xero-voided-request-notes-heading" className="text-sm font-medium text-foreground">
        Voided refund request notes
      </h3>
      <p className="text-xs text-muted-foreground">
        Each refund request below was paid back, but its own Xero credit note was voided in Xero and nothing replaces it. No retry
        raises a new one. If the note was voided by mistake, raise a fresh one here; otherwise leave it.
      </p>
      {loadError ? <p className="text-sm text-danger">{loadError}</p> : null}
      {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}
      <ul className="space-y-2">
        {requests.map((request) => {
          const key = `${request.paymentId}:${request.refundRequestId}`
          const notes = request.voidedNotes
            .map((note) => `${note.xeroObjectNumber || shortId(note.xeroObjectId)} (${note.status ?? "VOIDED"})`)
            .join(", ")
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background p-2 text-xs">
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  Refund request {shortId(request.refundRequestId)}
                  {request.amountCents !== null ? `, ${formatCents(request.amountCents, format)}` : ""}
                </p>
                <p className="text-muted-foreground">
                  Voided in Xero: {notes}. Payment{" "}
                  {request.paymentUrl ? (
                    <a href={request.paymentUrl} className="text-primary hover:underline">{shortId(request.paymentId)}</a>
                  ) : (
                    shortId(request.paymentId)
                  )}
                </p>
              </div>
              {request.activeOperationId ? (
                <p className="text-muted-foreground">A credit note for this request is queued for Xero.</p>
              ) : request.amountCents === null ? (
                <p className="text-muted-foreground">The voided note&rsquo;s amount cannot be read. Raise the replacement by hand in Xero.</p>
              ) : (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={!ancestorRendersViewOnlyBanner}
                  variant="outline"
                  size="sm"
                  onClick={() => void raise(request)}
                  disabled={raisingKey !== null}
                >
                  {raisingKey === key ? "Queueing..." : "Raise a fresh credit note"}
                </ViewOnlyActionButton>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
