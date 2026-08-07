"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select"
import { OccupancyCalendar, type CalendarTone } from "@/components/admin/occupancy-calendar"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { isRosterData, RosterEditor, type RosterData } from "@/components/admin/roster-editor"
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only"
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import type { RosterDayStatus, RosterDayStatusResult } from "@/lib/roster-status"

const ROSTER_LONG_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
})

const ROSTER_STATUS_OVERLAY: Record<
  Exclude<RosterDayStatus, "no-guests">,
  { tone: CalendarTone; label: string }
> = {
  "needs-roster": { tone: "red", label: "Needs roster" },
  suggested: { tone: "amber", label: "Suggested" },
  "needs-attention": { tone: "orange", label: "Needs chores" },
  confirmed: { tone: "green", label: "Confirmed" },
}

const ROSTER_LEGEND: Array<{ tone: CalendarTone; label: string }> = [
  { tone: "red", label: "Needs roster" },
  { tone: "amber", label: "Suggested (unconfirmed)" },
  { tone: "orange", label: "Confirmed — some guests need chores" },
  { tone: "green", label: "Confirmed" },
]

type ActionFailureKind = "roster" | "email-send" | "email-suppress"

function actionFailure(action: string, kind: ActionFailureKind = "roster") {
  if (kind === "email-send") {
    return "Sending roster emails could not be verified because the service could not be reached. Some recipients may already have received new links; check Email Deliverability before trying again."
  }
  if (kind === "email-suppress") {
    return "Recording the no-email choice could not be verified because the service could not be reached. No email send was requested, and existing links remain valid; check the audit log before recording the choice again."
  }
  return `${action} could not be verified because the service could not be reached. Reload the roster and check its current status before trying again.`
}

function unreadableActionFailure(action: string, kind: ActionFailureKind = "roster") {
  if (kind === "email-send") {
    return "Sending roster emails could not be verified because the service returned an unreadable response. Some recipients may already have received new links; check Email Deliverability before trying again."
  }
  if (kind === "email-suppress") {
    return "Recording the no-email choice could not be verified because the service returned an unreadable response. No email send was requested, and existing links remain valid; check the audit log before recording the choice again."
  }
  return `${action} could not be verified because the service returned an unreadable response. Reload the roster and check its current status before trying again.`
}

function isActionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEmailActionResult(
  value: Record<string, unknown>,
  notifyMember: boolean,
): boolean {
  if (value.success !== true) return false
  if (!notifyMember) return value.suppressed === true
  return (value.suppressed === undefined || value.suppressed === false) &&
    typeof value.partialFailure === "boolean" &&
    typeof value.sent === "number" &&
    typeof value.failed === "number" &&
    typeof value.skipped === "number"
}

export default function RosterPage() {
  const canEdit = useAdminAreaEditAccess("lodge")
  const [selectedDate, setSelectedDate] = useState(formatDateOnly(getTodayDateOnly()))
  const [roster, setRoster] = useState<RosterData | null>(null)
  const [rosterLoadVersion, setRosterLoadVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [savingAction, setSavingAction] = useState(false)
  const [includeNonEssential, setIncludeNonEssential] = useState<boolean | null>(null)
  const [sendingEmail, setSendingEmail] = useState(false)
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false)
  const [lastEmailSuppressed, setLastEmailSuppressed] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  const [editorActive, setEditorActive] = useState(false)
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin")
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation)
  const [overlayByDate, setOverlayByDate] = useState<Record<string, { tone: CalendarTone; label: string }>>({})
  const lodgeIdRef = useRef(lodgeId)
  const rosterRequestRef = useRef(0)
  const pageAlertRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    lodgeIdRef.current = lodgeId
  }, [lodgeId])

  useEffect(() => {
    if (!error) return
    pageAlertRef.current?.focus()
    pageAlertRef.current?.scrollIntoView?.({ block: "center" })
  }, [error])

  const loadMonthStatus = useCallback(async (month: string) => {
    try {
      const query = new URLSearchParams({ month })
      if (lodgeId) query.set("lodgeId", lodgeId)
      const response = await fetch(`/api/admin/roster/status?${query.toString()}`)
      if (!response.ok) return
      const data: { statuses: RosterDayStatusResult[] } = await response.json()
      if (lodgeId !== lodgeIdRef.current) return
      setOverlayByDate((current) => {
        const next = { ...current }
        for (const result of data.statuses ?? []) {
          if (result.status === "no-guests") delete next[result.date]
          else next[result.date] = ROSTER_STATUS_OVERLAY[result.status]
        }
        return next
      })
    } catch {
      // Calendar status is non-essential; the date controls remain usable.
    }
  }, [lodgeId])

  const rosterUrl = useCallback((date: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params)
    if (lodgeId) query.set("lodgeId", lodgeId)
    const suffix = query.toString()
    return `/api/admin/roster/${encodeURIComponent(date)}${suffix ? `?${suffix}` : ""}`
  }, [lodgeId])

  const fetchRoster = useCallback(async (date: string, signal?: AbortSignal) => {
    const requestId = ++rosterRequestRef.current
    // Invalidate the previous date/lodge partition before this request can
    // yield. A stale roster must never render beneath a newly-selected key.
    setRoster(null)
    setLoading(true)
    setError("")
    try {
      const response = await fetch(rosterUrl(date), { signal })
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error("Roster could not be loaded because the service returned an unreadable response. Try again.")
      }
      if (requestId !== rosterRequestRef.current) return
      if (!response.ok) {
        const message = typeof body === "object" && body !== null &&
          "error" in body && typeof body.error === "string"
          ? body.error
          : "Roster could not be loaded. Try again."
        throw new Error(message)
      }
      if (!isRosterData(body)) {
        throw new Error("Roster could not be loaded because the service returned an unreadable response. Try again.")
      }
      setRoster(body)
      setRosterLoadVersion((version) => version + 1)
      setLastEmailSuppressed(false)
      void loadMonthStatus(date.slice(0, 7))
    } catch (loadError) {
      if (requestId !== rosterRequestRef.current) return
      if (loadError instanceof DOMException && loadError.name === "AbortError") return
      // A failed date/lodge load clears the prior partition rather than
      // presenting stale row ids under the newly-selected key.
      setRoster(null)
      setError(
        loadError instanceof DOMException && loadError.name === "AbortError"
          ? ""
          : loadError instanceof TypeError
            ? "Roster could not be loaded because the service could not be reached. Try again."
            : loadError instanceof Error
              ? loadError.message
              : "Roster could not be loaded because the service could not be reached. Try again.",
      )
    } finally {
      if (requestId === rosterRequestRef.current) setLoading(false)
    }
  }, [loadMonthStatus, rosterUrl])

  useEffect(() => {
    const controller = new AbortController()
    void fetchRoster(selectedDate, controller.signal)
    return () => controller.abort()
  }, [fetchRoster, selectedDate])

  useEffect(() => setOverlayByDate({}), [lodgeId])

  function confirmDiscardDraft() {
    return !editorDirty || window.confirm("Discard your unsaved roster changes? This cannot be undone.")
  }

  function changeDate(nextDate: string) {
    if (!confirmDiscardDraft()) return
    rosterRequestRef.current += 1
    setRoster(null)
    setSelectedDate(nextDate)
  }

  function changeLodge(nextLodgeId: string | null) {
    if (!confirmDiscardDraft()) return
    rosterRequestRef.current += 1
    setRoster(null)
    setLodgeId(nextLodgeId)
  }

  async function runRosterAction(
    body: Record<string, unknown>,
    failureLabel: string,
    failureKind: ActionFailureKind = "roster",
  ) {
    setSavingAction(true)
    setError("")
    try {
      let response: Response
      try {
        response = await fetch(rosterUrl(selectedDate), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      } catch {
        throw new Error(actionFailure(failureLabel, failureKind))
      }
      if (response.status === 403) throw new Error(ADMIN_FORBIDDEN_SAVE_REASON)
      let decoded: unknown
      try {
        decoded = await response.json()
      } catch {
        throw new Error(unreadableActionFailure(failureLabel, failureKind))
      }
      if (!isActionRecord(decoded)) {
        throw new Error(unreadableActionFailure(failureLabel, failureKind))
      }
      if (!response.ok) {
        throw new Error(
          typeof decoded.error === "string"
            ? decoded.error
            : actionFailure(failureLabel, failureKind),
        )
      }
      return decoded
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : actionFailure(failureLabel, failureKind),
      )
      return null
    } finally {
      setSavingAction(false)
    }
  }

  async function handleRegenerate() {
    if (!confirmDiscardDraft()) return
    const hasFinalAssignments = roster?.assignments.some(
      (assignment) => assignment.status === "CONFIRMED" || assignment.status === "COMPLETED",
    ) ?? false
    if (hasFinalAssignments && !window.confirm(
      "This will replace the current confirmed roster with a new editable suggested roster. Continue?",
    )) return
    const result = await runRosterAction({
      action: "regenerate",
      includeNonEssential: includeNonEssential ?? undefined,
      overwriteConfirmed: hasFinalAssignments || undefined,
    }, "Regenerating the roster")
    if (result) await fetchRoster(selectedDate)
  }

  async function handleConfirm() {
    if (!window.confirm("Confirm all suggested assignments? This marks them as final.")) return
    const result = await runRosterAction({ action: "confirm" }, "Confirming the roster")
    if (result) await fetchRoster(selectedDate)
  }

  async function performSendEmail(notifyMember: boolean) {
    setSendingEmail(true)
    setLastEmailSuppressed(false)
    const failureKind = notifyMember ? "email-send" : "email-suppress"
    const failureLabel = notifyMember ? "Sending roster emails" : "Recording the no-email choice"
    const data = await runRosterAction(
      { action: "email", notifyMember },
      failureLabel,
      failureKind,
    )
    setSendingEmail(false)
    if (!data) return
    if (!isEmailActionResult(data, notifyMember)) {
      setError(unreadableActionFailure(failureLabel, failureKind))
      return
    }
    if (data.suppressed) {
      setLastEmailSuppressed(true)
      window.alert("No emails sent. Existing chore links remain valid. Your choice is recorded in the audit log.")
      return
    }
    const skipped = data.skipped ? ` ${data.skipped} guest(s) skipped because they opted out.` : ""
    window.alert(data.partialFailure
      ? `The roster was sent to successful recipients, with ${data.failed} failure(s). Check Email Deliverability before retrying so successful recipients are not sent another fresh link.${skipped}`
      : `Roster emails sent successfully.${skipped}`)
  }

  const hasSuggested = roster?.assignments.some((assignment) => assignment.status === "SUGGESTED") ?? false
  const isConfirmed = Boolean(roster?.assignments.length) && roster!.assignments.every(
    (assignment) => assignment.status === "CONFIRMED" || assignment.status === "COMPLETED",
  )
  const stayingBookingIds = new Set((roster?.guests ?? []).map((guest) => guest.bookingId))
  const coveredBookingIds = new Set((roster?.assignments ?? []).map((assignment) => assignment.bookingId))
  const uncoveredCount = [...stayingBookingIds].filter((bookingId) => !coveredBookingIds.has(bookingId)).length
  const selectedDatePathSegment = encodeURIComponent(selectedDate)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Chore Roster</h1>
          <p className="mt-1 text-muted-foreground">Review and manage daily chore assignments</p>
        </div>
        <div className="flex items-center space-x-3">
          <LodgeSelect lodges={lodges} value={lodgeId} onChange={changeLodge} loading={lodgesLoading} />
          <a
            href={`/admin/roster/${selectedDatePathSegment}/print${lodgeId ? `?lodgeId=${encodeURIComponent(lodgeId)}` : ""}`}
            target="_blank"
            rel="noopener noreferrer"
          ><Button variant="outline">Print Roster</Button></a>
        </div>
      </div>

      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
        Your admin role can view the chore roster but cannot change it. Lodge edit access is required.
      </AdminViewOnlySectionBanner>

      <div className="space-y-6">
        <div
          ref={pageAlertRef}
          role="alert"
          aria-live="assertive"
          tabIndex={-1}
          className={error ? "rounded-md bg-destructive/10 px-4 py-3 text-destructive" : "sr-only"}
        >{error}</div>

        <Card>
          <CardHeader><CardTitle>Select Date</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label htmlFor="date">Date</Label>
                <Input id="date" type="date" value={selectedDate} onChange={(event) => changeDate(event.target.value)} />
              </div>
              <div className="flex items-center space-x-2">
                <input
                  id="includeNonEssential"
                  type="checkbox"
                  checked={includeNonEssential ?? false}
                  onChange={(event) => setIncludeNonEssential(event.target.checked ? true : null)}
                  className="rounded border-input"
                />
                <Label htmlFor="includeNonEssential">Include non-essential chores</Label>
              </div>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                onClick={() => void handleRegenerate()}
                disabled={loading || savingAction}
              >Regenerate Roster</ViewOnlyActionButton>
            </div>
            <div className="mt-4">
              <OccupancyCalendar
                mode="single"
                selectedStartDate={selectedDate}
                selectedEndDate={selectedDate}
                onSelectionChange={({ startDate }) => changeDate(startDate)}
                overlayByDate={overlayByDate}
                overlayLegend={ROSTER_LEGEND}
                // #2631: the roster overlay — and ONLY the roster overlay —
                // colours the operational day, so this is the one calendar
                // that explains the difference between its colours and the
                // guest-night panel beneath them.
                overlayCountsOperationalDay
                onVisibleMonthChange={loadMonthStatus}
              />
            </div>
          </CardContent>
        </Card>

        {loading && <div className="py-8 text-center">Loading roster…</div>}
        {!loading && !roster && (
          <Card><CardContent className="py-8 text-center">
            <p className="mb-3 text-muted-foreground">The roster for this lodge night is unavailable.</p>
            <Button variant="outline" onClick={() => void fetchRoster(selectedDate)}>Try again</Button>
          </CardContent></Card>
        )}

        {roster && !loading && (
          <>
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Roster for {ROSTER_LONG_DATE.format(new Date(`${selectedDate}T00:00:00Z`))}</CardTitle>
                    {/* #2622: the count is everyone in the lodge on this
                        operational day, which includes the people checking out
                        this morning — not just tonight's sleepers. */}
                    <CardDescription>{roster.guestCount} guest{roster.guestCount === 1 ? "" : "s"} in the lodge · {roster.assignments.length} assignment{roster.assignments.length === 1 ? "" : "s"}</CardDescription>
                    {lastEmailSuppressed && <p className="mt-1 text-xs text-muted-foreground">Last send: no emails sent — existing chore links remain valid.</p>}
                  </div>
                  <div className="flex gap-2">
                    {hasSuggested && <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={() => void handleConfirm()} disabled={savingAction || editorActive}>Confirm Roster</ViewOnlyActionButton>}
                    {isConfirmed && <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" onClick={() => setNotifyDialogOpen(true)} disabled={sendingEmail || editorActive}>{sendingEmail ? "Sending…" : "Email Roster to Guests"}</ViewOnlyActionButton>}
                  </div>
                </div>
              </CardHeader>
            </Card>

            {isConfirmed && uncoveredCount > 0 && (
              <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
                {uncoveredCount} booking{uncoveredCount === 1 ? "" : "s"} in the lodge today {uncoveredCount === 1 ? "has" : "have"} no chores — regenerate the roster to include {uncoveredCount === 1 ? "it" : "them"}.
              </div>
            )}

            <RosterEditor
              key={`${roster.lodgeId}:${roster.date}:${rosterLoadVersion}`}
              roster={roster}
              canEdit={canEdit}
              saveUrl={rosterUrl(selectedDate)}
              onRosterUpdate={setRoster}
              onDirtyChange={setEditorDirty}
              onEditingChange={setEditorActive}
              ancestorRendersViewOnlyBanner
            />
          </>
        )}

        <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Email the roster to guests?</DialogTitle>
              <DialogDescription>
                Emailing sends each affected guest a fresh chore link. Choosing not to email leaves existing links valid and records the choice.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" disabled={sendingEmail} onClick={() => { setNotifyDialogOpen(false); void performSendEmail(false) }}>Don’t email — keep existing links</Button>
              <Button disabled={sendingEmail} onClick={() => { setNotifyDialogOpen(false); void performSendEmail(true) }}>Email guests the roster</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
