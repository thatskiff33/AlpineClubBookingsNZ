"use client"

import { useId } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2 } from "lucide-react"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { parentLinkTypeLabel } from "@/lib/admin-member-detail-helpers"
// A dependant's date of birth is a `@db.Date` CALENDAR DAY. It carries no
// timezone, so it is rendered with none: reading it through one is
// `INV-DATE-019`, and for a club behind UTC it dates a child a day early —
// which on this screen decides which age tier they appear to be in.
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day"
import { formatAgeTierName } from "@/lib/use-age-tier-options"
import {
  DEPENDENT_PARENT_BLOCK_EXPLANATIONS,
  dependentParentStateBlocker,
} from "@/lib/dependent-link-eligibility"
import { DependentNotice } from "./dependent-notices"
import type { MemberDetail } from "../_types"

interface MemberDependentsCardProps extends AncestorViewOnlyBannerProps {
  member: MemberDetail
  currentMemberPath: string
  unlinkingDependentId: string | null
  onOpenDependentDialog: () => void
  onUnlinkDependent: (parentId: string, dependentId: string, dependentName: string) => void
  /** Whether the actor may act (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined
  className?: string
}

export function MemberDependentsCard({
  member,
  currentMemberPath,
  unlinkingDependentId,
  onOpenDependentDialog,
  onUnlinkDependent,
  canEdit,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberDependentsCardProps) {
  const router = useRouter()
  // #2282: age is no longer part of this. A young member can be recorded as a
  // parent, so what is left is whether the record is CURRENT (active, not
  // archived) and whether it is a PERSON at all — an organisation or school
  // account carries `NOT_APPLICABLE` and cannot be anyone's parent. When one of
  // those blocks, the control is shown DISABLED WITH THE REASON rather than
  // hidden. A vanishing button taught the admin nothing; a button that fails on
  // save taught them even less.
  const blockReason = dependentParentStateBlocker(member)
  const blockReasonId = useId()
  // #2282: where a dependent added here would actually receive club email.
  // Recording parentage is age-blind; being the contact of record is not, so
  // this often names somebody else — an adult further up the family for a young
  // parent, or a partner's mailbox for an adult who inherits.
  const emailSource = member.dependentEmailSource
  const emailSourceIsThisMember = emailSource?.id === member.id

  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base font-medium">Dependents</CardTitle>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={!ancestorRendersViewOnlyBanner}
            variant="outline"
            size="sm"
            disabled={Boolean(blockReason)}
            // The reason is ATTACHED to the button, not merely printed beside
            // it: the button is disabled, so it is out of the tab order and its
            // `title` never fires (`disabled:pointer-events-none`). See
            // `DependentNotice`.
            aria-describedby={blockReason ? blockReasonId : undefined}
            onClick={onOpenDependentDialog}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Dependent
          </ViewOnlyActionButton>
          <DependentNotice id={blockReasonId} tone="warning">
            {blockReason
              ? DEPENDENT_PARENT_BLOCK_EXPLANATIONS[blockReason]
              : null}
          </DependentNotice>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* #2282: states WHERE the mail goes and nothing about WHY. The first
            draft of this line explained the routing as "this member is not an
            adult with a usable address of their own", which is false for a
            common shape: `resolveInheritedEmailSourceId` short-circuits on a
            stored `inheritEmailFromId` BEFORE testing the member themselves, so
            an adult with a perfectly good address who inherits their partner's
            mailbox resolved sideways, not up — and read, on an adult's page, as
            "this member is not an adult". */}
        {!blockReason &&
          (emailSource ? (
            !emailSourceIsThisMember && (
              <p className="text-xs text-muted-foreground">
                Club email for a dependent added here goes to{" "}
                {emailSource.firstName} {emailSource.lastName} (
                {emailSource.email}), not to this member.
              </p>
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              No adult the club can email is recorded at or above this member, so
              a dependent added here would have no contact of record and saving
              would be refused. Record an email address for an adult in this
              member&apos;s family — or link this member to their own parent
              first.
            </p>
          ))}
        {member.dependents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No dependents linked to this member yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Link</TableHead>
                <TableHead>Age Tier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date of Birth</TableHead>
                <TableHead>Login</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {member.dependents.map((dependent) => (
                <TableRow key={dependent.id}>
                  <TableCell className="font-medium">
                    {dependent.firstName} {dependent.lastName}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{parentLinkTypeLabel(dependent.parentLinkType)}</Badge>
                  </TableCell>
                  <TableCell>
                    {formatAgeTierName(dependent.ageTier)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={dependent.active ? "default" : "destructive"}
                      className={
                        dependent.active ? "border-success/20 bg-success-muted text-success hover:shadow-md" : ""
                      }
                    >
                      {dependent.active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>{dependent.dateOfBirth ? formatPayloadCalendarDay(dependent.dateOfBirth) : "-"}</TableCell>
                  <TableCell>
                    {dependent.canLogin ? (
                      <Badge variant="secondary" className="border-border bg-muted text-foreground">
                        Can Login
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="border-info/20 bg-info-muted text-info">
                        Non-Login
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          router.push(buildHrefWithReturnTo(`/admin/members/${dependent.id}`, currentMemberPath))
                        }
                      >
                        View
                      </Button>
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={!ancestorRendersViewOnlyBanner}
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          onUnlinkDependent(
                            member.id,
                            dependent.id,
                            `${dependent.firstName} ${dependent.lastName}`
                          )
                        }
                        disabled={unlinkingDependentId === dependent.id}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        {unlinkingDependentId === dependent.id ? "Removing..." : "Remove"}
                      </ViewOnlyActionButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
