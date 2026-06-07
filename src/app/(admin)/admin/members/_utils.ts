import type { Filters, MemberForm } from "./_types"

export const emptyForm: MemberForm = {
  firstName: "",
  lastName: "",
  email: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  dateOfBirth: "",
  role: "MEMBER",
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  sendInvite: false,
  forcePasswordChange: false,
  joinedDate: "",
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
}

export const emptyFilters: Filters = {
  role: "",
  financeAccess: "",
  lifecycleStatus: "",
  ageTier: "",
  familyGroup: "",
  inviteStatus: "",
  xeroLinked: "",
  subscription: "",
  xeroContactGroup: "",
}

export const filterLabelMap: Record<keyof Filters, string> = {
  role: "Role",
  financeAccess: "Finance",
  lifecycleStatus: "Status",
  ageTier: "Age Tier",
  familyGroup: "Family Group",
  inviteStatus: "Invite Status",
  xeroLinked: "Xero",
  subscription: "Subscription",
  xeroContactGroup: "Xero Group",
}

export const filterValueLabels: Partial<Record<keyof Filters, Record<string, string>>> = {
  lifecycleStatus: {
    active: "Active",
    inactive: "Inactive",
    cancelled: "Cancelled",
    archived: "Archived",
    all: "All Including Archived",
  },
  familyGroup: { any: "Yes", none: "No" },
  inviteStatus: {
    invite: "Invite",
    "resend-invite": "Resend Invite",
    "reset-password": "Reset Password",
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
}

export const subscriptionStatusConfig: Record<string, { className: string; label: string }> = {
  PAID: {
    className: "bg-green-100 text-green-800 border-green-200 hover:bg-green-200",
    label: "Paid",
  },
  UNPAID: {
    className: "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200",
    label: "Unpaid",
  },
  OVERDUE: {
    className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-200",
    label: "Overdue",
  },
  NOT_INVOICED: {
    className: "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200",
    label: "Not Invoiced",
  },
  NONE: {
    className: "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100",
    label: "No Record",
  },
  NOT_REQUIRED: {
    className: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",
    label: "Not Required",
  },
}

export function getInitialLifecycleStatus(searchParams: URLSearchParams) {
  const lifecycleStatus = searchParams.get("lifecycleStatus")
  if (lifecycleStatus) return lifecycleStatus
  const active = searchParams.get("active")
  if (active === "true") return "active"
  if (active === "false") return "inactive"
  return ""
}

export function getMissingFieldsForXeroCreate(form: MemberForm): string[] {
  const missing: string[] = []

  if (!form.firstName.trim()) missing.push("First Name")
  if (!form.lastName.trim()) missing.push("Last Name")
  if (!form.email.trim()) missing.push("Email")
  if (!form.phoneCountryCode.trim() || !form.phoneAreaCode.trim() || !form.phoneNumber.trim()) {
    missing.push("Phone")
  }
  if (!form.dateOfBirth) missing.push("Date of Birth")
  if (!form.joinedDate) missing.push("Joined Date")
  if (
    !form.streetAddressLine1.trim() ||
    !form.streetCity.trim() ||
    !form.streetRegion.trim() ||
    !form.streetPostalCode.trim() ||
    !form.streetCountry.trim()
  ) {
    missing.push("Physical Address")
  }
  if (
    !form.postalAddressLine1.trim() ||
    !form.postalCity.trim() ||
    !form.postalRegion.trim() ||
    !form.postalPostalCode.trim() ||
    !form.postalCountry.trim()
  ) {
    missing.push("Postal Address")
  }

  return missing
}
