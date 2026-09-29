"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { CancellationRulesEditor } from "./cancellation-rules-editor"
import { PolicyPreview } from "./policy-preview"
import { PolicyFeedback } from "./policy-feedback"
import {
  isPolicyScopeReady,
  PolicyScopeSelect,
  usePolicyScopeOptions,
} from "./policy-scope-select"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import {
  draftsEqual,
  NEW_PERIOD_DRAFT,
  toDraft,
  UNLOADED_SCOPE,
  type PeriodDraft,
} from "./booking-period-draft"
import { formatStayDateOrNull } from "@/lib/club-time"
import { useClubFormat } from "@/components/club-format-provider"
import type { BookingPeriod, PolicyRule } from "./types"

function PeriodForm({
  periodId,
  initial,
  canEdit,
  onSubmit,
  onCancel,
  onError,
}: {
  /** `null` while creating — there is no persisted row to be unchanged from. */
  periodId: string | null
  initial: PeriodDraft
  canEdit: boolean | undefined
  /** Persists the draft and closes the form. Throws to surface a failure. */
  onSubmit: (draft: PeriodDraft) => Promise<PeriodDraft>
  onCancel: () => void
  onError: (message: string) => void
}) {
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const nameHint = useFieldHint()
  const section = useSectionEditState<PeriodDraft>({
    initial,
    save: onSubmit,
    // The section renders its own `PolicyFeedback` above the list, so the
    // success copy is set by the parent when the form closes.
    successMessage: "",
    // #2143: an Edit -> Save that changed nothing must not reach the PUT, which
    // writes a `booking-period.update` audit entry with a `before`/`after` pair
    // unconditionally — identical halves and all — and busts the public-page
    // cache. Creating is the first-save exception (the same one the group
    // discount card makes): there is no persisted row for the draft to be
    // unchanged FROM, so a create is always savable once it validates.
    isDirty: (draft, saved) => periodId === null || !draftsEqual(draft, saved),
    isValid: (draft) =>
      Boolean(draft.name) && Boolean(draft.startDate) && Boolean(draft.endDate),
  })

  const { draft, saving, dirty, valid, error } = section
  // #2685: a fixed-fee box holding something that is not an amount blocks Save,
  // because the draft still carries the previous cents for that field.
  const [hasInvalidRuleAmounts, setHasInvalidRuleAmounts] = useState(false)

  // The hook owns the save-failure message; this section presents every message
  // in one place above the list, so mirror it up rather than rendering twice.
  useEffect(() => {
    if (error) onError(error)
  }, [error, onError])

  if (!draft) return null

  return (
    <Card className="border-info-6 bg-info-3/30">
      <CardContent className="pt-6 space-y-4">
        <h3 className="font-semibold">
          {periodId ? "Edit Period" : "New Period"}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="pName">Period Name</Label>
            <Input
              id="pName"
              value={draft.name}
              onChange={(e) => section.setDraft({ name: e.target.value })}
              {...nameHint.fieldProps}
            />
            <FieldHint {...nameHint.hintProps}>
              Example: School Holidays Jul 2026
            </FieldHint>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pHold">Non-member hold days</Label>
            <Input
              id="pHold"
              type="number"
              min="1"
              max="365"
              value={draft.holdDays}
              onChange={(e) =>
                section.setDraft({ holdDays: parseInt(e.target.value) || 5 })
              }
              className="w-24"
              disabled={!draft.holdEnabled}
            />
            <p className="text-xs text-muted-foreground">
              {draft.holdEnabled
                ? "Used only when this period applies and Members First is enabled."
                : "Stored but inactive while this period uses First Paid, First In."}
            </p>
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3 md:col-span-2">
            <Checkbox
              checked={draft.holdEnabled}
              onCheckedChange={(v) => section.setDraft({ holdEnabled: v === true })}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">Members First for this period</span>
              <span className="block text-xs text-muted-foreground">
                Disable this to let bookings in this date range proceed as First Paid, First In.
              </span>
            </span>
          </label>
          <div className="space-y-2">
            <Label htmlFor="pStart">Start Date</Label>
            <Input
              id="pStart"
              type="date"
              value={draft.startDate}
              onChange={(e) => section.setDraft({ startDate: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pEnd">End Date</Label>
            <Input
              id="pEnd"
              type="date"
              value={draft.endDate}
              onChange={(e) => section.setDraft({ endDate: e.target.value })}
            />
          </div>
        </div>

        <div>
          <Label className="text-sm font-semibold">Cancellation Rules for this Period</Label>
          <CancellationRulesEditor
            rules={draft.rules}
            onChange={(rules) => section.setDraft({ rules })}
            onInvalidAmountsChange={setHasInvalidRuleAmounts}
          />
        </div>

        <div>
          <Label className="text-sm font-semibold">Preview</Label>
          <PolicyPreview rules={draft.rules} />
        </div>

        <div className="flex space-x-3">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={() => void section.save()}
            disabled={saving || !valid || !dirty || hasInvalidRuleAmounts}
          >
            {saving ? "Saving..." : periodId ? "Update Period" : "Create Period"}
          </ViewOnlyActionButton>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function BookingPeriodsSection() {
  const format = useClubFormat()
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")
  // Per-lodge override scope (ADR-001 resolved question 3): null lists the
  // club-wide periods; a lodge lists its override set, which replaces the
  // club-wide set entirely at runtime. Hidden with fewer than two lodges.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const policyScope = usePolicyScopeOptions(scopeLodgeId)
  const policyScopeReady = isPolicyScopeReady(policyScope)
  const scopeLodgeName =
    policyScope.state.kind === "lodge" ? policyScope.state.lodgeName : null
  const [periods, setPeriods] = useState<BookingPeriod[]>([])
  /**
   * The scope `periods` was actually loaded FOR (#2142 review).
   *
   * `AGENTS.md` makes this binding for any section whose fetch is keyed on
   * something beyond the section itself: the key travels WITH the snapshot and a
   * mismatch is UNKNOWN — no editor, no destructive affordances. A failed fetch
   * here used to set `error` and leave `periods` alone, so after a failed switch
   * to a lodge the card was retitled "Date-Specific Periods — Lodge One", said
   * "Periods listed here belong to Lodge One", and left Edit, Delete (a HARD
   * delete) and Activate/Deactivate live over rows that were still the CLUB-WIDE
   * set. Every one of those buttons acts on `period.id`, so they would have hit
   * the club-wide rows the admin believed they had navigated away from.
   */
  const [loadedScope, setLoadedScope] = useState<string | null>(UNLOADED_SCOPE)
  // Mirrors `scopeLodgeId` for the async fetch below, which needs the CURRENT
  // scope at the moment it resolves rather than the one it closed over. The
  // list refresh after a save/delete/toggle carries no AbortSignal, so this is
  // the only thing standing between a slow response and the wrong partition.
  const scopeRef = useRef(scopeLodgeId)
  const [loadingPeriods, setLoadingPeriods] = useState(true)
  const [showPeriodForm, setShowPeriodForm] = useState(false)
  const [editingPeriodId, setEditingPeriodId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<PeriodDraft>(NEW_PERIOD_DRAFT)
  // Bumped every time an editor is opened. The open editor owns its own
  // draft/snapshot pair, seeded once from `initial`, so re-opening the SAME row
  // has to remount it — otherwise `key={editingPeriodId ?? "new"}` is unchanged,
  // React reuses the instance, the new `initial` is ignored, and clicking Edit
  // again on a row you were already editing silently keeps the unsaved draft
  // instead of resetting the form (#2142 review).
  const [editorInstance, setEditorInstance] = useState(0)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  /**
   * Load the list for the CURRENT scope.
   *
   * `scopeLoad` marks the fetch that a scope change (including the mount) is
   * waiting on: only that one flips the section into its loading state, so an
   * ordinary refresh after a write never blanks the list. Every state write is
   * guarded on the scope still being the one this call was made for, which is
   * also what keeps `loadedScope` honest — a dropped response leaves the new
   * scope UNKNOWN until its own load lands, rather than labelling one scope's
   * rows with another's.
   */
  const fetchPeriods = useCallback(
    async (options: { signal?: AbortSignal; scopeLoad?: boolean } = {}) => {
      const { signal, scopeLoad = false } = options
      const scope = scopeLodgeId
      if (!policyScopeReady) {
        if (scopeLoad) setLoadingPeriods(false)
        return
      }
      if (scopeLoad) setLoadingPeriods(true)
      try {
        const res = await fetch(
          scope
            ? `/api/admin/booking-policies/periods?lodgeId=${encodeURIComponent(scope)}`
            : "/api/admin/booking-policies/periods",
          { signal }
        )
        if (!res.ok) throw new Error("Failed to fetch periods")
        const data = await res.json()
        if (scopeRef.current !== scope) return
        setPeriods(
          data.map((period: BookingPeriod) => ({
            ...period,
            cancellationRules: period.cancellationRules.map((rule) => normalizeCancellationRule(rule)),
          }))
        )
        setLoadedScope(scope)
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return
        if (scopeRef.current !== scope) return
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        if (scopeLoad && scopeRef.current === scope) setLoadingPeriods(false)
      }
    },
    [policyScopeReady, scopeLodgeId],
  )

  useEffect(() => {
    scopeRef.current = scopeLodgeId
    // An open editor belongs to the partition we are leaving, so a scope change
    // closes it. Its row id would otherwise stay pointed at the old partition.
    setShowPeriodForm(false)
    setEditingPeriodId(null)
    setEditingDraft(NEW_PERIOD_DRAFT)
    const controller = new AbortController()
    void fetchPeriods({ signal: controller.signal, scopeLoad: true })
    return () => controller.abort()
  }, [fetchPeriods, scopeLodgeId])

  function resetPeriodForm() {
    setShowPeriodForm(false)
    setEditingPeriodId(null)
    setEditingDraft(NEW_PERIOD_DRAFT)
  }

  /** Close the open editor and clear the message it mirrored up (#2142 review). */
  function cancelPeriodForm() {
    setError("")
    resetPeriodForm()
  }

  function startAddPeriod() {
    if (!policyScopeReady) return
    setEditingPeriodId(null)
    setEditingDraft(NEW_PERIOD_DRAFT)
    setEditorInstance((n) => n + 1)
    setShowPeriodForm(true)
  }

  function startEditPeriod(period: BookingPeriod) {
    if (!policyScopeReady) return
    setEditingPeriodId(period.id)
    setEditingDraft(toDraft(period))
    setEditorInstance((n) => n + 1)
    setShowPeriodForm(true)
  }

  /**
   * The open editor's transport. Throws so `useSectionEditState` surfaces the
   * message; on success it closes the form and refreshes the list, which is why
   * the returned value (the hook's re-seed) is never actually rendered again.
   */
  const submitPeriod = useCallback(
    async (draft: PeriodDraft): Promise<PeriodDraft> => {
      if (!policyScopeReady) {
        throw new Error("Choose an available policy scope before saving")
      }
      setError("")
      setSuccess("")
      const url = editingPeriodId
        ? `/api/admin/booking-policies/periods/${editingPeriodId}`
        : "/api/admin/booking-policies/periods"
      const method = editingPeriodId ? "PUT" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          startDate: draft.startDate,
          endDate: draft.endDate,
          nonMemberHoldEnabled: draft.holdEnabled,
          nonMemberHoldDays: draft.holdDays,
          cancellationRules: draft.rules,
          // Partition is set at creation; edits keep the row's partition.
          ...(editingPeriodId ? {} : scopeLodgeId ? { lodgeId: scopeLodgeId } : {}),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const data = await res.json()
        throw new Error(data.error || "Failed to save period")
      }
      const wasEditing = editingPeriodId !== null
      // Parse the SERVER row into the re-seed value BEFORE closing the form, so
      // a malformed response surfaces as a save error rather than after a
      // success message has already been shown.
      let reseeded: PeriodDraft
      try {
        const saved = await res.json()
        reseeded = toDraft({
          ...saved,
          cancellationRules: (saved.cancellationRules ?? draft.rules).map(
            (rule: PolicyRule) => normalizeCancellationRule(rule),
          ),
        })
      } catch {
        // The write ALREADY SUCCEEDED at this point, so what a parse failure
        // may safely do depends on the verb. An edit is an idempotent PUT: keep
        // the form open with the error and the natural retry re-writes the same
        // row. A create is not: the row exists, but the form still has
        // `periodId === null`, so the same retry would POST a SECOND row. There
        // we swallow the parse failure, fall back to the submitted draft, and
        // close the form — the list refresh below shows what was really stored.
        if (wasEditing) {
          throw new Error(
            "The period was saved, but the server's reply could not be read. Reload the page to see what is stored.",
          )
        }
        reseeded = draft
      }
      resetPeriodForm()
      void fetchPeriods()
      setSuccess(wasEditing ? "Period updated" : "Period created")
      return reseeded
    },
    [editingPeriodId, scopeLodgeId, fetchPeriods, policyScopeReady],
  )

  async function handleDeletePeriod(id: string) {
    if (!policyScopeReady) return
    if (!confirm("Delete this booking period?")) return
    try {
      const res = await fetch(`/api/admin/booking-policies/periods/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      fetchPeriods()
      setSuccess("Period deleted")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  /**
   * #2143, second route in: Activate/Deactivate is a direct write, and it read
   * `period.active` from a row that only changes once the refresh below
   * resolves. Two quick clicks therefore both saw `active: true` and both sent
   * `{ active: false }` — the second PUT writing a `booking-period.update` entry
   * whose `before` and `after` are identical AND busting the public-page cache,
   * which is exactly the harm the Save dirty gate exists to stop, reachable by
   * one admin with an impatient double-click and no concurrency at all.
   *
   * The ref is the real guard: it is set synchronously, so a genuine
   * double-click dispatched inside one tick — where both handlers close over the
   * same pre-update state — still only fires once. `togglingId` is the visible
   * half, disabling the button for the round trip, and the refresh is awaited so
   * it stays disabled until the row it re-reads is on screen.
   */
  const togglingRef = useRef(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  async function handleTogglePeriod(period: BookingPeriod) {
    if (!policyScopeReady || togglingRef.current) return
    togglingRef.current = true
    setTogglingId(period.id)
    try {
      const res = await fetch(`/api/admin/booking-policies/periods/${period.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !period.active }),
      })
      if (!res.ok) throw new Error("Failed to update")
      await fetchPeriods()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      togglingRef.current = false
      setTogglingId(null)
    }
  }

  /** Re-run the current scope's load in place, without leaving the section. */
  function retryLoad() {
    if (!policyScopeReady) return
    setError("")
    void fetchPeriods({ scopeLoad: true })
  }

  /*
    #2142: the view-only explanation lives here, once, at the top of the
    section — announced on arrival and in the reading order — instead of on each
    disabled button below. It is rendered in every state below, in the same
    position, so the polite live region is registered in the accessibility tree
    from the first paint and only its CONTENT changes when `canEdit` resolves. A
    region injected already-populated is silently dropped by some
    screen-reader/browser pairings.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view booking periods but cannot change them. Bookings
      edit access is required.
    </AdminViewOnlySectionBanner>
  )

  // See `loadedScope`: the list is authoritative only for the scope it was
  // loaded for, and anything else is unknown rather than editable.
  const scopeKnown = loadedScope === scopeLodgeId

  /*
    #2142 review (round 4): there is deliberately NO early return for the
    loading state, and the frame below — banner, `PolicyFeedback`, scope
    select — is rendered in EVERY state. Loading replaces only the list card.

    Two things depend on that, and an early return broke both:

     - FOCUS. A scope change is now a `scopeLoad`, so it flips this section into
       its loading state. An early return that dropped everything below it took
       `PolicyScopeSelect` with it, so the keyboard user who had just changed
       scope from the "Rules for" select watched the control they were focused
       on leave the DOM for the whole round trip, dumping focus on `<body>` and
       forcing a full re-traverse to change scope again.
     - LIVE REGIONS. `PolicyFeedback`'s wrappers only work as live regions if
       they are registered in the accessibility tree BEFORE they have content
       (see its own header comment). Below an early return they were not: a
       failed FIRST load mounted them already populated, in one mutation, which
       is exactly the pattern some screen-reader/browser pairings drop.
  */
  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => setError("")}
        onClearSuccess={() => setSuccess("")}
      />
      <div className="space-y-6">
        <PolicyScopeSelect
          options={policyScope}
          value={scopeLodgeId}
          onChange={setScopeLodgeId}
          id="periods-scope"
        />

        {policyScopeReady && loadingPeriods ? (
          <div className="text-center py-8">Loading...</div>
        ) : null}

        {policyScopeReady && !loadingPeriods && !scopeKnown ? (
          <Card>
            <CardHeader>
              <CardTitle>
                Could not load the booking periods for{" "}
                {scopeLodgeName ?? "the club"}
              </CardTitle>
              <CardDescription>
                Nothing is listed, because we do not know what is stored here.
                The periods that were on screen a moment ago belong to a
                different scope, so editing, deleting, or deactivating them from
                here would change the wrong thing. Try again below — the list
                returns as soon as it loads.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={retryLoad}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {policyScopeReady && !loadingPeriods && scopeKnown ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>
                    {scopeLodgeName
                      ? `Date-Specific Periods — ${scopeLodgeName}`
                      : "Date-Specific Periods"}
                  </CardTitle>
                  <CardDescription>
                    Override the default policy for specific date ranges (e.g. school holidays).
                    If a booking&apos;s check-in falls within a period, that period&apos;s rules apply.
                    {scopeLodgeName ? (
                      <>
                        {" "}
                        Periods listed here belong to {scopeLodgeName} and replace
                        the club-wide set for that lodge; if the list is empty the
                        lodge uses the club-wide periods.
                      </>
                    ) : null}
                  </CardDescription>
                </div>
                {!showPeriodForm && (
                  <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={startAddPeriod}>Add Period</ViewOnlyActionButton>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Period Form — one `useSectionEditState` instance per open editor. */}
              {showPeriodForm && (
                <PeriodForm
                  key={`${editingPeriodId ?? "new"}:${editorInstance}`}
                  periodId={editingPeriodId}
                  initial={editingDraft}
                  canEdit={canEdit}
                  onSubmit={submitPeriod}
                  onCancel={cancelPeriodForm}
                  onError={setError}
                />
              )}

              {/* Periods List */}
              {periods.length === 0 && !showPeriodForm ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No date-specific periods configured. The default policy applies to all bookings.
                </p>
              ) : (
                <div className="space-y-3">
                  {periods.map((period) => (
                    <Card key={period.id} className={!period.active ? "opacity-60" : ""}>
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="font-semibold">{period.name}</h4>
                              <Badge variant={period.active ? "default" : "outline"}>
                                {period.active ? "Active" : "Inactive"}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {formatStayDateOrNull(period.startDate, format) ?? period.startDate} &mdash;{" "}
                              {formatStayDateOrNull(period.endDate, format) ?? period.endDate}
                              <span className="ml-3">
                                Non-member hold:{" "}
                                <strong>
                                  {period.nonMemberHoldEnabled ?? true
                                    ? `${period.nonMemberHoldDays} days`
                                    : "First Paid, First In"}
                                </strong>
                              </span>
                            </p>
                          </div>
                          <div className="flex space-x-2">
                            <ViewOnlyActionButton
                              canEdit={canEdit}
                              describeReason={false}
                              variant="outline"
                              size="sm"
                              disabled={togglingId === period.id}
                              onClick={() => void handleTogglePeriod(period)}
                            >
                              {period.active ? "Deactivate" : "Activate"}
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEditPeriod(period)}>
                              Edit
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDeletePeriod(period.id)}>
                              Delete
                            </ViewOnlyActionButton>
                          </div>
                        </div>
                        <PolicyPreview rules={period.cancellationRules} />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
