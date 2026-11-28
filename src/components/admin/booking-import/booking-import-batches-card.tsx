"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { BookingImportDialog } from "@/components/admin/booking-import/booking-import-dialog"
import { BookingImportBatchStatusBadge } from "@/components/admin/booking-import/booking-import-batch-status"
import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useClubFormat } from "@/components/club-format-provider"
import { useClubTime } from "@/components/club-time-provider"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminHref } from "@/lib/admin-hubs"
import type { BookingImportBatchSummary } from "@/lib/booking-import/batches"
import { parseInstant } from "@/lib/club-time"
import { formatCents } from "@/lib/utils"

/**
 * The paid-booking import batches (#5005, child C), on #4988's pattern: the
 * batches so far with their imported and refused totals, each linking to its
 * page, and the Import button. `canImport` is finance edit and bookings edit
 * together (O4); the server checks both again.
 */
export function BookingImportBatchesCard({ canImport }: { canImport: boolean | undefined }) {
  const router = useRouter()
  const format = useClubFormat()
  const clubTime = useClubTime()
  const [batches, setBatches] = useState<BookingImportBatchSummary[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Bumped on each Import press so the dialog remounts with an empty import.
  const [importRun, setImportRun] = useState(0)

  const when = (iso: string) => {
    const instant = parseInstant(iso)
    return instant === null ? iso : clubTime.instantDateTime(instant)
  }

  // A failed read says so: "no batches" must never stand in for "could not load them".
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/bookings/import/batches")
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { batches?: unknown }
      if (!Array.isArray(body.batches)) throw new Error("Malformed import batch list")
      setBatches(body.batches as BookingImportBatchSummary[])
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle headingLevel={2}>Import batches</CardTitle>
          <CardDescription>
            Each upload is one batch. Compare its imported and refused totals with your previous system&apos;s report.
          </CardDescription>
        </div>
        <ViewOnlyActionButton
          canEdit={canImport}
          readOnlyReason="Importing paid bookings needs both finance edit and bookings edit access."
          size="sm"
          onClick={() => {
            setImportRun((run) => run + 1)
            setImportOpen(true)
          }}
        >
          Import paid bookings
        </ViewOnlyActionButton>
      </CardHeader>
      <CardContent>
        {loadFailed ? (
          <p role="alert" className="text-sm text-destructive">
            The import batches could not be loaded. Refresh the page to try again.
          </p>
        ) : batches === null ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No paid bookings have been imported.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Confirmed</TableHead>
                <TableHead>Lodge</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Imported</TableHead>
                <TableHead className="text-right">Refused</TableHead>
                <TableHead className="text-right">Reversed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((batch) => (
                <TableRow key={batch.id}>
                  <TableCell>
                    <Link className="font-medium underline-offset-4 hover:underline" href={adminHref("booking-import-batch", { id: batch.id })}>
                      {when(batch.confirmedAt)}
                    </Link>
                    {batch.confirmedByName ? (
                      <span className="block text-xs text-muted-foreground">by {batch.confirmedByName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{batch.lodgeName}</TableCell>
                  <TableCell>
                    <BookingImportBatchStatusBadge status={batch.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {batch.imported.bookings} ({formatCents(batch.imported.amountCents, format)})
                  </TableCell>
                  <TableCell className="text-right">
                    {batch.refused.bookings} ({formatCents(batch.refused.amountCents, format)})
                  </TableCell>
                  <TableCell className="text-right">{batch.reversed.bookings}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <BookingImportDialog
        key={importRun}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={async (batchId) => {
          toast.success("Import finished")
          await load()
          router.push(adminHref("booking-import-batch", { id: batchId }))
        }}
      />
    </Card>
  )
}
