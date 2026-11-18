"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useClubIdentity } from "@/components/club-identity-provider"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import { apiRefusalFromResponse } from "@/lib/api-error-message"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"

const LOAD_FALLBACK = "Failed to fetch group discount"
const SAVE_FALLBACK = "Failed to save"

// Reference implementation of the canonical settings-section pattern
// (`AGENTS.md`): loads read-only, a per-section Edit reveals Save/Cancel, no
// control auto-persists, Cancel reverts to the saved snapshot, and Save
// persists once and re-seeds from the server response. The draft/snapshot
// bookkeeping lives in `useSectionEditState` (#2136).

interface GroupDiscountDraft {
  minGroupSize: number
  summerOnly: boolean
  enabled: boolean
  /**
   * Whether a later edit to an existing booking earns the discount on the
   * nights it newly buys (#2770, INV-MOD-026). Ticked by default, which is what
   * every edit path already did, so the control appearing changes no club's
   * prices.
   */
  applyToEdits: boolean
  /**
   * Whether a row is actually persisted, as reported by the GET (#2142). The
   * route SYNTHESISES the defaults when there is no row, so on a club that has
   * never saved this policy the draft equals the snapshot and the #2143 dirty
   * gate would make creating the row unreachable. This flag is never sent to
   * the server — the PUT body is built from the real policy fields only.
   */
  configured: boolean
}

const GROUP_DISCOUNT_DEFAULTS: GroupDiscountDraft = {
  // Deliberately `configured: true`: this seed is also the fallback a FAILED
  // load leaves in the form, and there we know nothing about the stored row.
  // Claiming "no row yet" would enable a pristine Save that blind-writes the
  // defaults over a club's real, configured policy. Failing closed costs
  // nothing — the admin can still save after changing a field, or reload.
  configured: true,
  minGroupSize: 5,
  summerOnly: true,
  enabled: false,
  applyToEdits: true,
}

const ENDPOINT = "/api/admin/booking-policies/group-discount"

function toDraft(data: {
  minGroupSize: number
  summerOnly: boolean
  enabled: boolean
  applyToEdits?: boolean
  configured?: boolean
}): GroupDiscountDraft {
  return {
    minGroupSize: data.minGroupSize,
    summerOnly: data.summerOnly,
    enabled: data.enabled,
    // The column is NOT NULL with a `true` default, so the server always sends a
    // boolean; the `?? true` is the FAIL-SAFE for a response that predates the
    // column (a fork mid-upgrade), where the behaviour in force is the old
    // always-on one and showing the box ticked is what is actually true.
    applyToEdits: data.applyToEdits ?? true,
    // The PUT response is the persisted row itself and carries no `configured`
    // flag; reaching it at all means the row now exists.
    configured: data.configured ?? true,
  }
}

export function GroupDiscountSection() {
  const { lodgeCapacity } = useClubIdentity()
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")

  const section = useSectionEditState<GroupDiscountDraft>({
    // Seeded so a failed load still renders the form with its defaults
    // alongside the error, as it always has.
    initial: GROUP_DISCOUNT_DEFAULTS,
    load: async (signal) => {
      const res = await fetch(ENDPOINT, { signal })
      if (!res.ok) throw new Error(LOAD_FALLBACK)
      return toDraft(await res.json())
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Only the real policy fields — four of them since #2770; `configured` is
        // a client-side view of the GET, not part of the write contract.
        body: JSON.stringify({
          minGroupSize: draft.minGroupSize,
          summerOnly: draft.summerOnly,
          enabled: draft.enabled,
          applyToEdits: draft.applyToEdits,
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        throw await apiRefusalFromResponse(res, SAVE_FALLBACK)
      }
      return toDraft(await res.json())
    },
    successMessage: "Group discount settings saved",
    loadErrorFallback: LOAD_FALLBACK,
    saveErrorFallback: SAVE_FALLBACK,
    // `allowPristineSave` stays at its default (false): an unchanged draft must
    // not re-PUT, because the write route logs `group-discount.update` and
    // revalidates the public pages unconditionally, so a no-op save would leave
    // an audit entry asserting a policy change that never happened (#2143).
    //
    // The one exception is expressed HERE rather than on the Save button,
    // because the hook's own `save()` enforces the same gate and would refuse a
    // click the button had allowed. Until a row is persisted there is nothing
    // for the draft to be unchanged FROM — the GET synthesised it — so the
    // draft counts as dirty and a first save can create the row even when the
    // admin is happy with every default (#2142). Once the row exists this is
    // the plain field-by-field comparison again.
    isDirty: (draft, saved) =>
      !draft.configured ||
      draft.minGroupSize !== saved.minGroupSize ||
      draft.summerOnly !== saved.summerOnly ||
      draft.enabled !== saved.enabled ||
      draft.applyToEdits !== saved.applyToEdits,
  })

  const { draft, editing, saving, dirty, error, success } = section

  /*
    #2142: the view-only explanation lives here, once, at the top of the
    section — announced on arrival and in the reading order — instead of on each
    disabled button below. It is rendered in BOTH branches below, in the same
    position, so the polite live region is registered in the accessibility tree
    from the first paint and only its CONTENT changes when `canEdit` resolves. A
    region injected already-populated is silently dropped by some
    screen-reader/browser pairings.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the group discount policy but cannot change it.
      Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  /*
    #2162 review: the section FRAME — the banner AND `PolicyFeedback` — is
    rendered in EVERY state, and only the cards below it are swapped. This early
    return used to sit ABOVE `PolicyFeedback`, which re-created the exact defect
    the unconditional live-region wrappers exist to prevent: a failed FIRST load
    clears `loading`, so the section left this branch and mounted
    `PolicyFeedback` already carrying the load error, in one commit — the
    single-mutation injection that some screen-reader/browser pairings drop
    silently.

    `initial` IS supplied above, so `draft` is non-null throughout and clearing
    `loading` is the only way this branch is left. The `!draft` term is kept as a
    guard for a future edit that drops `initial`, and the placeholder is gated on
    `loading` alone so that such an edit could not strand the section on
    "Loading..." forever with its error invisible.
  */
  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        <PolicyFeedback
          error={error}
          success={success}
          onClearError={() => section.setError("")}
          onClearSuccess={() => section.setSuccess("")}
        />
        {section.loading ? <div className="text-center py-8">Loading...</div> : null}
      </div>
    )
  }

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
        <Card {...section.sectionRegionProps}>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle {...section.titleProps}>Group Discount</CardTitle>
              <CardDescription>
                When a booking has enough guests, all guests are charged at member rates.
              </CardDescription>
            </div>
            {!editing && (
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" {...section.editTriggerProps} onClick={section.startEditing}>
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="groupEnabled"
                checked={draft.enabled}
                onChange={(e) => section.setDraft({ enabled: e.target.checked })}
                className="rounded border-input"
                disabled={!editing}
              />
              <Label htmlFor="groupEnabled">Enabled</Label>
            </div>

            <div className="space-y-2 max-w-xs">
              <Label htmlFor="groupMinSize">Minimum group size</Label>
              <div className="flex items-center space-x-2">
                <Input
                  id="groupMinSize"
                  type="number"
                  min="2"
                  max={String(lodgeCapacity)}
                  value={draft.minGroupSize}
                  onChange={(e) =>
                    section.setDraft({ minGroupSize: parseInt(e.target.value) || 5 })
                  }
                  className={`w-20 ${!editing ? "bg-muted text-muted-foreground" : ""}`}
                  disabled={!editing}
                />
                <span className="text-sm text-muted-foreground">guests</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Bookings with this many or more guests will have all guests charged at member rates.
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="groupSummerOnly"
                checked={draft.summerOnly}
                onChange={(e) => section.setDraft({ summerOnly: e.target.checked })}
                className="rounded border-input"
                disabled={!editing}
              />
              <Label htmlFor="groupSummerOnly">Summer seasons only</Label>
            </div>

            {/*
              #2770 (INV-MOD-026). One switch for EVERY way a booking can be
              edited later, which is the point of it: before this, one edit path
              priced a night differently from the others (#2756). It is stated
              here as well as beside the price the member sees, because the
              admin turning it off is the only person who can explain it.
            */}
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="groupApplyToEdits"
                  checked={draft.applyToEdits}
                  onChange={(e) =>
                    section.setDraft({ applyToEdits: e.target.checked })
                  }
                  className="rounded border-input"
                  disabled={!editing}
                />
                <Label htmlFor="groupApplyToEdits">
                  Apply to nights added after booking
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                On (the default): when a booking is edited later to add nights or
                guests, those new nights get the discount too, exactly as they
                would if they had been booked at the start. Off: only the
                original booking is discounted, and anything added later is
                charged at the ordinary rate. Either way, nights already booked
                keep the price they were booked at &mdash; turning this off never
                re-charges anyone for a night they have already paid for.
              </p>
            </div>

            {editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => void section.save()}
                  disabled={!dirty || saving}
                >
                  {saving ? "Saving..." : "Save Group Discount"}
                </ViewOnlyActionButton>
                <Button variant="outline" onClick={section.cancelEditing} disabled={saving}>
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
