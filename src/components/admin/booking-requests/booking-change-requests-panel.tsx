"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { buildBookingRequestDatasetPath } from "@/lib/admin-dataset-reset-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";

type RequestFilter = "REQUESTED" | "APPROVED" | "REJECTED" | "ALL";

const requestFilters = new Set<RequestFilter>([
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "ALL",
]);

function isRequestFilter(value: string | null): value is RequestFilter {
  return requestFilters.has(value as RequestFilter);
}

interface BookingChangeRequestData {
  id: string;
  bookingId: string;
  requestedByMemberId: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  requestedChanges: {
    requested?: {
      summary?: string | null;
    };
    payment?: {
      id?: string;
      amountCents?: number;
      refundedAmountCents?: number;
      status?: string;
      xeroInvoiceId?: string | null;
      xeroInvoiceNumber?: string | null;
    } | null;
  };
  reason: string | null;
  /**
   * MEMBER-VISIBLE (#2562). Rendered to the member verbatim on their booking page
   * under "Change Requests", so the field below is labelled for that audience
   * before a decision is submitted.
   */
  adminNotes: string | null;
  /** The officer's PRIVATE note (#2562) — admin surfaces only, never the member. */
  internalNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  reviewedBy: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  linkedModification: {
    id: string;
    createdAt: string;
    modificationType: string;
    priceDiffCents: number;
    changeFeeCents: number;
  } | null;
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
    member: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    };
    payment: {
      id: string;
      amountCents: number;
      refundedAmountCents: number;
      status: string;
      xeroInvoiceId: string | null;
      xeroInvoiceNumber: string | null;
    } | null;
  };
}

/**
 * A lodge night as the calendar day it IS - no timezone, because a calendar day
 * has none (CT-4, #2870; INV-DATE-010). A `@db.Date` crosses the wire as UTC
 * midnight and the kernel's calendar-date formatter pins UTC over that encoding,
 * so the projection is the identity. What this replaces read the day through a
 * ZONE: the identity east of Greenwich, the PREVIOUS DAY west of it.
 */
function formatDate(value: string) {
  return formatClubDate(calendarDateOfSerialisedDbDate(value));
}

/**
 * A real INSTANT, in the club's PERSISTED timezone (CT-4, #2870;
 * INV-CONFIG-002) rather than the container's `TZ`. A hook because that setting
 * reaches the browser as data through `ClubTimeProvider`.
 */
function useInstantFormatter() {
  const clubTime = useClubTime();
  return (value: string | null) =>
    value ? clubTime.instantDateTime(new Date(value)) : null;
}

function statusBadgeClass(status: BookingChangeRequestData["status"]) {
  if (status === "REQUESTED") return "border-warning-6 bg-warning-3 text-warning-11";
  if (status === "APPROVED") return "border-success-6 bg-success-3 text-success-11";
  return "border-border bg-muted text-muted-foreground";
}

interface BookingChangeRequestsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
  canEdit?: boolean;
}

/**
 * One request's un-submitted decision, as the officer has typed it so far.
 *
 * A DRAFT PER REQUEST, keyed by request id, and that is the whole design (#2562
 * review). The three fields used to share one state slot with a `reviewingId`
 * marker naming their owner, and every field's onChange moved the marker — so a
 * keystroke in the internal note or the modification id on one row claimed
 * ownership of the OTHER row's half-written member-facing explanation: the second
 * card displayed it, its decision buttons unlocked on it, and submitting posted
 * one member a sentence written about somebody else's request. On this table
 * `adminNotes` is read verbatim by the member on their own booking page, so that
 * was a privacy failure, not a cosmetic one. Keyed state makes the row-isolation
 * invariant structural: there is no shared slot left for a draft to leak through,
 * whichever field is typed in and in whatever order.
 */
interface DecisionDraft {
  /** The MEMBER-FACING decision explanation (`adminNotes`). */
  adminNotes: string;
  /** The officer's PRIVATE note. Never shown to the member. */
  internalNotes: string;
  linkedModificationId: string;
}

const EMPTY_DECISION_DRAFT: DecisionDraft = {
  adminNotes: "",
  internalNotes: "",
  linkedModificationId: "",
};

const EMPTY_SEARCH_PARAMS: Record<string, string> = {};

function buildBookingChangeRequestsPath(
  basePath: string,
  currentSearch: string,
  fixedSearchParams: Record<string, string>,
  status: RequestFilter,
  requestId: string | null,
) {
  return buildBookingRequestDatasetPath({
    basePath,
    currentSearch,
    fixedSearchParams,
    status,
    defaultStatus: "REQUESTED",
    recordKey: "requestId",
    recordId: requestId,
  });
}

export function BookingChangeRequestsPanel({
  basePath = "/admin/booking-requests",
  fixedSearchParams = EMPTY_SEARCH_PARAMS,
  showHeading = true,
  canEdit = true,
}: BookingChangeRequestsPanelProps) {
  const formatDateTime = useInstantFormatter();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const requestId = searchParams.get("requestId");
  const defaultFilter: RequestFilter = requestId ? "ALL" : "REQUESTED";
  const [requests, setRequests] = useState<BookingChangeRequestData[]>([]);
  const [filter, setFilter] = useState<RequestFilter>(
    isRequestFilter(initialFilter) ? initialFilter : defaultFilter
  );
  const [loading, setLoading] = useState(true);
  /**
   * Every open decision draft, keyed by the request it belongs to.
   *
   * One entry per row the officer has typed into, so a row's fields, the guard on
   * its buttons and the body it submits all read the SAME object and no row can
   * read another's (#2562 review — see `DecisionDraft`). A row nobody has typed
   * into has no entry, which is exactly the empty draft its buttons stay disabled
   * on.
   */
  const [decisionDrafts, setDecisionDrafts] = useState<
    Record<string, DecisionDraft>
  >({});
  /**
   * The ref is the synchronous claim; the state is only its rendered mirror.
   * React can batch two clicks before a disabled prop commits, so state alone lets
   * both handlers PATCH the same request (#2562). A Set keeps other rows usable.
   */
  const decisionInFlightRef = useRef(new Set<string>());
  const [decisionInFlight, setDecisionInFlight] = useState<Set<string>>(
    () => new Set(),
  );
  /** This row's draft as typed, or the empty one. Never another row's. */
  function decisionDraftFor(id: string): DecisionDraft {
    return decisionDrafts[id] ?? EMPTY_DECISION_DRAFT;
  }
  /** Patch one field of one row's draft, leaving every other row untouched. */
  function updateDecisionDraft(id: string, patch: Partial<DecisionDraft>) {
    setDecisionDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY_DECISION_DRAFT), ...patch },
    }));
  }
  /** Drop one row's draft — used on a SUCCESSFUL decision, and only then. */
  function clearDecisionDraft(id: string) {
    setDecisionDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  const [error, setError] = useState("");
  const currentPath = buildBookingChangeRequestsPath(
    basePath,
    searchParams.toString(),
    fixedSearchParams,
    filter,
    requestId,
  );

  useEffect(() => {
    router.replace(currentPath, { scroll: false });
  }, [currentPath, router]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-change-requests?status=${filter}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load booking change requests");
      }
      setRequests(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load booking change requests");
    } finally {
      setLoading(false);
    }
    // setState functions are referentially stable; they are listed so the
    // manual dependencies match what the React Compiler infers.
  }, [filter, setError, setLoading, setRequests]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function reviewRequest(
    request: BookingChangeRequestData,
    status: "APPROVED" | "REJECTED"
  ) {
    if (decisionInFlightRef.current.has(request.id)) return;
    decisionInFlightRef.current.add(request.id);
    setDecisionInFlight((current) => new Set(current).add(request.id));

    // This row's own draft, and nothing else (#2562 review): another row's
    // half-written note is not this member's. Trimmed here so the stored draft
    // keeps the officer's own spacing while the wire body carries neither.
    const draft = decisionDraftFor(request.id);
    setError("");

    try {
      const trimmedAdminNotes = draft.adminNotes.trim();
      const trimmedInternalNotes = draft.internalNotes.trim();
      const trimmedModificationId = draft.linkedModificationId.trim();
      const response = await fetch(`/api/admin/booking-change-requests/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          adminNotes: trimmedAdminNotes || undefined,
          internalNotes: trimmedInternalNotes || undefined,
          linkedModificationId:
            status === "APPROVED" && trimmedModificationId
              ? trimmedModificationId
              : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to review request");
      }

      // Cleared only on SUCCESS, and only THIS row's draft. A failed decision
      // keeps it (#2562 review) so the officer's typed note stays on screen and
      // can be resubmitted, instead of vanishing from the field while surviving
      // in state; and a draft the officer has open on another row is none of this
      // decision's business.
      clearDecisionDraft(request.id);
      toast.success(
        status === "APPROVED"
          ? trimmedModificationId
            ? "Request approved and linked to the booking modification."
            : "Request acknowledged as approved. Apply the actual change on the booking page if it is still required."
          : "Request rejected"
      );
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to review request");
    } finally {
      decisionInFlightRef.current.delete(request.id);
      setDecisionInFlight((current) => {
        const next = new Set(current);
        next.delete(request.id);
        return next;
      });
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
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view booking change requests but cannot approve or
      reject them. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {showHeading ? (
        <div>
          <h1 className="text-3xl font-bold">Booking change requests</h1>
          <p className="mt-1 text-muted-foreground">
            Review locked same-day and past-night booking change requests.
            See also{" "}
            <Link className="underline" href="/admin/booking-requests?tab=approvals">
              booking approvals
            </Link>{" "}
            (new bookings flagged for admin review).
          </p>
        </div>
      ) : null}

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-destructive">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}


      <div className="flex flex-wrap gap-2">
        {(["REQUESTED", "APPROVED", "REJECTED", "ALL"] as const).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {status === "ALL"
              ? "All"
              : status.charAt(0) + status.slice(1).toLowerCase()}
          </Button>
        ))}
        <DatasetResetButton
          disabled={filter === defaultFilter}
          onReset={() => setFilter(defaultFilter)}
        />
      </div>

      {loading ? (
        <div className="py-8 text-center">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No {filter === "ALL" ? "" : filter.toLowerCase() + " "}booking change requests found.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => {
            const summary =
              request.requestedChanges?.requested?.summary ||
              "Locked-period booking change";
            const reviewedAt = formatDateTime(request.reviewedAt);

            return (
              <Card
                key={request.id}
                className={request.id === requestId ? "border-warning-6" : undefined}
              >
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {request.booking.member.firstName} {request.booking.member.lastName}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        Requested by {request.requestedBy.firstName} {request.requestedBy.lastName} on{" "}
                        {formatDateTime(request.createdAt)}
                      </p>
                    </div>
                    <Badge variant="outline" className={statusBadgeClass(request.status)}>
                      {request.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">Dates:</span>{" "}
                      {formatDate(request.booking.checkIn)} to {formatDate(request.booking.checkOut)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status:</span>{" "}
                      {request.booking.status}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Booking total:</span>{" "}
                      {formatCents(request.booking.finalPriceCents)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Payment:</span>{" "}
                      {request.booking.payment
                        ? `${request.booking.payment.status} (${formatCents(request.booking.payment.amountCents)})`
                        : "No payment"}
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted p-3 text-sm">
                    <p className="font-medium text-foreground">{summary}</p>
                    {request.reason ? (
                      <p className="mt-2 text-muted-foreground">{request.reason}</p>
                    ) : null}
                  </div>

                  {request.booking.payment?.xeroInvoiceId ? (
                    <p className="text-sm text-muted-foreground">
                      Xero invoice:{" "}
                      {request.booking.payment.xeroInvoiceNumber ||
                        request.booking.payment.xeroInvoiceId}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-3 text-sm">
                    <Link
                      href={buildHrefWithReturnTo(
                        `/bookings/${request.booking.id}`,
                        currentPath
                      )}
                      className="text-info-11 hover:underline"
                    >
                      Open booking
                    </Link>
                    <Link
                      href={buildHrefWithReturnTo(
                        `/admin/members/${request.booking.member.id}`,
                        currentPath
                      )}
                      className="text-info-11 hover:underline"
                    >
                      Open member
                    </Link>
                  </div>

                  {request.status === "REQUESTED" ? (
                    <div className="space-y-3 rounded-md border border-border p-3">
                      <p className="text-xs text-muted-foreground">
                        Marking a request approved only acknowledges the review.
                        The booking is not edited automatically; open the
                        booking from the link above and apply the change there
                        if it is still feasible. Locked or fully-past date
                        changes are applied from the booking page using the
                        admin override control; when the dates you apply match
                        a date-only request, the override links its modification
                        back to this approved request automatically. If you
                        applied the change another way (or the request also
                        asked for guest changes), paste the booking modification
                        id below to link the audit trail.
                      </p>
                      {/* #2562 — the note SPLIT, and the labelling that makes it
                          safe, on the locked-period half of this table too. The
                          box used to be headed only "Admin notes" while writing
                          the same MEMBER-VISIBLE column the member reads verbatim
                          on their booking page, so an officer recording a
                          judgement about the member had no honest option and no
                          warning. Both fields are drawn together, each saying
                          plainly who reads it, BEFORE the decision is submitted.
                          The invariant is table-wide (DOMAIN_INVARIANTS §
                          adminNotes), and this is the surface whose old label most
                          invited the mistake. */}
                      <div className="space-y-1">
                        <Label htmlFor={`admin-notes-${request.id}`}>
                          Explanation for the member (required)
                        </Label>
                        <p className="text-xs font-semibold text-warning-11">
                          The member will see this. It is shown to them on their own
                          booking page under &ldquo;Change Requests&rdquo;. Neither
                          decision can be sent without it.
                        </p>
                        <Textarea
                          id={`admin-notes-${request.id}`}
                          value={decisionDraftFor(request.id).adminNotes}
                          disabled={!canEdit}
                          title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                          onChange={(event) =>
                            updateDecisionDraft(request.id, {
                              adminNotes: event.target.value,
                            })
                          }
                          maxLength={2000}
                          placeholder="What you decided and why, written for the member."
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`internal-notes-${request.id}`}>
                          Internal note (optional)
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Only admins see this. It is never shown to the member,
                          never emailed to them, and never sent to any member-facing
                          screen — put anything here that you would not say to their
                          face.
                        </p>
                        <Textarea
                          id={`internal-notes-${request.id}`}
                          value={decisionDraftFor(request.id).internalNotes}
                          disabled={!canEdit}
                          title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                          onChange={(event) =>
                            updateDecisionDraft(request.id, {
                              internalNotes: event.target.value,
                            })
                          }
                          maxLength={2000}
                          placeholder="Context for the next officer. The member never reads this."
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`linked-modification-${request.id}`}>
                          Linked booking modification id (optional)
                        </Label>
                        <Input
                          id={`linked-modification-${request.id}`}
                          value={decisionDraftFor(request.id).linkedModificationId}
                          disabled={!canEdit}
                          title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                          onChange={(event) =>
                            updateDecisionDraft(request.id, {
                              linkedModificationId: event.target.value,
                            })
                          }
                          placeholder="Paste the BookingModification id from the booking audit"
                        />
                      </div>
                      {/* Gated on THIS row's own draft (#2562 review). The original
                          rule was `reviewingId === request.id && !adminNotes.trim()`,
                          which enabled both buttons on every row the officer had
                          not typed into — so a decision could be sent with no
                          member-facing explanation at all. The shared-slot repair
                          then left a narrower version of the same hole: typing an
                          internal note on this row moved the ownership marker while
                          the ANOTHER row's explanation was still in the shared slot,
                          so this row's buttons unlocked on somebody else's sentence.
                          The draft is now keyed by request id, so a decision needs
                          this request's own explanation and can carry nothing but
                          this request's own draft — which is what makes the
                          table-wide invariant in DOMAIN_INVARIANTS true rather than
                          aspirational. */}
                      <div className="flex flex-wrap gap-2">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          size="sm"
                          onClick={() => reviewRequest(request, "APPROVED")}
                          disabled={
                            decisionInFlight.has(request.id) ||
                            !decisionDraftFor(request.id).adminNotes.trim()
                          }
                        >
                          Acknowledge as approved
                        </ViewOnlyActionButton>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          size="sm"
                          variant="outline"
                          onClick={() => reviewRequest(request, "REJECTED")}
                          disabled={
                            decisionInFlight.has(request.id) ||
                            !decisionDraftFor(request.id).adminNotes.trim()
                          }
                        >
                          Reject
                        </ViewOnlyActionButton>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                      {request.status === "APPROVED" ? "Approved" : "Rejected"}
                      {reviewedAt ? ` on ${reviewedAt}` : ""}
                      {request.reviewedBy
                        ? ` by ${request.reviewedBy.firstName} ${request.reviewedBy.lastName}`
                        : ""}
                      {/* #2562: after the decision the two notes stay visually
                          separated and labelled, so an officer reading a
                          colleague's decision knows which half the member has
                          already read. */}
                      {request.adminNotes ? (
                        <div className="mt-2 rounded-md border border-border bg-background p-2">
                          <p className="text-xs font-semibold text-foreground">
                            Explanation the member can see
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">
                            {request.adminNotes}
                          </p>
                        </div>
                      ) : null}
                      {request.internalNotes ? (
                        <div className="mt-2 rounded-md border border-dashed border-border bg-background p-2">
                          <p className="text-xs font-semibold text-foreground">
                            Internal note — admins only, never shown to the member
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">
                            {request.internalNotes}
                          </p>
                        </div>
                      ) : null}
                      {request.linkedModification ? (
                        <p className="mt-2 text-muted-foreground">
                          Linked booking modification:{" "}
                          <span className="font-mono">
                            {request.linkedModification.id}
                          </span>{" "}
                          ({request.linkedModification.modificationType},{" "}
                          {formatCents(request.linkedModification.priceDiffCents)}{" "}
                          delta)
                        </p>
                      ) : request.status === "APPROVED" ? (
                        <p className="mt-2 text-warning-11">
                          No booking modification linked. The booking edit may
                          still be outstanding — apply it from the booking page
                          (using the admin override control for locked or
                          fully-past dates); a date-only request links back here
                          automatically when the applied dates match.
                        </p>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}
