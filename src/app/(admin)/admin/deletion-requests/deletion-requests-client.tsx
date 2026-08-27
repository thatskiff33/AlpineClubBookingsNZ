"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  FieldHint,
  describedByFieldHint,
} from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import { isFullAdmin } from "@/lib/access-roles";
import {
  DELETION_APPROVAL_RELEASED_DISCLOSURE,
  DELETION_APPROVAL_RELEASED_LEAD,
  DELETION_REJECT_AFTER_RELEASE_CONFIRM_CODE,
  DELETION_REQUEST_APPROVAL_RELEASED_CODE,
  deletionApprovalWasReleased,
} from "@/lib/deletion-request-decision";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import { FocusedActionError } from "@/components/focused-action-error";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

/** #2264 — the rejection-reason hint id, spelled once. Only one review dialog
 *  is mounted at a time, so a fixed id cannot collide. */
const REVIEW_NOTE_HINT_ID = "review-note-hint";

/** Shown on a row whose last review outcome was never legibly confirmed. */
const UNCONFIRMED_REVIEW_REASON =
  "The last review of this request could not be confirmed. Check its current status before acting again.";

/**
 * Read a review response body without letting an unreadable one masquerade as
 * a failure. A deletion review commits real work before it answers — future
 * bookings are cancelled in separately committed transactions, and approval
 * takes a durable claim before the first of them — so a proxy error page, a
 * truncated body, or a dropped connection tells us the outcome is UNKNOWN, not
 * that nothing happened. `res.json()` throwing must therefore be distinguished
 * from a decoded error body, never merged into one generic catch.
 */
async function readReviewResponseBody(res: Response) {
  try {
    return { readable: true as const, body: await res.json() };
  } catch {
    return { readable: false as const, body: null };
  }
}

interface DeletionRequestMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  active: boolean;
}

interface DeletionRequest {
  id: string;
  status: "PENDING" | "APPROVAL_IN_PROGRESS" | "APPROVED" | "REJECTED";
  reason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  member: DeletionRequestMember;
}

interface ApiResponse {
  requests: DeletionRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Admin-initiated hard-delete review requests (MemberLifecycleActionRequest,
// action DELETE). Distinct from the self-service DeletionRequest above.
interface LifecycleRequest {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  requestedByMemberId: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  targetName: string;
  member: { id: string; name: string; email: string } | null;
}

interface LifecycleApiResponse {
  requests: LifecycleRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function DeletionRequestsClient({
  sessionMemberId,
}: {
  sessionMemberId: string;
}) {
  // Request, review and decision stamps are real INSTANTS, shown in the club's
  // persisted zone rather than the viewer's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  // Approve/reject write the membership-area deletion routes; a view-only
  // membership admin browses the queues but cannot act (#1997).
  const canEdit = useAdminAreaEditAccess("membership");
  // #2627: releasing a started approval re-opens a decision that had been closed
  // to rejection, on a path where future bookings may already have been
  // cancelled. The route requires Full Admin (403 otherwise) and stays the
  // authority; hiding the control for everyone else keeps the UI honest.
  const { data: session } = useSession();
  const canReleaseApprovalClaim = session?.user
    ? isFullAdmin({ accessRoles: session.user.accessRoles })
    : false;
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [adminInitiatedPage, setAdminInitiatedPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [recoveryAttentionVersion, setRecoveryAttentionVersion] = useState(0);
  const [deletionRecovery, setDeletionRecovery] = useState<{
    request: DeletionRequest;
    note: string;
    cancelledBookings: number;
    cancellationPending: boolean;
    retryBookingId: string | null;
    reviewBookingId: string | null;
    bookingActionLabel: string | null;
    heading: string;
    retryAllowed: boolean;
    message: string;
  } | null>(null);

  const [reviewDialog, setReviewDialog] = useState<{
    request: DeletionRequest;
    action: "approve" | "reject" | "release";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(`/api/admin/deletion-requests?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
      return true;
    } catch {
      setError("Failed to load deletion requests.");
      return false;
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  function showActionError(message: string) {
    setError(message);
    setErrorAttentionVersion((version) => version + 1);
  }

  /**
   * The review reached the server, or may have, but its outcome never came
   * back legibly. That is NOT the same as "it failed": an approval with future
   * bookings to cancel takes a durable APPROVAL_IN_PROGRESS claim and commits
   * those cancellations one at a time before it ever anonymises anything, and
   * one with none commits its whole decision in a single transaction it may
   * already have finished. Leaving Approve/Reject live on
   * the row would invite a second destructive attempt against a request the
   * server may already be part-way through — so suppress that row's controls
   * (the recovery banner disables them), re-read the authoritative queue, and
   * offer no retry.
   */
  async function enterUnconfirmedRecovery(
    pendingReview: {
      request: DeletionRequest;
      action: "approve" | "reject" | "release";
    },
    pendingNote: string,
    cause: string,
  ) {
    const attempted =
      pendingReview.action === "approve"
        ? "approval"
        : pendingReview.action === "release"
          ? "approval release"
          : "rejection";
    const recoveryBase = `This ${attempted} could not be confirmed because ${cause}. It may already have been recorded, and an approval may already have cancelled future bookings. Do not retry it — check this request's current status in the reloaded queue first.`;
    setReviewDialog(null);
    setDeletionRecovery({
      request: pendingReview.request,
      note: pendingNote,
      cancelledBookings: 0,
      cancellationPending: false,
      retryBookingId: null,
      reviewBookingId: null,
      bookingActionLabel: null,
      heading: "Deletion decision could not be confirmed",
      retryAllowed: false,
      message: recoveryBase,
    });
    setRecoveryAttentionVersion((version) => version + 1);
    const refreshed = await fetchRequests();
    // The refresh outcome belongs in the durable recovery, not the ordinary
    // action region, so it cannot steal focus from this warning.
    setError(null);
    setDeletionRecovery((current) =>
      current
        ? {
            ...current,
            message: `${recoveryBase}${
              refreshed
                ? " The latest deletion queue was loaded."
                : " The deletion queue could not be refreshed either, so this warning stays active until you reload the page."
            }`,
          }
        : current,
    );
    setRecoveryAttentionVersion((version) => version + 1);
  }

  // #1788: `notifyMember` is only meaningful on the reject path (the approve
  // path always sends the final privacy receipt). Absent = notify (default),
  // false = suppress the member email.
  async function handleReview(notifyMember?: boolean) {
    if (!reviewDialog) return;
    const pendingReview = reviewDialog;
    const pendingNote = reviewNote;
    setSubmitting(true);
    try {
      let res: Response;
      try {
        res = await fetch(
          `/api/admin/deletion-requests/${reviewDialog.request.id}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: reviewDialog.action,
              note: reviewNote || undefined,
              ...(notifyMember === undefined ? {} : { notifyMember }),
              // #2627: this dialog has just stated what the released approval
              // already did, so the confirmation the route demands is carried
              // from here. A page that predates the release has no marker on the
              // request, sends no flag, and is refused WITH the disclosure.
              ...(reviewDialog.action === "reject" &&
              deletionApprovalWasReleased(reviewDialog.request)
                ? { confirmReleasedApproval: true }
                : {}),
            }),
          }
        );
      } catch {
        // The request may still have been received and acted on.
        await enterUnconfirmedRecovery(
          pendingReview,
          pendingNote,
          "the server could not be reached",
        );
        return;
      }

      const parsed = await readReviewResponseBody(res);
      if (!parsed.readable) {
        await enterUnconfirmedRecovery(
          pendingReview,
          pendingNote,
          res.ok
            ? "the server accepted it but its confirmation could not be read"
            : "the server's response could not be read",
        );
        return;
      }
      const body = parsed.body;
      if (!res.ok) {
        if (
          body.decisionFinal === true &&
          (body.finalDecision === "APPROVED" ||
            body.finalDecision === "REJECTED") &&
          typeof body.memberAnonymised === "boolean" &&
          typeof body.cancelledBookings === "number" &&
          body.retryAllowed === false &&
          body.remainingCleanupPending !== true
        ) {
          const cancelledBookings = Math.max(0, body.cancelledBookings);
          const cancelledCopy =
            cancelledBookings === 1
              ? "1 future booking cancellation completed before the final decision."
              : `${cancelledBookings} future booking cancellations completed before the final decision.`;
          const memberCopy = body.memberAnonymised
            ? "The latest member record is anonymised."
            : "The latest member record is not anonymised.";
          const decisionCopy =
            body.finalDecision === "APPROVED"
              ? "Another administrator approved this deletion request."
              : "Another administrator rejected this deletion request.";
          const recoveryBase = `${decisionCopy} ${memberCopy} ${cancelledCopy} This decision is final; no deletion action was retried.`;

          setReviewDialog(null);
          setDeletionRecovery({
            request: pendingReview.request,
            note: pendingNote,
            cancelledBookings,
            cancellationPending: false,
            retryBookingId: null,
            reviewBookingId: null,
            bookingActionLabel: null,
            heading: "Deletion request already decided",
            retryAllowed: false,
            message: recoveryBase,
          });
          setRecoveryAttentionVersion((version) => version + 1);
          const refreshed = await fetchRequests();
          setError(null);
          setDeletionRecovery((current) =>
            current
              ? {
                  ...current,
                  message: `${recoveryBase}${
                    refreshed
                      ? " The latest deletion queue was loaded."
                      : " The deletion queue could not be refreshed. This final-decision warning remains active."
                  }`,
                }
              : current,
          );
          setRecoveryAttentionVersion((version) => version + 1);
          return;
        }
        // #2627: two refusals about a request whose started approval was
        // released. Both describe a state that is known EXACTLY — pending, with
        // the member's stays possibly already cancelled — so neither is the
        // durable "needs verification" recovery below: that one suppresses the
        // row's controls and forbids a retry, which would be wrong twice over
        // here. The request is decidable again, and the reloaded row carries the
        // warning the decider needs.
        if (
          body.code === DELETION_REQUEST_APPROVAL_RELEASED_CODE ||
          body.code === DELETION_REJECT_AFTER_RELEASE_CONFIRM_CODE
        ) {
          const cancelledBookings =
            typeof body.cancelledBookings === "number"
              ? Math.max(0, body.cancelledBookings)
              : 0;
          const cancelledCopy =
            cancelledBookings === 0
              ? ""
              : cancelledBookings === 1
                ? " 1 future booking cancellation had already committed and stays cancelled."
                : ` ${cancelledBookings} future booking cancellations had already committed and stay cancelled.`;
          setReviewDialog(null);
          // The typed note is deliberately kept: on the confirmation refusal the
          // admin is expected to come straight back and reject again.
          const refreshed = await fetchRequests();
          showActionError(
            `${String(body.error)}${cancelledCopy}${
              refreshed
                ? ""
                : " The deletion queue could not be refreshed, so reload the page before deciding it."
            }`,
          );
          return;
        }
        if (
          body.decisionStatusUnconfirmed === true &&
          body.retryAllowed === false
        ) {
          const recoveryBase =
            "Another administrator claimed this deletion request, but its final state could not be confirmed. Reload the deletion queue; do not retry the deletion action.";
          setReviewDialog(null);
          setDeletionRecovery({
            request: pendingReview.request,
            note: pendingNote,
            cancelledBookings:
              typeof body.cancelledBookings === "number"
                ? Math.max(0, body.cancelledBookings)
                : 0,
            cancellationPending: false,
            retryBookingId: null,
            reviewBookingId: null,
            bookingActionLabel: null,
            heading: "Deletion decision needs verification",
            retryAllowed: false,
            message: recoveryBase,
          });
          setRecoveryAttentionVersion((version) => version + 1);
          await fetchRequests();
          setError(null);
          return;
        }
        if (
          pendingReview.action === "approve" &&
          body.remainingCleanupPending === true &&
          typeof body.cancelledBookings === "number" &&
          (body.memberAnonymised === false ||
            body.memberDataAnonymised === false) &&
          body.approvalReceiptSent === false
        ) {
          const cancelledBookings = Math.max(0, body.cancelledBookings);
          const cancellationPending = body.cancellationPending === true;
          const retryBookingId =
            cancellationPending && typeof body.retryBookingId === "string"
              ? body.retryBookingId
              : null;
          const cancellationStatusUnconfirmed =
            body.cancellationStatusUnconfirmed === true;
          const cancellationPostProcessingUnconfirmed =
            body.cancellationPostProcessingUnconfirmed === true;
          const reviewBookingId =
            typeof body.reviewBookingId === "string"
              ? body.reviewBookingId
              : retryBookingId;
          const blocker =
            body.blocker &&
            typeof body.blocker === "object" &&
            typeof body.blocker.message === "string" &&
            typeof body.blocker.remedy === "string"
              ? {
                  message: body.blocker.message as string,
                  remedy: body.blocker.remedy as string,
                }
              : null;
          const cancelledCopy =
            cancelledBookings === 1
              ? "1 future booking was cancelled."
              : `${cancelledBookings} future bookings were cancelled.`;
          const cancellationCopy = cancellationPostProcessingUnconfirmed
            ? " The booking cancellation committed, but its post-cancellation processing could not be confirmed."
            : cancellationStatusUnconfirmed
              ? " The current cancellation status of one booking could not be confirmed. Review that booking before retrying."
              : cancellationPending
                ? " One remaining booking still needs cancellation."
                : " The discovered booking cancellations completed.";
          const blockerCopy = blocker
            ? ` Approval is still blocked: ${blocker.message} ${blocker.remedy}`
            : "";
          const recoveryBase = `${cancelledCopy}${cancellationCopy} The member's data was not anonymised and no approval receipt was sent.${blockerCopy} Retry only the remaining cleanup.`;

          setReviewDialog(null);
          setDeletionRecovery({
            request: pendingReview.request,
            note: pendingNote,
            cancelledBookings,
            cancellationPending,
            retryBookingId,
            reviewBookingId,
            bookingActionLabel: retryBookingId
              ? "Open pending booking"
              : reviewBookingId
                ? "Open booking for review"
                : null,
            heading: "Deletion approval partially completed",
            retryAllowed: true,
            message: recoveryBase,
          });
          setRecoveryAttentionVersion((version) => version + 1);
          const refreshed = await fetchRequests();
          // The refresh outcome is folded into the durable recovery below; do
          // not duplicate it in the ordinary action region or steal focus.
          setError(null);
          const refreshResult = refreshed
            ? " The latest deletion queue was loaded."
            : " The deletion queue could not be refreshed. This recovery warning remains active.";
          setDeletionRecovery((current) =>
            current
              ? { ...current, message: `${recoveryBase}${refreshResult}` }
              : current,
          );
          setRecoveryAttentionVersion((version) => version + 1);
          return;
        }
        throw new Error(body.error || "Failed");
      }
      setReviewDialog(null);
      setReviewNote("");
      setDeletionRecovery(null);
      await fetchRequests();
    } catch (err) {
      setReviewDialog(null);
      showActionError(
        err instanceof Error ? err.message : "Failed to process request",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const statusBadge = (status: string) => {
    if (status === "PENDING")
      return (
        <Badge className="bg-warning-3 text-warning-11 border-warning-6">
          Pending
        </Badge>
      );
    // A request mid-approval still owes the member its anonymisation, and may
    // already have cancelled their future bookings. It is emphatically not
    // "Rejected", which is what the fall-through below would otherwise label it.
    if (status === "APPROVAL_IN_PROGRESS")
      return (
        <Badge className="bg-warning-3 text-warning-11 border-warning-6">
          Approval in progress
        </Badge>
      );
    if (status === "APPROVED")
      return (
        <Badge className="bg-success-3 text-success-11 border-success-6">
          Approved
        </Badge>
      );
    return (
      <Badge className="bg-danger-3 text-danger-11 border-danger-6">Rejected</Badge>
    );
  };

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  /*
    #2627: rejecting a request whose started approval was released is the one
    rejection that can be final over stays that are already gone, so this dialog
    is not an ordinary reject dialog: it opens with the disclosure, its reason is
    mandatory, and the member is emailed it. The route enforces all three (403 /
    409 / 400), so these controls are the honest shape of what it will accept
    rather than the authority.
  */
  const rejectingReleasedApproval =
    reviewDialog?.action === "reject" &&
    deletionApprovalWasReleased(reviewDialog.request);
  const rejectedMemberHasEmail = Boolean(reviewDialog?.request.member.email);
  const reviewNoteLabel =
    reviewDialog?.action === "approve"
      ? "Note (optional)"
      : reviewDialog?.action === "release"
        ? "Reason for releasing (required — recorded on the request)"
        : rejectingReleasedApproval
          ? rejectedMemberHasEmail
            ? "Reason for rejection (required — will be sent to member)"
            : "Reason for rejection (required — recorded on the request)"
          : "Reason for rejection (optional — will be sent to member)";
  // Mandatory only where the member is owed an explanation for stays that were
  // already cancelled; an ordinary rejection keeps its optional note.
  const reviewNoteMissing =
    rejectingReleasedApproval && reviewNote.trim().length === 0;

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view deletion requests but cannot approve or reject
      them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Deletion Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review member account deletion requests. Members can request deletion
          of their own account; admins can request permanent (hard) deletion of
          a member record added in error. Hard-delete requests require a second
          admin to approve.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Member self-service requests</CardTitle>
              <CardDescription>
                {data ? `${data.total} total` : "Loading..."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                  setAdminInitiatedPage(1);
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                  <SelectItem value="ALL">All</SelectItem>
                </SelectContent>
              </Select>
              <DatasetResetButton
                disabled={
                  statusFilter === "PENDING" &&
                  page === 1 &&
                  adminInitiatedPage === 1
                }
                onReset={() => {
                  setStatusFilter("PENDING");
                  setPage(1);
                  setAdminInitiatedPage(1);
                }}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <FocusedActionError
            id="deletion-requests-recovery"
            error={deletionRecovery?.message ?? ""}
            attentionKey={recoveryAttentionVersion}
            heading={
              deletionRecovery?.heading
            }
            action={
              deletionRecovery ? (
                <div className="flex flex-wrap gap-2">
                  {deletionRecovery.retryAllowed ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setReviewNote(deletionRecovery.note);
                        setReviewDialog({
                          request: deletionRecovery.request,
                          action: "approve",
                        });
                      }}
                    >
                      Retry remaining cleanup
                    </Button>
                  ) : null}
                  {deletionRecovery.reviewBookingId &&
                  deletionRecovery.bookingActionLabel ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={buildHrefWithReturnTo(
                          `/bookings/${encodeURIComponent(deletionRecovery.reviewBookingId)}`,
                          "/admin/deletion-requests",
                        )}
                      >
                        {deletionRecovery.bookingActionLabel}
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : undefined
            }
          />
          <FocusedActionError
            id="deletion-requests-error"
            error={error ?? ""}
            attentionKey={errorAttentionVersion}
            action={
              error ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setError(null)}
                >
                  Dismiss
                </Button>
              ) : undefined
            }
          />
          {loading && (
            <p className="text-sm text-muted-foreground py-4">Loading...</p>
          )}
          {!loading && data && data.requests.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">
              No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
              deletion requests.
            </p>
          )}
          {!loading && data && data.requests.length > 0 && (
            <div className="divide-y">
              {data.requests.map((req) => {
                // #2627: a request whose started approval was released is
                // PENDING again, but it is NOT an ordinary pending request — an
                // approval may already have cancelled the member's future
                // bookings, and rejecting it will not bring them back. The
                // marker is in the row itself (see
                // deletionApprovalWasReleased), so the warning cannot lag the
                // state, and the reject path re-checks the same predicate
                // server-side.
                const releasedApproval = deletionApprovalWasReleased(req);
                const canRejectReleased =
                  !releasedApproval || canReleaseApprovalClaim;
                return (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">
                          {req.member.firstName} {req.member.lastName}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {req.member.email}
                        </span>
                        {statusBadge(req.status)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Requested {clubTime.instantDateTime(requireInstant(req.createdAt))}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.adminNote && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">
                            {releasedApproval
                              ? "Release reason:"
                              : "Admin note:"}
                          </span>{" "}
                          {req.adminNote}
                        </p>
                      )}
                      {/* A released request carries a reviewedAt with no
                          reviewer — that pair IS the release marker, and it must
                          never be mislabelled as a completed review. Its date is
                          stated in the warning below instead. */}
                      {req.reviewedAt && !releasedApproval && (
                        <p className="text-xs text-muted-foreground">
                          Reviewed{" "}
                          {clubTime.instantDate(requireInstant(req.reviewedAt))}
                        </p>
                      )}
                      {releasedApproval && (
                        <p className="text-xs text-warning-11 max-w-prose">
                          <span className="font-medium">
                            Approval started and released back to pending
                            {req.reviewedAt
                              ? ` ${clubTime.instantDateTime(requireInstant(req.reviewedAt))}`
                              : ""}
                            .
                          </span>{" "}
                          {DELETION_APPROVAL_RELEASED_DISCLOSURE}{" "}
                          {canRejectReleased
                            ? "Rejecting it asks you to confirm that first, and to give a reason the member is emailed."
                            : "Only a Full Admin can reject it now; approving completes the deletion the member asked for."}
                        </p>
                      )}
                    </div>
                    {req.status === "PENDING" && (
                      <div className="flex gap-2 shrink-0">
                        {/* #2627: the route refuses a reject-after-release from
                            anyone but a Full Admin (403), so offering it to a
                            scoped membership admin would be a button that can
                            only fail. The warning beside it says who can. */}
                        {canRejectReleased ? (
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            size="sm"
                            variant="outline"
                            className="text-danger-11 border-danger-6 hover:bg-danger-3"
                            onClick={() =>
                              setReviewDialog({ request: req, action: "reject" })
                            }
                            disabled={deletionRecovery?.request.id === req.id}
                          >
                            Reject
                          </ViewOnlyActionButton>
                        ) : null}
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "approve" })
                          }
                          disabled={deletionRecovery?.request.id === req.id}
                        >
                          Approve
                        </ViewOnlyActionButton>
                      </div>
                    )}
                    {/* Approval already owns this request, so rejection cannot
                        win it server-side while the claim stands, and offering
                        Reject here would be a button that can only fail. The
                        ordinary way forward is finishing the cleanup that has
                        already begun. #2627: a Full Admin can instead release
                        the claim, which hands the request back to the pending
                        queue so it can be approved or rejected again — the way
                        out of an approval that can never complete. */}
                    {req.status === "APPROVAL_IN_PROGRESS" && (
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className="flex gap-2">
                          {canReleaseApprovalClaim ? (
                            <ViewOnlyActionButton
                              canEdit={canEdit}
                              describeReason={false}
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setReviewDialog({
                                  request: req,
                                  action: "release",
                                })
                              }
                              disabled={deletionRecovery?.request.id === req.id}
                            >
                              Release approval
                            </ViewOnlyActionButton>
                          ) : null}
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            size="sm"
                            variant="destructive"
                            onClick={() =>
                              setReviewDialog({ request: req, action: "approve" })
                            }
                            disabled={deletionRecovery?.request.id === req.id}
                          >
                            Resume approval
                          </ViewOnlyActionButton>
                        </div>
                        <p className="text-xs text-warning-11 max-w-56 text-right">
                          Approval started and did not finish. Future bookings
                          may already be cancelled.{" "}
                          {canReleaseApprovalClaim
                            ? "Resume to complete it, or release it back to pending to decide again."
                            : "It cannot be rejected while the approval is started; a Full Admin can release it back to pending."}
                        </p>
                      </div>
                    )}
                    {deletionRecovery?.request.id === req.id ? (
                      <p className="text-xs text-warning-11">
                        Partial cleanup recovery is active above; use Retry remaining cleanup.
                      </p>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AdminInitiatedDeletionSection
        sessionMemberId={sessionMemberId}
        statusFilter={statusFilter}
        statusBadge={statusBadge}
        page={adminInitiatedPage}
        setPage={setAdminInitiatedPage}
      />

      {/* Review Dialog (self-service) */}
      <Dialog
        open={!!reviewDialog}
        onOpenChange={(open) => {
          if (!open) {
            setReviewDialog(null);
            setReviewNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === "approve"
                ? "Approve Deletion Request"
                : reviewDialog?.action === "release"
                  ? "Release Started Approval"
                  : "Reject Deletion Request"}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === "approve" ? (
                <>
                  This will permanently anonymise{" "}
                  <strong>
                    {reviewDialog.request.member.firstName}{" "}
                    {reviewDialog.request.member.lastName}
                  </strong>
                  &apos;s account, cancel all future bookings, and deactivate
                  their login. This action cannot be undone.
                </>
              ) : reviewDialog?.action === "release" ? (
                <>
                  This hands the request back to the pending queue so it can be
                  approved or rejected again. Nobody is anonymised and the member
                  is not emailed. {DELETION_APPROVAL_RELEASED_DISCLOSURE} Say why
                  you are releasing it.
                </>
              ) : rejectingReleasedApproval ? (
                <>
                  <strong>{DELETION_APPROVAL_RELEASED_LEAD}</strong>{" "}
                  {DELETION_APPROVAL_RELEASED_DISCLOSURE}{" "}
                  {rejectedMemberHasEmail
                    ? "A reason is required and the member is emailed it: it is the only thing they are told about stays that are already gone, so there is no silent option here."
                    : "A reason is required and is recorded on the request. This member has no email address on file, so nothing can be sent to them."}
                </>
              ) : reviewDialog?.request.member.email ? (
                <>
                  Choose below whether to email the member that their request
                  was not approved — either way the request is rejected.
                </>
              ) : (
                <>
                  The request will be rejected. This member has no email address
                  on file, so no notification is sent.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="review-note">{reviewNoteLabel}</Label>
            <Textarea
              id="review-note"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              /* #2264 — the APPROVE branch is a genuine instruction ("Internal
                 note") and stays inside the box. The REJECT branch was an
                 example of a reason, which read as a reason already typed, so
                 it moves to the hint below. A deterministic id rather than
                 `useFieldHint` because the hint only exists on one branch —
                 an always-spread `aria-describedby` would dangle on the other. */
              placeholder={
                reviewDialog?.action === "reject"
                  ? undefined
                  : reviewDialog?.action === "release"
                    ? undefined
                    : "Internal note"
              }
              aria-describedby={
                reviewDialog?.action === "reject"
                  ? describedByFieldHint(REVIEW_NOTE_HINT_ID)
                  : undefined
              }
              rows={3}
            />
            {reviewDialog?.action === "reject" ? (
              <FieldHint id={REVIEW_NOTE_HINT_ID}>
                {/* #2627: on a released request the stock example is actively
                    misleading — the stays are already gone. This note is the
                    only thing the member is told, so the example says what they
                    actually need to hear. */}
                {deletionApprovalWasReleased(reviewDialog.request)
                  ? "E.g. Your future bookings were cancelled when this deletion was started — contact us if you want to rebook"
                  : "E.g. Outstanding bookings must be resolved first"}
              </FieldHint>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReviewDialog(null);
                setReviewNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            {reviewDialog?.action === "approve" ? (
              // The approve receipt always sends (the member asked for deletion
              // and cannot log in afterwards), so no notify choice here.
              <Button
                variant="destructive"
                onClick={() => handleReview()}
                disabled={submitting}
              >
                {submitting ? "Processing..." : "Approve & Delete Account"}
              </Button>
            ) : reviewDialog?.action === "release" ? (
              // #2627: no member email on this path — the release decides
              // nothing, it only re-opens the decision. The reason is mandatory
              // (the route returns 400 without one), so the control says so
              // rather than letting the submission fail.
              <Button
                onClick={() => handleReview()}
                disabled={submitting || reviewNote.trim().length === 0}
              >
                {submitting ? "Processing..." : "Release back to pending"}
              </Button>
            ) : rejectingReleasedApproval ? (
              // #2627: no "without emailing" here. The member's future stays were
              // cancelled by the started approval and this note is the only thing
              // they are ever told, so the route refuses a suppressed or
              // reasonless rejection with a 400 (#1788's free choice stays on
              // every ordinary rejection, where nothing has been destroyed).
              <Button
                onClick={() =>
                  handleReview(rejectedMemberHasEmail ? true : undefined)
                }
                disabled={submitting || reviewNoteMissing}
              >
                {submitting
                  ? "Processing..."
                  : rejectedMemberHasEmail
                    ? "Reject and email member"
                    : "Reject Request"}
              </Button>
            ) : reviewDialog?.request.member.email ? (
              // #1788: reject with a member on file — two-button email choice.
              <>
                <Button
                  variant="outline"
                  onClick={() => handleReview(false)}
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : "Reject without emailing"}
                </Button>
                <Button
                  onClick={() => handleReview(true)}
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : "Reject and email member"}
                </Button>
              </>
            ) : (
              // No address on file — nothing would send, so reject directly.
              <Button onClick={() => handleReview()} disabled={submitting}>
                {submitting ? "Processing..." : "Reject Request"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}

// Admin-initiated hard-delete review queue (#1938). Fetches DELETE lifecycle
// requests via the shared list API, reusing the page's status filter through
// its PENDING->REQUESTED mapping. Approve/reject goes to the EXISTING lifecycle
// review PATCH, which enforces the second-admin rule server-side (403); the
// disabled buttons here are a UX hint, not the authority.
function AdminInitiatedDeletionSection({
  sessionMemberId,
  statusFilter,
  statusBadge,
  page,
  setPage,
}: {
  sessionMemberId: string;
  statusFilter: string;
  statusBadge: (status: string) => React.ReactNode;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
}) {
  const clubTime = useClubTime();
  const canEdit = useAdminAreaEditAccess("membership");
  const [data, setData] = useState<LifecycleApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [dialog, setDialog] = useState<{
    request: LifecycleRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Rows whose review outcome never came back legibly. A hard delete is
  // irreversible, so its controls stay suppressed until the queue is re-read.
  const [unconfirmedRequestId, setUnconfirmedRequestId] = useState<
    string | null
  >(null);

  // The status filter lives in the parent card header; when it changes, jump
  // back to page 1 so a deep page from the previous filter is never shown.
  useEffect(() => {
    setPage(1);
  }, [setPage, statusFilter]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        action: "DELETE",
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests?${params}`
      );
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load admin-initiated deletion requests.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  /**
   * Same hazard as the self-service queue: an approved hard delete removes the
   * member record permanently, so an unreadable or unreachable response leaves
   * the outcome unknown rather than failed. Suppress that row's controls and
   * force an authoritative re-read instead of leaving Approve live.
   */
  async function enterUnconfirmedReview(requestId: string, cause: string) {
    setDialog(null);
    setNote("");
    setUnconfirmedRequestId(requestId);
    setError(
      `This review could not be confirmed because ${cause}. The record may already have been deleted. Do not retry it — check this request's current status in the reloaded queue first.`,
    );
    setErrorAttentionVersion((version) => version + 1);
    await fetchRequests();
  }

  async function submitReview() {
    if (!dialog) return;
    const pendingRequestId = dialog.request.id;
    setSubmitting(true);
    try {
      let res: Response;
      try {
        res = await fetch(
          `/api/admin/member-lifecycle-action-requests/${pendingRequestId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: dialog.action,
              note: note || undefined,
            }),
          }
        );
      } catch {
        await enterUnconfirmedReview(
          pendingRequestId,
          "the server could not be reached",
        );
        return;
      }

      const parsed = await readReviewResponseBody(res);
      if (!parsed.readable) {
        await enterUnconfirmedReview(
          pendingRequestId,
          res.ok
            ? "the server accepted it but its confirmation could not be read"
            : "the server's response could not be read",
        );
        return;
      }
      const body = parsed.body;
      if (!res.ok) throw new Error(body.error || "Failed");
      setDialog(null);
      setNote("");
      setUnconfirmedRequestId(null);
      fetchRequests();
    } catch (err) {
      setDialog(null);
      setError(err instanceof Error ? err.message : "Failed to process request");
      setErrorAttentionVersion((version) => version + 1);
    } finally {
      setSubmitting(false);
    }
  }

  // Lifecycle requests use REQUESTED for the pending state; the shared badge
  // renderer speaks PENDING, so translate before rendering.
  const renderStatus = (status: string) =>
    statusBadge(status === "REQUESTED" ? "PENDING" : status);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin-initiated deletion requests</CardTitle>
        <CardDescription>
          Permanent hard-delete requests raised by an admin from a member
          record. A different admin must approve or reject each request.
          Filtered by the status selector above.
          {data ? ` ${data.total} total` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FocusedActionError
          id="admin-initiated-deletion-requests-error"
          error={error ?? ""}
          attentionKey={errorAttentionVersion}
          action={
            error ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setError(null)}
              >
                Dismiss
              </Button>
            ) : undefined
          }
        />
        {loading && <p className="text-sm text-muted-foreground py-4">Loading...</p>}
        {!loading && data && data.requests.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
            admin-initiated deletion requests.
          </p>
        )}
        {!loading && data && data.requests.length > 0 && (
          <div className="divide-y">
            {data.requests.map((req) => {
              const isOwnRequest =
                req.requestedByMemberId === sessionMemberId;
              const isUnconfirmed = unconfirmedRequestId === req.id;
              const requesterLabel =
                req.requestedBy?.name ||
                req.requestedBy?.email ||
                "Unknown admin";
              return (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">
                          {req.targetName}
                        </span>
                        {req.member?.email && (
                          <span className="text-sm text-muted-foreground">
                            {req.member.email}
                          </span>
                        )}
                        {renderStatus(req.status)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Requested by {requesterLabel} · {clubTime.instantDateTime(requireInstant(req.requestedAt))}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.reviewNote && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Review note:</span>{" "}
                          {req.reviewNote}
                        </p>
                      )}
                    </div>
                    {req.status === "REQUESTED" && (
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-danger-11 border-danger-6 hover:bg-danger-3"
                            disabled={
                              isOwnRequest || !canEdit || isUnconfirmed
                            }
                            title={
                              !canEdit
                                ? ADMIN_VIEW_ONLY_ACTION_REASON
                                : isOwnRequest
                                  ? "A different admin must review this request"
                                  : isUnconfirmed
                                    ? UNCONFIRMED_REVIEW_REASON
                                    : undefined
                            }
                            onClick={() =>
                              setDialog({ request: req, action: "reject" })
                            }
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={
                              isOwnRequest || !canEdit || isUnconfirmed
                            }
                            title={
                              !canEdit
                                ? ADMIN_VIEW_ONLY_ACTION_REASON
                                : isOwnRequest
                                  ? "A different admin must review this request"
                                  : isUnconfirmed
                                    ? UNCONFIRMED_REVIEW_REASON
                                    : undefined
                            }
                            onClick={() =>
                              setDialog({ request: req, action: "approve" })
                            }
                          >
                            Approve
                          </Button>
                        </div>
                        {isOwnRequest && (
                          <p className="text-xs text-muted-foreground">
                            A different admin must review this request
                          </p>
                        )}
                        {isUnconfirmed && (
                          <p className="text-xs text-warning-11 max-w-56 text-right">
                            {UNCONFIRMED_REVIEW_REASON}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === "approve"
                ? "Approve hard-delete request"
                : "Reject hard-delete request"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.action === "approve" ? (
                <>
                  This will permanently delete{" "}
                  <strong>{dialog.request.targetName}</strong>&apos;s member
                  record. Eligibility is re-checked at approval; this action
                  cannot be undone.
                </>
              ) : (
                <>
                  Reject the request to hard-delete{" "}
                  <strong>{dialog?.request.targetName}</strong>. The record is
                  left unchanged.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="lifecycle-review-note">Note (optional)</Label>
            <Textarea
              id="lifecycle-review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Internal review note"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant={dialog?.action === "approve" ? "destructive" : "default"}
              onClick={submitReview}
              disabled={submitting}
            >
              {submitting
                ? "Processing..."
                : dialog?.action === "approve"
                  ? "Approve & Delete Record"
                  : "Reject Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
