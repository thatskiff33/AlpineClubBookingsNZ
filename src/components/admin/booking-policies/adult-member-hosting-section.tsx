"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"
import {
  isPolicyScopeReady,
  PolicyScopeSelect,
  usePolicyScopeOptions,
} from "./policy-scope-select"
import type {
  AdultMemberHostingModeValue,
  AdultMemberHostingPolicy,
  AdultMemberHostScopeSetValue,
} from "./types"

const ENDPOINT = "/api/admin/booking-policies/adult-member-hosting"

/**
 * The scope a snapshot was loaded FOR. Club-wide scope is `null`, so `null`
 * cannot double as "unknown" — the same sentinel as the minimum-stay and
 * cancellation sections, and for the same reason: after a failed switch to a
 * lodge, a card that kept the previous scope's values on screen would let an
 * admin save one lodge's decision onto another's.
 */
const UNLOADED_SCOPE = "__unloaded__"

/**
 * The checkbox wording, taken from the server's own
 * `ADULT_MEMBER_HOST_SCOPE_LABELS` / `..._DESCRIPTIONS` (#2576 §12). Repeated as
 * literals rather than imported because this is a client component and those live
 * beside the evaluator; the route tests assert the two agree.
 */
const HOST_SCOPE_LABELS: Record<keyof AdultMemberHostScopeSetValue, string> = {
  sameBooking: "Eligible adult member on the same booking",
  sameBookingOwner: "Another booking on the same account",
  sameGroupTrip: "Another booking in the same Group Trip",
}

const HOST_SCOPE_DESCRIPTIONS: Record<
  keyof AdultMemberHostScopeSetValue,
  string
> = {
  sameBooking:
    "Count a qualifying adult member who is staying on the booking itself for the nights they are there.",
  sameBookingOwner:
    "Allow a qualifying adult member on another confirmed booking owned by the same member account to provide coverage for the same lodge and nights.",
  sameGroupTrip:
    "Allow a qualifying adult member on another confirmed booking in the same Group Trip to provide coverage for the same lodge and nights, even when that booking belongs to a different member. Off unless you turn it on.",
}

const HOST_SCOPE_ORDER = [
  "sameBooking",
  "sameBookingOwner",
  "sameGroupTrip",
] as const

const SOURCE_LABELS: Record<string, string> = {
  LODGE: "set for this lodge",
  CLUB_WIDE: "inherited from the club",
  BUILT_IN_DEFAULT: "the built-in default (nothing saved)",
}

interface HostingDraft {
  mode: AdultMemberHostingModeValue
  /** Empty until an admin chooses: new policies get no automatic mode (D-R6). */
  capacityMode: "" | "HOLD" | "NO_HOLD"
  /**
   * null is the explicit inherit option (#2569 §2). Kept as its own field rather
   * than folded into `mode`, because the two dimensions are independent: a lodge
   * may override the consequence while inheriting the scopes, or the reverse.
   */
  hostScopes: AdultMemberHostScopeSetValue | null
  /** CAS token; absent (null) means "no row is stored for this scope yet". */
  version: number | null
  /** Whether a row is actually persisted, as reported by the GET (#2142). */
  configured: boolean
}

/**
 * The scope set the checkboxes show while "inherit" is selected.
 *
 * The effective set, so switching to "custom" starts from what is actually in
 * force rather than from an arbitrary default the admin never chose — and so
 * ticking one extra box does not silently drop the club's other choices.
 */
function customScopeStartingPoint(
  policy: AdultMemberHostingPolicy,
): AdultMemberHostScopeSetValue {
  return policy.hostScopes ?? policy.effective.hostScopes
}

function toDraft(policy: AdultMemberHostingPolicy): HostingDraft {
  return {
    mode: policy.mode,
    capacityMode: policy.capacityMode ?? "",
    hostScopes: policy.hostScopes,
    version: policy.configured ? policy.version : null,
    configured: policy.configured,
  }
}

function scopeSetsEqual(
  a: AdultMemberHostScopeSetValue | null,
  b: AdultMemberHostScopeSetValue | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.sameBooking === b.sameBooking &&
    a.sameBookingOwner === b.sameBookingOwner &&
    // #3037. Normalised through `=== true` on both sides, so an absent field from
    // a previous colour's response and an explicit `false` compare equal — they
    // mean the same setting, and treating them as different would mark a freshly
    // loaded card dirty and offer a save that changes nothing.
    (a.sameGroupTrip === true) === (b.sameGroupTrip === true)
  )
}

/** Accept only a complete server row that is safe to render and re-seed. */
function parsePolicy(value: unknown): AdultMemberHostingPolicy | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (
    row.mode !== "INHERIT" &&
    row.mode !== "DISABLED" &&
    row.mode !== "ADMIN_REVIEW_REQUIRED" &&
    row.mode !== "ENFORCED"
  ) {
    return null
  }
  if (row.hostScopes !== null && typeof row.hostScopes !== "object") return null
  // The effective block is what the card DISPLAYS as in force. A row without it
  // is not safe to render: the card would either show nothing or fall back to
  // guessing the inheritance, which is the one thing it must never do.
  const effective = row.effective
  if (!effective || typeof effective !== "object") return null
  if (typeof (effective as Record<string, unknown>).preview !== "string") {
    return null
  }
  if (
    row.capacityMode !== null &&
    row.capacityMode !== "HOLD" &&
    row.capacityMode !== "NO_HOLD"
  ) {
    return null
  }
  if (!Number.isInteger(row.version)) return null
  if (typeof row.configured !== "boolean") return null
  return row as unknown as AdultMemberHostingPolicy
}

async function responseMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null
  return typeof body?.error === "string" ? body.error : fallback
}

export function AdultMemberHostingSection() {
  // Booking-policy config gates on the bookings area, whose write route enforces
  // bookings:edit; a bookings:view admin sees this read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const policyScope = usePolicyScopeOptions(scopeLodgeId)
  const policyScopeReady = isPolicyScopeReady(policyScope)
  const scopeLodgeName =
    policyScope.state.kind === "lodge" ? policyScope.state.lodgeName : null
  const [loadedScope, setLoadedScope] = useState<string | null>(UNLOADED_SCOPE)
  /**
   * The server's resolved view of this scope (#2569 §16). Held beside the draft
   * rather than inside it: it is not editable, and it is refreshed by whatever the
   * server says after each load and each save.
   */
  const [effective, setEffective] =
    useState<AdultMemberHostingPolicy["effective"] | null>(null)
  /** The scope set the checkboxes hold while "inherit" is selected. */
  const [customScopeSeed, setCustomScopeSeed] =
    useState<AdultMemberHostScopeSetValue>({
      sameBooking: true,
      sameBookingOwner: false,
      sameGroupTrip: false,
    })
  const scopeRef = useRef(scopeLodgeId)
  const modeHint = useFieldHint()
  const capacityHint = useFieldHint()
  /**
   * The hook's `reload`, reachable from inside its own `save` callback.
   *
   * `save` is declared in the options object that CREATES the hook state, so it
   * cannot close over `section` directly. A ref refreshed after each commit is
   * the smallest honest way to let a 409 pull a fresh authoritative row.
   */
  const reloadRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    scopeRef.current = scopeLodgeId
  }, [scopeLodgeId])

  const section = useSectionEditState<HostingDraft>({
    load: async (signal) => {
      if (!policyScopeReady) {
        throw new DOMException("Policy scope is unresolved", "AbortError")
      }
      const scope = scopeRef.current
      const res = await fetch(
        scope ? `${ENDPOINT}?lodgeId=${encodeURIComponent(scope)}` : ENDPOINT,
        { signal },
      )
      if (!res.ok) {
        setLoadedScope(UNLOADED_SCOPE)
        throw new Error("Failed to load the adult-member hosting policy")
      }
      const policy = parsePolicy(await res.json().catch(() => null))
      if (!policy) {
        setLoadedScope(UNLOADED_SCOPE)
        throw new Error("Failed to read the adult-member hosting policy")
      }
      setLoadedScope(scope)
      setEffective(policy.effective)
      setCustomScopeSeed(customScopeStartingPoint(policy))
      return toDraft(policy)
    },
    save: async (draft) => {
      if (!policyScopeReady) {
        throw new Error("Choose an available policy scope before saving")
      }
      const scope = scopeRef.current
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: draft.mode,
          capacityMode: draft.capacityMode,
          // Always sent, including null: null IS the inherit choice, so omitting
          // it would make "inherit the club's scopes" indistinguishable from "do
          // not mention the scopes", and the route would have to guess.
          hostScopes: draft.hostScopes,
          // Only sent when a row is stored: absent means "I believe there is
          // nothing here yet", which the route checks rather than assumes.
          ...(draft.version !== null ? { version: draft.version } : {}),
          ...(scope ? { lodgeId: scope } : {}),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const message = await responseMessage(res, "Failed to save")
        if (res.status === 409) {
          // Somebody else moved the row. Drop this scope back to UNKNOWN so no
          // further write can be sent from a stale token, then pull the current
          // one. `reload` clears both messages, so the refusal is re-set after.
          setLoadedScope(UNLOADED_SCOPE)
          await reloadRef.current()
        }
        throw new Error(message)
      }
      const policy = parsePolicy(await res.json().catch(() => null))
      if (!policy) throw new Error("Saved, but the response could not be read")
      setEffective(policy.effective)
      setCustomScopeSeed(customScopeStartingPoint(policy))
      return toDraft(policy)
    },
    successMessage: "Adult-member hosting policy saved",
    // First save exception (#2142): until a row is persisted there is nothing
    // for the draft to be unchanged FROM — the GET synthesised it — so a first
    // save can store the club's choice even when it matches the built-in
    // default. Afterwards this is the plain field comparison again (#2143).
    isDirty: (draft, saved) =>
      !draft.configured ||
      draft.mode !== saved.mode ||
      draft.capacityMode !== saved.capacityMode ||
      !scopeSetsEqual(draft.hostScopes, saved.hostScopes),
    // Capacity mode is required on every write, so a first save cannot happen
    // until the admin has actually chosen one (D-R6). #2569 adds the second
    // condition: a CUSTOM scope set with nothing ticked has no valid reading, so
    // the Save button is unreachable rather than the save being refused by the
    // route with a sentence the admin has to go and read.
    isValid: (draft) =>
      draft.capacityMode !== "" &&
      (draft.hostScopes === null ||
        draft.hostScopes.sameBooking ||
        draft.hostScopes.sameBookingOwner ||
        draft.hostScopes.sameGroupTrip === true),
  })

  const { draft, editing, saving, dirty, valid, error, success } = section

  useEffect(() => {
    reloadRef.current = section.reload
  })

  // Reload when the scope CHANGES; the keyed snapshot travels with its scope.
  // The hook already loads once on mount, so the mount run is skipped rather
  // than fetching the club-wide row twice on first paint.
  const mountedRef = useRef(false)
  const policyScopeReadyOnFirstRender = useRef(policyScopeReady)
  useEffect(() => {
    if (!policyScopeReady) return
    if (!mountedRef.current) {
      mountedRef.current = true
      if (policyScopeReadyOnFirstRender.current) return
    }
    setLoadedScope(UNLOADED_SCOPE)
    void reloadRef.current()
  }, [policyScopeReady, scopeLodgeId])

  const retryLoad = useCallback(() => {
    if (!policyScopeReady) return
    void reloadRef.current()
  }, [policyScopeReady])

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the adult-member hosting policy but cannot change
      it. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  // The snapshot is authoritative only for the scope it was loaded for.
  const scopeKnown = loadedScope === scopeLodgeId

  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => section.setError("")}
        onClearSuccess={() => section.setSuccess("")}
      />
      <div className="space-y-6">
        <PolicyScopeSelect
          options={policyScope}
          value={scopeLodgeId}
          onChange={setScopeLodgeId}
          id="adult-member-hosting-scope"
        />

        {policyScopeReady && section.loading ? (
          <div className="text-center py-8">Loading...</div>
        ) : null}

        {policyScopeReady && !section.loading && (!scopeKnown || !draft) ? (
          <Card>
            <CardHeader>
              <CardTitle>
                Could not load the adult-member hosting policy for{" "}
                {scopeLodgeName ?? "the club"}
              </CardTitle>
              <CardDescription>
                Nothing is shown, because we do not know what is stored here. The
                settings that were on screen a moment ago belong to a different
                scope, so saving from here would change the wrong one. Try again
                below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={retryLoad}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {policyScopeReady && !section.loading && scopeKnown && draft ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>
                  {scopeLodgeName
                    ? `Adult Member Hosting — ${scopeLodgeName}`
                    : "Adult Member Hosting"}
                </CardTitle>
                <CardDescription>
                  Ask that every night a non-member guest stays is covered by an
                  adult member. Two separate settings: what happens when it is
                  not, and which adult members count. A recorded review clears
                  itself if cover is added later.
                  {scopeLodgeName ? (
                    <>
                      {" "}
                      This setting belongs to {scopeLodgeName}. Leave it on
                      &ldquo;Use the club-wide setting&rdquo; for the lodge to
                      follow whatever the club decides.
                    </>
                  ) : null}
                </CardDescription>
              </div>
              {!editing && (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  onClick={section.startEditing}
                >
                  Edit
                </ViewOnlyActionButton>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 max-w-md">
                <Label htmlFor="hostingMode">
                  Non-member guests without an adult member
                </Label>
                <select
                  id="hostingMode"
                  value={draft.mode}
                  disabled={!editing}
                  onChange={(event) =>
                    section.setDraft({
                      mode: event.target.value as HostingDraft["mode"],
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:bg-muted disabled:text-muted-foreground"
                  {...modeHint.fieldProps}
                >
                  {scopeLodgeId ? (
                    <option value="INHERIT">Use the club-wide setting</option>
                  ) : null}
                  <option value="DISABLED">
                    Allowed — no adult member needed
                  </option>
                  <option value="ADMIN_REVIEW_REQUIRED">
                    Allow the booking, but send it to a Booking Officer to review
                  </option>
                  <option value="ENFORCED">
                    Stop the booking unless it is corrected or an exception is
                    approved
                  </option>
                </select>
                <FieldHint {...modeHint.hintProps}>
                  Choose what happens when a non-member guest has no adult member
                  cover. Reviewing still makes the booking and asks an officer to
                  look; stopping it means the member has to add cover, change the
                  guests or dates, pick another lodge, or ask a Booking Officer to
                  approve an exception. An exception request for a new booking
                  does not hold any beds.
                </FieldHint>
              </div>

              <div className="space-y-3 max-w-md">
                <Label htmlFor="hostingScopeSource">
                  Adult members who count
                </Label>
                <select
                  id="hostingScopeSource"
                  aria-describedby="hostingScopeHint"
                  value={draft.hostScopes === null ? "INHERIT" : "CUSTOM"}
                  disabled={!editing}
                  onChange={(event) =>
                    section.setDraft({
                      hostScopes:
                        event.target.value === "INHERIT"
                          ? null
                          : { ...customScopeSeed },
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:bg-muted disabled:text-muted-foreground"
                >
                  <option value="INHERIT">
                    {scopeLodgeId
                      ? "Inherit the club-wide choice of who counts"
                      : "Use the built-in default (adult member on the same booking)"}
                  </option>
                  <option value="CUSTOM">
                    {scopeLodgeId
                      ? "Choose who counts for this lodge"
                      : "Choose who counts club-wide"}
                  </option>
                </select>

                <fieldset
                  className="space-y-2"
                  disabled={!editing || draft.hostScopes === null}
                  aria-describedby="hostingScopeHint"
                >
                  <legend className="sr-only">
                    Qualifying adult-member sources
                  </legend>
                  {HOST_SCOPE_ORDER.map((key) => (
                    <label
                      key={key}
                      className="flex items-start gap-2 text-sm"
                      htmlFor={`hostScope-${key}`}
                    >
                      <input
                        id={`hostScope-${key}`}
                        type="checkbox"
                        className="mt-1"
                        checked={draft.hostScopes?.[key] ?? false}
                        disabled={!editing || draft.hostScopes === null}
                        onChange={(event) =>
                          section.setDraft({
                            hostScopes: draft.hostScopes
                              ? {
                                  ...draft.hostScopes,
                                  [key]: event.target.checked,
                                }
                              : draft.hostScopes,
                          })
                        }
                      />
                      <span>
                        {HOST_SCOPE_LABELS[key]}
                        <span className="block text-muted-foreground">
                          {HOST_SCOPE_DESCRIPTIONS[key]}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <FieldHint id="hostingScopeHint">
                  These are independent: a night counts as covered when at least
                  one ticked kind of adult member covers it, and different nights
                  may be covered by different people. A qualifying adult member has
                  to be staying in their own right — owning the booking is not
                  enough, and child or youth members do not count. One adult can
                  cover any number of non-member guests; there is no ratio.
                  {draft.mode === "DISABLED" ? (
                    <>
                      {" "}
                      The requirement is off at the moment, so these are saved but
                      not applied.
                    </>
                  ) : null}
                </FieldHint>
              </div>

              <div className="space-y-2 max-w-md">
                <Label htmlFor="hostingCapacityMode">
                  Exception capacity handling
                </Label>
                <select
                  id="hostingCapacityMode"
                  value={draft.capacityMode}
                  disabled={!editing}
                  onChange={(event) =>
                    section.setDraft({
                      capacityMode: event.target
                        .value as HostingDraft["capacityMode"],
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:bg-muted disabled:text-muted-foreground"
                  {...capacityHint.fieldProps}
                >
                  <option value="" disabled>
                    Select how capacity is handled
                  </option>
                  <option value="HOLD">
                    Hold requested capacity while it waits
                  </option>
                  <option value="NO_HOLD">
                    Do not hold capacity until approval
                  </option>
                </select>
                <FieldHint {...capacityHint.hintProps}>
                  This applies when a booking needs an approved exception to this
                  rule. There is no automatic choice, so pick one even if the
                  requirement is off today — it is what the club will fall back
                  on the moment it is turned on. A hold is not open-ended: it
                  lasts until the request is decided or its deadline passes —
                  7 days after it is raised, never past the start of the first
                  night held, and never less than 24 hours — after which the beds
                  return to the pool and the request is marked Expired.
                </FieldHint>
              </div>

              {effective ? (
                <div className="rounded-md border bg-muted p-3 text-sm space-y-1">
                  <p className="font-medium">In force here now</p>
                  <p>{effective.preview}</p>
                  <p className="text-muted-foreground">
                    Consequence:{" "}
                    {SOURCE_LABELS[effective.modeSource] ?? effective.modeSource}.
                    Who counts:{" "}
                    {SOURCE_LABELS[effective.hostScopeSource] ??
                      effective.hostScopeSource}
                    {" — "}
                    {HOST_SCOPE_ORDER.filter((key) => effective.hostScopes[key])
                      .map((key) => HOST_SCOPE_LABELS[key])
                      .join("; ") || "nobody counts"}
                    .
                  </p>
                </div>
              ) : null}

              <p className="text-sm text-muted-foreground">
                {draft.configured
                  ? `Revision ${draft.version}.`
                  : "Not configured yet — the built-in default is shown."}
              </p>

              {editing && (
                <div className="flex space-x-3">
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={() => void section.save()}
                    disabled={!dirty || !valid || saving}
                  >
                    {saving ? "Saving..." : "Save Hosting Policy"}
                  </ViewOnlyActionButton>
                  <Button
                    variant="outline"
                    onClick={section.cancelEditing}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
