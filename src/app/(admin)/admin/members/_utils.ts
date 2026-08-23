import type { Filters, MemberForm } from "./_types";
import { ACCESS_ROLE_LABELS } from "@/lib/access-roles";
import { LOGIN_STAGE_LABELS } from "@/lib/member-login-stage";
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter";
import { defaultMembershipTypeNameForRole } from "@/lib/membership-types";
import {
  NON_MEMBER_ROLE_VALUES,
  ROLE_LABELS,
  type AppRole,
} from "@/lib/member-roles";

export const emptyForm: MemberForm = {
  title: "",
  firstName: "",
  lastName: "",
  gender: "",
  email: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  dateOfBirth: "",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  sendInvite: false,
  forcePasswordChange: false,
  joinedDate: "",
  lifeMemberDate: "",
  occupation: "",
  comments: "",
  canLogin: true,
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: "",
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: "",
};

export const emptyFilters: Filters = {
  role: "",
  financeAccess: "",
  lifecycleStatus: "",
  membershipType: "",
  ageTier: "",
  familyGroup: "",
  inviteStatus: "",
  xeroLinked: "",
  subscription: "",
  xeroContactGroup: "",
  contactability: "",
};

export const filterLabelMap: Record<keyof Filters, string> = {
  role: "Access Role",
  financeAccess: "Finance",
  lifecycleStatus: "Status",
  membershipType: "Membership Type",
  ageTier: "Age Tier",
  familyGroup: "Family Group",
  inviteStatus: "Login Access",
  xeroLinked: "Xero",
  subscription: "Subscription",
  xeroContactGroup: "Xero Group",
  contactability: "Contactable",
};

export const filterValueLabels: Partial<
  Record<keyof Filters, Record<string, string>>
> = {
  contactability: {
    unreachable: "No reachable email",
    "inheritance-unresolved": "Waiting on a parent's email",
    "placeholder-address": "No email on record",
  },
  lifecycleStatus: {
    active: "Active",
    inactive: "Inactive",
    cancelled: "Cancelled",
    archived: "Archived",
    all: "All Including Archived",
  },
  // The `role` filter param carries either an access-role token (from the
  // Access Role select) or a non-login member-type Role (from the Non-Member
  // Category select), so cover both so the active-filter chip renders a
  // friendly label.
  role: {
    ...ACCESS_ROLE_LABELS,
    NON_MEMBER: ROLE_LABELS.NON_MEMBER,
    SCHOOL: ROLE_LABELS.SCHOOL,
  },
  // The `membershipType` param carries a DB MembershipType id (resolved to its
  // name in the toolbar via the membership-type options) or the Unassigned
  // sentinel; only the sentinel has a static friendly label here.
  membershipType: { [UNASSIGNED_MEMBERSHIP_TYPE_VALUE]: "Unassigned" },
  familyGroup: { any: "Yes", none: "No" },
  // The `inviteStatus` param carries the four mutually-exclusive login stages
  // (#1444); the three login-on values stay the historical action kinds.
  inviteStatus: {
    "no-login": LOGIN_STAGE_LABELS["no-login"],
    invite: LOGIN_STAGE_LABELS["not-invited"],
    "resend-invite": LOGIN_STAGE_LABELS.invited,
    "reset-password": LOGIN_STAGE_LABELS["can-login"],
  },
  xeroLinked: { true: "Linked", false: "Not Linked" },
  subscription: {
    PAID: "Paid",
    UNPAID: "Unpaid",
    OVERDUE: "Overdue",
    NOT_INVOICED: "Not Invoiced",
    NONE: "No Record",
    NOT_REQUIRED: "Not Required",
  },
};

/**
 * Format an AgeTier for display (e.g. "ADULT" → "Adult").
 *
 * #1440 follow-up: AgeTier will gain a NOT_APPLICABLE member for organisation /
 * no-DOB records. We map the raw string defensively here — without depending on
 * the not-yet-added enum member — so the combined Type–Tier column renders
 * "N/A" the moment #1440 lands, with no further change to this file.
 */
export function formatAgeTierLabel(ageTier: string): string {
  if (ageTier === "NOT_APPLICABLE") return "N/A";
  return ageTier.charAt(0) + ageTier.slice(1).toLowerCase();
}

/**
 * The type name a non-member category falls back to (#2978), e.g. `NON_MEMBER`
 * -> "Non-Member". Resolved from the SAME role->type mapping the pricing engine
 * uses, so the column cannot drift from what the person is actually charged.
 *
 * `clubMembershipTypes` is the club's OWN rows, which is what decides the word.
 * `MembershipType.name` is editable, so a club that renames its `NON_MEMBER`
 * type to "Visitor" must read "Visitor" here as well as everywhere else; the
 * seed name is only the fallback while the list has not loaded. That resolution
 * lives in `defaultMembershipTypeNameForRole`, shared with the member detail
 * page so the roster and the record cannot disagree.
 */
function fallbackTypeNameForNonMemberRole(
  role: string | null | undefined,
  clubMembershipTypes?: ReadonlyArray<{ key: string; name: string }>,
): string | null {
  if (!role) return null;
  if (!(NON_MEMBER_ROLE_VALUES as readonly string[]).includes(role)) return null;
  return defaultMembershipTypeNameForRole(role as AppRole, clubMembershipTypes);
}

/**
 * Combined "Type – Tier" display column (#1445). The membership type and age
 * tier stay separate data (separate filters); this only combines them for
 * display, e.g. "Full – Adult".
 *
 * #2978: a NON-MEMBER category record now reads its own built-in type -
 * "Non-Member – Adult" - instead of "Unassigned – Adult". A non-member booking
 * contact has no season assignment and never will, so "Unassigned" was not a
 * blank but a WRONG answer: it reads as a member whose type nobody has set yet,
 * i.e. an administrative to-do, on a row that is complete exactly as it stands.
 * The role->default-type fallback already existed and already decided what these
 * people are charged; it simply was not applied to the displayed type.
 *
 * DISPLAY ONLY, and deliberately so. The Membership Type filter's "Unassigned"
 * option still means "no current-season assignment" and still matches these
 * rows - the label changed, the data did not. Every other role keeps reading
 * "Unassigned", because for them it is the truth: a member with no type assigned
 * really is an administrative to-do.
 */
export function formatTypeTierLabel(
  typeName: string | null | undefined,
  ageTier: string,
  role?: string | null,
  clubMembershipTypes?: ReadonlyArray<{ key: string; name: string }>,
): string {
  const resolved =
    typeName ??
    fallbackTypeNameForNonMemberRole(role, clubMembershipTypes) ??
    "Unassigned";
  return `${resolved} – ${formatAgeTierLabel(ageTier)}`;
}

export function getInitialLifecycleStatus(searchParams: URLSearchParams) {
  const lifecycleStatus = searchParams.get("lifecycleStatus");
  if (lifecycleStatus) return lifecycleStatus;
  const active = searchParams.get("active");
  if (active === "true") return "active";
  if (active === "false") return "inactive";
  return "";
}

/**
 * Client mirror of the server create gate (#2089,
 * `getMissingFieldsForXeroContactCreate` in `@/lib/xero-contacts`). Xero's
 * contact-create API needs only a unique name; we additionally require email
 * (Xero uses it for invoice delivery and contact matching). Phone, date of
 * birth, joined date, and both addresses are OPTIONAL. This must stay in
 * lockstep with the server helper's required set — a parity test asserts it.
 */
export function getMissingFieldsForXeroCreate(form: MemberForm): string[] {
  const missing: string[] = [];

  if (!form.firstName.trim()) missing.push("First Name");
  if (!form.lastName.trim()) missing.push("Last Name");
  if (!form.email.trim()) missing.push("Email");

  return missing;
}

/**
 * Blank OPTIONAL profile fields for the D-A2 info note (#2089). Create always
 * works; when any of these are blank we surface a small informational note so
 * the admin knows the Xero contact is being created without them. Date of birth
 * and joined date are never sent to Xero on create (they live on the member
 * record only), but an incomplete profile is still worth flagging here. Labels
 * are lower-case so they read naturally inside the note sentence.
 */
export function getBlankOptionalXeroFields(form: MemberForm): string[] {
  const blank: string[] = [];

  if (
    !form.phoneCountryCode.trim() ||
    !form.phoneAreaCode.trim() ||
    !form.phoneNumber.trim()
  ) {
    blank.push("phone");
  }
  if (!form.dateOfBirth) blank.push("date of birth");
  if (!form.joinedDate) blank.push("joined date");
  if (
    !form.streetAddressLine1.trim() ||
    !form.streetCity.trim() ||
    !form.streetRegion.trim() ||
    !form.streetPostalCode.trim() ||
    !form.streetCountry.trim()
  ) {
    blank.push("physical address");
  }
  if (
    !form.postalAddressLine1.trim() ||
    !form.postalCity.trim() ||
    !form.postalRegion.trim() ||
    !form.postalPostalCode.trim() ||
    !form.postalCountry.trim()
  ) {
    blank.push("postal address");
  }

  return blank;
}
