"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import type { AncestorViewOnlyBannerProps } from "@/components/admin/view-only-action"
import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useClubFormat } from "@/components/club-format-provider"
import { useClubTime } from "@/components/club-time-provider"
import { OpeningCreditImportDialog } from "@/components/admin/opening-credit-import-dialog"
import { fetchWithRecentAuth } from "@/components/confirm-its-you"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { apiErrorMessageFromResponse } from "@/lib/api-error-message"
import { parseInstant } from "@/lib/club-time"
import type { OpeningCreditBatchListItem } from "@/lib/opening-credit-batch"
import { OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH } from "@/lib/opening-credit-csv"
import { formatCents } from "@/lib/utils"

type Batch = OpeningCreditBatchListItem

/**
 * Opening credits (#4988, `INV-PAY-162`): import a moving-in club's credit
 * balances from one CSV, previewed and totalled, posted on one confirmation,
 * and reversible as a whole batch while none of it is spent.
 */
export function OpeningCreditBatchesCard({
  canEdit,
  ancestorRendersViewOnlyBanner = false,
}: { canEdit: boolean | undefined } & AncestorViewOnlyBannerProps) {
  const format = useClubFormat()
  const clubTime = useClubTime()
  const [batches, setBatches] = useState<Batch[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Bumped on each Import press so the dialog remounts with an empty import.
  const [importRun, setImportRun] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState("")
  const [reversing, setReversing] = useState<Batch | null>(null)
  const [reason, setReason] = useState("")

  const when = (iso: string) => {
    const instant = parseInstant(iso)
    return instant === null ? iso : clubTime.instantDateTime(instant)
  }

  // A failed read says so rather than showing an empty list: "no batches posted"
  // must never stand in for "could not load the batches" on a money screen.
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/opening-credits")
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { batches?: unknown }
      // A body without the list is a failed read too, never a render crash
      // that takes the rest of the refund page down with it.
      if (!Array.isArray(body.batches)) throw new Error("Malformed opening-credit list")
      setBatches(body.batches as Batch[])
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function confirmReverse() {
    if (!reversing) return
    setBusy(true)
    setDialogError("")
    try {
      const response = await fetchWithRecentAuth(`/api/admin/opening-credits/${reversing.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      if (!response.ok) {
        setDialogError(await apiErrorMessageFromResponse(response, "The batch could not be reversed"))
        return
      }
      toast.success(`Reversed the opening-credit batch of ${formatCents(reversing.totalCents, format)}`)
      setReversing(null)
      setReason("")
      await load()
    } catch {
      // A dropped connection leaves the outcome unknown; the server's claim
      // makes a retry safe, so refresh the list and say so.
      setDialogError("The batch could not be reversed; check the list before trying again")
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle headingLevel={2}>Opening credits</CardTitle>
          <CardDescription>
            Bring members&apos; credit balances across from your previous system in one CSV. Nothing is posted until
            you confirm the previewed total, and no email, Xero document or card payment is made.
          </CardDescription>
        </div>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={!ancestorRendersViewOnlyBanner}
          size="sm"
          onClick={() => {
            setImportRun((run) => run + 1)
            setImportOpen(true)
          }}
        >
          Import opening credits
        </ViewOnlyActionButton>
      </CardHeader>
      <CardContent>
        {loadFailed ? (
          <p role="alert" className="text-sm text-destructive">
            The opening-credit batches could not be loaded. Refresh the page to try again.
          </p>
        ) : batches === null ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No opening-credit batches have been posted.</p>
        ) : (
          <ul className="divide-y">
            {batches.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="space-y-0.5 text-sm">
                  <p className="font-medium">
                    {formatCents(batch.totalCents, format)} across {batch.rowCount} member{batch.rowCount === 1 ? "" : "s"}{" "}
                    {batch.reversedAt ? <Badge variant="secondary">Reversed</Badge> : null}
                  </p>
                  <p className="text-muted-foreground">
                    Posted {when(batch.postedAt)}
                    {batch.postedBy ? ` by ${batch.postedBy}` : ""}
                  </p>
                  {batch.reversedAt ? (
                    <p className="text-muted-foreground">
                      Reversed {when(batch.reversedAt)}
                      {batch.reversedBy ? ` by ${batch.reversedBy}` : ""}: {batch.reversalReason}
                    </p>
                  ) : null}
                </div>
                {batch.reversedAt ? null : (
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDialogError("")
                      setReason("")
                      setReversing(batch)
                    }}
                  >
                    Reverse batch
                  </ViewOnlyActionButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <OpeningCreditImportDialog
        key={importRun}
        open={importOpen}
        onOpenChange={setImportOpen}
        onPosted={load}
        when={when}
      />

      <Dialog open={reversing !== null} onOpenChange={(open) => (open || busy ? null : setReversing(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse opening-credit batch</DialogTitle>
            <DialogDescription>
              {reversing
                ? `Removes all ${reversing.rowCount} credits (${formatCents(reversing.totalCents, format)}). It is refused, and nothing changes, if any member has used any of their opening credit.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="opening-credit-reverse-reason">Reason</Label>
            <Textarea
              id="opening-credit-reverse-reason"
              value={reason}
              maxLength={OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
            />
            {dialogError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {dialogError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setReversing(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy || reason.trim() === ""} onClick={() => void confirmReverse()}>
              Reverse batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
