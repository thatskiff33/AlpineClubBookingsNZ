"use client"

import {
  AdminFilterBar,
  type AdminFilterChip,
} from "@/components/admin/admin-filter-bar"
import { DatasetResetButton } from "@/components/admin/dataset-reset-button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAccessRoleOptions } from "@/hooks/use-access-role-options"
import type { MembershipTypeOption } from "@/hooks/use-membership-type-options"
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter"
import { NON_MEMBER_ROLE_VALUES, ROLE_LABELS } from "@/lib/member-roles"
import {
  LOGIN_STAGE_FILTER_VALUES,
  LOGIN_STAGE_LABELS,
  type MemberLoginStage,
} from "@/lib/member-login-stage"
import {
  MEMBER_AGE_TIER_FILTER_LABELS,
  MEMBER_AGE_TIER_FILTER_VALUES,
} from "../_age-tier-filter-values"
import type { Filters, XeroContactGroup, XeroFeatureFlags } from "../_types"
import { filterLabelMap, filterValueLabels } from "../_utils"

interface MemberFilterToolbarProps {
  search: string
  filters: Filters
  xeroFeatures: XeroFeatureFlags
  xeroContactGroupsList: XeroContactGroup[]
  /**
   * The club's membership types, ALL of them. Passed in rather than fetched here
   * (#2978): the table needs the same list to name a non-member category's
   * fallback type, and two components each calling `useMembershipTypeOptions`
   * would fetch the same endpoint twice on one page load.
   */
  membershipTypes?: MembershipTypeOption[]
  onSearchChange: (value: string) => void
  onSetFilter: (key: keyof Filters, value: string) => void
  resetDisabled: boolean
  onReset: () => void
}

export function MemberFilterToolbar({
  search,
  filters,
  xeroFeatures,
  xeroContactGroupsList,
  membershipTypes,
  onSearchChange,
  onSetFilter,
  resetDisabled,
  onReset,
}: MemberFilterToolbarProps) {
  const roleOptions = useAccessRoleOptions()
  // Only the ACTIVE types are offered as filter values, exactly as before the
  // hook widened to return every type.
  const membershipTypeOptions = (membershipTypes ?? []).filter(
    (type) => type.isActive,
  )
  // The `role` filter param is shared by the Access Role and Non-Member
  // Category selects (backend reads a single `role` param); the two categories
  // are mutually exclusive, so each select shows its neutral "All" state when
  // the active value belongs to the other dimension. The separate Membership
  // Type select below writes its own `membershipType` param (DB membership
  // types) so Role and MembershipType are no longer conflated (#1445).
  const roleFilterIsNonMemberCategory = (
    NON_MEMBER_ROLE_VALUES as readonly string[]
  ).includes(filters.role)
  const getFilterDisplayValue = (key: string, value: string) => {
    if (key === "xeroContactGroup") {
      return (
        xeroContactGroupsList.find((group) => group.id === value)?.name ?? value
      )
    }
    if (key === "membershipType") {
      if (value === UNASSIGNED_MEMBERSHIP_TYPE_VALUE) return "Unassigned"
      return (
        membershipTypeOptions.find((type) => type.id === value)?.name ?? value
      )
    }
    return filterValueLabels[key as keyof Filters]?.[value] ?? value
  }

  // Count of active filters that live under "More filters" (Access Role,
  // Membership Type and Status stay in the always-visible primary row). The
  // shared `role` param counts as advanced only when it holds a Non-Member
  // Category value (that control lives under the disclosure; the Access Role
  // select is primary). Presentation only — the params are unchanged.
  const advancedActiveCount =
    (roleFilterIsNonMemberCategory ? 1 : 0) +
    (filters.ageTier ? 1 : 0) +
    (filters.familyGroup ? 1 : 0) +
    (filters.inviteStatus ? 1 : 0) +
    (filters.xeroLinked ? 1 : 0) +
    (filters.subscription ? 1 : 0) +
    (filters.xeroContactGroup ? 1 : 0) +
    (filters.contactability ? 1 : 0)

  // Active-filter chips — one per set filter param, in the interface's field
  // order, exactly as before. Each × calls onSetFilter(key, "") to clear just
  // that filter (unchanged behaviour).
  const chips: AdminFilterChip[] = Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key, value]) => ({
      key,
      label: filterLabelMap[key as keyof Filters],
      value: getFilterDisplayValue(key, value),
      onRemove: () => onSetFilter(key as keyof Filters, ""),
    }))

  return (
    <AdminFilterBar
      idPrefix="members-filters"
      advancedActiveCount={advancedActiveCount}
      chips={chips}
      search={
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by name or email..."
        />
      }
      primary={
        <>
          <Select
            value={roleFilterIsNonMemberCategory ? "all" : filters.role || "all"}
            onValueChange={(value) => onSetFilter("role", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[160px]" aria-label="Filter by access role">
              <SelectValue placeholder="Access Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Access Roles</SelectItem>
              {roleOptions.map((option) => (
                <SelectItem key={option.token} value={option.token}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.membershipType || "all"}
            onValueChange={(value) =>
              onSetFilter("membershipType", value === "all" ? "" : value)
            }
          >
            <SelectTrigger className="w-[175px]" aria-label="Filter by membership type">
              <SelectValue placeholder="Membership Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Membership Types</SelectItem>
              <SelectItem value={UNASSIGNED_MEMBERSHIP_TYPE_VALUE}>
                Unassigned
              </SelectItem>
              {/*
                #2978 (owner decision, 21 Aug 2026): COPY ONLY — nothing about
                what these options match has changed, and acceptance criterion 1
                forbids changing it. The Type – Tier column now reads
                "Non-Member – Adult" for a non-member booking contact, so an
                officer reasonably picks the Non-Member type below and gets
                nothing: those rows carry no season assignment, which is what
                Unassigned means and always meant. Say so where they are looking.

                A `SelectLabel`, not an item: Radix renders it as a plain node
                inside the listbox, so it is announced as text and can never be
                chosen as a value.

                IT MUST BE WRAPPED IN A `SelectGroup`, and the wrapper is not
                cosmetic. Radix's `SelectLabel` reads the group context and
                THROWS without it - and it throws on page load, not on open,
                because a CLOSED `SelectContent` still portals its children into
                a detached DocumentFragment to collect them. Unwrapped, this
                crashed the whole members page to the error boundary; the unit
                suites could not see it because they mock this select module.
              */}
              <SelectGroup>
                <SelectLabel className="max-w-[240px] whitespace-normal text-xs font-normal text-muted-foreground">
                  Non-member contacts have no membership type — they are listed
                  under Unassigned.
                </SelectLabel>
              </SelectGroup>
              {membershipTypeOptions.map((type) => (
                <SelectItem key={type.id} value={type.id}>
                  {type.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.lifecycleStatus || "nonArchived"}
            onValueChange={(value) =>
              onSetFilter("lifecycleStatus", value === "nonArchived" ? "" : value)
            }
          >
            <SelectTrigger className="w-[155px]" aria-label="Filter by member status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="nonArchived">All Non-Archived</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="all">All Including Archived</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
      actions={
        <DatasetResetButton disabled={resetDisabled} onReset={onReset} />
      }
      advanced={
        <>
          <Select
            value={roleFilterIsNonMemberCategory ? filters.role : "all"}
            onValueChange={(value) => onSetFilter("role", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[175px]" aria-label="Filter by non-member category">
              <SelectValue placeholder="Non-Member Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Non-Member Categories</SelectItem>
              {NON_MEMBER_ROLE_VALUES.map((role) => (
                <SelectItem key={role} value={role}>
                  {ROLE_LABELS[role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.ageTier || "all"}
            onValueChange={(value) => onSetFilter("ageTier", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[130px]" aria-label="Filter by age tier">
              <SelectValue placeholder="Age Tier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tiers</SelectItem>
              {/* One vocabulary, shared with the page's AI Diagnostics
                  publication and pinned to the Prisma enum by a test (#2816). */}
              {MEMBER_AGE_TIER_FILTER_VALUES.map((tier) => (
                <SelectItem key={tier} value={tier}>
                  {MEMBER_AGE_TIER_FILTER_LABELS[tier]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.familyGroup || "all"}
            onValueChange={(value) => onSetFilter("familyGroup", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[150px]" aria-label="Filter by family group">
              <SelectValue placeholder="Family Group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Family Groups</SelectItem>
              <SelectItem value="any">Family Group: Yes</SelectItem>
              <SelectItem value="none">Family Group: No</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.inviteStatus || "all"}
            onValueChange={(value) => onSetFilter("inviteStatus", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[165px]" aria-label="Filter by login access">
              <SelectValue placeholder="Login Access" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Login Access</SelectItem>
              {(Object.keys(LOGIN_STAGE_LABELS) as MemberLoginStage[]).map((stage) => (
                <SelectItem key={stage} value={LOGIN_STAGE_FILTER_VALUES[stage]}>
                  {LOGIN_STAGE_LABELS[stage]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.xeroLinked || "all"}
            onValueChange={(value) => onSetFilter("xeroLinked", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[130px]" aria-label="Filter by Xero link">
              <SelectValue placeholder="Xero" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Xero</SelectItem>
              <SelectItem value="true">Linked</SelectItem>
              <SelectItem value="false">Not Linked</SelectItem>
            </SelectContent>
          </Select>
          {/*
            #2716: the accepted cost of direct-parent-only email inheritance,
            findable. Where a middle generation has no address the descendant
            inherits nobody, and a gap is only the right failure direction while
            an admin can see it. The stuck-states dashboard links straight to
            `?contactability=unreachable`, so these option values are a contract
            with that screen rather than local naming.
          */}
          <Select
            value={filters.contactability || "all"}
            onValueChange={(value) => onSetFilter("contactability", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[200px]" aria-label="Filter by contactability">
              <SelectValue placeholder="Contactable" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Contactable</SelectItem>
              <SelectItem value="unreachable">No reachable email</SelectItem>
              <SelectItem value="inheritance-unresolved">
                Waiting on a parent&apos;s email
              </SelectItem>
              <SelectItem value="placeholder-address">No email on record</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.subscription || "all"}
            onValueChange={(value) => onSetFilter("subscription", value === "all" ? "" : value)}
          >
            <SelectTrigger className="w-[170px]" aria-label="Filter by subscription">
              <SelectValue placeholder="Subscription" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Subs</SelectItem>
              <SelectItem value="PAID">Paid</SelectItem>
              <SelectItem value="UNPAID">Unpaid</SelectItem>
              <SelectItem value="OVERDUE">Overdue</SelectItem>
              <SelectItem value="NOT_INVOICED">Not Invoiced</SelectItem>
              <SelectItem value="NONE">No Record</SelectItem>
              <SelectItem value="NOT_REQUIRED">Not Required</SelectItem>
            </SelectContent>
          </Select>
          {xeroFeatures.liveMemberGroupLookups && xeroContactGroupsList.length > 0 && (
            <Select
              value={filters.xeroContactGroup || "all"}
              onValueChange={(value) =>
                onSetFilter("xeroContactGroup", value === "all" ? "" : value)
              }
            >
              <SelectTrigger className="w-[170px]" aria-label="Filter by Xero contact group">
                <SelectValue placeholder="Xero Group" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Xero Groups</SelectItem>
                {xeroContactGroupsList.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name} ({group.contactCount})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      }
    />
  )
}
