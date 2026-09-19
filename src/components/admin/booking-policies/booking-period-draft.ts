/**
 * The booking-period DRAFT model: the shape an open period editor holds, its
 * blank value, how one is built from a server row, how two are compared, and
 * how a boundary date is shown.
 *
 * Split out of `booking-periods-section.tsx` (#2887) because none of it is
 * React or JSX — it is the data shaping that both the section and its row-level
 * `PeriodForm` share — and because that file crossed its size budget. Keeping
 * the model beside `types.ts` matches how the rest of this directory is
 * organised.
 */

import {
  cancellationRuleSetsEqual,
  normalizeCancellationRule,
} from "@/lib/cancellation-rules"
import { dateOnlyFromIsoString } from "@/lib/date-only"
import type { BookingPeriod, PolicyRule } from "./types"

const NEW_PERIOD_RULES: PolicyRule[] = [
  { daysBeforeStay: 21, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
]

/**
 * One open period editor's draft. This section's snapshot is a LIST, so the
 * draft/snapshot pair that `useSectionEditState` owns is scoped to the ROW
 * being edited, not to the section: the form mounts one hook instance per open
 * editor (keyed on the row id) and the list itself stays plain state.
 */
export interface PeriodDraft {
  name: string
  startDate: string
  endDate: string
  holdEnabled: boolean
  holdDays: number
  rules: PolicyRule[]
}

/**
 * The scope of a list that was never loaded (#2142 review). Club-wide scope is
 * `null`, so `null` cannot double as "unknown" — see the identical sentinel in
 * `default-cancellation-policy-section.tsx`.
 */
export const UNLOADED_SCOPE = "__unloaded__"

export const NEW_PERIOD_DRAFT: PeriodDraft = {
  name: "",
  startDate: "",
  endDate: "",
  holdEnabled: true,
  holdDays: 5,
  rules: NEW_PERIOD_RULES,
}

export function toDraft(period: BookingPeriod): PeriodDraft {
  return {
    name: period.name,
    startDate: dateOnlyFromIsoString(period.startDate),
    endDate: dateOnlyFromIsoString(period.endDate),
    holdEnabled: period.nonMemberHoldEnabled ?? true,
    holdDays: period.nonMemberHoldDays,
    rules: period.cancellationRules.map((rule) => normalizeCancellationRule(rule)),
  }
}

export function draftsEqual(a: PeriodDraft, b: PeriodDraft) {
  return (
    a.name === b.name &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.holdEnabled === b.holdEnabled &&
    a.holdDays === b.holdDays &&
    cancellationRuleSetsEqual(a.rules, b.rules)
  )
}
