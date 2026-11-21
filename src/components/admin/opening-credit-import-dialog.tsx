"use client"

import { useState } from "react"
import { toast } from "sonner"

import { useClubFormat } from "@/components/club-format-provider"
import { fetchWithRecentAuth } from "@/components/confirm-its-you"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiErrorMessageFromResponse } from "@/lib/api-error-message"
import type { OpeningCreditPreview } from "@/lib/opening-credit-batch"
import { OPENING_CREDIT_CSV_MAX_CHARS } from "@/lib/opening-credit-csv"
import { formatCents } from "@/lib/utils"

type Preview = Omit<OpeningCreditPreview, "alreadyPosted"> & {
  alreadyPosted: { batchId: string; postedAt: string; reversedAt: string | null } | null
}

/**
 * The opening-credit import dialog (#4988, `INV-PAY-162`), split from
 * `OpeningCreditBatchesCard`: choose a CSV, show the server's preview and
 * total, and post it on one confirmation. Nothing is written until the
 * officer confirms the previewed total. The card remounts it (a fresh `key`)
 * each time Import is pressed, so every import starts empty.
 */
export function OpeningCreditImportDialog({
  open,
  onOpenChange,
  onPosted,
  when,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: () => Promise<void>
  when: (iso: string) => string
}) {
  const format = useClubFormat()
  const [csvText, setCsvText] = useState<string | null>(null)
  const [fileName, setFileName] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState("")

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
        setDialogError(await apiErrorMessageFromResponse(response, "The file could not be previewed"))
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
        setDialogError(await apiErrorMessageFromResponse(response, "The batch could not be posted"))
        return
      }
      toast.success(`Posted ${preview.matchedCount} opening credits totalling ${formatCents(preview.totalCents, format)}`)
      onOpenChange(false)
      resetImport()
      await onPosted()
    } finally {
      setBusy(false)
    }
  }

  const canPost = preview !== null && preview.batchKey !== null && preview.alreadyPosted === null && !busy

  return (
  <Dialog open={open} onOpenChange={(open) => (busy ? null : onOpenChange(open))}>
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
          <Input
            id="opening-credit-file"
            type="file"
            accept=".csv,text/csv"
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
              <p role="status" className="rounded-md bg-warning-3 px-3 py-2 text-sm text-warning-11">
                This file was already posted on {when(preview.alreadyPosted.postedAt)}
                {preview.alreadyPosted.reversedAt ? " and later reversed" : ""}. The same file can only post
                once; to post these credits again, change the file (such as its descriptions) so it becomes a new
                batch.
              </p>
            ) : null}
            <div className="max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-muted">
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead>Member</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row) => (
                    <TableRow key={row.lineNumber} className="align-top">
                      <TableCell>{row.lineNumber}</TableCell>
                      <TableCell>
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
                      </TableCell>
                      <TableCell className="text-right">
                        {row.amountCents === null ? "—" : formatCents(row.amountCents, format)}
                      </TableCell>
                      <TableCell>{row.description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
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
  )
}
