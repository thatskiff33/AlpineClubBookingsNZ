import type { FinanceAccessLevel, Gender, Title } from "@prisma/client"
import type { MembershipTypeAgeExemption } from "@/lib/membership-types"
import { legacyRoleFromAccessRoles } from "@/lib/access-roles"
import { financeAccessLevelFromMatrix } from "@/lib/admin-permissions"
import {
  previewMatrixForTokens,
  type AccessRoleOption,
} from "@/lib/access-role-definitions"
import { memberUsesSamePostalAddress } from "@/lib/admin-member-detail-helpers"
import {
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address"
import type { AppRole } from "@/lib/member-roles"
import { formatDateOnly } from "@/lib/date-only";

// Per-group edit forms for the admin member detail page. Each group unlocks
// and saves independently; its payload builder emits ONLY that group's fields
// so a Contact save can never touch access/auth fields and vice versa (the
// PUT /api/admin/members/[id] schema is fully partial).
//
// `lifeMemberDate` is intentionally absent: the old whole-form dialog carried
// it silently with no input. The column and API schema remain; the admin UI
// simply no longer round-trips it.

export interface MemberContactEditForm extends MemberAddressValues {
  title: Title | ""
  firstName: string
  lastName: string
  gender: Gender | ""
  email: string
  phoneCountryCode: string
  phoneAreaCode: string
  phoneNumber: string
  dateOfBirth: string
  joinedDate: string
  occupation: string
  /**
   * #2941: present only when the detail response carried the key — i.e. the
   * admin holds a membership dietary grant and the club has the field ON. Absent
   * means the Contact save sends nothing and the stored value is untouched.
   */
  dietaryRequirements?: string
  comments: string
  ageTier: string
  postalSameAsPhysical: boolean
}

export interface MemberAccountEditForm {
  canLogin: boolean
  active: boolean
  forcePasswordChange: boolean
  requiresInduction: boolean
  inheritEmailFromId: string | null
  // Role tokens: enum values or AccessRoleDefinition ids.
  accessRoles: string[]
  role: AppRole
  financeAccessLevel: FinanceAccessLevel
}

interface MemberContactSource {
  title: Title | null
  firstName: string
  lastName: string
  gender: Gender | null
  email: string
  phoneCountryCode: string | null
  phoneAreaCode: string | null
  phoneNumber: string | null
  dateOfBirth: string | null
  joinedDate: string | null
  occupation: string | null
  dietaryRequirements?: string | null
  comments: string | null
  ageTier: string
  streetAddressLine1: string | null
  streetAddressLine2: string | null
  streetCity: string | null
  streetRegion: string | null
  streetPostalCode: string | null
  streetCountry: string | null
  postalAddressLine1: string | null
  postalAddressLine2: string | null
  postalCity: string | null
  postalRegion: string | null
  postalPostalCode: string | null
  postalCountry: string | null
}

interface MemberAccountSource {
  canLogin: boolean
  active: boolean
  forcePasswordChange: boolean
  requiresInduction: boolean
  inheritEmailFromId: string | null
  accessRoles: string[]
  role: AppRole
  financeAccessLevel: FinanceAccessLevel
}

function toDateInputValue(value: string | null) {
  return value ? formatDateOnly(new Date(value)) : ""
}

export function buildContactEditForm(
  member: MemberContactSource
): MemberContactEditForm {
  return {
    title: member.title ?? "",
    firstName: member.firstName,
    lastName: member.lastName,
    gender: member.gender ?? "",
    email: member.email,
    phoneCountryCode: member.phoneCountryCode || "",
    phoneAreaCode: member.phoneAreaCode || "",
    phoneNumber: member.phoneNumber || "",
    dateOfBirth: toDateInputValue(member.dateOfBirth),
    joinedDate: toDateInputValue(member.joinedDate),
    occupation: member.occupation ?? "",
    ...("dietaryRequirements" in member
      ? { dietaryRequirements: member.dietaryRequirements ?? "" }
      : {}),
    comments: member.comments || "",
    ageTier: member.ageTier,
    streetAddressLine1: member.streetAddressLine1 || "",
    streetAddressLine2: member.streetAddressLine2 || "",
    streetCity: member.streetCity || "",
    streetRegion: member.streetRegion || "",
    streetPostalCode: member.streetPostalCode || "",
    streetCountry: withDefaultNzCountry(member.streetCountry),
    postalAddressLine1: member.postalAddressLine1 || "",
    postalAddressLine2: member.postalAddressLine2 || "",
    postalCity: member.postalCity || "",
    postalRegion: member.postalRegion || "",
    postalPostalCode: member.postalPostalCode || "",
    postalCountry: withDefaultNzCountry(member.postalCountry),
    postalSameAsPhysical: memberUsesSamePostalAddress(member),
  }
}

export function buildAccountEditForm(
  member: MemberAccountSource
): MemberAccountEditForm {
  return {
    canLogin: member.canLogin,
    active: member.active,
    forcePasswordChange: member.forcePasswordChange,
    requiresInduction: member.requiresInduction,
    inheritEmailFromId: member.inheritEmailFromId,
    accessRoles: member.accessRoles,
    role: member.role,
    financeAccessLevel: member.financeAccessLevel,
  }
}

export function buildContactPayload(
  form: MemberContactEditForm,
  options?: { ageExemption?: MembershipTypeAgeExemption | null }
) {
  return {
    title: form.title || null,
    firstName: form.firstName,
    lastName: form.lastName,
    gender: form.gender || null,
    email: form.email,
    phoneCountryCode: form.phoneCountryCode || null,
    phoneAreaCode: form.phoneAreaCode || null,
    phoneNumber: form.phoneNumber || null,
    dateOfBirth: form.dateOfBirth || null,
    joinedDate: form.joinedDate || null,
    occupation: form.occupation || null,
    ...(form.dietaryRequirements !== undefined
      ? { dietaryRequirements: form.dietaryRequirements || null }
      : {}),
    comments: form.comments || null,
    // Age tier: a real person tier is always sent. NOT_APPLICABLE is normally
    // server-managed (#1440) — organisations get it forced, and a member
    // reclassified away from Organisation needs the server to restore a
    // DOB-derived tier — so it is omitted by default. The ONE case we submit
    // N/A is an ALLOWED-type manual pick (#2106): the type offers N/A alongside
    // person tiers, so an admin's hand-picked N/A must reach the server. This
    // is always an edit context (no create), so there is no create-mode guard.
    ...(form.ageTier === "NOT_APPLICABLE"
      ? options?.ageExemption === "ALLOWED"
        ? { ageTier: "NOT_APPLICABLE" }
        : {}
      : { ageTier: form.ageTier }),
    streetAddressLine1: form.streetAddressLine1 || null,
    streetAddressLine2: form.streetAddressLine2 || null,
    streetCity: form.streetCity || null,
    streetRegion: form.streetRegion || null,
    streetPostalCode: form.streetPostalCode || null,
    streetCountry: form.streetCountry || null,
    postalAddressLine1: form.postalAddressLine1 || null,
    postalAddressLine2: form.postalAddressLine2 || null,
    postalCity: form.postalCity || null,
    postalRegion: form.postalRegion || null,
    postalPostalCode: form.postalPostalCode || null,
    postalCountry: form.postalCountry || null,
    postalSameAsPhysical: form.postalSameAsPhysical,
  }
}

export function buildAccountPayload(form: MemberAccountEditForm) {
  return {
    canLogin: form.canLogin,
    active: form.active,
    forcePasswordChange: form.forcePasswordChange,
    requiresInduction: form.requiresInduction,
    inheritEmailFromId: form.inheritEmailFromId || null,
    accessRoles: form.accessRoles,
    role: form.role,
    financeAccessLevel: form.financeAccessLevel,
  }
}

// Moved verbatim from the retired member-edit-dialog so role toggles keep the
// same derived legacy role + finance level semantics.
export function buildAccessRolePatch(
  accessRoles: string[],
  roleOptions: readonly AccessRoleOption[]
) {
  return {
    accessRoles,
    role: legacyRoleFromAccessRoles(accessRoles),
    // Matrix-derived so definition-backed (custom or edited) roles are
    // reflected; keeps unchanged echo submissions no-ops server-side.
    financeAccessLevel: financeAccessLevelFromMatrix(
      previewMatrixForTokens(accessRoles, roleOptions)
    ),
  }
}
