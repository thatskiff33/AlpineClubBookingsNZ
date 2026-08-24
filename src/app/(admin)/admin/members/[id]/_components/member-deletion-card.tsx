"use client"

import {
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Trash2 } from "lucide-react"
import { useClubTime } from "@/components/club-time-provider"
import { formatPayloadInstantDate } from "../../../_lib/payload-instant"
import { cn } from "@/lib/utils"
import type {
  MemberDeleteEligibility,
  MemberLifecycleActionRequest,
} from "../_types"

interface MemberDeletionCardProps extends AncestorViewOnlyBannerProps {
  deleteEligibility: MemberDeleteEligibility
  deleteRequests: MemberLifecycleActionRequest[]
  pendingDeleteRequest: MemberLifecycleActionRequest | undefined
  approvalBlockerCount: number
  canReviewPendingDeleteRequest: boolean
  onOpenRequestDialog: () => void
  onOpenReviewDialog: (
    request: MemberLifecycleActionRequest,
    action: "approve" | "reject"
  ) => void
  /** Whether the actor may act (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined
  className?: string
}

const deleteStatusLabel: Record<MemberLifecycleActionRequest["status"], string> = {
  REQUESTED: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
}

export function MemberDeletionCard({
  deleteEligibility,
  deleteRequests,
  pendingDeleteRequest,
  approvalBlockerCount,
  canReviewPendingDeleteRequest,
  onOpenRequestDialog,
  onOpenReviewDialog,
  canEdit,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberDeletionCardProps) {
  // `requestedAt` is a real INSTANT — when the request row was written — so it
  // has no civil date until a zone is chosen, and that zone is the club's
  // persisted one (`INV-CONFIG-002`), not the reviewing admin's browser.
  const clubTime = useClubTime()
  const deleteBlockers = deleteEligibility.blockers

  return (
    <Card className={cn("border-danger-6", className)}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base font-medium">Member Deletion</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Hard deletion is only available for records added in error with no meaningful history.
          </p>
        </div>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={!ancestorRendersViewOnlyBanner}
          variant="destructive"
          size="sm"
          onClick={onOpenRequestDialog}
          disabled={!deleteEligibility.eligible || Boolean(pendingDeleteRequest)}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Request Delete
        </ViewOnlyActionButton>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingDeleteRequest ? (
          <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
            <div className="font-medium">Delete request pending second-admin review</div>
            <div className="mt-1">
              Requested {formatPayloadInstantDate(clubTime, pendingDeleteRequest.requestedAt)} by{" "}
              {pendingDeleteRequest.requestedBy?.name ?? "Unknown admin"}
            </div>
            <div className="mt-2 text-warning-11">{pendingDeleteRequest.reason}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={!ancestorRendersViewOnlyBanner}
                size="sm"
                variant="destructive"
                onClick={() => onOpenReviewDialog(pendingDeleteRequest, "approve")}
                disabled={!canReviewPendingDeleteRequest || approvalBlockerCount > 0}
              >
                Approve Delete
              </ViewOnlyActionButton>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={!ancestorRendersViewOnlyBanner}
                size="sm"
                variant="outline"
                onClick={() => onOpenReviewDialog(pendingDeleteRequest, "reject")}
                disabled={!canReviewPendingDeleteRequest}
              >
                Reject
              </ViewOnlyActionButton>
              {!canReviewPendingDeleteRequest && (
                <span className="self-center text-xs text-warning-11">
                  Requester cannot approve or reject their own delete request.
                </span>
              )}
            </div>
          </div>
        ) : deleteEligibility.eligible ? (
          <div className="rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
            This member has no delete blockers. A reason and second-admin approval are still required.
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">Deletion is blocked</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {deleteBlockers.map((blocker) => (
                <li key={blocker.code}>
                  {blocker.label}
                  {typeof blocker.count === "number" ? ` (${blocker.count})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {deleteRequests.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent delete requests
            </div>
            <div className="divide-y divide-border rounded-md border border-border">
              {deleteRequests.map((request) => (
                <div key={request.id} className="p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-foreground">{deleteStatusLabel[request.status]}</div>
                    <div className="text-xs text-muted-foreground">{formatPayloadInstantDate(clubTime, request.requestedAt)}</div>
                  </div>
                  <div className="mt-1 text-muted-foreground">{request.reason}</div>
                  {request.reviewNote && (
                    <div className="mt-1 text-xs text-muted-foreground">Review note: {request.reviewNote}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
