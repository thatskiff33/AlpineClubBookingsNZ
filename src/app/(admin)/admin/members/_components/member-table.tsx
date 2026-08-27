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
import { MemberLoginStageChip } from "@/components/admin/member-login-stage-chip"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { getLifecycleStatusConfig } from "@/lib/admin-member-badges"
import { CHIP_TONE_CLASSES, type ChipTone } from "@/lib/chip-tones"
import { memberName } from "@/lib/member-serialization"
import { useClubTime } from "@/components/club-time-provider"
import { requireInstant } from "@/lib/club-time"
import { formatPayloadCalendarDay } from "../../_lib/calendar-day"
import { getXeroContactGroupTone } from "@/lib/xero-contact-group-tone"
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
  /**
   * The club's own membership types (#2978), so the Type – Tier column can name
   * a non-member category's fallback type the way THIS club names it rather than
   * the way the seed does. Optional and empty-tolerant: until the page's fetch
   * resolves, and for a viewer whose permissions do not reach the membership
   * types endpoint, the label falls back to the built-in name — which is right
   * for every club that has not renamed it.
   */
  membershipTypes?: ReadonlyArray<{ key: string; name: string }>
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  onToggleSort: (column: string) => void
  onOpenPasswordActionDialog: (ids: string[], label: string) => void
}

// Selection checkboxes are native inputs (kept for their stable aria-label
// associations that the members tests target); themed via accent + focus ring.
const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"

// The shell that loading / empty / populated states all sit on, so the list
// keeps one themed, dark-mode-correct surface regardless of state.
const SURFACE_CLASS = "rounded-lg border border-border bg-card"

/** A themed, non-domain chip for the Family Group and Xero columns. The
 *  StatusChip `kind` API only covers booking/payment/subscription/lifecycle/
 *  financeAccess, so these signals (login-journey stage, family membership, Xero
 *  linkage/groups) render here through the shared `@/lib/chip-tones` map — the
 *  single source shared with StatusChip and MiniChip — rather than inventing a
 *  new kind or a private tone family. */
/**
 * "Member since", which is TWO DIFFERENT TEMPORAL CONCEPTS behind one column
 * (CT-4, #2870 — the mandatory regression anchor for the mixed
 * `joinedDate || createdAt` branch).
 *
 * `joinedDate` is a `@db.Date` CALENDAR DATE — the day the membership started,
 * sourced from Xero's first invoice. A calendar date has no timezone, so it is
 * decoded from its UTC-midnight encoding and formatted with no zone at all.
 * Reading it through a zone is the `INV-DATE-019` defect, and through a zone
 * behind UTC it named the day before the member actually joined.
 *
 * `createdAt` is a real INSTANT — when the row was written — and has no civil
 * date until a zone is chosen. That zone is the club's persisted one
 * (`INV-CONFIG-002`), never the viewer's.
 *
 * The old single expression fed BOTH through the instant formatter, so the
 * calendar half was projected and the branch you got decided whether the
 * displayed day was right.
 */
function formatMemberSince(
  clubTime: ReturnType<typeof useClubTime>,
  member: Pick<Member, "joinedDate" | "createdAt">,
): string {
  return member.joinedDate
    ? formatPayloadCalendarDay(member.joinedDate)
    : clubTime.instantDate(requireInstant(member.createdAt))
}

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
  membershipTypes,
  onToggleSelect,
  onToggleSelectAll,
  onToggleSort,
  onOpenPasswordActionDialog,
}: MemberTableProps) {
  // "Member since" mixes a calendar date with an instant; see formatMemberSince.
  const clubTime = useClubTime()
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

  // #2620: "select all" means all SELECTABLE rows. A member an approved deletion
  // request has anonymised is never a bulk-action target — bulk Reactivate,
  // deactivate and set-role all have nothing legitimate to do to an erased
  // account — so it is excluded here and in the page's toggleSelectAll. Keying
  // the header tick to the same count stops it sitting unticked forever on a page
  // that happens to contain one.
  const selectableCount = members.filter((member) => !member.deletedAccount).length

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
                checked={selectedIds.size === selectableCount && selectableCount > 0}
                onChange={onToggleSelectAll}
                className={CHECKBOX_CLASS}
              />
            </TableHead>
          ) : null}
          {[
            ["name", "Name"],
            ["email", "Email"],
            ["access", "Access"],
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
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const lifecycleConfig = getLifecycleStatusConfig(member)
          // Access is the four-state login journey, never the member's role.
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
                    // #2620: an erased account cannot be selected at all, so a
                    // bulk Reactivate can never reach it by accident. The server
                    // refuses too (409) — this is the half that stops the
                    // mistake being made.
                    disabled={member.deletedAccount === true}
                    title={
                      member.deletedAccount
                        ? "This member has been deleted and cannot be included in a bulk action"
                        : undefined
                    }
                    className={CHECKBOX_CLASS}
                  />
                </TableCell>
              ) : null}
              <TableCell className="font-medium">
                <Link
                  href={buildHrefWithReturnTo(`/admin/members/${member.id}`, membersListPath)}
                  className="rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                <MemberLoginStageChip member={member} />
              </TableCell>
              <TableCell>
                {/* Display-only combination; data stays separate (#1445). */}
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {formatTypeTierLabel(
                    member.currentMembershipType?.name,
                    member.ageTier,
                    // #2978: the role decides the fallback when there is no
                    // season assignment, so a non-member booking contact reads
                    // "Non-Member" rather than "Unassigned".
                    member.role,
                    // …named as THIS club names it. `MembershipType.name` is
                    // editable, so a club that renamed its Non-Member type must
                    // read its own word here and not the seed's.
                    membershipTypes,
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
                        <InfoChip
                          key={group.id}
                          tone={getXeroContactGroupTone(group.id)}
                        >
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
                {formatMemberSince(clubTime, member)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {canEdit ? (
                    <MemberPasswordActionButton
                      member={member}
                      onClick={() => onOpenPasswordActionDialog([member.id], name)}
                    />
                  ) : null}
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      href={buildHrefWithReturnTo(
                        `/admin/members/${member.id}`,
                        membersListPath,
                      )}
                      aria-label={`Open ${name}`}
                    >
                      Open
                    </Link>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </AdminDataTable>
  )
}
