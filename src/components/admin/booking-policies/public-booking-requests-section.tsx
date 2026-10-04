"use client"

import { useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"

const ENDPOINT = "/api/admin/booking-requests/settings"

interface BookingRequestSettings {
  showPricingToNonMembers: boolean
  quoteResponseTtlDays: number
  quoteReminderLeadDays: number
  attendeeConfirmationLeadDays: number
  attendeeConfirmationReminderDays: number
}

/**
 * The three cards' drafts (#2162, #2166).
 *
 * All five settings live in ONE server-side row behind ONE whole-object PUT, so
 * a single `useSectionEditState` instance for the whole section would match the
 * storage exactly. It still cannot be used, and the reason survived the #2166
 * decision to Edit-gate the timing cards: the hook carries ONE `editing` flag,
 * and three cards sharing it would mean one Edit unlocking all three, one
 * Cancel discarding all three drafts, and one Save writing all five fields. The
 * owner decision in #2166 was explicitly per-card Edit gating, NOT a
 * section-level Edit — so each card keeps its own instance, its own Edit, its
 * own dirty gate, and its own Cancel.
 *
 * The price of three instances is the shared write object, and it is paid the
 * documented way (`AGENTS.md`, `docs/ARCHITECTURE.md`): every save GETs the
 * fresh settings and merges only the fields the ADMIN CHANGED, exactly as the
 * magic-link and Google cards do against `PUT /api/admin/modules`. Merging only
 * its own fields would be enough to stop a card writing a sibling's UNSAVED
 * draft or its own stale snapshot of one; narrowing further to the changed
 * fields is what stops a card reverting a field it owns but the admin never
 * touched (see {@link changedTimingFields}).
 *
 * The two timing drafts hold STRINGS, because their editors are free-text
 * number boxes an admin can legitimately leave mid-typed ("", "1", "0"). They
 * are declared as type aliases rather than interfaces so they carry the
 * implicit index signature {@link isTimingDirty} needs.
 */
interface PricingDraft {
  showPricingToNonMembers: boolean
}

type QuoteTimingDraft = {
  quoteResponseTtlDays: string
  quoteReminderLeadDays: string
}

type AttendeeTimingDraft = {
  attendeeConfirmationLeadDays: string
  attendeeConfirmationReminderDays: string
}

/**
 * Seed for the form, and the value a FAILED load leaves in it. It matches what
 * `getBookingRequestSettings` synthesises when no row is stored.
 */
const SETTINGS_FALLBACK: BookingRequestSettings = {
  showPricingToNonMembers: false,
  quoteResponseTtlDays: 14,
  quoteReminderLeadDays: 3,
  attendeeConfirmationLeadDays: 14,
  attendeeConfirmationReminderDays: 3,
}

function toQuoteTimingDraft(data: BookingRequestSettings): QuoteTimingDraft {
  return {
    quoteResponseTtlDays: String(data.quoteResponseTtlDays),
    quoteReminderLeadDays: String(data.quoteReminderLeadDays),
  }
}

function toAttendeeTimingDraft(data: BookingRequestSettings): AttendeeTimingDraft {
  return {
    attendeeConfirmationLeadDays: String(data.attendeeConfirmationLeadDays),
    attendeeConfirmationReminderDays: String(data.attendeeConfirmationReminderDays),
  }
}

/**
 * Dirty check for the two timing cards.
 *
 * Their drafts are strings but the stored values are integers, so the
 * comparison is NUMERIC — `07` is not a change from `7`, and an emptied box is
 * not a change from `0`. That is the same comparison the pre-#2166 hand-rolled
 * `timingDirty` / `attendeeTimingDirty` flags made, kept deliberately: a plain
 * string compare would arm Save for a re-typing that stores nothing, and the
 * write logs `booking_request.settings_updated` unconditionally (#2143).
 *
 * A box the admin has made unparseable (`abc` -> `NaN`) still counts as dirty,
 * so Save stays clickable and the card's own validation can explain what is
 * wrong rather than leaving a greyed-out button with no reason.
 */
function isTimingDirty<T extends Record<string, string>>(draft: T, saved: T) {
  return (Object.keys(draft) as (keyof T & string)[]).some(
    (field) => Number(draft[field]) !== Number(saved[field]),
  )
}

/**
 * The fields of a timing card the admin ACTUALLY changed, as numbers, ready to
 * merge over the save's fresh read.
 *
 * GET-fresh-then-merge only protects the fields a card does not OWN. Writing
 * every field a card owns from its draft still reverts an untouched-but-stale
 * one: admin A opens the page (window 30, reminder 7), admin B changes the
 * window to 45, admin A edits only the reminder and saves — a whole-draft merge
 * would put A's load-time 30 back over B's 45, and A's card would then display
 * 30 as confirmed.
 *
 * Sending only the changed fields closes that: an untouched field is simply not
 * in the patch, so it keeps the fresh read's value and the server echo re-seeds
 * the card with B's 45 rather than A's 30. The route's schema still requires all
 * five fields, and it still gets all five — what changes is which of them come
 * from `fresh` and which from the draft.
 *
 * The comparison is the same NUMERIC one {@link isTimingDirty} makes, so the
 * two agree by construction: a field that did not arm Save is never written.
 * `saved` is `null` only before a load has resolved, which Save is gated behind;
 * treating that as "everything changed" keeps the fallback the safe one.
 */
function changedTimingFields<T extends Record<string, string>>(
  draft: T,
  saved: T | null,
): Partial<Record<keyof T, number>> {
  const patch: Partial<Record<keyof T, number>> = {}
  for (const field of Object.keys(draft) as (keyof T & string)[]) {
    if (saved === null || Number(draft[field]) !== Number(saved[field])) {
      patch[field] = Number(draft[field])
    }
  }
  return patch
}

/**
 * The quote card carries the route's cross-field rule
 * (`quoteReminderLeadDays < quoteResponseTtlDays`), and only the CHANGED field
 * goes on the wire, so the pair that would reach the route can be one the admin
 * never saw: their new reminder beside a window that moved since page load (or
 * the reverse) — whether a second admin moved it, this admin did in another tab,
 * or a config-transfer import did. The card's own click-time validation compares
 * the two DRAFT values and cannot see that. Refuse the pair here instead of sending
 * it — the route would reject it with a bare "Invalid input", and either way the
 * change does not land, so the admin deserves to be told why.
 */
const QUOTE_TIMING_CONFLICT =
  "Your change was not saved: the quote timing has been changed since this page loaded, and the reminder lead time would no longer be shorter than the response window. Reload the page to see the current values, then try again."

/**
 * Shown when the fresh read a save takes fails for any reason other than a 403
 * (which has its own narrowed-actor copy). It has to say the change did not
 * land: the admin clicked Save, not Reload.
 */
const SAVE_STEP_READ_FAILED =
  "Your change was not saved: the current settings could not be re-read. Please try again."

/** Every card reports the same thing, because they all write the same row. */
const SAVE_SUCCESS = "Booking request settings saved"

/**
 * The section's only read, in both of its roles: the mount-time load, and the
 * fresh read every card takes immediately before it writes.
 *
 * `asSaveStep` says which. A save's fresh read is part of the WRITE, so a 403
 * on it means the actor was narrowed since page load and belongs in the shared
 * "this change was not saved" copy — the same mapping `google-security-card.tsx`
 * applies to its own fresh read of `/api/admin/modules`. The mount-time load is
 * an ordinary GET on `bookings:view`, so the same status there is a genuine read
 * failure and keeps the generic message.
 *
 * Neither role passes an `AbortSignal`. The save's read must not be abortable —
 * aborting the read half of a save would leave the write undecided rather than
 * cancelled, and the PUT it feeds is not abortable either — and the mount-time
 * load is shared across three hooks, where a signal is actively harmful (see
 * `loadSettings`).
 */
async function fetchSettings(
  options: { asSaveStep?: boolean } = {},
): Promise<BookingRequestSettings> {
  const res = await fetch(ENDPOINT)
  if (!res.ok) {
    if (options.asSaveStep) {
      if (res.status === 403) throw new ForbiddenSaveError()
      // Any other failure of the save's fresh read means the PUT never went out.
      // The message lands in the error region the admin is watching after
      // clicking Save, so read-flavoured copy there would report a failure they
      // did not ask for and say nothing about the change they did (#2162
      // review).
      throw new Error(SAVE_STEP_READ_FAILED)
    }
    throw new Error("Failed to fetch booking request settings")
  }
  return (await res.json()) as BookingRequestSettings
}

/**
 * The section's only write. The route takes the whole settings object, so every
 * card sends all five fields — but a card may only source a field from its own
 * draft when the admin CHANGED it. Each save GETs the fresh row through
 * {@link fetchSettings} and merges its changed fields over it, so every other
 * field on the wire is what is STORED right now: the four a card does not own,
 * and any it owns but the admin left alone.
 *
 * Throws {@link ForbiddenSaveError} for a 403 so all three cards map it to the
 * same shared copy through the hook.
 */
async function putSettings(
  body: BookingRequestSettings,
): Promise<BookingRequestSettings> {
  const res = await fetch(ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 403) throw new ForbiddenSaveError()
    const data = await res.json()
    throw new Error(data.error || "Failed to save")
  }
  return (await res.json()) as BookingRequestSettings
}

/** The slice of a card's state a SIBLING card needs in order to clear it. */
interface ClearableFeedback {
  setError: (message: string) => void
  setSuccess: (message: string) => void
}

/**
 * All three cards report through one `PolicyFeedback`, so a card starting a save
 * clears the other two first — otherwise one card's stale confirmation sits
 * above another card's fresh result. Each hook already clears its OWN pair when
 * its save starts.
 */
function clearOtherFeedback(...others: ClearableFeedback[]) {
  for (const card of others) {
    card.setError("")
    card.setSuccess("")
  }
}

export function PublicBookingRequestsSection() {
  // Booking-request settings gate on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees the whole section read-only
  // (#1940). Since #2162/#2166 no control in it auto-persists, so the gate is
  // purely about which affordances are offered, not about a silent 403.
  const canEdit = useAdminAreaEditAccess("bookings")

  /**
   * ONE mount-time GET for the whole section, shared by the three cards' loads.
   *
   * Each card owns a `useSectionEditState` instance and the hook fetches per
   * instance, so without this the section would issue three identical GETs on
   * mount — and, worse, three snapshots that a write landing between them could
   * leave disagreeing about the same row. The three `load` callbacks run in the
   * same commit, so they all reach this before the request settles and all
   * three seed from the SAME response.
   *
   * The ref is cleared once the request settles so a later `reload` (none today)
   * would fetch again rather than replay a stale body.
   *
   * The shared read deliberately carries NO `AbortSignal`, and that is load-
   * bearing rather than an omission. The ref is only cleared in a microtask
   * (`pending.then`), but React StrictMode's mount -> cleanup -> re-mount is
   * SYNCHRONOUS: on the second mount the ref still holds the first mount's
   * promise, whose fetch the first mount's cleanup just aborted. If that promise
   * were signal-bound, all three re-mounted hooks would await a promise that
   * rejects with `AbortError`, the hook would swallow it as an ordinary
   * unmount, and — because the SECOND mount's signals were never aborted — it
   * would still clear `loading` without ever seeding `saved`/`draft`. The
   * section would then render {@link SETTINGS_FALLBACK} as though those were the
   * stored values, so the admin edits against fabricated numbers — and any field
   * they then changed would be written over a stored value they never saw.
   * (Only that field: each save sends just the fields the admin CHANGED, merged
   * over a fresh read, so the fallback itself never reaches the wire.)
   * `next dev` enables StrictMode by default, so that is every local session.
   *
   * Nothing is lost by dropping the signal: the request is one GET, and each
   * hook independently discards a result whose OWN signal aborted before it
   * resolved, so an unmounted section still sets no state.
   */
  const inflightLoad = useRef<Promise<BookingRequestSettings> | null>(null)
  const loadSettings = useCallback(() => {
    if (!inflightLoad.current) {
      const pending = fetchSettings()
      const release = () => {
        if (inflightLoad.current === pending) inflightLoad.current = null
      }
      // Both arms, so a failed load does not pin the rejected promise in the ref.
      pending.then(release, release)
      inflightLoad.current = pending
    }
    return inflightLoad.current
  }, [])

  /*
    #2162: the Indicative Pricing card. The toggle used to persist the moment it
    was clicked; it now stages behind an Edit, like every other control in
    Booking Policies.
  */
  const pricing = useSectionEditState<PricingDraft>({
    initial: { showPricingToNonMembers: SETTINGS_FALLBACK.showPricingToNonMembers },
    load: async () => ({
      showPricingToNonMembers: (await loadSettings()).showPricingToNonMembers,
    }),
    save: async (draft) => {
      // GET-fresh-then-merge over the shared whole-object PUT: write the STORED
      // timing values plus this card's new one, never the snapshot this card
      // happened to load with and never a timing draft the admin has typed but
      // not saved. This card owns ONE field and Save is dirty-gated, so that
      // field has always changed — no per-field patch is needed here.
      const fresh = await fetchSettings({ asSaveStep: true })
      const next = await putSettings({
        ...fresh,
        showPricingToNonMembers: draft.showPricingToNonMembers,
      })
      return { showPricingToNonMembers: next.showPricingToNonMembers }
    },
    successMessage: SAVE_SUCCESS,
    // No first-save exception on any of the three cards, even though the GET
    // SYNTHESISES defaults when no row is stored (`getBookingRequestSettings`).
    // The exception exists so a form whose defaults are already correct can
    // still commit them — but here the synthesised defaults ARE the effective
    // settings at every read site, and no BEHAVIOUR keys on the row existing
    // (no setup-checklist entry, no create/delete semantics). An admin who
    // wants a different value types it and the draft is dirty; an admin happy
    // with the defaults has nothing to commit. Adding a `configured` flag would
    // only unlock a pristine Save that writes an audit entry asserting a change
    // that never happened (#2143).
    //
    // Config-transfer used to observe the row — it skipped a singleton with
    // none, so a club that never saved these settings exported no
    // `booking-request-settings.json`. #2171 fixed that where it belonged, in
    // the exporter: a missing row is now exported as the effective defaults
    // (`src/config/club-settings-defaults.ts`, the same constants this GET
    // reads through `getBookingRequestSettings`). Nothing keys on the
    // `BookingRequestSettings` row existing — other singletons' rows DO drive
    // setup-readiness signals, but none of these cards' — so there is still no
    // reason for a first-save exception here.
  })

  /*
    #2166 (owner decision): the two timing cards used to be always-editable with
    a dirty-gated Save and no Edit or Cancel — the last acknowledged divergence
    from the canonical settings pattern in Booking Policies. They now follow the
    pricing card exactly: read-only until Edit, Save and Cancel only while
    editing, Save gated on `dirty`.
  */
  const quoteTiming = useSectionEditState<QuoteTimingDraft>({
    initial: toQuoteTimingDraft(SETTINGS_FALLBACK),
    load: async () => toQuoteTimingDraft(await loadSettings()),
    save: async (draft, saved) => {
      // Same GET-fresh-then-merge, narrowed to the fields the admin changed so
      // an untouched box cannot revert the other admin who moved it.
      const fresh = await fetchSettings({ asSaveStep: true })
      const body = { ...fresh, ...changedTimingFields(draft, saved) }
      // Merging one field of a cross-field pair CAN compose a pair the admin
      // never saw, which is why this check exists (see QUOTE_TIMING_CONFLICT).
      if (body.quoteReminderLeadDays >= body.quoteResponseTtlDays) {
        throw new Error(QUOTE_TIMING_CONFLICT)
      }
      return toQuoteTimingDraft(await putSettings(body))
    },
    successMessage: SAVE_SUCCESS,
    isDirty: isTimingDirty,
  })

  const attendeeTiming = useSectionEditState<AttendeeTimingDraft>({
    initial: toAttendeeTimingDraft(SETTINGS_FALLBACK),
    load: async () => toAttendeeTimingDraft(await loadSettings()),
    save: async (draft, saved) => {
      // Same per-field patch. This card's two fields carry no cross-field rule
      // (the route range-checks each on its own), so there is nothing to compose.
      const fresh = await fetchSettings({ asSaveStep: true })
      return toAttendeeTimingDraft(
        await putSettings({ ...fresh, ...changedTimingFields(draft, saved) }),
      )
    },
    successMessage: SAVE_SUCCESS,
    isDirty: isTimingDirty,
  })

  /*
    #2166: `beginSaveDraftSync` is GONE, and nothing replaces it.

    It existed because every card wrote through ONE shared `settings` snapshot
    that every save re-seeded from its fresh read. That read can legitimately
    move a field this admin never touched, so a sibling card's untouched draft
    box could end up disagreeing with the snapshot its dirty flag compared
    against — arming a Save nobody armed, one click from silently reverting the
    other admin.

    There is no shared snapshot any more. Each card's draft and snapshot live in
    its own hook instance and are only ever re-seeded TOGETHER, by that card's
    own load or its own save. No card's save can leave a sibling dirty, so the
    hazard is structurally impossible rather than defended against.

    What is left is display staleness: a card the admin did not touch still
    shows the values it loaded with, even after a sibling's save re-read the row
    and found that a second admin has moved them. That is the same accepted
    property the module-toggle cards on `/admin/security` have. Be precise about
    what does and does not follow from it:

      - `startEditing` is `setEditing(true)` and NOTHING else. Opening a card
        does not re-fetch, so clicking Edit does not resolve the staleness. The
        boxes an admin starts typing into can already be out of date.
      - What keeps that from becoming a WRITE is the per-field patch: a stale
        box the admin never touched is not in the PUT body at all, so it cannot
        revert anyone. Only a field they actually changed is written, and that
        one they saw.
      - The dirty gate is against this card's own snapshot, which is what is on
        screen — so a stale box never arms Save on its own either.

    Do NOT "fix" the staleness by having one card's save re-seed another card's
    state: that is the coupling this removed.
  */

  const busy = pricing.saving || quoteTiming.saving || attendeeTiming.saving
  const loading = pricing.loading || quoteTiming.loading || attendeeTiming.loading

  // `initial` is always supplied, so these are never actually null once loading
  // clears; the checks below exist only to narrow the hook's `T | null`, which
  // is `null` only for a card that renders nothing until its fetch resolves.
  const pricingDraft = pricing.draft
  const quoteDraft = quoteTiming.draft
  const attendeeDraft = attendeeTiming.draft

  function handleSavePricing() {
    clearOtherFeedback(quoteTiming, attendeeTiming)
    void pricing.save()
  }

  /*
    Validation stays in the click handler rather than in the hook's `isValid`.
    `isValid` would only grey the Save button out, leaving the admin with a dead
    control and no reason for it — and the reason (which field, which range,
    which cross-field rule) is exactly what they need. Save therefore stays
    enabled for a dirty-but-invalid draft and the click explains the problem.
  */
  function handleSaveQuoteTiming(draft: QuoteTimingDraft) {
    clearOtherFeedback(pricing, attendeeTiming)
    // The hook clears this card's own pair when `save()` starts, but a
    // validation failure returns BEFORE `save()` — leaving a green "settings
    // saved" from an earlier save sitting above the red error below.
    quoteTiming.setSuccess("")
    const ttl = Number(draft.quoteResponseTtlDays)
    const reminder = Number(draft.quoteReminderLeadDays)
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) {
      quoteTiming.setError(
        "Quote response window must be a whole number of days between 1 and 60.",
      )
      return
    }
    if (!Number.isInteger(reminder) || reminder < 0 || reminder > 30) {
      quoteTiming.setError(
        "Reminder lead time must be a whole number of days between 0 and 30.",
      )
      return
    }
    if (reminder >= ttl) {
      quoteTiming.setError(
        "Reminder lead time must be shorter than the quote response window.",
      )
      return
    }
    void quoteTiming.save()
  }

  function handleSaveAttendeeTiming(draft: AttendeeTimingDraft) {
    clearOtherFeedback(pricing, quoteTiming)
    // Same reason as the quote handler above.
    attendeeTiming.setSuccess("")
    const lead = Number(draft.attendeeConfirmationLeadDays)
    const reminder = Number(draft.attendeeConfirmationReminderDays)
    if (!Number.isInteger(lead) || lead < 0 || lead > 90) {
      attendeeTiming.setError(
        "The attendee prompt lead time must be a whole number of days between 0 and 90.",
      )
      return
    }
    if (!Number.isInteger(reminder) || reminder < 1 || reminder > 30) {
      attendeeTiming.setError(
        "The attendee reminder interval must be a whole number of days between 1 and 30.",
      )
      return
    }
    void attendeeTiming.save()
  }

  /*
    #2142: one section-level banner carries the view-only explanation —
    announced on arrival, in the reading order — instead of each disabled Save
    carrying its own copy. It, and `PolicyFeedback` below it, form the section's
    FRAME: both are rendered in EVERY state so their live regions are registered
    in the accessibility tree from the first paint and only their CONTENT
    changes. A region injected already-populated is silently dropped by some
    screen-reader/browser pairings, and a failed FIRST load would otherwise mount
    the section together with an already-populated alert in one commit. Only the
    cards below the frame are swapped for the loading placeholder.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the public booking request settings but cannot
      change them. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={pricing.error || quoteTiming.error || attendeeTiming.error}
        success={pricing.success || quoteTiming.success || attendeeTiming.success}
        onClearError={() => {
          pricing.setError("")
          quoteTiming.setError("")
          attendeeTiming.setError("")
        }}
        onClearSuccess={() => {
          pricing.setSuccess("")
          quoteTiming.setSuccess("")
          attendeeTiming.setSuccess("")
        }}
      />
      {loading ||
      pricingDraft === null ||
      quoteDraft === null ||
      attendeeDraft === null ? (
        <div className="text-center py-8">Loading...</div>
      ) : (
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Indicative Pricing</CardTitle>
              <CardDescription>
                Control whether the public booking request form shows indicative pricing to non-members.
              </CardDescription>
            </div>
            {/*
              #2166: all three cards now carry an Edit, so the shared visible
              word cannot be the whole accessible name — a screen reader's
              button list would show three identical "Edit"s, the same defect
              #2142 fixed for the two look-alike "Deactivate" buttons on a
              minimum-stay row. Each one therefore carries an `aria-label`
              naming its card, matching that card's already-distinct Save label
              and leaving the visible button exactly as it looks today. The
              label still STARTS with the visible word, so it satisfies
              WCAG 2.5.3 Label in Name for speech input. Same treatment on
              Cancel, which can legitimately appear three times at once.
            */}
            {!pricing.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label="Edit indicative pricing"
                onClick={pricing.startEditing}
                disabled={busy}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="showPricingToNonMembers"
                checked={pricingDraft.showPricingToNonMembers}
                onChange={(e) =>
                  pricing.setDraft({ showPricingToNonMembers: e.target.checked })
                }
                className="rounded border-input"
                disabled={!pricing.editing || busy}
              />
              <Label htmlFor="showPricingToNonMembers">Show indicative pricing on the request form</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              When enabled, the public form is labelled &ldquo;Request to Book&rdquo; and shows an indicative
              price. When disabled, it is labelled &ldquo;Request for Price&rdquo; and no pricing is shown
              until an officer reviews the request.
            </p>
            <p className="text-xs text-muted-foreground">
              Submitted requests that are declined, or never have their email verified, are automatically
              purged after 90 days in line with the Privacy Act 2020.
            </p>

            {pricing.editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  type="button"
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={handleSavePricing}
                  disabled={busy || !pricing.dirty || !canEdit}
                >
                  {pricing.saving ? "Saving…" : "Save indicative pricing"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Cancel indicative pricing"
                  onClick={pricing.cancelEditing}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Quote Response Window &amp; Reminders</CardTitle>
              <CardDescription>
                Set how long a quote link stays valid after you send it, and when the requester is reminded
                before it expires.
              </CardDescription>
            </div>
            {!quoteTiming.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label="Edit quote timing"
                onClick={quoteTiming.startEditing}
                disabled={busy}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1">
              <Label htmlFor="quoteResponseTtlDays">Quote response window (days)</Label>
              <input
                type="number"
                id="quoteResponseTtlDays"
                min={1}
                max={60}
                value={quoteDraft.quoteResponseTtlDays}
                onChange={(e) =>
                  quoteTiming.setDraft({ quoteResponseTtlDays: e.target.value })
                }
                className={`block w-28 rounded border border-input px-2 py-1 text-sm${
                  !quoteTiming.editing ? " bg-muted text-muted-foreground" : ""
                }`}
                disabled={!quoteTiming.editing || busy}
              />
              <p className="text-xs text-muted-foreground">
                How many days the requester has to accept, cancel, or reply before the secure quote link
                expires. Applies to quotes sent from now on; quotes already sent keep their original expiry.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="quoteReminderLeadDays">Reminder lead time (days before expiry)</Label>
              <input
                type="number"
                id="quoteReminderLeadDays"
                min={0}
                max={30}
                value={quoteDraft.quoteReminderLeadDays}
                onChange={(e) =>
                  quoteTiming.setDraft({ quoteReminderLeadDays: e.target.value })
                }
                className={`block w-28 rounded border border-input px-2 py-1 text-sm${
                  !quoteTiming.editing ? " bg-muted text-muted-foreground" : ""
                }`}
                disabled={!quoteTiming.editing || busy}
              />
              <p className="text-xs text-muted-foreground">
                Send the requester one reminder this many days before the quote expires. The reminder
                contains a fresh, working quote link so they never have to find the original email. Set to
                0 to turn reminders off. Must be shorter than the response window above.
              </p>
            </div>

            {/*
              #2142: these Saves were already gated correctly, but as raw
              <button> elements they were unthemed and could not participate in
              the shared view-only treatment. `ViewOnlyActionButton` keeps the
              resolving (`undefined`) window neutral, and `describeReason={false}`
              defers the explanation to the section banner above (a disabled button
              is out of the tab order, so its own reason was never reachable). The
              existing `!canEdit` term is now redundant with the wrapper's own
              `canEdit !== true` check; it is kept so the gate is legible here
              rather than only inside the wrapper.
            */}
            {quoteTiming.editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  type="button"
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => handleSaveQuoteTiming(quoteDraft)}
                  disabled={busy || !quoteTiming.dirty || !canEdit}
                >
                  {quoteTiming.saving ? "Saving…" : "Save quote timing"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Cancel quote timing"
                  onClick={quoteTiming.cancelEditing}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>School Attendee Confirmation</CardTitle>
              <CardDescription>
                Before a school group arrives, the school contact is emailed a secure link to replace the
                placeholder attendee names and confirm who is coming. The chore roster uses the confirmed
                names.
              </CardDescription>
            </div>
            {!attendeeTiming.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label="Edit attendee prompts"
                onClick={attendeeTiming.startEditing}
                disabled={busy}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="attendeeConfirmationLeadDays">First prompt (days before check-in)</Label>
              <input
                type="number"
                id="attendeeConfirmationLeadDays"
                min={0}
                max={90}
                value={attendeeDraft.attendeeConfirmationLeadDays}
                onChange={(e) =>
                  attendeeTiming.setDraft({
                    attendeeConfirmationLeadDays: e.target.value,
                  })
                }
                className={`block w-28 rounded border border-input px-2 py-1 text-sm${
                  !attendeeTiming.editing ? " bg-muted text-muted-foreground" : ""
                }`}
                disabled={!attendeeTiming.editing || busy}
              />
              <p className="text-xs text-muted-foreground">
                Start prompting the school this many days before check-in. Set to 0 to turn the prompts
                off.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="attendeeConfirmationReminderDays">Reminder interval (days)</Label>
              <input
                type="number"
                id="attendeeConfirmationReminderDays"
                min={1}
                max={30}
                value={attendeeDraft.attendeeConfirmationReminderDays}
                onChange={(e) =>
                  attendeeTiming.setDraft({
                    attendeeConfirmationReminderDays: e.target.value,
                  })
                }
                className={`block w-28 rounded border border-input px-2 py-1 text-sm${
                  !attendeeTiming.editing ? " bg-muted text-muted-foreground" : ""
                }`}
                disabled={!attendeeTiming.editing || busy}
              />
              <p className="text-xs text-muted-foreground">
                Keep re-sending the confirmation link this often until the school confirms the list or
                check-in arrives. Each email carries a fresh working link.
              </p>
            </div>

            {attendeeTiming.editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  type="button"
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => handleSaveAttendeeTiming(attendeeDraft)}
                  disabled={busy || !attendeeTiming.dirty || !canEdit}
                >
                  {attendeeTiming.saving ? "Saving…" : "Save attendee prompts"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Cancel attendee prompts"
                  onClick={attendeeTiming.cancelEditing}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  )
}
