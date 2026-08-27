"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Archive, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MembershipCancellationBlockerNotice } from "@/components/admin/membership-cancellation-blocker-notice";
import {
  MembershipCancellationInvoiceCheckSkippedLine,
  MembershipCancellationInvoiceCheckSkippedNotice,
} from "@/components/admin/membership-cancellation-invoice-check-skipped-notice";
import { MembershipCancellationSharedInvoiceNotice } from "@/components/admin/membership-cancellation-shared-invoice-notice";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { isMembershipCancellationParticipantAwaitingApproval } from "@/lib/membership-cancellation-approval-readiness";
import type {
  MembershipCancellationBlocker,
  MembershipCancellationSharedInvoiceNotice as SharedInvoiceNotice,
} from "@/lib/membership-cancellation-blocker-messages";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import { cn } from "@/lib/utils";

type RequestFilter =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "COMPLETED"
  | "ALL";

/**
 * Family links the approval detached (#2255). Approving a cancellation clears
 * one level of parent links, so cancelling a MIDDLE generation of a
 * three- or four-generation family leaves that member's own dependants without
 * a parent link — and anyone inheriting their email without a mailbox. Neither
 * is re-parented automatically, so the admin is told who to look at.
 */
type OrphanedLinkMember = { id: string; name: string; email: string };
type OrphanedLinks = {
  dependants: OrphanedLinkMember[];
  emailInheritors: OrphanedLinkMember[];
};

/** Only worth showing when something was actually detached. */
function pickDetachedLinks(value: OrphanedLinks | undefined): OrphanedLinks | null {
  if (!value) return null;
  return value.dependants.length > 0 || value.emailInheritors.length > 0
    ? value
    : null;
}

// #2392: the blocker shapes and their wording are shared with the server, so
// the panel below says exactly what the server would say if Approve were
// pressed — including the unpaid-Xero-invoice refusal and how to clear it.
type Blocker = MembershipCancellationBlocker;

type CancellationParticipant = {
  id: string;
  memberId: string;
  name: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  cancelledAt: string | null;
  status: string;
  reason: string | null;
  adminNote: string | null;
  confirmationTokenExpiresAt: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
  reviewedAt: string | null;
  cancelledAtParticipant: string | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  blockers: Blocker[];
  // #2400: present when this member's subscription invoice also covers members
  // who are staying, so approving raises no credit note against it.
  sharedInvoiceNotice: SharedInvoiceNotice | null;
  // #2402: true when this participant could be approved but the UNPAID-INVOICE
  // check was not run for this viewer, so the money side of the two notices
  // above is silent because nothing was asked. The booking blockers in
  // `blockers` are complete either way. Said out loud rather than left to look
  // like a clean bill of health.
  invoiceCheckSkipped: boolean;
  // #2383: serialized by membership-cancellation-admin.ts so the queue can say
  // what kind of account is being cancelled. `holdsPrivilegedAccess` is the
  // approval-time Full-Admin guard's own predicate.
  holdsPrivilegedAccess: boolean;
  accountType: "user" | "organisation" | "admin" | "lodge";
  // #2284 (S1): true when this is a non-login member somebody else put on the
  // request, so the "Confirmed" stamp was recorded on their behalf. Surfaced as
  // an explicit note by the row.
  includedWithoutOwnOrSecondAdultConfirmation: boolean;
};

type CancellationRequest = {
  id: string;
  status: string;
  reason: string | null;
  adminNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  participants: CancellationParticipant[];
};

type CancellationResponse = {
  requests: CancellationRequest[];
  pendingCount: number;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type ArchiveRequest = {
  id: string;
  memberId: string;
  action: string;
  status: string;
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  processedAt: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  member: {
    id: string;
    name: string;
    email: string;
    active: boolean;
    canLogin: boolean;
    cancelledAt: string | null;
    archivedAt: string | null;
    archivedReason: string | null;
  } | null;
};

type ArchiveResponse = {
  requests: ArchiveRequest[];
  pendingCount: number;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const filters: Array<{ value: RequestFilter; label: string }> = [
  { value: "REQUESTED", label: "Open" },
  { value: "COMPLETED", label: "Completed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" },
  { value: "ALL", label: "All" },
];

const currentPath = "/admin/membership-cancellations";

// Real INSTANTS, shown in the club's persisted zone rather than the viewer's
// or the build's (CT-4, #2870; INV-CONFIG-002). `parseInstant` is stricter
// than the `new Date()` it replaces: an offset-less ISO string names a
// wall-clock reading in whichever zone happens to be reading it, so it now
// falls to the placeholder instead of being read in the host's zone.
function formatDateTime(clubTime: BoundClubTime, value: string | null) {
  const instant = value === null ? null : parseInstant(value);
  if (instant === null) return "Not recorded";
  return clubTime.instantDateTime(instant);
}

function requestStatusLabel(status: string) {
  switch (status) {
    case "REQUESTED":
      return "Open";
    case "COMPLETED":
      return "Completed";
    case "REJECTED":
      return "Rejected";
    case "WITHDRAWN":
      return "Withdrawn";
    case "APPROVED":
      return "Approved";
    default:
      return status;
  }
}

function participantStatusLabel(status: string) {
  switch (status) {
    case "REQUESTED":
      return "Ready for review";
    case "PENDING_CONFIRMATION":
      return "Awaiting confirmation";
    case "DECLINED":
      return "Declined by member";
    case "REJECTED":
      return "Rejected";
    case "CANCELLED":
      return "Cancelled";
    case "APPROVED":
      return "Approved";
    case "REJOINED":
      return "Rejoined";
    default:
      return status;
  }
}

function statusBadge(status: string) {
  const classes =
    status === "REQUESTED"
      ? "border-info-6 bg-info-3 text-info-11"
      : status === "PENDING_CONFIRMATION"
        ? "border-warning-6 bg-warning-3 text-warning-11"
        : status === "CANCELLED" || status === "COMPLETED"
          ? "border-success-6 bg-success-3 text-success-11"
          : status === "DECLINED" || status === "REJECTED"
            ? "border-danger-6 bg-danger-3 text-danger-11"
            : "border-border bg-muted text-muted-foreground";

  return (
    <Badge variant="outline" className={classes}>
      {status === "COMPLETED"
        ? requestStatusLabel(status)
        : participantStatusLabel(status)}
    </Badge>
  );
}

/**
 * #2402: the SHARED rule, not a copy of it.
 *
 * This used to be `status === "REQUESTED" && confirmedAt` — a hand-made
 * approximation of the server's approval guards that omitted the request's own
 * status and the membership's active/cancelled state. That mattered once the
 * queue stopped loading blockers for rows nobody can approve: a member
 * deactivated out of band still rendered an ENABLED Approve button beside an
 * empty blocker panel, which is precisely the "silence read as a clean bill of
 * health" this issue exists to prevent. Now the button is enabled exactly where
 * the server would accept the approval, and therefore exactly where the checks
 * behind the panel were run.
 */
function canApprove(
  requestStatus: string,
  participant: CancellationParticipant,
) {
  return isMembershipCancellationParticipantAwaitingApproval({
    requestStatus,
    status: participant.status,
    confirmedAt: participant.confirmedAt,
    member: {
      active: participant.active,
      cancelledAt: participant.cancelledAt,
    },
  });
}

function canReject(participant: CancellationParticipant) {
  return (
    participant.status === "REQUESTED" ||
    participant.status === "PENDING_CONFIRMATION"
  );
}

/**
 * Why Approve is unavailable, in the server's own terms — so a disabled button
 * is never unexplained (#2402).
 *
 * Returns null when Approve is available, and when the participant is simply
 * settled: a Rejected or Cancelled row already says so in its status badge, and
 * a second sentence repeating it would be noise. The separation-of-duties case
 * ("you raised this") has its own line further down and is deliberately not
 * duplicated here.
 */
function approvalUnavailableReason(
  requestStatus: string,
  participant: CancellationParticipant,
): string | null {
  if (canApprove(requestStatus, participant)) return null;

  if (!participant.confirmedAt) {
    // Wording preserved exactly from the original PENDING_CONFIRMATION line.
    return participant.status === "REQUESTED" ||
      participant.status === "PENDING_CONFIRMATION"
      ? "Approval is unavailable until this adult confirms their own cancellation request."
      : null;
  }

  if (participant.status !== "REQUESTED") return null;

  if (!participant.active || participant.cancelledAt) {
    return "Approval is unavailable because this membership is already inactive or cancelled — so its Xero and booking checks were not run either. Reject this request instead, or reactivate the membership first.";
  }

  if (requestStatus !== "REQUESTED") {
    return "Approval is unavailable because this request has already been reviewed. Reload the queue to see its current state.";
  }

  return null;
}

export default function MembershipCancellationsPage() {
  const clubTime = useClubTime();
  const { data: session } = useSession();
  const currentAdminId = session?.user?.id;
  // Participant/archive review writes membership-area routes; a view-only
  // membership admin browses the queues but cannot act (#1997).
  const canEditMembership = useAdminAreaEditAccess("membership");
  const [filter, setFilter] = useState<RequestFilter>("REQUESTED");
  const [data, setData] = useState<CancellationResponse | null>(null);
  const [archiveData, setArchiveData] = useState<ArchiveResponse | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [archiveNotes, setArchiveNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [archiveLoading, setArchiveLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [archiveSubmittingId, setArchiveSubmittingId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState("");
  // #2255: survives the reload that follows an approval, and is cleared at the
  // start of the next review, so it always describes the most recent action.
  const [orphanedLinks, setOrphanedLinks] = useState<OrphanedLinks | null>(null);
  // #1787: which cancellation-review action is waiting on the admin's
  // notify-or-not choice, and whether that dialog is open. Every approve and
  // reject fires a member outcome email, so both route through this dialog. The
  // choice is kept set while the dialog fades out so the copy never flickers to
  // the other action's wording.
  const [notifyChoice, setNotifyChoice] = useState<{
    requestId: string;
    participantId: string;
    action: "approve" | "reject";
  } | null>(null);
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);

  const pendingSummary = useMemo(() => {
    const cancellationCount = data?.pendingCount ?? 0;
    const archiveCount = archiveData?.pendingCount ?? 0;
    const parts = [
      cancellationCount > 0
        ? `${cancellationCount} cancellation request${
            cancellationCount === 1 ? "" : "s"
          }`
        : null,
      archiveCount > 0
        ? `${archiveCount} archive request${archiveCount === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);

    if (parts.length === 0) {
      return "No membership lifecycle requests awaiting review";
    }

    return `${parts.join(" and ")} awaiting review`;
  }, [archiveData?.pendingCount, data?.pendingCount]);

  /**
   * Reload the cancellation queue. Returns the failure message when the reload
   * itself failed, and null when it succeeded — because a caller that is about
   * to set an error of its own has to know it is overwriting one (#2392 review,
   * residual 5).
   */
  const loadRequests = useCallback(async (): Promise<string | null> => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({ status: filter });
      const response = await fetch(
        `/api/admin/membership-cancellation-requests?${params.toString()}`,
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Could not load cancellation requests.");
      }
      setData(body);
      return null;
    } catch (err) {
      const failure =
        err instanceof Error
          ? err.message
          : "Could not load cancellation requests.";
      setError(failure);
      return failure;
    } finally {
      setLoading(false);
    }
  }, [filter]);

  const loadArchiveRequests = useCallback(async () => {
    setArchiveLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({
        action: "ARCHIVE",
        status: "REQUESTED",
      });
      const response = await fetch(
        `/api/admin/member-lifecycle-action-requests?${params.toString()}`,
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Could not load archive requests.");
      }
      setArchiveData(body);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load archive requests.",
      );
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  const refreshQueues = useCallback(async () => {
    await Promise.all([loadRequests(), loadArchiveRequests()]);
  }, [loadArchiveRequests, loadRequests]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    loadArchiveRequests();
  }, [loadArchiveRequests]);

  // Bring a refusal into view and under the cursor. `scrollIntoView` is guarded
  // because jsdom does not implement it.
  useEffect(() => {
    const node = errorRef.current;
    if (!error || !node) return;
    node.focus();
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [error]);

  // #1787: open the notify-choice dialog for a given cancellation-review action.
  function openNotifyChoice(
    requestId: string,
    participantId: string,
    action: "approve" | "reject",
  ) {
    setNotifyChoice({ requestId, participantId, action });
    setNotifyDialogOpen(true);
  }

  // #1787: dispatch the pending choice. Close the dialog without clearing the
  // choice so its wording holds while it fades out.
  function confirmNotify(notifyMember: boolean) {
    const choice = notifyChoice;
    setNotifyDialogOpen(false);
    if (!choice) return;
    void reviewParticipant(
      choice.requestId,
      choice.participantId,
      choice.action,
      notifyMember,
    );
  }

  async function reviewParticipant(
    requestId: string,
    participantId: string,
    action: "approve" | "reject",
    notifyMember?: boolean,
  ) {
    setSubmittingId(`${participantId}:${action}`);
    setError("");
    setMessage("");
    setOrphanedLinks(null);

    try {
      const response = await fetch(
        `/api/admin/membership-cancellation-requests/${requestId}/participants/${participantId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note: notes[participantId] || undefined,
            // #1787: only send the flag when a choice was made; omitting it
            // preserves the default-notify behaviour server-side.
            ...(notifyMember !== undefined ? { notifyMember } : {}),
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Could not review participant.");
      }

      setNotes((prev) => ({ ...prev, [participantId]: "" }));
      // #1787: when the admin chose "…without emailing", the standard
      // notified copy would be untrue — state the recorded choice instead.
      const emailSuppressed = notifyMember === false;
      const base =
        action === "approve"
          ? "Membership cancellation approved and processed."
          : "Membership cancellation participant rejected.";
      setMessage(
        emailSuppressed
          ? `${base} The member was not emailed — your choice is recorded in the audit log.`
          : base,
      );
      setOrphanedLinks(pickDetachedLinks(body.orphanedLinks));
      await loadRequests();
    } catch (err) {
      const failure =
        err instanceof Error ? err.message : "Could not review participant.";
      // #2392 (review M6): a refusal is a statement about the queue, not just
      // about this click — most often "Xero says money is owing" on a row whose
      // own panel was loaded before the invoice was raised, or shows nothing at
      // all. Reloading first means the banner and the participant's panel agree,
      // and the participant's panel is where the whole list lives. loadRequests
      // clears the error as it starts, so the refusal is set afterwards.
      //
      // If the reload ALSO failed, saying only the refusal would leave the admin
      // reading a stale queue that looks freshly loaded — the one thing the
      // reload was added to prevent — so both are said, in that order (#2392
      // review, residual 5).
      const reloadFailure = await loadRequests();
      setError(
        reloadFailure
          ? `${failure} The review queue below could not be reloaded either, so it may be out of date: ${reloadFailure}`
          : failure,
      );
    } finally {
      setSubmittingId(null);
    }
  }

  async function reviewArchiveRequest(
    requestId: string,
    action: "approve" | "reject",
  ) {
    setArchiveSubmittingId(`${requestId}:${action}`);
    setError("");
    setMessage("");
    setOrphanedLinks(null);

    try {
      const response = await fetch(
        `/api/admin/member-lifecycle-action-requests/${requestId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note: archiveNotes[requestId] || undefined,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Could not review archive request.");
      }

      setArchiveNotes((prev) => ({ ...prev, [requestId]: "" }));
      setMessage(
        action === "approve"
          ? "Member archived."
          : "Archive request rejected.",
      );
      // #2255: archive runs the same family-link sweep as cancellation, so it
      // gets the same declaration rather than only a count in the audit.
      setOrphanedLinks(pickDetachedLinks(body.orphanedLinks));
      await loadArchiveRequests();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not review archive request.",
      );
    } finally {
      setArchiveSubmittingId(null);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditMembership} className="mb-6">
      Your admin role can view membership cancellations but cannot
      approve or reject them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Membership Cancellations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{pendingSummary}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as RequestFilter)}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filters.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DatasetResetButton
            disabled={filter === "REQUESTED"}
            onReset={() => setFilter("REQUESTED")}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => refreshQueues()}
            disabled={loading || archiveLoading}
            aria-label="Refresh membership lifecycle requests"
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                (loading || archiveLoading) && "animate-spin",
              )}
            />
          </Button>
        </div>
      </div>

      {/* #2392 (review M6): a refusal can be several sentences long and, on a
          full queue, render well above the button that was just pressed. The
          live region is mounted permanently and only its CONTENT is gated —
          same reason as the family-links region below — and the message itself
          takes focus so a keyboard or screen-reader user lands on it instead of
          hunting for it. */}
      <div role="alert">
        {error && (
          <div
            ref={errorRef}
            tabIndex={-1}
            className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11 outline-none"
          >
            {error}
          </div>
        )}
      </div>
      {message && (
        <div className="rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
          {message}
        </div>
      )}
      {/* The live region is mounted permanently and only its CONTENT is gated:
          a polite region injected already-populated is dropped outright by some
          screen-reader/browser pairings, and this text is the only notice an
          admin gets that a family was detached. */}
      <div role="status">
        {orphanedLinks && (
        <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p className="font-medium">
            Family links were cleared by this change.
          </p>
          {orphanedLinks.dependants.length > 0 && (
            <p>
              No longer linked to a parent member:{" "}
              {orphanedLinks.dependants
                .map((member) => `${member.name} (${member.email})`)
                .join(", ")}
              . They were not re-linked to a grandparent — who is responsible
              for a member is not changed automatically. Link them under another
              parent if that is right for this family.
            </p>
          )}
          {orphanedLinks.emailInheritors.length > 0 && (
            <p>
              No longer inheriting a notification email address:{" "}
              {orphanedLinks.emailInheritors
                .map((member) => `${member.name} (${member.email})`)
                .join(", ")}
              . Club email now goes to their own recorded address — which may
              still be a copy of the removed member&apos;s, or a placeholder that
              receives nothing, so check it.
            </p>
          )}
        </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Archive Review Queue</CardTitle>
          <CardDescription>
            {archiveData
              ? `${archiveData.pendingCount} archive request${
                  archiveData.pendingCount === 1 ? "" : "s"
                } awaiting review`
              : "Loading archive requests"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {archiveLoading && (
            <p className="py-6 text-sm text-muted-foreground">
              Loading archive requests...
            </p>
          )}

          {!archiveLoading && archiveData?.requests.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">
              No archive requests are awaiting review.
            </p>
          )}

          {!archiveLoading && archiveData && archiveData.requests.length > 0 && (
            <div className="divide-y">
              {archiveData.requests.map((request) => {
                const requesterIsCurrentAdmin =
                  Boolean(currentAdminId) &&
                  request.requestedBy?.id === currentAdminId;
                const memberHref = `/admin/members/${request.memberId}`;
                const isSubmitting = archiveSubmittingId?.startsWith(
                  `${request.id}:`,
                );

                return (
                  <section
                    key={request.id}
                    className="space-y-4 py-5 first:pt-0"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Archive className="h-4 w-4 text-muted-foreground" />
                          <Link
                            className="font-medium text-foreground underline-offset-2 hover:underline"
                            href={buildHrefWithReturnTo(memberHref, currentPath)}
                          >
                            {request.member?.name ||
                              request.member?.email ||
                              request.memberId}
                          </Link>
                          {statusBadge(request.status)}
                          {request.member?.archivedAt && (
                            <Badge variant="outline">Already archived</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Requested by{" "}
                          {request.requestedBy ? (
                            <Link
                              className="font-medium text-foreground underline-offset-2 hover:underline"
                              href={buildHrefWithReturnTo(
                                `/admin/members/${request.requestedBy.id}`,
                                currentPath,
                              )}
                            >
                              {request.requestedBy.name}
                            </Link>
                          ) : (
                            "Unknown admin"
                          )}{" "}
                          on {formatDateTime(clubTime, request.requestedAt)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Reason:</span>{" "}
                          {request.reason}
                        </p>
                        {request.member?.cancelledAt && (
                          <p className="text-xs text-muted-foreground">
                            Cancelled {formatDateTime(clubTime, request.member.cancelledAt)}
                          </p>
                        )}
                      </div>
                    </div>

                    {requesterIsCurrentAdmin ? (
                      <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                        A different admin must approve or reject this archive
                        request.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="space-y-1.5">
                          <Label htmlFor={`archive-note-${request.id}`}>
                            Review note
                          </Label>
                          <Textarea
                            id={`archive-note-${request.id}`}
                            value={archiveNotes[request.id] ?? ""}
                            onChange={(event) =>
                              setArchiveNotes((prev) => ({
                                ...prev,
                                [request.id]: event.target.value,
                              }))
                            }
                            maxLength={1000}
                            rows={2}
                            placeholder="Optional note for the member and audit log"
                          />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ViewOnlyActionButton
                            canEdit={canEditMembership}
                            describeReason={false}
                            variant="outline"
                            className="border-danger-6 text-danger-11 hover:bg-danger-3"
                            disabled={Boolean(isSubmitting)}
                            onClick={() => reviewArchiveRequest(request.id, "reject")}
                          >
                            <XCircle className="h-4 w-4" />
                            Reject
                          </ViewOnlyActionButton>
                          <ViewOnlyActionButton
                            canEdit={canEditMembership}
                            describeReason={false}
                            variant="destructive"
                            disabled={Boolean(isSubmitting)}
                            onClick={() =>
                              reviewArchiveRequest(request.id, "approve")
                            }
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Approve Archive
                          </ViewOnlyActionButton>
                        </div>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cancellation Review Queue</CardTitle>
          <CardDescription>
            {data ? `${data.total} request${data.total === 1 ? "" : "s"}` : "Loading requests"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <p className="py-6 text-sm text-muted-foreground">Loading requests...</p>
          )}

          {!loading && data?.requests.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">
              No membership cancellation requests match this filter.
            </p>
          )}

          {!loading && data && data.requests.length > 0 && (
            <div className="divide-y">
              {data.requests.map((request) => {
                // #2402: the explanation is a fact about the VIEWER, identical
                // for every affected row, so it is said once per request card
                // and each affected row carries a one-line marker instead.
                const invoiceChecksSkipped = request.participants.filter(
                  (participant) => participant.invoiceCheckSkipped,
                ).length;

                return (
                <section key={request.id} className="space-y-4 py-5 first:pt-0">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-foreground">
                          Request {request.id.slice(-8)}
                        </h2>
                        {statusBadge(request.status)}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Requested by{" "}
                        {request.requestedBy ? (
                          <Link
                            className="font-medium text-foreground underline-offset-2 hover:underline"
                            href={buildHrefWithReturnTo(
                              `/admin/members/${request.requestedBy.id}`,
                              currentPath,
                            )}
                          >
                            {request.requestedBy.name}
                          </Link>
                        ) : (
                          "Unknown member"
                        )}{" "}
                        on {formatDateTime(clubTime, request.submittedAt)}
                      </p>
                      {request.reason && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium">Reason:</span>{" "}
                          {request.reason}
                        </p>
                      )}
                    </div>
                    {request.reviewedAt && (
                      <p className="text-xs text-muted-foreground">
                        Reviewed {formatDateTime(clubTime, request.reviewedAt)}
                      </p>
                    )}
                  </div>

                  <MembershipCancellationInvoiceCheckSkippedNotice
                    count={invoiceChecksSkipped}
                  />

                  <div className="space-y-3">
                    {request.participants.map((participant) => {
                      const requesterIsCurrentAdmin =
                        Boolean(currentAdminId) &&
                        request.requestedBy?.id === currentAdminId;
                      const approvable = canApprove(request.status, participant);
                      const approveDisabled =
                        submittingId !== null ||
                        !approvable ||
                        requesterIsCurrentAdmin;
                      const rejectDisabled =
                        submittingId !== null || !canReject(participant);
                      // #2402: a disabled Approve always says why, so a row whose
                      // checks were never run is never silently inert.
                      const unavailableReason = approvalUnavailableReason(
                        request.status,
                        participant,
                      );

                      return (
                        <div
                          key={participant.id}
                          className="rounded-md border border-border bg-card p-4"
                        >
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link
                                  className="font-medium text-foreground underline-offset-2 hover:underline"
                                  href={buildHrefWithReturnTo(
                                    `/admin/members/${participant.memberId}`,
                                    currentPath,
                                  )}
                                >
                                  {participant.name || participant.email}
                                </Link>
                                {statusBadge(participant.status)}
                                {!participant.active && (
                                  <Badge variant="outline">Inactive</Badge>
                                )}
                                {participant.canLogin ? (
                                  <Badge variant="outline">Login enabled</Badge>
                                ) : (
                                  <Badge variant="outline">No login</Badge>
                                )}
                                {/*
                                  #2383: any account holder is now cancellable,
                                  so the queue has to say what this one IS.
                                  Approving a privileged account needs a Full
                                  Admin and is refused otherwise — the badge is
                                  the same predicate as that guard.
                                */}
                                {participant.holdsPrivilegedAccess && (
                                  <Badge variant="warning">
                                    Holds admin access
                                  </Badge>
                                )}
                                {participant.accountType === "organisation" && (
                                  <Badge variant="outline">Organisation</Badge>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {participant.email} - {participant.ageTier}
                              </p>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>
                                  Confirmed:{" "}
                                  {participant.confirmedAt
                                    ? formatDateTime(clubTime, participant.confirmedAt)
                                    : "Not confirmed"}
                                </span>
                                {participant.declinedAt && (
                                  <span>
                                    Declined: {formatDateTime(clubTime, participant.declinedAt)}
                                  </span>
                                )}
                                {participant.reviewedAt && (
                                  <span>
                                    Reviewed: {formatDateTime(clubTime, participant.reviewedAt)}
                                  </span>
                                )}
                              </div>
                              {/*
                                #2284 (S1): a non-login member somebody else put
                                on this request has no login to confirm with, and
                                there is no second-adult signature step — so the
                                "Confirmed" stamp above was made on their behalf.
                                Say so explicitly, so an auto-stamped confirmation
                                is never mistaken for a personally-given one, and
                                the reviewer applies judgement.
                              */}
                              {participant.includedWithoutOwnOrSecondAdultConfirmation && (
                                <p className="rounded-md border border-warning-6 bg-warning-3 px-2 py-1 text-xs text-warning-11">
                                  Included without their own or a second adult&apos;s
                                  confirmation — this member has no login of their
                                  own, so the confirmation above was recorded on
                                  their behalf.
                                </p>
                              )}
                              {participant.adminNote && (
                                <p className="text-sm text-muted-foreground">
                                  <span className="font-medium">Admin note:</span>{" "}
                                  {participant.adminNote}
                                </p>
                              )}
                            </div>
                          </div>

                          <MembershipCancellationBlockerNotice
                            blockers={participant.blockers}
                            returnTo={currentPath}
                          />

                          <MembershipCancellationSharedInvoiceNotice
                            notice={participant.sharedInvoiceNotice ?? null}
                          />

                          {/* #2402: the MONEY half of the two notices above is
                              only as good as the Xero check behind it, and for a
                              view-only admin that check is not run. This marks
                              which rows, so their silence is never read as
                              "nothing is owing"; the explanation itself sits once
                              at the top of the request. */}
                          <MembershipCancellationInvoiceCheckSkippedLine
                            skipped={Boolean(participant.invoiceCheckSkipped)}
                          />

                          {(approvable || canReject(participant)) && (
                            <div className="mt-4 space-y-3">
                              <div className="space-y-1.5">
                                <Label htmlFor={`note-${participant.id}`}>
                                  Admin note
                                </Label>
                                <Textarea
                                  id={`note-${participant.id}`}
                                  value={notes[participant.id] ?? ""}
                                  onChange={(event) =>
                                    setNotes((prev) => ({
                                      ...prev,
                                      [participant.id]: event.target.value,
                                    }))
                                  }
                                  maxLength={1000}
                                  rows={2}
                                  placeholder="Optional note for the member and audit log"
                                />
                              </div>
                              <div className="rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
                                Paid membership subscriptions are not refunded.
                                Unpaid or overdue subscription invoices are
                                cleared with an allocated Xero credit note —
                                unless the invoice also covers other members who
                                are staying, in which case nothing is credited
                                automatically and it is said above.
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <ViewOnlyActionButton
                                  canEdit={canEditMembership}
                                  describeReason={false}
                                  variant="outline"
                                  className="border-danger-6 text-danger-11 hover:bg-danger-3"
                                  disabled={rejectDisabled}
                                  onClick={() =>
                                    openNotifyChoice(
                                      request.id,
                                      participant.id,
                                      "reject",
                                    )
                                  }
                                >
                                  <XCircle className="h-4 w-4" />
                                  Reject
                                </ViewOnlyActionButton>
                                <ViewOnlyActionButton
                                  canEdit={canEditMembership}
                                  describeReason={false}
                                  disabled={approveDisabled}
                                  onClick={() =>
                                    openNotifyChoice(
                                      request.id,
                                      participant.id,
                                      "approve",
                                    )
                                  }
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Approve
                                </ViewOnlyActionButton>
                              </div>
                              {unavailableReason && (
                                <p className="text-xs text-muted-foreground">
                                  {unavailableReason}
                                </p>
                              )}
                              {requesterIsCurrentAdmin && approvable && (
                                  <p className="text-xs text-warning-11">
                                    A different admin must approve cancellation
                                    requests you initiated.
                                  </p>
                                )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* #1787: per-action member-email choice, mirroring the #1705/#1769a
          pattern. Every approve and reject sends a member outcome email, so the
          dialog is shown for both actions; either choice completes the review
          and the choice itself is recorded in the audit log. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && submittingId === null) setNotifyDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.action === "reject"
                ? "Email the member about this rejection?"
                : "Email the member about this approval?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.action === "reject"
                ? "The cancellation request is rejected either way. Choose whether the member receives the standard rejection email — your choice is recorded in the audit log."
                : "The membership cancellation is approved and processed either way. Choose whether the member receives the standard approval email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={submittingId !== null}
              onClick={() => confirmNotify(false)}
            >
              {notifyChoice?.action === "reject"
                ? "Reject without emailing"
                : "Approve without emailing"}
            </Button>
            <Button
              disabled={submittingId !== null}
              onClick={() => confirmNotify(true)}
            >
              {notifyChoice?.action === "reject"
                ? "Reject and email member"
                : "Approve and email member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
