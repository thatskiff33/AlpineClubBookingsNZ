"use client"

import { useState } from "react"

import { BookingImportPlanView } from "@/components/admin/booking-import/booking-import-plan-view"
import { useClubFormat } from "@/components/club-format-provider"
import { fetchWithRecentAuth } from "@/components/confirm-its-you"
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiErrorMessageFromResponse } from "@/lib/api-error-message"
import {
  BOOKING_IMPORT_COLUMNS,
  inferBookingImportColumnMapping,
  type BookingImportColumnKey,
  type BookingImportColumnMapping,
} from "@/lib/booking-import/columns"
import type { BookingImportPlan } from "@/lib/booking-import/plan"
import {
  DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  MEMBER_IMPORT_DATE_FORMATS,
  parseMemberImportCsv,
  type MemberImportDateFormat,
} from "@/lib/member-csv-import"
import { formatCents } from "@/lib/utils"

/** Matches `BOOKING_IMPORT_CSV_MAX_CHARS` on the server, which refuses a larger body. */
const MAX_FILE_CHARS = 1_000_000
const NOT_IN_FILE = "__not_in_file__"

type Step = "upload" | "mapping" | "preview"
type Preview = { plan: BookingImportPlan; existingBatch: { id: string; status: string } | null }
type ConfirmSlice = { batchId: string; remaining: number; imported: number; refused: number }

/**
 * The paid-booking import dialog (#5005, child C), on #4988's pattern: choose
 * the lodge and the file, map its columns and date format, read the server's
 * preview, then confirm. Confirm writes in slices and repeats until nothing
 * remains; if the preview changed underneath, nothing is written and the new
 * preview replaces the old one. The parent remounts it (a fresh `key`) for
 * every import.
 */
export function BookingImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (batchId: string) => Promise<void> | void
}) {
  const format = useClubFormat()
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin")
  const [lodgeId, setLodgeId] = useState<string | null>(null)
  const [step, setStep] = useState<Step>("upload")
  const [fileName, setFileName] = useState("")
  const [csvText, setCsvText] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<BookingImportColumnMapping>({})
  const [dateFormat, setDateFormat] = useState<MemberImportDateFormat>(DEFAULT_MEMBER_IMPORT_DATE_FORMAT)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [progress, setProgress] = useState<{ imported: number; refused: number; remaining: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function chooseFile(file: File | undefined) {
    setError("")
    setPreview(null)
    setCsvText(null)
    setFileName("")
    if (!file) return
    const text = await file.text()
    if (text.length > MAX_FILE_CHARS) {
      setError("That file is too large for one import")
      return
    }
    const parsed = parseMemberImportCsv(text)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setFileName(file.name)
    setCsvText(text)
    setHeaders(parsed.data.headers)
    setMapping(inferBookingImportColumnMapping(parsed.data.headers))
  }

  const fileBody = () => ({ lodgeId, csvText, dateFormat, columnMapping: mapping })

  async function loadPreview() {
    setBusy(true)
    setError("")
    try {
      const response = await fetchWithRecentAuth("/api/admin/bookings/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fileBody()),
      })
      if (!response.ok) {
        setError(await apiErrorMessageFromResponse(response, "The file could not be previewed"))
        return
      }
      setPreview((await response.json()) as Preview)
      setStep("preview")
    } finally {
      setBusy(false)
    }
  }

  async function confirmImport() {
    if (!preview) return
    setBusy(true)
    setError("")
    const totals = { imported: 0, refused: 0, remaining: preview.plan.importTotals.bookings }
    setProgress(totals)
    try {
      // One slice per call; the batch key resumes the same batch each time.
      for (;;) {
        const response = await fetchWithRecentAuth("/api/admin/bookings/import/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...fileBody(), digest: preview.plan.digest }),
        })
        if (response.status === 409) {
          const body = (await response.json().catch(() => ({}))) as { error?: string; plan?: BookingImportPlan }
          if (body.plan) setPreview({ plan: body.plan, existingBatch: preview.existingBatch })
          setError(body.error ?? "The import could not continue")
          return
        }
        if (!response.ok) {
          setError(await apiErrorMessageFromResponse(response, "The import stopped. Confirm again to carry on."))
          return
        }
        const slice = (await response.json()) as ConfirmSlice
        totals.imported += slice.imported
        totals.refused += slice.refused
        totals.remaining = slice.remaining
        setProgress({ ...totals })
        if (slice.remaining === 0) {
          onOpenChange(false)
          await onImported(slice.batchId)
          return
        }
      }
    } catch {
      setError("The connection dropped. Confirm again: bookings already imported are not imported twice.")
    } finally {
      setBusy(false)
    }
  }

  const missingRequired = BOOKING_IMPORT_COLUMNS.filter(
    (column) => column.required && (mapping[column.key] === undefined || mapping[column.key] === null),
  )
  const canPreview = Boolean(lodgeId && csvText) && missingRequired.length === 0 && !busy
  const reversed = preview?.existingBatch?.status === "REVERSED"
  const canConfirm = preview !== null && preview.plan.importTotals.bookings > 0 && !reversed && !busy

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? null : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import paid bookings</DialogTitle>
          <DialogDescription>
            Future stays already paid for in your previous system, one row per guest. Each is stored as paid at the
            amount paid and holds its beds. No invoice, card payment or email is made.
          </DialogDescription>
        </DialogHeader>

        {step === "upload" || step === "mapping" ? (
          <div className="space-y-4">
            <LodgeSelect lodges={lodges} value={lodgeId} onChange={setLodgeId} loading={lodgesLoading} id="booking-import-lodge" />
            <div className="space-y-2">
              <Label htmlFor="booking-import-file">CSV file</Label>
              <Input
                id="booking-import-file"
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(event) => {
                  setStep("upload")
                  void chooseFile(event.target.files?.[0]).then(() => setStep("mapping"))
                }}
              />
              {fileName ? <p className="text-xs text-muted-foreground">{fileName}</p> : null}
            </div>
            {step === "mapping" && csvText ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="booking-import-date-format">Date format in the file</Label>
                  <Select value={dateFormat} onValueChange={(value) => setDateFormat(value as MemberImportDateFormat)}>
                    <SelectTrigger id="booking-import-date-format" className="w-full sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEMBER_IMPORT_DATE_FORMATS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label} (for example {option.example})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Check Out is the morning the guests leave, not their last night.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {BOOKING_IMPORT_COLUMNS.map((column) => (
                    <ColumnSelect
                      key={column.key}
                      columnKey={column.key}
                      label={column.required ? column.label : `${column.label} (optional)`}
                      headers={headers}
                      value={mapping[column.key] ?? null}
                      onChange={(index) => setMapping((current) => ({ ...current, [column.key]: index }))}
                    />
                  ))}
                </div>
                {missingRequired.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Choose a file column for: {missingRequired.map((column) => column.label).join(", ")}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {step === "preview" && preview ? (
          <div className="space-y-3">
            {preview.existingBatch ? (
              <p role="status" className="rounded-md bg-warning-3 px-3 py-2 text-sm text-warning-11">
                {reversed
                  ? "This file was imported before and that import was reversed. Change the file (correct the rows) to import it again."
                  : "This file was imported before. Confirming carries on with that import; bookings already imported are not imported twice."}
              </p>
            ) : null}
            <BookingImportPlanView plan={preview.plan} />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {progress && busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Imported {progress.imported}, refused {progress.refused}; {progress.remaining} still to do.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {step === "preview" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setStep("mapping")}>
                Back to columns
              </Button>
              <Button disabled={!canConfirm} onClick={() => void confirmImport()}>
                {preview
                  ? `Import ${preview.plan.importTotals.bookings} booking${preview.plan.importTotals.bookings === 1 ? "" : "s"} (${formatCents(preview.plan.importTotals.amountCents, format)})`
                  : "Import"}
              </Button>
            </>
          ) : (
            <Button disabled={!canPreview} onClick={() => void loadPreview()}>
              Preview
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ColumnSelect({
  columnKey,
  label,
  headers,
  value,
  onChange,
}: {
  columnKey: BookingImportColumnKey
  label: string
  headers: string[]
  value: number | null
  onChange: (index: number | null) => void
}) {
  const id = `booking-import-column-${columnKey}`
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value === null ? NOT_IN_FILE : String(value)}
        onValueChange={(next) => onChange(next === NOT_IN_FILE ? null : Number(next))}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_IN_FILE}>Not in the file</SelectItem>
          {headers.map((header, index) => (
            <SelectItem key={`${index}-${header}`} value={String(index)}>
              {header || `Column ${index + 1}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
