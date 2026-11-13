"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import type { AncestorViewOnlyBannerProps } from "@/components/admin/view-only-action"
import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useClubFormat } from "@/components/club-format-provider"
import { useClubTime } from "@/components/club-time-provider"
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
import { parseInstant } from "@/lib/club-time"
import type { OpeningCreditBatchListItem, OpeningCreditPreview } from "@/lib/opening-credit-batch"
import { OPENING_CREDIT_CSV_MAX_CHARS, OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH } from "@/lib/opening-credit-csv"
import { formatCents } from "@/lib/utils"

type Batch = OpeningCreditBatchListItem
type Preview = Omit<OpeningCreditPreview, "alreadyPosted"> & {
  alreadyPosted: { batchId: string; postedAt: string; reversedAt: string | null } | null
}

async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? fallback
}

/**
 * Opening credits (#4988, `INV-PAY-151`): import a moving-in club's credit
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
  const [importOpen, setImportOpen] = useState(false)
  const [csvText, setCsvText] = useState<string | null>(null)
  const [fileName, setFileName] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState("")
  const [reversing, setReversing] = useState<Batch | null>(null)
  const [reason, setReason] = useState("")

  const when = (iso: string) => {
    const instant = parseInstant(iso)
    return instant === null ? iso : clubTime.instantDateTime(instant)
  }

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/opening-credits")
    if (response.ok) {
      const body = (await response.json()) as { batches: Batch[] }
      setBatches(body.batches)
    } else {
      setBatches([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function resetImport() {
    setCsvText(null)
    setFileName("")
    setPreview(null)
    setDialogError("")
  }

  async function chooseFile(file: File | undefined) {
    resetImport()
    if (!file) return
    const text = await file.text()
    if (text.length > OPENING_CREDIT_CSV_MAX_CHARS) {
      setDialogError("That file is too large for one opening-credit batch")
      return
    }
    setFileName(file.name)
    setCsvText(text)
    setBusy(true)
    try {
      const response = await fetchWithRecentAuth("/api/admin/opening-credits/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: text }),
      })
      if (!response.ok) {
        setDialogError(await readError(response, "The file could not be previewed"))
        return
      }
      setPreview((await response.json()) as Preview)
    } finally {
      setBusy(false)
    }
  }

  async function confirmImport() {
    if (!csvText || !preview?.batchKey) return
    setBusy(true)
    setDialogError("")
    try {
      const response = await fetchWithRecentAuth("/api/admin/opening-credits/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText, batchKey: preview.batchKey, totalCents: preview.totalCents }),
      })
      if (!response.ok) {
        setDialogError(await readError(response, "The batch could not be posted"))
        return
      }
      toast.success(`Posted ${preview.matchedCount} opening credits totalling ${formatCents(preview.totalCents, format)}`)
      setImportOpen(false)
      resetImport()
      await load()
    } finally {
      setBusy(false)
    }
  }

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
        setDialogError(await readError(response, "The batch could not be reversed"))
        return
      }
      toast.success(`Reversed the opening-credit batch of ${formatCents(reversing.totalCents, format)}`)
      setReversing(null)
      setReason("")
      await load()
    } finally {
      setBusy(false)
    }
  }

  const canPost = preview !== null && preview.batchKey !== null && preview.alreadyPosted === null && !busy

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Opening credits</CardTitle>
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
            resetImport()
            setImportOpen(true)
          }}
        >
          Import opening credits
        </ViewOnlyActionButton>
      </CardHeader>
      <CardContent>
        {batches === null ? (
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

      <Dialog open={importOpen} onOpenChange={(open) => (busy ? null : setImportOpen(open))}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import opening credits</DialogTitle>
            <DialogDescription>
              One row per member: a Member ID or Email column, an Amount in dollars (or Amount Cents), and an optional
              Description. Every row must match a member before the batch can be posted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="opening-credit-file">CSV file</Label>
              <input
                id="opening-credit-file"
                type="file"
                accept=".csv,text/csv"
                className="block text-sm"
                disabled={busy}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              {fileName ? <p className="text-xs text-muted-foreground">{fileName}</p> : null}
            </div>
            {dialogError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {dialogError}
              </p>
            ) : null}
            {preview ? (
              <div className="space-y-3">
                <dl className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Matched members</dt>
                    <dd className="font-medium">{preview.matchedCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Rows to fix</dt>
                    <dd className="font-medium">{preview.errorCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Total to post</dt>
                    <dd className="font-medium">{formatCents(preview.totalCents, format)}</dd>
                  </div>
                </dl>
                {preview.skippedZeroRows > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {preview.skippedZeroRows} row{preview.skippedZeroRows === 1 ? "" : "s"} with a zero amount
                    {preview.skippedZeroRows === 1 ? " was" : " were"} skipped.
                  </p>
                ) : null}
                {preview.alreadyPosted ? (
                  <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    This file was already posted on {when(preview.alreadyPosted.postedAt)}
                    {preview.alreadyPosted.reversedAt ? " and later reversed" : ""}. Posting it again would change no
                    balance, so it cannot be confirmed.
                  </p>
                ) : null}
                <div className="max-h-80 overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted text-left">
                      <tr>
                        <th className="px-3 py-2">Line</th>
                        <th className="px-3 py-2">Member</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.lineNumber} className="border-t align-top">
                          <td className="px-3 py-2">{row.lineNumber}</td>
                          <td className="px-3 py-2">
                            {row.memberName ? (
                              <>
                                <span className="font-medium">{row.memberName}</span>
                                <span className="block text-xs text-muted-foreground">{row.memberEmail}</span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">Unmatched</span>
                            )}
                            {row.errors.map((message) => (
                              <span key={message} className="block text-xs text-destructive">
                                Line {row.lineNumber} {message}
                              </span>
                            ))}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row.amountCents === null ? "—" : formatCents(row.amountCents, format)}
                          </td>
                          <td className="px-3 py-2">{row.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!canPost} onClick={() => void confirmImport()}>
              {preview && preview.batchKey
                ? `Post ${formatCents(preview.totalCents, format)} to ${preview.matchedCount} member${preview.matchedCount === 1 ? "" : "s"}`
                : "Post opening credits"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
