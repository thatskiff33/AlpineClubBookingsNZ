"use client"

import { useEffect, useMemo, useState } from "react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useClubTime } from "@/components/club-time-provider"
import { calendarDateParts } from "@/lib/club-time"

// Keep in lockstep with the route schema (`ids.max(100)`): bulk membership
// changes are capped so one run stays a bounded, sequential set of saves.
const BULK_MEMBERSHIP_MAX = 100

interface MembershipTypeOption {
  id: string
  name: string
  isActive: boolean
}

interface LinkedGuestLabel {
  bookingGuestId: string
  bookingId: string
  ownerMemberId: string
  checkIn: string
  checkOut: string
  stayStart: string
  stayEnd: string
}

interface LinkedGuestBookings {
  count: number
  truncatedCount?: number
  list?: LinkedGuestLabel[]
}

interface PreviewMember {
  memberId: string
  name: string
  previewToken: string
  affectedCounts: {
    futureConfirmedBookings: number
    draftBookings: number
    waitlistRecords: number
  }
  changed: boolean
  currentAgeTier: string
  resultingAgeTier: string
  ageTierChanged: boolean
  linkedGuestBlocked: boolean
  linkedGuestBookings: LinkedGuestBookings
}

interface PreviewResponse {
  seasonYear: number
  membershipTypeId: string
  summary: {
    requested: number
    previewed: number
    changed: number
    unchanged: number
    skipped: number
    ageTierChanges: number
    linkedGuestBlocks: number
    affectedTotals: {
      futureConfirmedBookings: number
      draftBookings: number
      waitlistRecords: number
    }
  }
  members: PreviewMember[]
  skipped: Array<{ memberId: string; reason: "archived" | "not_found" }>
}

type MemberOutcome =
  | "changed"
  | "unchanged"
  | "stale"
  | "blocked_linked_guests"
  | "error"

interface SaveResultRow {
  memberId: string
  name?: string
  outcome: MemberOutcome
  error?: string
  linkedGuestBookings?: LinkedGuestBookings
}

interface SaveResponse {
  outcomeCounts: Record<MemberOutcome, number>
  results: SaveResultRow[]
  xeroReconcile?: {
    attempted: number
    succeeded: number
    haltedByDailyLimit: boolean
  } | null
}

interface MemberBulkMembershipDialogProps {
  open: boolean
  selectedIds: Set<string>
  memberNames: Map<string, string>
  onOpenChange: (open: boolean) => void
  onComplete: (changed: number) => void
  onError: (message: string) => void
}

type Step = "configure" | "preview" | "reason" | "results"

const OUTCOME_LABELS: Record<MemberOutcome, string> = {
  changed: "Changed",
  unchanged: "No change",
  stale: "Stale — preview again",
  blocked_linked_guests: "Blocked (linked guest)",
  error: "Error",
}

/** A short, human-readable label for a linked-guest booking row. */
function linkedGuestLabel(booking: LinkedGuestLabel): string {
  return `${booking.stayStart} → ${booking.stayEnd}`
}

function LinkedGuestBookingList({
  bookings,
}: {
  bookings: LinkedGuestBookings | undefined
}) {
  if (!bookings?.list?.length) return null
  return (
    <ul className="ml-4 mt-0.5 list-disc text-muted-foreground">
      {bookings.list.map((booking) => (
        <li key={booking.bookingGuestId}>{linkedGuestLabel(booking)}</li>
      ))}
      {bookings.truncatedCount && bookings.truncatedCount > 0 ? (
        <li>+{bookings.truncatedCount} more</li>
      ) : null}
    </ul>
  )
}

export function MemberBulkMembershipDialog({
  open,
  selectedIds,
  memberNames,
  onOpenChange,
  onComplete,
  onError,
}: MemberBulkMembershipDialogProps) {
  // The CLUB's calendar year, not the operator's browser year — an admin in
  // London on 1 January must seed the same fallback as one at the lodge
  // (CT-4, #2870; INV-CONFIG-002). This is only a placeholder until the
  // membership-types load supplies the server-resolved season year.
  const clubTime = useClubTime()
  const currentYear = calendarDateParts(clubTime.today()).year
  const [types, setTypes] = useState<MembershipTypeOption[]>([])
  const [membershipTypeId, setMembershipTypeId] = useState<string>("")
  // Server-resolved (config-driven) current season year; a calendar-year fallback
  // until the membership-types load supplies it.
  const [currentSeasonYear, setCurrentSeasonYear] = useState<number>(currentYear)
  const [seasonYear, setSeasonYear] = useState<number>(currentYear)
  const [step, setStep] = useState<Step>("configure")
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [reason, setReason] = useState("")
  const [saveResult, setSaveResult] = useState<SaveResponse | null>(null)
  const [loading, setLoading] = useState(false)
  /*
    #2264 — this audit Reason field carried a fully interpolated sentence as its
    placeholder, so the box looked like it already held a written reason (and
    the wording vanished the moment the admin started typing their own). The
    same sentence is now an example under the field.
  */
  const reasonHint = useFieldHint()

  const ids = useMemo(() => [...selectedIds], [selectedIds])
  const overCap = ids.length > BULK_MEMBERSHIP_MAX

  useEffect(() => {
    if (!open) return
    setStep("configure")
    setMembershipTypeId("")
    setSeasonYear(currentYear)
    setCurrentSeasonYear(currentYear)
    setPreview(null)
    setReason("")
    setSaveResult(null)
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/admin/membership-types")
        if (!res.ok) throw new Error("Failed to load membership types")
        const data = (await res.json()) as {
          membershipTypes: MembershipTypeOption[]
          currentSeasonYear?: number
        }
        if (!cancelled) {
          setTypes(data.membershipTypes.filter((type) => type.isActive))
          if (typeof data.currentSeasonYear === "number") {
            setCurrentSeasonYear(data.currentSeasonYear)
            setSeasonYear(data.currentSeasonYear)
          }
        }
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : "Failed to load membership types")
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const yearOptions = [
    currentSeasonYear - 1,
    currentSeasonYear,
    currentSeasonYear + 1,
    currentSeasonYear + 2,
  ]

  const runPreview = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/members/bulk-membership-type/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, seasonYear, membershipTypeId }),
      })
      const data = (await res.json().catch(() => ({}))) as PreviewResponse & {
        error?: string
      }
      if (!res.ok) throw new Error(data.error || "Preview failed")
      setPreview(data)
      setStep("preview")
    } catch (err) {
      onError(err instanceof Error ? err.message : "Preview failed")
    } finally {
      setLoading(false)
    }
  }

  const runSave = async () => {
    if (!preview) return
    setLoading(true)
    try {
      const previewTokens = Object.fromEntries(
        preview.members.map((member) => [member.memberId, member.previewToken]),
      )
      const res = await fetch("/api/admin/members/bulk-membership-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: preview.members.map((member) => member.memberId),
          seasonYear,
          membershipTypeId,
          reason,
          previewTokens,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as SaveResponse & {
        error?: string
      }
      if (!res.ok) throw new Error(data.error || "Bulk membership change failed")
      setSaveResult(data)
      setStep("results")
    } catch (err) {
      onError(err instanceof Error ? err.message : "Bulk membership change failed")
    } finally {
      setLoading(false)
    }
  }

  const typeName = types.find((type) => type.id === membershipTypeId)?.name ?? ""

  const nameFor = (memberId: string, name?: string) =>
    name ?? memberNames.get(memberId) ?? memberId

  const xero = saveResult?.xeroReconcile

  return (
    <Dialog
      open={open}
      // Never drop a run mid-save: ignore a close request while the server-side
      // save is in flight so the completed run always lands `onComplete`.
      onOpenChange={(next) => {
        if (!next && loading) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (loading) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (loading) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Set Membership Type</DialogTitle>
          <DialogDescription>
            Assign a seasonal membership type to {ids.length} selected member
            {ids.length === 1 ? "" : "s"}.
          </DialogDescription>
        </DialogHeader>

        {step === "configure" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-membership-type">Membership type</Label>
              <Select value={membershipTypeId} onValueChange={setMembershipTypeId}>
                <SelectTrigger id="bulk-membership-type">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-membership-season">Season year</Label>
              <Select
                value={String(seasonYear)}
                onValueChange={(value) => setSeasonYear(Number(value))}
              >
                <SelectTrigger id="bulk-membership-season">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((year) => (
                    <SelectItem key={year} value={String(year)}>
                      {year}
                      {year === currentSeasonYear ? " (current season)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {overCap && (
              <Alert variant="warning">
                Bulk membership changes are limited to {BULK_MEMBERSHIP_MAX} members at
                a time — refine your selection.
              </Alert>
            )}
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Season {preview.seasonYear}
              </p>
              <p className="mt-1 font-medium">
                {preview.summary.changed} of {preview.summary.previewed} will change
                {preview.summary.unchanged > 0
                  ? ` (${preview.summary.unchanged} already on this type)`
                  : ""}
                .
              </p>
              {preview.seasonYear !== currentSeasonYear && (
                <p className="mt-1 text-xs text-warning-11">
                  Heads up: this is not the current season ({currentSeasonYear}).
                </p>
              )}
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li>
                  Future confirmed bookings affected:{" "}
                  {preview.summary.affectedTotals.futureConfirmedBookings}
                </li>
                <li>Draft bookings: {preview.summary.affectedTotals.draftBookings}</li>
                <li>
                  Waitlist records: {preview.summary.affectedTotals.waitlistRecords}
                </li>
                {preview.summary.ageTierChanges > 0 && (
                  <li>Age tier changes: {preview.summary.ageTierChanges}</li>
                )}
                {preview.summary.linkedGuestBlocks > 0 && (
                  <li className="text-destructive">
                    Blocked by linked-guest bookings:{" "}
                    {preview.summary.linkedGuestBlocks}
                  </li>
                )}
                {preview.summary.skipped > 0 && (
                  <li>Skipped (archived / not found): {preview.summary.skipped}</li>
                )}
              </ul>
            </div>
            <Alert variant="info">
              Existing bookings are not repriced. Changing the membership type only
              affects future pricing and eligibility.
            </Alert>
            {(preview.summary.ageTierChanges > 0 ||
              preview.summary.linkedGuestBlocks > 0) && (
              <div className="max-h-40 overflow-y-auto rounded-md border p-2 text-xs">
                {preview.members
                  .filter(
                    (member) => member.ageTierChanged || member.linkedGuestBlocked,
                  )
                  .map((member) => (
                    <div key={member.memberId} className="py-0.5">
                      <div>
                        <span className="font-medium">{member.name}</span>
                        {member.ageTierChanged && (
                          <span className="ml-2 text-muted-foreground">
                            age tier {member.currentAgeTier} →{" "}
                            {member.resultingAgeTier}
                          </span>
                        )}
                        {member.linkedGuestBlocked && (
                          <span className="ml-2 text-destructive">
                            blocked: linked guest on{" "}
                            {member.linkedGuestBookings.count} future booking(s)
                          </span>
                        )}
                      </div>
                      {member.linkedGuestBlocked && (
                        <LinkedGuestBookingList
                          bookings={member.linkedGuestBookings}
                        />
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {step === "reason" && (
          <div className="space-y-2">
            <Label htmlFor="bulk-membership-reason">
              Reason (recorded on each member&apos;s audit trail)
            </Label>
            <Textarea
              id="bulk-membership-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={1000}
              {...reasonHint.fieldProps}
            />
            <FieldHint {...reasonHint.hintProps}>
              {`Example: Changing ${preview?.summary.changed ?? 0} member(s) to ${typeName}`}
            </FieldHint>
          </div>
        )}

        {step === "results" && saveResult && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-1">
              {(Object.keys(OUTCOME_LABELS) as MemberOutcome[]).map((outcome) =>
                saveResult.outcomeCounts[outcome] > 0 ? (
                  <div key={outcome} className="flex justify-between rounded border px-2 py-1">
                    <span>{OUTCOME_LABELS[outcome]}</span>
                    <span className="font-medium">
                      {saveResult.outcomeCounts[outcome]}
                    </span>
                  </div>
                ) : null,
              )}
            </div>
            {xero && xero.attempted > 0 && xero.succeeded < xero.attempted && (
              <Alert variant="info">
                Xero group sync: {xero.succeeded} of {xero.attempted} synced
                {xero.haltedByDailyLimit
                  ? " — daily limit reached, the nightly reconcile will finish the rest."
                  : " — the nightly reconcile will finish the rest."}
              </Alert>
            )}
            {saveResult.results.some(
              (result) =>
                result.outcome === "stale" ||
                result.outcome === "blocked_linked_guests" ||
                result.outcome === "error",
            ) && (
              <div className="max-h-40 overflow-y-auto rounded-md border p-2 text-xs">
                {saveResult.results
                  .filter(
                    (result) =>
                      result.outcome === "stale" ||
                      result.outcome === "blocked_linked_guests" ||
                      result.outcome === "error",
                  )
                  .map((result) => (
                    <div key={result.memberId} className="py-0.5">
                      <div>
                        <span className="font-medium">
                          {nameFor(result.memberId, result.name)}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {OUTCOME_LABELS[result.outcome]}
                          {result.error ? ` — ${result.error}` : ""}
                        </span>
                      </div>
                      {result.outcome === "blocked_linked_guests" && (
                        <LinkedGuestBookingList
                          bookings={result.linkedGuestBookings}
                        />
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "configure" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button
                onClick={runPreview}
                disabled={loading || !membershipTypeId || overCap}
              >
                {loading ? "Previewing..." : "Preview"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("configure")} disabled={loading}>
                Back
              </Button>
              <Button
                onClick={() => setStep("reason")}
                disabled={loading || (preview?.summary.changed ?? 0) === 0}
              >
                Continue
              </Button>
            </>
          )}
          {step === "reason" && (
            <>
              <Button variant="outline" onClick={() => setStep("preview")} disabled={loading}>
                Back
              </Button>
              <Button onClick={runSave} disabled={loading || reason.trim().length === 0}>
                {loading ? "Saving..." : "Confirm change"}
              </Button>
            </>
          )}
          {step === "results" && (
            <>
              <Button variant="outline" onClick={runPreview} disabled={loading}>
                Preview again
              </Button>
              <Button
                onClick={() => {
                  onComplete(saveResult?.outcomeCounts.changed ?? 0)
                  onOpenChange(false)
                }}
                disabled={loading}
              >
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
