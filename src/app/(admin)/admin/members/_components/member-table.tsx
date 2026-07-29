"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { ExternalLink, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Spinner } from "@/components/ui/spinner"
import { StatusChip } from "@/components/ui/status-chip"
import { AdminDataTable } from "@/components/admin/admin-data-table"
import { SortHeader } from "@/components/admin/sort-header"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  MemberPasswordActionButton,
} from "@/components/admin/member-password-action-button"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { getLifecycleStatusConfig } from "@/lib/admin-member-badges"
import {
  getMemberLoginStage,
  LOGIN_STAGE_LABELS,
} from "@/lib/member-login-stage"
import { deriveUserType, USER_TYPE_LABELS } from "@/lib/access-roles"
import { CHIP_TONE_CLASSES, type ChipTone } from "@/lib/chip-tones"
import { memberName } from "@/lib/member-serialization"
import { buildXeroContactUrl, buildXeroInvoiceUrl } from "@/lib/xero-links"
import type { SubscriptionStatus } from "@prisma/client"
import type { Member } from "../_types"
import { formatTypeTierLabel } from "../_utils"

interface MemberTableProps {
  members: Member[]
  loading: boolean
  debouncedSearch: string
  selectedIds: Set<string>
  // Tri-state (#2065): `undefined` while the session resolves; the affordance
  // columns falsy-hide (accepted neutral) rather than flash enabled.
  canEdit: boolean | undefined
  /**
   * Organisation short code for the Xero invoice/contact deep links, or null
   * when unavailable — the links then degrade to the generic session-scoped
   * Xero URL, they are never hidden (#2283).
   */
  xeroOrgShortCode: string | null
  sortBy: string
  sortDir: "asc" | "desc"
  membersListPath: string
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  onToggleSort: (column: string) => void
  onOpenPasswordActionDialog: (ids: string[], label: string) => void
  onEditMember: (member: Member) => void
}

// Selection checkboxes are native inputs (kept for their stable aria-label
// associations that the members tests target); themed via accent + focus ring.
const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"

// The shell that loading / empty / populated states all sit on, so the list
// keeps one themed, dark-mode-correct surface regardless of state.
const SURFACE_CLASS = "rounded-lg border border-border bg-card"

/** A themed, non-domain chip for the Access, Family Group and Xero columns. The
 *  StatusChip `kind` API only covers booking/payment/subscription/lifecycle/
 *  financeAccess, so these signals (login-journey stage, family membership, Xero
 *  linkage/groups) render here through the shared `@/lib/chip-tones` map — the
 *  single source shared with StatusChip and MiniChip — rather than inventing a
 *  new kind or a private tone family. */
function InfoChip({
  tone = "neutral",
  className,
  children,
}: {
  tone?: ChipTone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP_TONE_CLASSES[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  )
}

export function MemberTable({
  members,
  loading,
  debouncedSearch,
  selectedIds,
  canEdit,
  xeroOrgShortCode,
  sortBy,
  sortDir,
  membersListPath,
  onToggleSelect,
  onToggleSelectAll,
  onToggleSort,
  onOpenPasswordActionDialog,
  onEditMember,
}: MemberTableProps) {
  if (loading) {
    return (
      <div className={`flex justify-center py-12 ${SURFACE_CLASS}`}>
        <Spinner label="Loading members…" />
      </div>
    )
  }

  if (members.length === 0) {
    return (
      <div className={SURFACE_CLASS}>
        <EmptyState
          icon={Users}
          title={
            debouncedSearch
              ? `No members match "${debouncedSearch}"`
              : "No members yet"
          }
          description={
            debouncedSearch
              ? "Try a different name or email, or clear the search to see everyone."
              : "Members you add will appear here."
          }
        />
      </div>
    )
  }

  return (
    <AdminDataTable aria-label="Members">
      <TableHeader>
        <TableRow>
          {canEdit ? (
            <TableHead className="w-10">
              <span className="sr-only">Select</span>
              <input
                type="checkbox"
                aria-label="Select all members on this page"
                checked={selectedIds.size === members.length && members.length > 0}
                onChange={onToggleSelectAll}
                className={CHECKBOX_CLASS}
              />
            </TableHead>
          ) : null}
          {[
            ["name", "Name"],
            ["email", "Email"],
            // Access shows the member's derived type plus their single login
            // stage. The login stage is derived (no sortable DB column), so
            // this header sorts by the stored `role` — an approximation of
            // type order — rather than the rendered stage.
            ["role", "Access"],
          ].map(([column, label]) => (
            <SortHeader
              key={column}
              active={sortBy === column}
              direction={sortDir}
              onSort={() => onToggleSort(column)}
            >
              {label}
            </SortHeader>
          ))}
          {/*
            Combined "Type – Tier" column (#1445): the current-season
            membership type followed by the age tier (e.g. "Full – Adult").
            The column leads with Type, but sorts by `ageTier` — the type
            comes from a filtered to-many relation (the current-season
            SeasonalMembershipAssignment) that Prisma cannot cleanly orderBy,
            whereas ageTier is a real, whitelisted sortable Member column. The
            separate Membership Type and Age Tier filters remain distinct.
          */}
          <SortHeader
            active={sortBy === "ageTier"}
            direction={sortDir}
            onSort={() => onToggleSort("ageTier")}
          >
            Type – Tier
          </SortHeader>
          <SortHeader
            active={sortBy === "active"}
            direction={sortDir}
            onSort={() => onToggleSort("active")}
          >
            Status
          </SortHeader>
          <TableHead>Family Group</TableHead>
          <TableHead>Subscription</TableHead>
          <TableHead>Xero</TableHead>
          <SortHeader
            active={sortBy === "createdAt"}
            direction={sortDir}
            onSort={() => onToggleSort("createdAt")}
          >
            Joined
          </SortHeader>
          {canEdit ? <TableHead className="text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const lifecycleConfig = getLifecycleStatusConfig(member)
          // One Access column (#1444): the member's derived type plus their
          // single login-journey stage. The no-login case renders just "No
          // login" (no type prefix); every login-on stage renders
          // "{Type} · {Stage}", e.g. "Admin · Invited".
          const loginStage = getMemberLoginStage(member)
          const userType = deriveUserType(member.accessRoles, member.canLogin)
          const accessTypeLabel =
            userType === "lodge" ? "Lodge" : USER_TYPE_LABELS[userType]
          const accessLabel =
            loginStage === "no-login"
              ? LOGIN_STAGE_LABELS["no-login"]
              : `${accessTypeLabel} · ${LOGIN_STAGE_LABELS[loginStage]}`
          // Subscription chip (#1811): reuse the shared StatusChip subscription
          // tones/labels. A member with no subscription record (null) keeps its
          // historical "No Record" label rendered on the neutral fallback tone.
          const subscriptionStatus = member.subscriptionStatus ?? "NONE"
          const subscriptionChip = (
            <StatusChip
              kind="subscription"
              value={subscriptionStatus as SubscriptionStatus}
              label={member.subscriptionStatus ? undefined : "No Record"}
            />
          )
          const name = memberName(member)

          return (
            <TableRow key={member.id}>
              {canEdit ? (
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`Select ${name}`}
                    checked={selectedIds.has(member.id)}
                    onChange={() => onToggleSelect(member.id)}
                    className={CHECKBOX_CLASS}
                  />
                </TableCell>
              ) : null}
              <TableCell className="font-medium">
                <Link
                  href={buildHrefWithReturnTo(`/admin/members/${member.id}`, membersListPath)}
                  className="text-primary hover:underline"
                >
                  {name}
                </Link>
                {member.forcePasswordChange && (
                  <Badge variant="destructive" className="ml-2 text-xs">
                    PW Reset
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{member.email}</TableCell>
              <TableCell>
                {/* Admin access reads blue (info) to stand out from the neutral
                    non-admin types, restoring the pre-theme-rework affordance
                    (#156). */}
                <InfoChip tone={userType === "admin" ? "info" : "neutral"}>
                  {accessLabel}
                </InfoChip>
              </TableCell>
              <TableCell>
                {/* Display-only combination; data stays separate (#1445). */}
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {formatTypeTierLabel(
                    member.currentMembershipType?.name,
                    member.ageTier,
                  )}
                </span>
              </TableCell>
              <TableCell>
                <StatusChip kind="lifecycle" value={lifecycleConfig.label} />
              </TableCell>
              <TableCell>
                {member.familyGroups && member.familyGroups.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {member.familyGroups.map((familyGroup) =>
                      canEdit ? (
                        <Link
                          key={familyGroup.id}
                          href={`/admin/family-groups?edit=${familyGroup.id}`}
                        >
                          <InfoChip tone="cat1" className="cursor-pointer">
                            {familyGroup.name || "Unnamed Group"}
                          </InfoChip>
                        </Link>
                      ) : (
                        <InfoChip key={familyGroup.id} tone="cat1">
                          {familyGroup.name || "Unnamed Group"}
                        </InfoChip>
                      )
                    )}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell>
                {member.subscriptionXeroInvoiceId ? (
                  <a
                    href={buildXeroInvoiceUrl(member.subscriptionXeroInvoiceId, {
                      shortCode: xeroOrgShortCode,
                    })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1"
                  >
                    {subscriptionChip}
                    <ExternalLink aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
                  </a>
                ) : (
                  subscriptionChip
                )}
              </TableCell>
              <TableCell>
                <div className="space-y-1">
                  {member.xeroContactId ? (
                    <a
                      href={buildXeroContactUrl(member.xeroContactId, {
                        shortCode: xeroOrgShortCode,
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <InfoChip tone="info" className="cursor-pointer">
                        Linked
                        <ExternalLink aria-hidden="true" className="h-3 w-3" />
                      </InfoChip>
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                  {member.xeroContactGroups.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {member.xeroContactGroups.map((group) => (
                        <InfoChip key={group.id} tone="cat5">
                          {group.name}
                        </InfoChip>
                      ))}
                    </div>
                  )}
                  {member.xeroContactId && !member.xeroContactGroupsLoaded && (
                    <p className="text-xs text-muted-foreground">Cached groups not refreshed yet</p>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {new Date(member.joinedDate || member.createdAt).toLocaleDateString("en-NZ", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </TableCell>
              {canEdit ? (
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <MemberPasswordActionButton
                      member={member}
                      onClick={() => onOpenPasswordActionDialog([member.id], name)}
                    />
                    <Button variant="outline" size="sm" onClick={() => onEditMember(member)}>
                      Edit
                    </Button>
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          )
        })}
      </TableBody>
    </AdminDataTable>
  )
}
