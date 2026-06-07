import {
  postalMatchesPhysical,
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address"

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

export interface XeroCreateFormFields {
  firstName: string
  lastName: string
  email: string
  phoneCountryCode: string
  phoneAreaCode: string
  phoneNumber: string
  dateOfBirth: string
  joinedDate: string
  streetAddressLine1: string
  streetCity: string
  streetRegion: string
  streetPostalCode: string
  streetCountry: string
  postalAddressLine1: string
  postalCity: string
  postalRegion: string
  postalPostalCode: string
  postalCountry: string
}

export const collapsibleMemberSections = [
  "subs",
  "bookings",
  "xero",
  "audit",
] as const
export type CollapsibleMemberSection =
  (typeof collapsibleMemberSections)[number]

export const memberSectionStorageKeys: Record<
  CollapsibleMemberSection,
  string
> = {
  subs: "admin-member-section:subs",
  bookings: "admin-member-section:bookings",
  xero: "admin-member-section:xero",
  audit: "admin-member-section:audit",
}

export function isCollapsibleMemberSection(
  value: string
): value is CollapsibleMemberSection {
  return collapsibleMemberSections.includes(value as CollapsibleMemberSection)
}

export function getMemberDetailBackLabel(returnTo: string) {
  if (returnTo.startsWith("/admin/bookings")) return "Back to Bookings"
  if (returnTo.startsWith("/admin/payments")) return "Back to Payments"
  if (returnTo.startsWith("/admin/subscriptions"))
    return "Back to Subscriptions"
  if (returnTo.startsWith("/admin/refund-requests"))
    return "Back to Refund Requests"
  if (returnTo.startsWith("/admin/xero")) return "Back to Xero"
  return "Back to Members"
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
  const postalHasValues = [
    member.postalAddressLine1,
    member.postalAddressLine2,
    member.postalCity,
    member.postalRegion,
    member.postalPostalCode,
    member.postalCountry,
  ].some((value) => value?.trim())

  if (!postalHasValues) {
    return Boolean(
      member.streetAddressLine1?.trim() ||
        member.streetCity?.trim() ||
        member.streetPostalCode?.trim()
    )
  }

  return postalMatchesPhysical({
    streetAddressLine1: member.streetAddressLine1,
    streetAddressLine2: member.streetAddressLine2,
    streetCity: member.streetCity,
    streetRegion: member.streetRegion,
    streetPostalCode: member.streetPostalCode,
    streetCountry: withDefaultNzCountry(member.streetCountry),
    postalAddressLine1: member.postalAddressLine1,
    postalAddressLine2: member.postalAddressLine2,
    postalCity: member.postalCity,
    postalRegion: member.postalRegion,
    postalPostalCode: member.postalPostalCode,
    postalCountry: withDefaultNzCountry(member.postalCountry),
  })
}

export function getMissingFieldsForXeroCreate(
  form: XeroCreateFormFields
): string[] {
  const missing: string[] = []

  if (!form.firstName.trim()) missing.push("First Name")
  if (!form.lastName.trim()) missing.push("Last Name")
  if (!form.email.trim()) missing.push("Email")
  if (
    !form.phoneCountryCode.trim() ||
    !form.phoneAreaCode.trim() ||
    !form.phoneNumber.trim()
  )
    missing.push("Phone")
  if (!form.dateOfBirth) missing.push("Date of Birth")
  if (!form.joinedDate) missing.push("Joined Date")
  if (
    !form.streetAddressLine1.trim() ||
    !form.streetCity.trim() ||
    !form.streetRegion.trim() ||
    !form.streetPostalCode.trim() ||
    !form.streetCountry.trim()
  )
    missing.push("Physical Address")
  if (
    !form.postalAddressLine1.trim() ||
    !form.postalCity.trim() ||
    !form.postalRegion.trim() ||
    !form.postalPostalCode.trim() ||
    !form.postalCountry.trim()
  )
    missing.push("Postal Address")

  return missing
}

export function formatMemberDateNz(value: string) {
  return new Date(value).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}
