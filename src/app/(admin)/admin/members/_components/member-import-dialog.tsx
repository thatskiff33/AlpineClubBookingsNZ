"use client"

import type { ChangeEvent } from "react"
import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  MEMBER_IMPORT_FIELD_DEFINITIONS,
  MEMBER_IMPORT_MAX_ROWS,
  parseMemberImportCsv,
  type CsvRecord,
  type MemberImportColumnMapping,
  type MemberImportCsvData,
  type MemberImportFieldKey,
  type MemberImportPreview,
} from "@/lib/member-csv-import"
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite"
import type { ImportResult } from "../_types"

interface MemberImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
  onError: (message: string) => void
}

const WIZARD_STEPS = [
  { key: "upload", label: "Upload" },
  { key: "parse", label: "Parse Preview" },
  { key: "mapping", label: "Mapping" },
  { key: "validation", label: "Validation" },
  { key: "import", label: "Import" },
] as const

type WizardStep = (typeof WIZARD_STEPS)[number]["key"]

const UNMAPPED_VALUE = "unmapped"

function formatParseError(error: string, lineNumber?: number) {
  return lineNumber ? `Line ${lineNumber}: ${error}` : error
}

function getStepIndex(step: WizardStep) {
  return WIZARD_STEPS.findIndex((wizardStep) => wizardStep.key === step)
}

function getColumnCount(headers: string[], rows: CsvRecord[]) {
  return Math.max(headers.length, ...rows.map((row) => row.values.length), 1)
}

function CsvTablePreview({
  headers,
  rows,
}: {
  headers: string[]
  rows: CsvRecord[]
}) {
  const columnCount = getColumnCount(headers, rows)
  const displayHeaders = Array.from({ length: columnCount }, (_, index) =>
    headers[index]?.trim() || `Column ${index + 1}`
  )

  return (
    <div className="max-h-72 overflow-auto rounded-md border text-xs">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky top-0 z-10 w-16 bg-background">Line</TableHead>
            {displayHeaders.map((header, index) => (
              <TableHead
                key={`${header}-${index}`}
                className="sticky top-0 z-10 min-w-36 bg-background"
              >
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => (
            <TableRow key={`${row.lineNumber}-${rowIndex}`}>
              <TableCell className="text-slate-500">{row.lineNumber}</TableCell>
              {displayHeaders.map((_, index) => (
                <TableCell
                  key={`${row.lineNumber}-${index}`}
                  className="max-w-56 whitespace-pre-wrap break-words"
                >
                  {row.values[index] || ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function WizardStepList({ step }: { step: WizardStep }) {
  const currentStepIndex = getStepIndex(step)

  return (
    <div className="grid grid-cols-5 gap-2">
      {WIZARD_STEPS.map((wizardStep, index) => {
        const active = wizardStep.key === step
        const complete = index < currentStepIndex
        return (
          <div
            key={wizardStep.key}
            className={[
              "flex min-w-0 items-center gap-2 rounded-md border px-2 py-2 text-xs",
              active ? "border-slate-900 bg-slate-50 text-slate-950" : "",
              complete ? "border-green-200 bg-green-50 text-green-800" : "",
              !active && !complete ? "border-slate-200 text-slate-500" : "",
            ].join(" ")}
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold">
              {complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className="truncate">{wizardStep.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function MappingSelect({
  fieldKey,
  mapping,
  headers,
  onChange,
}: {
  fieldKey: MemberImportFieldKey
  mapping: MemberImportColumnMapping
  headers: string[]
  onChange: (fieldKey: MemberImportFieldKey, columnIndex: number | null) => void
}) {
  const selected = mapping[fieldKey]
  return (
    <Select
      value={selected === null ? UNMAPPED_VALUE : String(selected)}
      onValueChange={(value) =>
        onChange(fieldKey, value === UNMAPPED_VALUE ? null : Number(value))
      }
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNMAPPED_VALUE}>Not mapped</SelectItem>
        {headers.map((header, index) => (
          <SelectItem key={`${header}-${index}`} value={String(index)}>
            {header || `Column ${index + 1}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ValidationTable({ preview }: { preview: MemberImportPreview }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border text-xs">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky top-0 z-10 w-16 bg-background">Line</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">First Name</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">Last Name</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">Email</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">Role</TableHead>
            <TableHead className="sticky top-0 z-10 min-w-56 bg-background">Issues</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.rows.map((row, index) => (
            <TableRow key={`${row.lineNumber}-${index}`}>
              <TableCell className="text-slate-500">{row.lineNumber}</TableCell>
              <TableCell>
                {row.errors.length > 0 ? (
                  <Badge variant="destructive">Blocked</Badge>
                ) : (
                  <Badge variant="success">Ready</Badge>
                )}
              </TableCell>
              <TableCell>{row.values.firstName}</TableCell>
              <TableCell>{row.values.lastName}</TableCell>
              <TableCell className="break-all">{row.values.email}</TableCell>
              <TableCell>{row.values.role || "MEMBER"}</TableCell>
              <TableCell className="text-red-700">
                {row.errors.length > 0 ? row.errors.join(", ") : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function MemberImportDialog({
  open,
  onOpenChange,
  onImported,
  onError,
}: MemberImportDialogProps) {
  const [wizardStep, setWizardStep] = useState<WizardStep>("upload")
  const [csvFileName, setCsvFileName] = useState("")
  const [csvData, setCsvData] = useState<MemberImportCsvData | null>(null)
  const [columnMapping, setColumnMapping] = useState<MemberImportColumnMapping>(
    inferMemberImportColumnMapping([])
  )
  const [parseError, setParseError] = useState<string | null>(null)
  const [importSendInvites, setImportSendInvites] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)

  const preview = useMemo(
    () => (csvData ? buildMemberImportPreview(csvData, columnMapping) : null),
    [columnMapping, csvData]
  )

  useEffect(() => {
    if (!open) return
    setWizardStep("upload")
    setCsvFileName("")
    setCsvData(null)
    setColumnMapping(inferMemberImportColumnMapping([]))
    setParseError(null)
    setImportSendInvites(false)
    setImportLoading(false)
    setImportResult(null)
  }, [open])

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setCsvFileName(file.name)
    setParseError(null)
    setImportResult(null)

    const reader = new FileReader()
    reader.onload = (loadEvent) => {
      const text = loadEvent.target?.result
      if (typeof text !== "string" || text.length === 0) {
        const message = "CSV file is empty"
        setParseError(message)
        onError(message)
        return
      }

      const parsed = parseMemberImportCsv(text)
      if (!parsed.ok) {
        const message = formatParseError(parsed.error, parsed.lineNumber)
        setCsvData(null)
        setColumnMapping(inferMemberImportColumnMapping([]))
        setParseError(message)
        setWizardStep("upload")
        onError(message)
        return
      }

      setCsvData(parsed.data)
      setColumnMapping(inferMemberImportColumnMapping(parsed.data.headers))
      setWizardStep("parse")
    }
    reader.onerror = () => {
      const message = "Unable to read CSV file"
      setParseError(message)
      onError(message)
    }
    reader.readAsText(file)
  }

  const handleMappingChange = (fieldKey: MemberImportFieldKey, columnIndex: number | null) => {
    setColumnMapping((currentMapping) => ({
      ...currentMapping,
      [fieldKey]: columnIndex,
    }))
  }

  const handleImport = async () => {
    if (!preview || preview.hasErrors) return

    setImportLoading(true)
    setImportResult(null)
    setWizardStep("import")
    try {
      const res = await fetch("/api/admin/members/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: preview.importRows,
          sendInvites: importSendInvites,
          autoLinkXero: false,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as ImportResult & { error?: string }
      if (!res.ok) throw new Error(data.error || "Import failed")
      setImportResult(data)
      onImported()
    } catch (err) {
      setWizardStep("validation")
      onError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImportLoading(false)
    }
  }

  const currentStepIndex = getStepIndex(wizardStep)
  const canGoBack = currentStepIndex > 0 && wizardStep !== "import" && !importLoading
  const canContinueFromParse = wizardStep === "parse" && Boolean(csvData)
  const canContinueFromMapping = wizardStep === "mapping" && Boolean(csvData)
  const canImport =
    wizardStep === "validation" && Boolean(preview) && !preview?.hasErrors && !importLoading

  const sampleValueForField = (fieldKey: MemberImportFieldKey) => {
    if (!csvData) return ""
    const columnIndex = columnMapping[fieldKey]
    if (columnIndex === null) return ""
    return csvData.rows[0]?.values[columnIndex]?.trim() || ""
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !importLoading && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import Members from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with member details, confirm the column mapping, then import.
          </DialogDescription>
        </DialogHeader>

        <WizardStepList step={wizardStep} />

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {wizardStep === "upload" && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="csvFile">CSV File</Label>
                <Input
                  id="csvFile"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileUpload}
                  className="mt-1"
                />
              </div>
              {parseError && (
                <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{parseError}</p>
                </div>
              )}
            </div>
          )}

          {wizardStep === "parse" && csvData && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">File</p>
                  <p className="truncate text-sm font-medium">{csvFileName || "Selected CSV"}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">Rows</p>
                  <p className="text-sm font-medium">{csvData.rows.length}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">Columns</p>
                  <p className="text-sm font-medium">{csvData.headers.length}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">Blank Lines</p>
                  <p className="text-sm font-medium">{csvData.blankLineCount}</p>
                </div>
              </div>
              {csvData.rows.length > MEMBER_IMPORT_MAX_ROWS && (
                <div className="flex gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>Imports are limited to {MEMBER_IMPORT_MAX_ROWS} data rows.</p>
                </div>
              )}
              <CsvTablePreview headers={csvData.headers} rows={csvData.rows} />
            </div>
          )}

          {wizardStep === "mapping" && csvData && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {MEMBER_IMPORT_FIELD_DEFINITIONS.map((definition) => {
                const mapped = columnMapping[definition.key] !== null
                return (
                  <div key={definition.key} className="rounded-md border p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <Label className="text-sm">{definition.label}</Label>
                      {definition.required && <Badge variant="secondary">Required</Badge>}
                    </div>
                    <MappingSelect
                      fieldKey={definition.key}
                      mapping={columnMapping}
                      headers={csvData.headers}
                      onChange={handleMappingChange}
                    />
                    <p className="mt-2 min-h-4 truncate text-xs text-slate-500">
                      {mapped ? sampleValueForField(definition.key) || "Blank in first row" : ""}
                    </p>
                  </div>
                )
              })}
            </div>
          )}

          {wizardStep === "validation" && preview && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">Rows Ready</p>
                  <p className="text-sm font-medium">
                    {preview.rows.filter((row) => row.errors.length === 0).length}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">Rows Blocked</p>
                  <p className="text-sm font-medium">
                    {preview.rows.filter((row) => row.errors.length > 0).length}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase text-slate-500">API Limit</p>
                  <p className="text-sm font-medium">{MEMBER_IMPORT_MAX_ROWS} rows</p>
                </div>
              </div>
              {preview.fileErrors.length > 0 && (
                <div className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {preview.fileErrors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 rounded-md border p-3">
                <Checkbox
                  id="sendInvites"
                  checked={importSendInvites}
                  onCheckedChange={(checked) => setImportSendInvites(checked === true)}
                />
                <Label htmlFor="sendInvites" className="text-sm">
                  Send account setup invites ({MEMBER_SETUP_INVITE_TTL_DAYS}-day links)
                </Label>
              </div>
              <ValidationTable preview={preview} />
            </div>
          )}

          {wizardStep === "import" && (
            <div className="space-y-4">
              {importLoading && (
                <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  <p>Importing members...</p>
                </div>
              )}
              {importResult && (
                <div className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-md border p-3">
                      <p className="text-xs uppercase text-slate-500">Created</p>
                      <p className="text-sm font-medium text-green-700">{importResult.created}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs uppercase text-slate-500">Skipped</p>
                      <p className="text-sm font-medium text-yellow-700">{importResult.skipped}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs uppercase text-slate-500">Errors</p>
                      <p className="text-sm font-medium text-red-700">
                        {importResult.errors.length}
                      </p>
                    </div>
                  </div>
                  {importResult.errors.length > 0 && (
                    <div className="max-h-40 overflow-y-auto rounded-md border border-red-200 p-3 text-xs text-red-700">
                      {importResult.errors.map((error, index) => (
                        <p key={`${error.row}-${index}`}>
                          Row {error.row}: {error.errors.join(", ")}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importLoading}>
            Close
          </Button>
          {canGoBack && (
            <Button
              variant="outline"
              onClick={() => setWizardStep(WIZARD_STEPS[currentStepIndex - 1].key)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          )}
          {canContinueFromParse && (
            <Button onClick={() => setWizardStep("mapping")}>
              Continue
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
          {canContinueFromMapping && (
            <Button onClick={() => setWizardStep("validation")}>
              Validate
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
          {canImport && (
            <Button onClick={handleImport}>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Import {preview?.importRows.length ?? 0} Members
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
