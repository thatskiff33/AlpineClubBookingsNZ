"use client"

import Link from "next/link"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Archive } from "lucide-react"
import { useClubTime } from "@/components/club-time-provider"
import { formatPayloadInstantDate } from "../../../_lib/payload-instant"
import type {
  MemberDetail,
  MemberLifecycleActionRequest,
  OpenCancellationRequestSummary,
} from "../_types"

interface MemberLifecycleCardProps extends AncestorViewOnlyBannerProps {
  member: MemberDetail
  pendingArchiveRequest: MemberLifecycleActionRequest | null
  reviewedArchiveRequests: MemberLifecycleActionRequest[]
  isArchiveRequester: boolean
  canRequestArchive: boolean
  canRequestCancellation: boolean
  openCancellationRequest: OpenCancellationRequestSummary | null
  archiveError: string
  archiveReason: string
  archiveReviewNotes: Record<string, string>
  archiveActionLoading: string | null
  cancellationError: string
  cancellationReason: string
  cancellationSubmitting: boolean
  onChangeArchiveReason: (value: string) => void
  onChangeArchiveReviewNote: (requestId: string, value: string) => void
  onChangeCancellationReason: (value: string) => void
  onSubmitArchive: () => void
  onSubmitCancellation: () => void
  onReviewArchive: (
    requestId: string,
    action: "approve" | "reject",
    notifyMember?: boolean,
  ) => void
  /** Whether the actor may act (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined
  className?: string
}

export function MemberLifecycleCard({
  member,
  pendingArchiveRequest,
  reviewedArchiveRequests,
  isArchiveRequester,
  canRequestArchive,
  canRequestCancellation,
  openCancellationRequest,
  archiveError,
  archiveReason,
  archiveReviewNotes,
  archiveActionLoading,
  cancellationError,
  cancellationReason,
  cancellationSubmitting,
  onChangeArchiveReason,
  onChangeArchiveReviewNote,
  onChangeCancellationReason,
  onSubmitArchive,
  onSubmitCancellation,
  onReviewArchive,
  canEdit,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberLifecycleCardProps) {
  // Every stamp on this card is a real INSTANT — when a lifecycle row was
  // written or reviewed — so it has no civil date until a zone is chosen, and
  // that is the club's persisted zone (`INV-CONFIG-002`), not the admin's
  // browser. None of them is a `@db.Date` calendar day.
  const clubTime = useClubTime()
  // #1788: which archive review is waiting on the admin's notify-or-not choice.
  // The dialog only opens when an email would actually send (the target member
  // has an address on file); a member with no email reviews directly with no
  // flag. The choice is kept set while the dialog fades out (Radix keeps the
  // content mounted through its exit animation) so the copy never flickers.
  const memberHasEmail = Boolean(member.email)
  const [notifyChoice, setNotifyChoice] = useState<{
    requestId: string
    action: "approve" | "reject"
  } | null>(null)
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false)

  function startReview(requestId: string, action: "approve" | "reject") {
    if (memberHasEmail) {
      setNotifyChoice({ requestId, action })
      setNotifyDialogOpen(true)
    } else {
      // Nothing to email — perform directly, no notify flag, no dialog.
      onReviewArchive(requestId, action)
    }
  }

  // #1788: dispatch the pending choice. Close the dialog without clearing the
  // choice so the content keeps its wording while it fades out.
  function confirmNotify(notifyMember: boolean) {
    const choice = notifyChoice
    setNotifyDialogOpen(false)
    if (!choice) return
    onReviewArchive(choice.requestId, choice.action, notifyMember)
  }

  const isReviewing = Boolean(archiveActionLoading)

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Archive className="h-4 w-4 text-muted-foreground" />
          Lifecycle
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {archiveError && (
          <div className="p-2 bg-danger-3 border border-danger-6 text-danger-11 rounded text-sm">{archiveError}</div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Cancellation</p>
            {member.cancelledAt ? (
              <div className="mt-2 space-y-1 text-sm">
                <Badge variant="secondary" className="bg-warning-3 text-warning-11 border-warning-6">
                  Cancelled {formatPayloadInstantDate(clubTime, member.cancelledAt)}
                </Badge>
                {member.cancelledReason && <p className="text-muted-foreground">{member.cancelledReason}</p>}
              </div>
            ) : openCancellationRequest ? (
              <p className="mt-2 text-sm text-warning-11">Cancellation request pending review.</p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">This member has not been cancelled.</p>
            )}
          </div>
          <div className="rounded-md border border-border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Archive</p>
            {member.archivedAt ? (
              <div className="mt-2 space-y-1 text-sm">
                <Badge variant="secondary" className="bg-border text-foreground border-border">
                  Archived {formatPayloadInstantDate(clubTime, member.archivedAt)}
                </Badge>
                {member.archivedReason && <p className="text-muted-foreground">{member.archivedReason}</p>}
              </div>
            ) : pendingArchiveRequest ? (
              <p className="mt-2 text-sm text-warning-11">Archive request pending review.</p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {member.cancelledAt ? "Ready to request archive." : "Archive is available after cancellation."}
              </p>
            )}
          </div>
        </div>

        {cancellationError && (
          <div className="p-2 bg-danger-3 border border-danger-6 text-danger-11 rounded text-sm">{cancellationError}</div>
        )}

        {openCancellationRequest && (
          <div className="rounded-md border border-warning-6 bg-warning-3 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-warning-11">Pending cancellation request</p>
              {openCancellationRequest.reason && (
                <p className="text-sm text-warning-11">{openCancellationRequest.reason}</p>
              )}
              <p className="text-xs text-warning-11">
                Requested by {openCancellationRequest.requestedBy?.name ?? "Unknown"} on{" "}
                {formatPayloadInstantDate(clubTime, openCancellationRequest.submittedAt)} ({openCancellationRequest.participantStatus.replace(/_/g, " ").toLowerCase()})
              </p>
              <p className="text-xs text-warning-11">
                Review in the <Link href="/admin/membership-cancellations" className="underline">cancellation review queue</Link>.
              </p>
            </div>
          </div>
        )}

        {canRequestCancellation && (
          <div className="rounded-md border border-border p-4">
            <div className="space-y-2">
              <Label htmlFor="cancellation-reason">Cancellation reason *</Label>
              <textarea
                id="cancellation-reason"
                value={cancellationReason}
                onChange={(event) => onChangeCancellationReason(event.target.value)}
                rows={3}
                maxLength={1000}
                className="min-h-24 w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Admin-initiated cancellation requests go directly to the review queue without requiring the member to confirm by email.
              </p>
            </div>
            <ViewOnlyActionButton canEdit={canEdit} describeReason={!ancestorRendersViewOnlyBanner} className="mt-3" size="sm" onClick={onSubmitCancellation} disabled={cancellationSubmitting}>
              {cancellationSubmitting ? "Submitting..." : "Request Cancellation"}
            </ViewOnlyActionButton>
          </div>
        )}

        {pendingArchiveRequest && (
          <div className="rounded-md border border-warning-6 bg-warning-3 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-warning-11">Pending archive request</p>
                <p className="text-sm text-warning-11">{pendingArchiveRequest.reason}</p>
                <p className="text-xs text-warning-11">
                  Requested by {pendingArchiveRequest.requestedBy?.name ?? "Unknown admin"} on{" "}
                  {formatPayloadInstantDate(clubTime, pendingArchiveRequest.requestedAt)}
                </p>
              </div>
              {isArchiveRequester ? (
                <p className="text-xs text-warning-11">Needs another admin to approve or reject.</p>
              ) : (
                <div className="w-full space-y-2 sm:max-w-sm">
                  <Label htmlFor={`archive-review-note-${pendingArchiveRequest.id}`}>Optional review note</Label>
                  <textarea
                    id={`archive-review-note-${pendingArchiveRequest.id}`}
                    value={archiveReviewNotes[pendingArchiveRequest.id] ?? ""}
                    onChange={(event) => onChangeArchiveReviewNote(pendingArchiveRequest.id, event.target.value)}
                    rows={2}
                    maxLength={1000}
                    className="min-h-20 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                  />
                  <div className="flex justify-end gap-2">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={!ancestorRendersViewOnlyBanner}
                      variant="outline"
                      size="sm"
                      disabled={Boolean(archiveActionLoading)}
                      onClick={() => startReview(pendingArchiveRequest.id, "reject")}
                    >
                      {archiveActionLoading === `reject:${pendingArchiveRequest.id}` ? "Rejecting..." : "Reject"}
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={!ancestorRendersViewOnlyBanner}
                      variant="destructive"
                      size="sm"
                      disabled={Boolean(archiveActionLoading)}
                      onClick={() => startReview(pendingArchiveRequest.id, "approve")}
                    >
                      {archiveActionLoading === `approve:${pendingArchiveRequest.id}` ? "Archiving..." : "Approve Archive"}
                    </ViewOnlyActionButton>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {canRequestArchive && (
          <div className="rounded-md border border-border p-4">
            <div className="space-y-2">
              <Label htmlFor="archive-reason">Archive reason *</Label>
              <textarea
                id="archive-reason"
                value={archiveReason}
                onChange={(event) => onChangeArchiveReason(event.target.value)}
                rows={3}
                maxLength={1000}
                className="min-h-24 w-full rounded-md border border-border px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                A different admin must approve this request before the member is archived.
              </p>
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              className="mt-3"
              size="sm"
              onClick={onSubmitArchive}
              disabled={archiveActionLoading === "request"}
            >
              <Archive className="h-4 w-4 mr-1" />
              {archiveActionLoading === "request" ? "Submitting..." : "Request Archive"}
            </ViewOnlyActionButton>
          </div>
        )}

        {reviewedArchiveRequests.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Recent archive decisions</p>
            <div className="space-y-2">
              {reviewedArchiveRequests.map((request) => (
                <div key={request.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={
                        request.status === "APPROVED"
                          ? "bg-border text-foreground border-border"
                          : "bg-danger-3 text-danger-11 border-danger-6"
                      }
                    >
                      {request.status === "APPROVED" ? "Approved" : "Rejected"}
                    </Badge>
                    <span className="text-muted-foreground">
                      {request.reviewedAt ? formatPayloadInstantDate(clubTime, request.reviewedAt) : "Not dated"} by{" "}
                      {request.reviewedBy?.name ?? "Unknown admin"}
                    </span>
                  </div>
                  {request.reviewNote && <p className="mt-1 text-muted-foreground">{request.reviewNote}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* #1788: per-review member-email choice, mirroring the #1705/#1769a
          pattern. Shown only when the target member has an address on file;
          both choices complete the review and the choice is recorded in the
          audit log. Archive approve and reject are handled identically — only
          the wording changes. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && !isReviewing) setNotifyDialogOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.action === "approve"
                ? "Email the member about this archive?"
                : "Email the member about this decision?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.action === "approve"
                ? "The member is archived either way. Choose whether they receive the standard archive-completed email — your choice is recorded in the audit log."
                : "The archive request is rejected either way. Choose whether the member receives the standard rejection email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={isReviewing}
              onClick={() => confirmNotify(false)}
            >
              {notifyChoice?.action === "approve"
                ? "Archive without emailing"
                : "Reject without emailing"}
            </Button>
            <Button
              variant={notifyChoice?.action === "approve" ? "destructive" : "default"}
              disabled={isReviewing}
              onClick={() => confirmNotify(true)}
            >
              {notifyChoice?.action === "approve"
                ? "Archive and email member"
                : "Reject and email member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
