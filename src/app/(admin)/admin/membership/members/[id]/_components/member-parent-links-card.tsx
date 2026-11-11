"use client"

import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Link2, Trash2 } from "lucide-react"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { parentLinkTypeLabel } from "@/lib/admin-member-detail-helpers"
import type { MemberDetail } from "../_types"

import { adminHref } from "@/lib/admin-hubs";
interface MemberParentLinksCardProps extends AncestorViewOnlyBannerProps {
  member: MemberDetail
  memberIsArchived: boolean
  currentMemberPath: string
  unlinkingDependentId: string | null
  onOpenParentLinkDialog: () => void
  onUnlinkParent: (parentId: string, dependentId: string, dependentName: string) => void
  /** Whether the actor may act (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined
  className?: string
}

export function MemberParentLinksCard({
  member,
  memberIsArchived,
  currentMemberPath,
  unlinkingDependentId,
  onOpenParentLinkDialog,
  onUnlinkParent,
  canEdit,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberParentLinksCardProps) {
  const router = useRouter()
  const parentLinkCount = member.parentLinks?.length ?? 0
  // #2255: the notification mailbox can now sit further up the family chain than
  // the direct parent — a middle generation with no address of their own passes
  // the resolution up to the nearest ancestor who has one. The per-parent badge
  // below only fires for a DIRECT parent, so where the source is neither parent
  // the card states outright where club email actually goes; otherwise a member
  // would show "inherits email" with nothing on screen saying from whom.
  const notificationSource = member.inheritEmailFrom
  const notificationSourceIsDirectParent = (member.parentLinks ?? []).some(
    (parent) =>
      notificationSource?.id === parent.id ||
      notificationSource?.id === parent.inheritEmailFromId,
  )

  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base font-medium">Parent Links</CardTitle>
        {memberIsArchived ? (
          <Badge variant="secondary" className="border-border bg-muted text-foreground">
            Archived
          </Badge>
        ) : parentLinkCount < 2 ? (
          // #2255: having dependants no longer bars a member from being linked
          // under a parent — families run to four generations, so a member can
          // be someone's child and someone's parent at once. The button stays
          // enabled and the server decides, because whether THIS link fits
          // depends on the chain above the parent the admin picks, which is not
          // knowable from this member's row alone.
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={!ancestorRendersViewOnlyBanner}
            variant="outline"
            size="sm"
            onClick={onOpenParentLinkDialog}
          >
            <Link2 className="h-4 w-4 mr-1" />
            {parentLinkCount === 0 ? "Add Parent" : "Add Second Parent"}
          </ViewOnlyActionButton>
        ) : (
          <Badge variant="secondary" className="border-border bg-muted text-foreground">
            Two parents linked
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {parentLinkCount > 0 ? (
          <div className="space-y-3">
            {member.parentLinks.map((parent) => (
              <div
                key={parent.id}
                className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">
                      {parent.firstName} {parent.lastName}
                    </p>
                    <Badge variant="secondary">{parentLinkTypeLabel(parent.parentLinkType)}</Badge>
                    <Badge variant="secondary">{parent.ageTier}</Badge>
                    <Badge
                      variant={parent.active ? "default" : "destructive"}
                      className={
                        parent.active ? "border-success/20 bg-success-muted text-success hover:shadow-md" : ""
                      }
                    >
                      {parent.active ? "Active" : "Inactive"}
                    </Badge>
                    {member.inheritEmailFromId === parent.id ||
                    member.inheritEmailFromId === parent.inheritEmailFromId ? (
                      <Badge variant="secondary" className="border-warning/20 bg-warning-muted text-warning">
                        Notification email
                      </Badge>
                    ) : null}
                    {parent.canLogin ? (
                      <Badge variant="secondary" className="border-border bg-muted text-foreground">
                        Can Login
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="border-info/20 bg-info-muted text-info">
                        Non-Login
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 break-all text-sm text-muted-foreground">{parent.email}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      router.push(buildHrefWithReturnTo(`${adminHref("member-detail", { id: parent.id })}`, currentMemberPath))
                    }
                  >
                    View Parent
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onUnlinkParent(parent.id, member.id, `${member.firstName} ${member.lastName}`)
                    }
                    disabled={unlinkingDependentId === member.id}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    {unlinkingDependentId === member.id ? "Removing..." : "Remove"}
                  </ViewOnlyActionButton>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No parent member linked.</p>
        )}
        {notificationSource && !notificationSourceIsDirectParent && (
          <p className="text-xs text-muted-foreground">
            Club email for this member goes to {notificationSource.firstName}{" "}
            {notificationSource.lastName} ({notificationSource.email}), further up
            the family than the parent linked here.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Family links can run up to four generations — great-grandparent,
          grandparent, parent, child — with at most two parents each. A member
          who has dependants of their own can still be linked under a parent, as
          long as the whole chain stays within four generations; a link that
          would make it longer is refused.
        </p>
      </CardContent>
    </Card>
  )
}
