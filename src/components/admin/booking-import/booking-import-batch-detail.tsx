"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { BookingImportBatchStatusBadge } from "@/components/admin/booking-import/booking-import-batch-status"
import { BookingImportTotalsList } from "@/components/admin/booking-import/booking-import-plan-view"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiErrorMessageFromResponse } from "@/lib/api-error-message"
import type { BookingImportBatchSummary } from "@/lib/booking-import/batches"
import type { BookingImportReversalPlan, BookingImportReversalRowState } from "@/lib/booking-import/reverse"
import { buildBookingDetailPath } from "@/lib/booking-email-contract"
import { parseInstant } from "@/lib/club-time"
import { formatCents } from "@/lib/utils"

type Detail = { batch: BookingImportBatchSummary; reversal: BookingImportReversalPlan }

const STATE_LABELS: Record<BookingImportReversalRowState, string> = {
  UNTOUCHED: "Imported, untouched",
  TOUCHED: "Imported, changed since",
  REVERSED: "Reversed",
  NOT_IMPORTED: "Refused",
}

/**
 * One import batch (#5005, child C): its totals to compare with the old
 * system's records, every booking with its outcome, and Reverse. Reverse
 * first shows which bookings it would take back and which it keeps, and why
 * (`INV-PAY-163`); it then runs in slices until none remain.
 */
export function BookingImportBatchDetail({ batchId, canReverse }: { batchId: string; canReverse: boolean | undefined }) {
  const format = useClubFormat()
  const clubTime = useClubTime()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loadError, setLoadError] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState("")

  const when = (iso: string) => {
    const instant = parseInstant(iso)
    return instant === null ? iso : clubTime.instantDateTime(instant)
  }

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/bookings/import/batches/${encodeURIComponent(batchId)}`)
      if (!response.ok) {
        setLoadError(await apiErrorMessageFromResponse(response, "The import batch could not be loaded"))
        return
      }
      setDetail((await response.json()) as Detail)
      setLoadError("")
    } catch {
      setLoadError("The import batch could not be loaded. Refresh the page to try again.")
    }
  }, [batchId])

  useEffect(() => {
    void load()
  }, [load])

  async function reverse() {
    setBusy(true)
    setDialogError("")
    let reversed = 0
    let kept = 0
    try {
      for (;;) {
        const response = await fetchWithRecentAuth(`/api/admin/bookings/import/batches/${encodeURIComponent(batchId)}/reverse`, {
          method: "POST",
        })
        if (!response.ok) {
          setDialogError(await apiErrorMessageFromResponse(response, "The reversal stopped. Reverse again to carry on."))
          return
        }
        const body = (await response.json()) as { rows: { outcome: string }[]; remaining: number }
        reversed += body.rows.filter((row) => row.outcome === "REVERSED").length
        kept += body.rows.filter((row) => row.outcome !== "REVERSED").length
        if (body.remaining === 0) break
      }
      toast.success(`Reversed ${reversed} booking${reversed === 1 ? "" : "s"}${kept ? `; ${kept} kept` : ""}`)
      setConfirming(false)
    } catch {
      setDialogError("The connection dropped. Reverse again: bookings already reversed are not reversed twice.")
    } finally {
      setBusy(false)
      await load()
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {loadError}
      </p>
    )
  }
  if (!detail) return <p className="text-sm text-muted-foreground">Loading...</p>

  const { batch, reversal } = detail
  const untouched = reversal.totals.UNTOUCHED
  const touched = reversal.totals.TOUCHED
  const unfinished = reversal.rows.some((row) => row.cancelPending)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle headingLevel={2} className="flex items-center gap-2">
            {batch.lodgeName} <BookingImportBatchStatusBadge status={batch.status} />
          </CardTitle>
          <CardDescription>
            Confirmed {when(batch.confirmedAt)}
            {batch.confirmedByName ? ` by ${batch.confirmedByName}` : ""}
            {batch.reversedAt ? `. Reversed ${when(batch.reversedAt)}${batch.reversedByName ? ` by ${batch.reversedByName}` : ""}` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <BookingImportTotalsList label="Whole file" totals={batch.file} />
            <BookingImportTotalsList label="Imported" totals={batch.imported} />
            <BookingImportTotalsList label="Refused" totals={batch.refused} />
            <BookingImportTotalsList label="Reversed" totals={batch.reversed} />
          </div>
          {batch.pending > 0 ? (
            <p role="status" className="rounded-md bg-warning-3 px-3 py-2 text-sm text-warning-11">
              {batch.pending} booking{batch.pending === 1 ? " was" : "s were"} not reached. Upload the same file again and
              confirm to finish the import.
            </p>
          ) : null}
          {batch.status !== "OPEN" && (untouched.bookings > 0 || unfinished) ? (
            <ViewOnlyActionButton
              canEdit={canReverse}
              readOnlyReason="Reversing an import needs both finance edit and bookings edit access."
              variant="outline"
              onClick={() => {
                setDialogError("")
                setConfirming(true)
              }}
            >
              Reverse batch
            </ViewOnlyActionButton>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>Bookings</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Booking Ref</TableHead>
                <TableHead className="text-right">Guests</TableHead>
                <TableHead className="text-right">Amount paid</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reversal.rows.map((row) => (
                <TableRow key={row.bookingRef} className="align-top">
                  <TableCell>{row.firstLineNumber}</TableCell>
                  <TableCell className="font-medium">
                    {row.bookingId ? <Link className="underline-offset-4 hover:underline" href={buildBookingDetailPath(row.bookingId)}>{row.bookingRef}</Link> : row.bookingRef}
                  </TableCell>
                  <TableCell className="text-right">{row.guestCount}</TableCell>
                  <TableCell className="text-right">{formatCents(row.amountCents, format)}</TableCell>
                  <TableCell>
                    <Badge variant={row.state === "NOT_IMPORTED" ? "destructive" : row.state === "UNTOUCHED" ? "outline" : "secondary"}>
                      {STATE_LABELS[row.state]}
                    </Badge>
                    {[...row.reasons, ...row.refusals].map((reason) => (
                      <span key={reason} className="mt-1 block text-xs text-muted-foreground">
                        {reason}
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={confirming} onOpenChange={(open) => (busy ? null : setConfirming(open))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse this import</DialogTitle>
            <DialogDescription>
              {untouched.bookings} untouched booking{untouched.bookings === 1 ? "" : "s"} (
              {formatCents(untouched.amountCents, format)}) will have the recorded payment taken back and be cancelled.
              Nobody is emailed and nothing is refunded.
              {touched.bookings > 0
                ? ` ${touched.bookings} booking${touched.bookings === 1 ? " has" : "s have"} changed since the import and will be kept; the list shows why.`
                : ""}{" "}
              The Booking Refs it reverses can be imported again from a corrected file.
            </DialogDescription>
          </DialogHeader>
          {dialogError ? (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {dialogError}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void reverse()}>
              {busy ? "Reversing..." : "Reverse batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
