import type { NormalizedCancellationRule } from "@/lib/cancellation-rules"

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export type PolicyRule = NormalizedCancellationRule & { id?: string }

export interface MinStayPolicy {
  id: string
  name: string
  startDate: string
  endDate: string
  triggerDays: number[]
  minimumNights: number
  capacityMode: "HOLD" | "NO_HOLD"
  version: number
  active: boolean
}

/**
 * One scope's adult-member hosting setting (#2364).
 *
 * `configured: false` is the SYNTHESISED body the GET returns for a scope with
 * no stored row: `version` is then 0 and `capacityMode` null, because a new
 * policy has no automatic capacity choice (epic decision D-R6).
 */
export type AdultMemberHostingModeValue =
  | "INHERIT"
  | "DISABLED"
  | "ADMIN_REVIEW_REQUIRED"
  | "ENFORCED"

/**
 * The three independent host scopes (#2569 §2, #3037); null is the inherit option.
 *
 * `sameGroupTrip` is optional on the wire and defaults to false when the server
 * omits it, so a card rendered against a response from a previous colour shows the
 * scope unticked — which is what it is — rather than failing to parse.
 */
export interface AdultMemberHostScopeSetValue {
  sameBooking: boolean
  sameBookingOwner: boolean
  sameGroupTrip?: boolean
}

/**
 * What is actually in force at the selected scope, resolved by the SERVER
 * (#2569 §16). The card displays it and never recomputes it: the inheritance rule
 * has exactly one implementation, in `resolveAdultMemberHostingPolicy`.
 */
export interface AdultMemberHostingEffective {
  mode: "DISABLED" | "ADMIN_REVIEW_REQUIRED" | "ENFORCED"
  modeSource: "LODGE" | "CLUB_WIDE" | "BUILT_IN_DEFAULT"
  hostScopes: AdultMemberHostScopeSetValue
  hostScopeSource: "LODGE" | "CLUB_WIDE" | "BUILT_IN_DEFAULT"
  preview: string
}

export interface AdultMemberHostingPolicy {
  scopeKey: string
  lodgeId: string | null
  mode: AdultMemberHostingModeValue
  capacityMode: "HOLD" | "NO_HOLD" | null
  /** null means this scope inherits the club's host scopes (#2569 §2). */
  hostScopes: AdultMemberHostScopeSetValue | null
  version: number
  configured: boolean
  effective: AdultMemberHostingEffective
}

export interface BookingPeriod {
  id: string
  name: string
  startDate: string
  endDate: string
  nonMemberHoldEnabled: boolean
  nonMemberHoldDays: number
  cancellationRules: PolicyRule[]
  active: boolean
}
