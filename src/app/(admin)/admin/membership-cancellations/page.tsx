"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
import { cn } from "@/lib/utils";

type RequestFilter =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "COMPLETED"
  | "ALL";

type Blocker = {
  type: "owned_booking" | "guest_appearance";
  bookingId: string;
  bookingStatus: string;
  checkIn: string;
  checkOut: string;
  guestAppearanceId?: string;
};

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

const filters: Array<{ value: RequestFilter; label: string }> = [
  { value: "REQUESTED", label: "Open" },
  { value: "COMPLETED", label: "Completed" },
  { value: "REJECTED", label: "Rejected" },
  { value: "WITHDRAWN", label: "Withdrawn" },
  { value: "ALL", label: "All" },
];

const currentPath = "/admin/membership-cancellations";

function formatDateTime(value: string | null) {
  if (!value) return "Not recorded";
  return formatNZDateTime(new Date(value));
}

function formatDateOnly(value: string) {
  return formatNZDate(new Date(value));
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
      ? "border-blue-200 bg-blue-50 text-blue-800"
      : status === "PENDING_CONFIRMATION"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : status === "CANCELLED" || status === "COMPLETED"
          ? "border-green-200 bg-green-50 text-green-800"
          : status === "DECLINED" || status === "REJECTED"
            ? "border-red-200 bg-red-50 text-red-800"
            : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <Badge variant="outline" className={classes}>
      {status === "COMPLETED"
        ? requestStatusLabel(status)
        : participantStatusLabel(status)}
    </Badge>
  );
}

function blockerText(blocker: Blocker) {
  const prefix =
    blocker.type === "owned_booking" ? "Owned booking" : "Guest appearance";
  return `${prefix} ${blocker.bookingId} (${blocker.bookingStatus}) from ${formatDateOnly(
    blocker.checkIn,
  )} to ${formatDateOnly(blocker.checkOut)}`;
}

function canApprove(participant: CancellationParticipant) {
  return participant.status === "REQUESTED" && Boolean(participant.confirmedAt);
}

function canReject(participant: CancellationParticipant) {
  return (
    participant.status === "REQUESTED" ||
    participant.status === "PENDING_CONFIRMATION"
  );
}

export default function MembershipCancellationsPage() {
  const [filter, setFilter] = useState<RequestFilter>("REQUESTED");
  const [data, setData] = useState<CancellationResponse | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const pendingSummary = useMemo(() => {
    if (!data?.pendingCount) return "No cancellation requests awaiting review";
    return `${data.pendingCount} cancellation request${
      data.pendingCount === 1 ? "" : "s"
    } awaiting review`;
  }, [data?.pendingCount]);

  const loadRequests = useCallback(async () => {
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
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load cancellation requests.",
      );
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  async function reviewParticipant(
    requestId: string,
    participantId: string,
    action: "approve" | "reject",
  ) {
    setSubmittingId(`${participantId}:${action}`);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/admin/membership-cancellation-requests/${requestId}/participants/${participantId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note: notes[participantId] || undefined,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Could not review participant.");
      }

      setNotes((prev) => ({ ...prev, [participantId]: "" }));
      setMessage(
        action === "approve"
          ? "Membership cancellation approved and processed."
          : "Membership cancellation participant rejected.",
      );
      await loadRequests();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not review participant.",
      );
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Membership Cancellations
          </h1>
          <p className="mt-1 text-sm text-slate-500">{pendingSummary}</p>
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
          <Button
            variant="outline"
            size="icon"
            onClick={() => loadRequests()}
            disabled={loading}
            aria-label="Refresh cancellation requests"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Review Queue</CardTitle>
          <CardDescription>
            {data ? `${data.total} request${data.total === 1 ? "" : "s"}` : "Loading requests"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <p className="py-6 text-sm text-slate-500">Loading requests...</p>
          )}

          {!loading && data?.requests.length === 0 && (
            <p className="py-6 text-sm text-slate-500">
              No membership cancellation requests match this filter.
            </p>
          )}

          {!loading && data && data.requests.length > 0 && (
            <div className="divide-y">
              {data.requests.map((request) => (
                <section key={request.id} className="space-y-4 py-5 first:pt-0">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-900">
                          Request {request.id.slice(-8)}
                        </h2>
                        {statusBadge(request.status)}
                      </div>
                      <p className="text-sm text-slate-600">
                        Requested by{" "}
                        {request.requestedBy ? (
                          <Link
                            className="font-medium text-slate-900 underline-offset-2 hover:underline"
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
                        on {formatDateTime(request.submittedAt)}
                      </p>
                      {request.reason && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Reason:</span>{" "}
                          {request.reason}
                        </p>
                      )}
                    </div>
                    {request.reviewedAt && (
                      <p className="text-xs text-slate-500">
                        Reviewed {formatDateTime(request.reviewedAt)}
                      </p>
                    )}
                  </div>

                  <div className="space-y-3">
                    {request.participants.map((participant) => {
                      const approveDisabled =
                        submittingId !== null || !canApprove(participant);
                      const rejectDisabled =
                        submittingId !== null || !canReject(participant);

                      return (
                        <div
                          key={participant.id}
                          className="rounded-md border border-slate-200 bg-white p-4"
                        >
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link
                                  className="font-medium text-slate-900 underline-offset-2 hover:underline"
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
                              </div>
                              <p className="text-sm text-slate-500">
                                {participant.email} - {participant.ageTier}
                              </p>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                                <span>
                                  Confirmed:{" "}
                                  {participant.confirmedAt
                                    ? formatDateTime(participant.confirmedAt)
                                    : "Not confirmed"}
                                </span>
                                {participant.declinedAt && (
                                  <span>
                                    Declined: {formatDateTime(participant.declinedAt)}
                                  </span>
                                )}
                                {participant.reviewedAt && (
                                  <span>
                                    Reviewed: {formatDateTime(participant.reviewedAt)}
                                  </span>
                                )}
                              </div>
                              {participant.adminNote && (
                                <p className="text-sm text-slate-600">
                                  <span className="font-medium">Admin note:</span>{" "}
                                  {participant.adminNote}
                                </p>
                              )}
                            </div>
                          </div>

                          {participant.blockers.length > 0 && (
                            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                              <div className="flex gap-2">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                <div>
                                  <p className="font-medium">
                                    Resolve these bookings before approval.
                                  </p>
                                  <ul className="mt-1 list-disc space-y-1 pl-5">
                                    {participant.blockers.map((blocker) => (
                                      <li
                                        key={`${blocker.type}-${blocker.bookingId}-${blocker.guestAppearanceId ?? "owner"}`}
                                      >
                                        {blockerText(blocker)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </div>
                          )}

                          {(canApprove(participant) || canReject(participant)) && (
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
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  variant="outline"
                                  className="border-red-200 text-red-700 hover:bg-red-50"
                                  disabled={rejectDisabled}
                                  onClick={() =>
                                    reviewParticipant(
                                      request.id,
                                      participant.id,
                                      "reject",
                                    )
                                  }
                                >
                                  <XCircle className="h-4 w-4" />
                                  Reject
                                </Button>
                                <Button
                                  disabled={approveDisabled}
                                  onClick={() =>
                                    reviewParticipant(
                                      request.id,
                                      participant.id,
                                      "approve",
                                    )
                                  }
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                  Approve
                                </Button>
                              </div>
                              {!participant.confirmedAt &&
                                participant.status === "PENDING_CONFIRMATION" && (
                                  <p className="text-xs text-slate-500">
                                    Approval is unavailable until this adult confirms
                                    their own cancellation request.
                                  </p>
                                )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
