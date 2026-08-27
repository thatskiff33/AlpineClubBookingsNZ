import {
  shouldDefaultPostalSameAsPhysical,
  type MemberAddressValues,
} from "@/lib/member-address"
import { seasonSelectLabel } from "@/lib/season-label"
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseCalendarDate,
  parseInstant,
} from "@/lib/club-time"

export interface AdminActor {
  id: string
  firstName: string
  lastName: string
}

export interface AuditActor {
  id: string
  firstName: string
  lastName: string
  email: string
}

export interface AuditLogEntry {
  id: string
  action: string
  details: string | null
  createdAt: string
  actor: AuditActor | null
}

export interface InviteAuditDetails {
  recipientEmail?: string
  recipientName?: string
  kind?: "invite" | "reset"
  expiryLabel?: string
}

export interface ParentLinkSummary {
  id: string
  firstName: string
  lastName: string
  email: string
  ageTier: string
  active: boolean
  canLogin: boolean
  inheritEmailFromId?: string | null
  parentLinkType: "PRIMARY" | "SECONDARY"
}

export interface PromoCodeBenefitSource {
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS" | "FIXED_NIGHTLY_PRICE"
  percentOff: number | null
  valueCents: number | null
  freeNightsPerIndividual: number | null
  lifetimeFreeNightsCap: number | null
  fixedNightlyPriceCents?: number | null
  fixedNightlyMode?: "SET_PRICE" | "CAP_ONLY" | null
}

// Storage keys are member-agnostic on purpose: an admin's expanded/collapsed
// choices follow them from one member page to the next. Keys retired by the
// grouped-layout redesign (subs/bookings/xero/audit) are left stale in
// localStorage; every group simply starts collapsed on first visit.
export const collapsibleMemberSections = [
  "contact",
  "account",
  "family",
  "membership",
  "finance",
  "committee",
  "history",
  "lifecycle",
] as const
export type CollapsibleMemberSection =
  (typeof collapsibleMemberSections)[number]

export const memberSectionStorageKeys: Record<
  CollapsibleMemberSection,
  string
> = {
  contact: "admin-member-section:contact",
  account: "admin-member-section:account",
  family: "admin-member-section:family",
  membership: "admin-member-section:membership",
  finance: "admin-member-section:finance",
  committee: "admin-member-section:committee",
  history: "admin-member-section:history",
  lifecycle: "admin-member-section:lifecycle",
}

export function isCollapsibleMemberSection(
  value: string
): value is CollapsibleMemberSection {
  return collapsibleMemberSections.includes(value as CollapsibleMemberSection)
}

// The label names the parent surface the back-link returns to; the shared
// BackLink prepends the ← affordance, so the label stays a bare parent name
// (no "Back to " prefix, which would duplicate the arrow — #2046).
export function getMemberDetailBackLabel(returnTo: string) {
  if (returnTo.startsWith("/admin/bookings")) return "Bookings"
  if (returnTo.startsWith("/admin/payments")) return "Payments"
  if (returnTo.startsWith("/admin/subscriptions")) return "Subscriptions"
  if (returnTo.startsWith("/admin/refund-requests")) return "Refund Requests"
  if (returnTo.startsWith("/admin/xero")) return "Xero"
  return "Members"
}

export function formatAdminName(admin: AdminActor | null | undefined) {
  return admin ? `${admin.firstName} ${admin.lastName}` : "Unknown admin"
}

export function parseInviteAuditDetails(
  details: string | null
): InviteAuditDetails | null {
  if (!details) return null

  try {
    const parsed = JSON.parse(details) as InviteAuditDetails
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

export function getAuditActorDisplayName(
  actor: AuditActor | null | undefined
) {
  if (!actor) return "System"

  const fullName = `${actor.firstName} ${actor.lastName}`.trim()
  return fullName || actor.email || "System"
}

export function formatMemberAuditLogSummary(
  log: AuditLogEntry,
  formattedTimestamp: string
) {
  const parsedDetails = parseInviteAuditDetails(log.details)
  const actorName = getAuditActorDisplayName(log.actor)

  if (
    log.action === "member.setup-invite-sent" &&
    parsedDetails?.recipientEmail
  ) {
    return `Invited via email to ${parsedDetails.recipientEmail} on ${formattedTimestamp} by ${actorName}`
  }

  if (
    log.action === "member.password-reset-sent" &&
    parsedDetails?.recipientEmail
  ) {
    return `Password reset sent to ${parsedDetails.recipientEmail} on ${formattedTimestamp} by ${actorName}`
  }

  return log.action
}

export function shouldDefaultLinkSideEffects(ageTier: string) {
  return ageTier !== "ADULT"
}

export function parentLinkTypeLabel(type?: "PRIMARY" | "SECONDARY") {
  return type === "SECONDARY" ? "Second parent" : "Primary parent"
}

/**
 * What the parent picker says when its eight slots did not hold everyone who
 * matched (#2425).
 *
 * The wording is the member-guest finder's own truncation sentence
 * (`MEMBER_GUEST_FIND_COPY.truncated`, #2308), character for character, so the
 * product says the same thing in the same words wherever a search is cut short.
 * It is a COPY of that string rather than an import: the member-guest sentence
 * is load-bearing privacy copy — it must never grow a count, because there the
 * count would describe members the booker is not being shown — and coupling the
 * two would let a change made for one surface's reasons silently land on the
 * other. A test pins the two equal, so they cannot drift apart unnoticed either.
 *
 * Note what it does NOT say: no count. Here that is only consistency, not
 * privacy — an admin may see the whole roll — but "keep typing" is the useful
 * instruction whether five or five hundred were left out.
 */
export const MEMBER_SEARCH_TRUNCATED_HINT = "Keep typing to narrow this down."

export function dedupeParentOptions<T extends { id: string }>(parents: T[]) {
  const seen = new Set<string>()
  return parents.filter((parent) => {
    if (seen.has(parent.id)) return false
    seen.add(parent.id)
    return true
  })
}

export function formatPromoBenefit(promo: PromoCodeBenefitSource) {
  if (promo.type === "PERCENTAGE") {
    return promo.percentOff !== null
      ? `${promo.percentOff}% off per individual`
      : "Percentage discount"
  }
  if (promo.type === "FIXED_AMOUNT") {
    return promo.valueCents !== null
      ? `$${(promo.valueCents / 100).toFixed(2)} off per individual`
      : "Fixed discount"
  }
  if (promo.type === "FIXED_NIGHTLY_PRICE") {
    if (promo.fixedNightlyPriceCents == null) {
      return "Fixed nightly price"
    }
    const mode = promo.fixedNightlyMode === "SET_PRICE" ? "set price" : "cap only"
    return `$${(promo.fixedNightlyPriceCents / 100).toFixed(2)} per eligible night · ${mode}`
  }
  if (promo.freeNightsPerIndividual !== null) {
    const perBooking = `${promo.freeNightsPerIndividual} free night${promo.freeNightsPerIndividual === 1 ? "" : "s"} per booking`
    if (promo.lifetimeFreeNightsCap != null) {
      return `${perBooking} · ${promo.lifetimeFreeNightsCap} lifetime`
    }
    return perBooking
  }
  return "Free nights"
}

export type NullableMemberAddress = Record<keyof MemberAddressValues, string | null>

export function memberUsesSamePostalAddress(member: NullableMemberAddress) {
  return shouldDefaultPostalSameAsPhysical(member)
}

/**
 * A CALENDAR DAY from an admin payload, rendered with no timezone at all
 * (CT-4, #2870; `INV-DATE-019`).
 *
 * NARROW, DECLARED `src/lib` EXCEPTION, and it exists because half of this
 * value moved and half did not. `member-summary-strip.tsx` now decodes
 * `stats.lastStay` — the `_max` of the member's booking `checkOut`, a `@db.Date`
 * lodge night — as the stored day, while {@link formatMemberHistoryPreview}
 * three lines away still projected the SAME value through the file's old
 * `formatMemberDateNz` and `APP_TIME_ZONE`. For any club behind UTC that put the
 * member's last stay on two different days on one screen. #3123 deleted that
 * helper: its last production caller had already moved to
 * `formatPayloadInstantDate`, so migrating it would have shipped a zone-correct
 * function nothing called.
 *
 * It accepts both spellings a `@db.Date` reaches the browser in — Prisma's
 * UTC-midnight ISO instant and a bare `yyyy-MM-dd` — for the reason
 * `admin/_lib/calendar-day.ts` states: a caller should not have to know which
 * one the route happened to build. It degrades rather than throws for the same
 * reason that helper does: these values are fed straight from API payloads into
 * a rendered row.
 *
 * The duplication with `admin/_lib/calendar-day.ts` is deliberate and
 * temporary. That module is admin-scoped and `src/lib` cannot import from
 * `src/app`; group F's `calendarDateOfSerialisedDbDate` (reported on #2870) is
 * the one call site both should collapse onto.
 */
export function formatMemberCalendarDay(value: string, fallback = "—") {
  const bare = parseCalendarDate(value)
  if (bare !== null) return formatClubDate(bare)
  const instant = parseInstant(value)
  return instant === null
    ? fallback
    : formatClubDate(calendarDateOfDateOnlyInstant(instant))
}

export function formatMemberPhone(parts: {
  phoneCountryCode: string | null
  phoneAreaCode: string | null
  phoneNumber: string | null
}) {
  if (!parts.phoneNumber) return null
  return [
    parts.phoneCountryCode ? `+${parts.phoneCountryCode}` : null,
    parts.phoneAreaCode,
    parts.phoneNumber,
  ]
    .filter(Boolean)
    .join(" ")
}

// Collapsed-header preview lines for the member detail groups. Each takes the
// narrow fields it needs (not MemberDetail — _types.ts imports from this file)
// and returns a single "a · b · c" line.
const PREVIEW_SEPARATOR = " · "

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function formatMemberContactPreview(input: {
  email: string
  phoneCountryCode: string | null
  phoneAreaCode: string | null
  phoneNumber: string | null
  streetCity: string | null
}) {
  return [input.email, formatMemberPhone(input), input.streetCity]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberAccountPreview(input: {
  canLogin: boolean
  accessRoleCount: number
  active: boolean
}) {
  return [
    input.canLogin ? "Can log in" : "No login",
    input.canLogin ? pluralize(input.accessRoleCount, "role") : null,
    input.active ? "Active" : "Inactive",
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberFamilyPreview(input: {
  parentCount: number
  dependentCount: number
  familyGroupCount: number
}) {
  const parts = [
    input.parentCount > 0 ? pluralize(input.parentCount, "parent") : null,
    input.dependentCount > 0
      ? pluralize(input.dependentCount, "dependent")
      : null,
    input.familyGroupCount > 0
      ? pluralize(input.familyGroupCount, "family group")
      : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(PREVIEW_SEPARATOR) : "None"
}

export function formatMemberMembershipPreview(input: {
  currentSeasonYear: number
  currentSeasonTypeName: string | null
  currentSeasonSubscriptionLabel: string | null
}) {
  const season = seasonSelectLabel(input.currentSeasonYear)
  return [
    `${season}: ${input.currentSeasonTypeName ?? "No seasonal type set"}`,
    input.currentSeasonSubscriptionLabel,
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberFinancePreview(input: {
  creditBalanceCents: number | null
  promoCodeCount: number
  xeroLinked: boolean
}) {
  return [
    input.creditBalanceCents === null
      ? "Credit —"
      : `Credit $${(input.creditBalanceCents / 100).toFixed(2)}`,
    input.promoCodeCount > 0
      ? pluralize(input.promoCodeCount, "promo code")
      : null,
    input.xeroLinked ? "Xero linked" : "Not linked to Xero",
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberCommitteePreview(input: {
  assignmentCount: number
}) {
  return input.assignmentCount > 0
    ? pluralize(input.assignmentCount, "assignment")
    : "None"
}

export function formatMemberHistoryPreview(input: {
  totalBookings: number
  lastStay: string | null
}) {
  return [
    pluralize(input.totalBookings, "booking"),
    // `lastStay` is a `@db.Date` CALENDAR DAY, not an instant — see
    // `formatMemberCalendarDay`. The summary strip on the same page renders it
    // the same way, so the two can no longer name different days.
    input.lastStay ? `last stay ${formatMemberCalendarDay(input.lastStay)}` : null,
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberLifecyclePreview(input: {
  active: boolean
  cancelledAt: string | null
  archivedAt: string | null
  hasPendingDeleteRequest: boolean
}) {
  const status = input.archivedAt
    ? "Archived"
    : input.cancelledAt
      ? "Cancelled"
      : input.active
        ? "Active"
        : "Inactive"
  return [status, input.hasPendingDeleteRequest ? "delete requested" : null]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}
