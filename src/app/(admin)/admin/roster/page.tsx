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
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status"
import { isRosterData, RosterEditor, type RosterData } from "@/components/admin/roster-editor"
import { useClubTime } from "@/components/club-time-provider"
import { formatClubLongWeekdayDate, parseCalendarDate } from "@/lib/club-time"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import type { RosterDayStatus, RosterDayStatusResult } from "@/lib/roster-status"
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope"

// #2264: deliberately not one of the shared house shapes — the printed chore
// roster heads the page with the full weekday and month, matching the
// on-screen roster and the chore-roster email.
//
// CT-4 (#2870): the roster day is a CALENDAR DATE and calendar dates have no
// timezone — 16 April 2026 is a Thursday everywhere on earth. The kernel's
// `longWeekdayDate` shape pins "UTC" over its own UTC-midnight encoding, which
// is the IDENTITY for every club rather than a projection, so this needs no zone
// plumbing at all. The local copy of the same options this replaces was one of
// six.

/** The roster day as a heading. Falsy/malformed renders as itself, not a throw. */
function formatRosterDay(date: string): string {
  const day = parseCalendarDate(date)
  return day ? formatClubLongWeekdayDate(day) : date
}

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
  // The roster opens on the CLUB's today. The chore roster is a lodge-night
  // surface and the API windows it in club time, so seeding it from the build's
  // `NEXT_PUBLIC_TZ` opened the wrong day. That constant is not the viewer's
  // clock and never was -- it is fixed at build time, and on a deployment that
  // sets only `TZ` it falls back to `Pacific/Auckland` for every viewer while
  // the server uses `TZ` (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime()
  const [selectedDate, setSelectedDate] = useState<string>(() => clubTime.today())
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
  /*
    #2701: this page keeps TWO lodge-scoped things on screen — the day's roster
    editor and the month calendar's status overlay — and both key off `lodgeId`.
    A failed lodge list used to leave `lodgeId` null, which the roster routes
    resolve to the club's DEFAULT lodge; the page then regenerated and emailed a
    roster for a lodge it never named. Worse, the two halves could disagree,
    because they are separate requests over the same unstated scope. So a failed
    list stops BOTH, rather than either one.
    Loading, failure, 403, and a successful empty response all stop both halves.
  */
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    reload: reloadLodges,
  } = useLodgeOptions("admin")
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation)
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
  })
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null
  const lodgeScopeReady = scopedLodgeId !== null
  const [overlayByDate, setOverlayByDate] = useState<Record<string, { tone: CalendarTone; label: string }>>({})
  const lodgeIdRef = useRef(scopedLodgeId)
  const selectedDateRef = useRef(selectedDate)
  const rosterRequestRef = useRef(0)
  const pageAlertRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    lodgeIdRef.current = scopedLodgeId
  }, [scopedLodgeId])
  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  useEffect(() => {
    if (!error) return
    pageAlertRef.current?.focus()
    pageAlertRef.current?.scrollIntoView?.({ block: "center" })
  }, [error])

  const loadMonthStatus = useCallback(async (month: string) => {
    // #2701: the overlay is the calendar's half of the scope. Leaving it to load
    // unscoped while the editor is stopped is exactly the disagreement to avoid
    // — the month would be coloured for the default lodge under a page that has
    // told the admin it does not know which lodge it is on.
    if (!scopedLodgeId) return
    try {
      const query = new URLSearchParams({ month })
      query.set("lodgeId", scopedLodgeId)
      const response = await fetch(`/api/admin/roster/status?${query.toString()}`)
      if (!response.ok) return
      const data: { statuses: RosterDayStatusResult[] } = await response.json()
      if (scopedLodgeId !== lodgeIdRef.current) return
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
  }, [scopedLodgeId])

  const rosterUrl = useCallback((date: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params)
    if (scopedLodgeId) query.set("lodgeId", scopedLodgeId)
    const suffix = query.toString()
    return `/api/admin/roster/${encodeURIComponent(date)}${suffix ? `?${suffix}` : ""}`
  }, [scopedLodgeId])

  const fetchRoster = useCallback(async (date: string, signal?: AbortSignal) => {
    const requestId = ++rosterRequestRef.current
    // Invalidate the previous date/lodge partition before this request can
    // yield. A stale roster must never render beneath a newly-selected key.
    setRoster(null)
    // #2701: no lodge list, no lodge partition. The roster routes resolve a
    // missing lodgeId to the club's default lodge, so loading (and then
    // confirming or emailing) a roster here would act on a lodge nobody chose.
    // Clearing the roster above is the point: the editor goes with it.
    if (!scopedLodgeId) {
      setLoading(false)
      setError("")
      return
    }
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
  }, [loadMonthStatus, rosterUrl, scopedLodgeId])

  useEffect(() => {
    const controller = new AbortController()
    void fetchRoster(selectedDate, controller.signal)
    return () => controller.abort()
  }, [fetchRoster, selectedDate])

  // #2701: a lodge list that fails after a month has already been coloured
  // clears the overlay too, so the calendar cannot keep showing the old scope's
  // colours next to a stopped editor.
  useEffect(() => setOverlayByDate({}), [scopedLodgeId])

  function confirmDiscardDraft() {
    return !editorDirty || window.confirm("Discard your unsaved roster changes? This cannot be undone.")
  }

  function changeDate(nextDate: string) {
    if (!confirmDiscardDraft()) return
    rosterRequestRef.current += 1
    selectedDateRef.current = nextDate
    setRoster(null)
    setSelectedDate(nextDate)
  }

  function changeLodge(nextLodgeId: string | null) {
    if (!confirmDiscardDraft()) return
    rosterRequestRef.current += 1
    lodgeIdRef.current = nextLodgeId
    setRoster(null)
    setLodgeId(nextLodgeId)
  }

  async function runRosterAction(
    body: Record<string, unknown>,
    failureLabel: string,
    failureKind: ActionFailureKind = "roster",
  ) {
    // #2701 backstop for the disabled action buttons: every roster action PUTs
    // to a URL whose lodgeId must be the id validated by the successful options
    // response, never an unresolved deep-link value or an omitted default.
    if (!scopedLodgeId) return null
    const requestedLodgeId = scopedLodgeId
    const requestedDate = selectedDate
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
      if (
        lodgeIdRef.current !== requestedLodgeId ||
        selectedDateRef.current !== requestedDate
      ) {
        return null
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
          <LodgeSelect lodges={lodges} value={lodgeId} onChange={changeLodge} loading={lodgesLoading}
            // #2701: an empty list from a FAILED request is not evidence the
            // caller's lodge is gone, so the ADR-002 normaliser must not wipe a
            // ?lodgeId= hub link (ADR-003) while the outage lasts.
            deferDefaultSelection={lodgesFailed || lodgesForbidden}
          />
          {/* #2701: the print sheet is lodge-scoped too — with no lodgeId in the
              link it prints the default lodge's roster, which is the one thing
              worse than not printing at all, because it leaves the building. */}
          {lodgeScopeReady ? (
            <a
              href={`/admin/roster/${selectedDatePathSegment}/print?lodgeId=${encodeURIComponent(scopedLodgeId)}`}
              target="_blank"
              rel="noopener noreferrer"
            ><Button variant="outline">Print Roster</Button></a>
          ) : null}
        </div>
      </div>

      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodges}
        what="the roster and its chore assignments"
        className="mb-6"
      />

      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
        Your admin role can view the chore roster but cannot change it. Lodge edit access is required.
      </AdminViewOnlySectionBanner>

      {lodgeScopeReady ? (
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
                // #2701: `canEdit` keeps carrying the ROLE reason; a missing
                // lodge list disables the action separately, explained by the
                // notice above.
                disabled={loading || savingAction}
              >Regenerate Roster</ViewOnlyActionButton>
            </div>
            <div className="mt-4">
              <OccupancyCalendar
                mode="single"
                // #2887: the heat-map is lodge-scoped like everything else on
                // this page. This branch only renders once the scope settles,
                // so `scopedLodgeId` is concrete here.
                lodgeId={scopedLodgeId}
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
        {/* #2701: while the lodge list is down the roster was never requested,
            so "unavailable — try again" would be both wrong and a retry that
            can only no-op. The notice above owns that explanation and its
            retry. */}
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
                    <CardTitle>Roster for {formatRosterDay(selectedDate)}</CardTitle>
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
      ) : null}
    </div>
  )
}
