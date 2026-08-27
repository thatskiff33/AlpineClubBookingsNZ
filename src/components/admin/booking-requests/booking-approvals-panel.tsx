"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DiagnosticsRecordButton } from "@/components/help-widget/diagnostics-record-button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { buildBookingRequestDatasetPath } from "@/lib/admin-dataset-reset-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";
import { FocusedActionError } from "@/components/focused-action-error";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

type ReviewFilter = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

const reviewFilters = new Set<ReviewFilter>(["PENDING", "APPROVED", "REJECTED", "ALL"]);

function isReviewFilter(value: string | null): value is ReviewFilter {
  return reviewFilters.has(value as ReviewFilter);
}

interface BookingReviewData {
  id: string;
  checkIn: string;
  checkOut: string;
  status: string;
  finalPriceCents: number;
  memberReviewJustification: string | null;
  adminReviewStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  adminReviewNotes: string | null;
  adminReviewedAt: string | null;
  createdAt: string;
  // #2259: the booking's "No emails" switch. The review outcome emails
  // (`booking-review-approved` / `booking-review-rejected`) are booking-scoped,
  // so the mailer withholds them while it is on and the notify prompt stops
  // offering the choice. Served by `/api/admin/booking-reviews`, which is
  // admin-only, so the field never reaches a member.
  noEmails: boolean;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  adminReviewedBy: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  guests: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
  }>;
}

function statusBadgeClass(status: BookingReviewData["adminReviewStatus"]) {
  if (status === "PENDING") return "border-warning-6 bg-warning-3 text-warning-11";
  if (status === "APPROVED") return "border-success-6 bg-success-3 text-success-11";
  return "border-border bg-muted text-muted-foreground";
}

interface BookingApprovalsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
  canEdit?: boolean;
}

const EMPTY_SEARCH_PARAMS: Record<string, string> = {};

function buildBookingApprovalsPath(
  basePath: string,
  currentSearch: string,
  fixedSearchParams: Record<string, string>,
  status: ReviewFilter,
  bookingId: string | null,
) {
  return buildBookingRequestDatasetPath({
    basePath,
    currentSearch,
    fixedSearchParams,
    status,
    defaultStatus: "PENDING",
    recordKey: "bookingId",
    recordId: bookingId,
  });
}

/**
 * A lodge night as the calendar day it IS - no timezone, because a calendar day
 * has none (CT-4, #2870; INV-DATE-010). `checkIn`/`checkOut` are `@db.Date`
 * columns and reach the browser as UTC midnight; the kernel's calendar-date
 * formatter pins UTC over that encoding, so the projection is the identity.
 *
 * WHAT THIS REPLACES projected the same value through a zone, which is the
 * identity for a club east of Greenwich and the PREVIOUS DAY west of it.
 */
function formatStayDate(value: string): string {
  return formatClubDate(calendarDateOfSerialisedDbDate(value));
}

export function BookingApprovalsPanel({
  basePath = "/admin/booking-requests",
  fixedSearchParams = EMPTY_SEARCH_PARAMS,
  showHeading = true,
  canEdit = true,
}: BookingApprovalsPanelProps) {
  /**
   * Real INSTANTS project through the club's PERSISTED timezone (CT-4, #2870;
   * INV-CONFIG-002), not the container's `TZ`. The zone reaches this browser as
   * data through `ClubTimeProvider` and is never read from the viewer's clock.
   */
  const clubTime = useClubTime();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const focusedBookingId = searchParams.get("bookingId");
  const defaultFilter: ReviewFilter = focusedBookingId ? "ALL" : "PENDING";
  const [bookings, setBookings] = useState<BookingReviewData[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>(
    isReviewFilter(initialFilter) ? initialFilter : defaultFilter,
  );
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [recoveryAttentionVersion, setRecoveryAttentionVersion] = useState(0);
  const [decisionRecovery, setDecisionRecovery] = useState<{
    bookingId: string;
    message: string;
  } | null>(null);
  // #1790: which decision is waiting on the admin's notify-or-not choice, and
  // whether the dialog is open. Both approve and reject always email the member
  // (unconditional sends in the route), so the dialog is shown for both. The
  // choice is kept set while the dialog fades out (Radix keeps the content
  // mounted through its exit animation) so the copy never flickers to the other
  // decision's wording.
  const [notifyChoice, setNotifyChoice] = useState<
    {
      bookingId: string;
      decision: "APPROVED" | "REJECTED";
      noEmails: boolean;
    } | null
  >(null);
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const currentPath = buildBookingApprovalsPath(
    basePath,
    searchParams.toString(),
    fixedSearchParams,
    filter,
    focusedBookingId,
  );

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-reviews?status=${filter}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load booking reviews");
      }
      setBookings(Array.isArray(data?.data) ? data.data : []);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load booking reviews");
      return false;
    } finally {
      setLoading(false);
    }
    // setState functions are referentially stable; they are listed so the
    // manual dependencies match what the React Compiler infers.
  }, [filter, setBookings, setError, setLoading]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  useEffect(() => {
    router.replace(currentPath, { scroll: false });
  }, [currentPath, router]);

  function showActionError(message: string) {
    setError(message);
    setErrorAttentionVersion((version) => version + 1);
  }

  // #1790: validate the decision (reject needs admin notes) and then open the
  // notify-choice dialog. Both decisions email the member either way, so the
  // dialog always asks; the actual PATCH runs from confirmNotify.
  function requestDecision(bookingId: string, decision: "APPROVED" | "REJECTED") {
    const adminNotes = notesById[bookingId]?.trim() ?? "";
    if (decision === "REJECTED" && !adminNotes) {
      showActionError("Please add admin notes before rejecting so the member gets a reason.");
      return;
    }
    setError("");
    // #2259: carry the booking's "No emails" state into the choice, read off
    // the already-loaded queue row rather than fetched per action.
    setNotifyChoice({
      bookingId,
      decision,
      noEmails:
        bookings.find((booking) => booking.id === bookingId)?.noEmails === true,
    });
    setNotifyDialogOpen(true);
  }

  // #1790: dispatch the pending decision with the admin's notify choice. Close
  // the dialog without clearing the choice, so the content keeps its wording
  // while it fades out.
  function confirmNotify(notify: boolean) {
    const choice = notifyChoice;
    setNotifyDialogOpen(false);
    if (!choice) return;
    void performDecision(choice.bookingId, choice.decision, notify);
  }

  /**
   * #2259 H1: dispatch the silenced path with NO notify choice at all.
   *
   * `notifyMember: false` makes the route skip the send outright, so the
   * mailer's gate never runs and no `SKIPPED_NO_EMAILS` row is recorded — the
   * booking's withheld-list banner would then omit the very approval or
   * decline just performed. Omitting the flag lets the send be ATTEMPTED and
   * withheld, which records the row and, because the route only audits an
   * explicit `false`, leaves the audit trail honestly showing that the admin
   * made no choice, because none was offered.
   */
  function confirmSilenced() {
    const choice = notifyChoice;
    setNotifyDialogOpen(false);
    if (!choice) return;
    void performDecision(choice.bookingId, choice.decision, undefined, true);
  }

  async function performDecision(
    bookingId: string,
    decision: "APPROVED" | "REJECTED",
    notifyMember: boolean | undefined,
    noEmails = false,
  ) {
    const adminNotes = notesById[bookingId]?.trim() ?? "";
    setReviewingId(bookingId);
    setError("");
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: decision,
          adminNotes,
          // Absent = notify (the route's documented default), which is what
          // lets the gate withhold and record on a silenced booking.
          ...(notifyMember !== undefined ? { notifyMember } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (
          decision === "REJECTED" &&
          data.reviewRecorded === true &&
          (data.cancellationPending === true ||
            data.cancellationStatusUnconfirmed === true)
        ) {
          const recoveryBase = data.cancellationPending === true
            ? "The rejection was recorded, but cancellation is still pending. Do not reject this booking again."
            : "The rejection was recorded, but the booking's cancellation status could not be confirmed. Do not reject this booking again.";
          setBookings((current) =>
            current.filter((booking) => booking.id !== bookingId),
          );
          setDecisionRecovery({ bookingId, message: recoveryBase });
          setRecoveryAttentionVersion((version) => version + 1);
          const refreshed = await fetchBookings();
          // The refresh outcome is folded into the durable recovery below; do
          // not duplicate it in the ordinary action region or steal focus.
          setError("");
          const refreshResult = refreshed
            ? " The latest review queue was loaded; open the booking and check its cancellation status."
            : " The review queue could not be refreshed. This warning remains active; open the booking and check its cancellation status.";
          setDecisionRecovery({
            bookingId,
            message: `${recoveryBase}${refreshResult}`,
          });
          setRecoveryAttentionVersion((version) => version + 1);
          return;
        }
        throw new Error(data.error || "Failed to record decision");
      }
      setNotesById((prev) => {
        const next = { ...prev };
        delete next[bookingId];
        return next;
      });
      // #1790 honesty: approve sends only the review-approved email, so
      // suppressing it means no email at all. Reject also triggers the shared
      // cancellation flow, whose cancellation notice is deliberately
      // always-notify (#1730, DOMAIN_INVARIANTS), so a suppressed reject only
      // withholds the review-declined explainer — the member is still emailed.
      //
      // #2259: with the switch on, the cancellation notice the reject branch
      // above relies on is withheld too, so "the member is still emailed" is
      // false — say nothing was sent at all.
      const suppressedNote = noEmails
        ? " Emails are off for this booking, so nothing was sent — the withheld messages are listed on the booking."
        : notifyMember === false
          ? decision === "APPROVED"
            ? " The member was not emailed."
            : " The review-declined email was not sent."
          : "";
      toast.success(
        (decision === "APPROVED" ? "Booking approved." : "Booking rejected and cancelled.") +
          suppressedNote,
      );
      await fetchBookings();
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to record decision");
    } finally {
      setReviewingId(null);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view bookings awaiting approval but cannot decide
      them. Bookings edit access is required to approve or reject a booking.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {showHeading ? (
        <div>
          <h1 className="text-3xl font-bold">Booking approvals</h1>
          <p className="mt-1 text-muted-foreground">
            Review bookings that need admin approval before they can be paid.
            See also{" "}
            <Link className="underline" href="/admin/booking-requests?tab=changes">
              booking change requests
            </Link>{" "}
            and{" "}
            <Link className="underline" href="/admin/refund-requests">
              refund requests
            </Link>
            .
          </p>
        </div>
      ) : null}

      <FocusedActionError
        id="booking-approvals-recovery"
        error={decisionRecovery?.message ?? ""}
        attentionKey={recoveryAttentionVersion}
        heading={decisionRecovery ? "Rejection recorded - cancellation pending" : undefined}
        action={
          decisionRecovery ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={buildHrefWithReturnTo(
                  `/bookings/${encodeURIComponent(decisionRecovery.bookingId)}`,
                  currentPath,
                )}
              >
                Open affected booking
              </Link>
            </Button>
          ) : undefined
        }
      />
      <FocusedActionError
        id="booking-approvals-error"
        error={error}
        attentionKey={errorAttentionVersion}
        action={
          error ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setError("")}>
              Dismiss
            </Button>
          ) : undefined
        }
      />


      <div className="flex flex-wrap gap-2">
        {(["PENDING", "APPROVED", "REJECTED", "ALL"] as const).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
          </Button>
        ))}
        <DatasetResetButton
          disabled={filter === defaultFilter}
          onReset={() => setFilter(defaultFilter)}
        />
      </div>

      {loading ? (
        <div className="py-8 text-center">Loading...</div>
      ) : bookings.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No {filter === "ALL" ? "" : filter.toLowerCase() + " "}booking reviews found.
        </div>
      ) : (
        <div className="space-y-4">
          {bookings.map((booking) => {
            const decided = booking.adminReviewStatus !== "PENDING";
            const highlighted = booking.id === focusedBookingId;
            return (
              <Card
                key={booking.id}
                className={highlighted ? "border-warning-6" : undefined}
              >
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {booking.member.firstName} {booking.member.lastName}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Created {clubTime.instantDateTime(new Date(booking.createdAt))} —{" "}
                        <Link href={`/admin/bookings/${booking.id}`} className="underline">
                          view booking
                        </Link>
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className={statusBadgeClass(booking.adminReviewStatus)}>
                        {booking.adminReviewStatus ?? "—"}
                      </Badge>
                      {/* #2812 — the approvals queue is the single most likely
                          place to ask "why will this booking not confirm?", and
                          it was the one review surface #2378's D11 wiring left
                          out (its registry row pointed at a redirect). Beside
                          the review status, same as the other three lists. */}
                      <DiagnosticsRecordButton
                        recordId={booking.id}
                        subject={`the booking for ${booking.member.firstName} ${booking.member.lastName} awaiting review`}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">Dates:</span>{" "}
                      {formatStayDate(booking.checkIn)} to{" "}
                      {formatStayDate(booking.checkOut)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status:</span> {booking.status}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Total:</span>{" "}
                      {formatCents(booking.finalPriceCents)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Guests:</span>{" "}
                      {booking.guests.length}
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted p-3 text-sm">
                    <p className="font-medium text-foreground">Guests on this booking</p>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                      {booking.guests.map((guest) => (
                        <li key={guest.id}>
                          {guest.firstName} {guest.lastName} — {guest.ageTier}
                          {guest.isMember ? " (member)" : ""}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {booking.memberReviewJustification && (
                    <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm">
                      <p className="font-medium text-warning-11">
                        Member&apos;s reason for booking without an adult
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-warning-11">
                        {booking.memberReviewJustification}
                      </p>
                    </div>
                  )}

                  {decided ? (
                    <div className="rounded-md border bg-muted p-3 text-sm">
                      <p className="font-medium text-foreground">
                        Decision: {booking.adminReviewStatus}
                        {booking.adminReviewedBy
                          ? ` by ${booking.adminReviewedBy.firstName} ${booking.adminReviewedBy.lastName}`
                          : ""}
                        {booking.adminReviewedAt
                          ? ` on ${clubTime.instantDateTime(new Date(booking.adminReviewedAt))}`
                          : ""}
                      </p>
                      {booking.adminReviewNotes && (
                        <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                          {booking.adminReviewNotes}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-sm font-medium" htmlFor={`notes-${booking.id}`}>
                        Admin notes (required to reject; optional for approval)
                      </label>
                      <Textarea
                        id={`notes-${booking.id}`}
                        value={notesById[booking.id] ?? ""}
                        disabled={!canEdit}
                        title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                        onChange={(event) =>
                          setNotesById((prev) => ({ ...prev, [booking.id]: event.target.value }))
                        }
                        rows={3}
                        maxLength={2000}
                        placeholder="Explain your decision. The member will see this note."
                      />
                      <div className="flex flex-wrap gap-2">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          onClick={() => requestDecision(booking.id, "APPROVED")}
                          disabled={reviewingId === booking.id}
                        >
                          Approve
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="destructive"
                          onClick={() => requestDecision(booking.id, "REJECTED")}
                          disabled={reviewingId === booking.id}
                        >
                          Reject and cancel
                        </ViewOnlyActionButton>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* #1790: per-decision member-email choice, mirroring the #1695/#1705
          pattern. Both approve and reject email the member either way, so the
          dialog always asks; the choice itself is recorded in the audit log.
          It suppresses only the review approval/rejection notice — the shared
          cancellation flow behind a reject is unaffected. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && reviewingId === null) setNotifyDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.noEmails
                ? notifyChoice.decision === "REJECTED"
                  ? "Decline this booking?"
                  : "Approve this booking?"
                : notifyChoice?.decision === "REJECTED"
                  ? "Email the member about this decline?"
                  : "Email the member about this approval?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.noEmails
                ? notifyChoice.decision === "REJECTED"
                  ? "The booking will be declined and cancelled. Nothing at all is emailed to the member — not even the standard cancellation notice."
                  : "The booking will be approved."
                : notifyChoice?.decision === "REJECTED"
                  ? "The booking is declined and cancelled either way, and the member always receives the standard cancellation notice. Choose whether they also receive the review-declined explainer email — your choice is recorded in the audit log."
                  : "The booking is approved either way. Choose whether the member receives the standard review-approved email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          {/* #2259: with the booking's "No emails" switch on, the review
              outcome email is withheld whatever is chosen — and so, on the
              reject path, is the cancellation notice the copy above would
              otherwise promise. No choice is offered. */}
          {notifyChoice?.noEmails && <BookingNoEmailsNotice />}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={reviewingId !== null}
              onClick={() =>
                notifyChoice?.noEmails ? confirmSilenced() : confirmNotify(false)
              }
            >
              {notifyChoice?.noEmails
                ? notifyChoice.decision === "REJECTED"
                  ? "Reject booking"
                  : "Approve booking"
                : notifyChoice?.decision === "REJECTED"
                  ? "Reject without emailing"
                  : "Approve without emailing"}
            </Button>
            {!notifyChoice?.noEmails && (
              <Button
                disabled={reviewingId !== null}
                onClick={() => confirmNotify(true)}
              >
                {notifyChoice?.decision === "REJECTED"
                  ? "Reject and email member"
                  : "Approve and email member"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
