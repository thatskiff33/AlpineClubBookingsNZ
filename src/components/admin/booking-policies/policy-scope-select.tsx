"use client"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LodgeOptionsUnavailableNotice } from "@/components/admin/lodge-options-status"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  type LodgeOption,
  useLodgeOptions,
} from "@/components/lodge-select"

const CLUB_WIDE = "__club_wide__"

/** What a save says when it is refused because no policy scope is settled yet. */
export const POLICY_SCOPE_NOT_READY_REASON =
  "Choose an available policy scope before saving"

export type PolicyScopeState =
  | { kind: "resolving" }
  | { kind: "unavailable"; failed: boolean; forbidden: boolean }
  | { kind: "invalid-lodge"; lodgeId: string }
  | { kind: "club-wide" }
  | { kind: "lodge"; lodgeId: string; lodgeName: string | null }

export type PolicyScopeOptions = {
  state: PolicyScopeState
  lodges: LodgeOption[]
  reload: () => void
}

/**
 * Resolve the policy partition before any policy endpoint may be read or
 * written. In particular, `club-wide` is a settled, deliberate state; it is
 * never represented by the same value as a still-loading or failed lodge list.
 */
export function usePolicyScopeOptions(
  lodgeId: string | null,
): PolicyScopeOptions {
  const { lodges, loading, failed, forbidden, reload } =
    useLodgeOptions("admin")

  let state: PolicyScopeState
  if (loading) {
    state = { kind: "resolving" }
  } else if (failed || forbidden) {
    state = { kind: "unavailable", failed, forbidden }
  } else if (lodgeId) {
    const lodge = lodges.find((option) => option.id === lodgeId)
    state = lodge
      ? { kind: "lodge", lodgeId, lodgeName: lodge.name }
      : { kind: "invalid-lodge", lodgeId }
  } else {
    state = { kind: "club-wide" }
  }

  return { state, lodges, reload }
}

export function isPolicyScopeReady(options: PolicyScopeOptions): boolean {
  return options.state.kind === "club-wide" || options.state.kind === "lodge"
}

// Scope selector for the booking-policy editors (ADR-001 resolved question
// 3): policies are club-wide by default with per-lodge override sets that
// REPLACE (never merge with) the club-wide rules. Unlike LodgeSelect, the
// default option here is explicitly "club-wide", not a lodge. Renders
// nothing while fewer than two lodges exist (ADR-002 presentation rule), so
// single-lodge clubs only ever edit the club-wide rules.
export function PolicyScopeSelect({
  options,
  value,
  onChange,
  id = "policy-scope-select",
}: {
  options: PolicyScopeOptions
  value: string | null
  onChange: (lodgeId: string | null) => void
  id?: string
}) {
  const { lodges, state, reload } = options

  if (state.kind === "resolving") {
    return null
  }

  /*
    #2701: this control had no error surface at all — a failed lodge list gave
    an empty `lodges`, which is the same shape as a single-lodge club, so it
    returned null and the section silently became "club-wide rules" with no way
    to reach a lodge's overrides. Club-wide rules are not a harmless default
    here: they apply to every lodge that has no override of its own, so an admin
    who meant to change one lodge changes all of them, and the control that
    would have said so is not on the page.

    Rendered INSTEAD of null, never alongside the select, so a section that has
    a scope control always has either the control or the reason it is missing.
  */
  if (state.kind === "unavailable") {
    return (
      <LodgeOptionsUnavailableNotice
        failed={state.failed}
        forbidden={state.forbidden}
        onRetry={reload}
        what="per-lodge rule overrides"
        className="max-w-xl"
      />
    )
  }

  if (state.kind === "invalid-lodge") {
    return (
      <Alert variant="error" title="This lodge is no longer available">
        <p className="mb-3">
          The selected lodge is not in the current active lodge list. Nothing
          can be viewed or changed in that stale scope.
        </p>
        <Button type="button" variant="outline" onClick={() => onChange(null)}>
          Return to club-wide rules
        </Button>
      </Alert>
    )
  }

  if (lodges.length < 2) {
    return null
  }

  return (
    <div className="max-w-xs space-y-2">
      <Label htmlFor={id}>Rules for</Label>
      <Select
        value={value ?? CLUB_WIDE}
        onValueChange={(next) => onChange(next === CLUB_WIDE ? null : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLUB_WIDE}>Club-wide rules (default)</SelectItem>
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {lodge.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
