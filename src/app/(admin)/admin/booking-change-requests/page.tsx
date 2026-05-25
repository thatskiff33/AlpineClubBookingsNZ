"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
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
  adminNotes: string | null;
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

function formatDate(value: string) {
  return formatNZDate(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return null;
  return formatNZDateTime(new Date(value));
}

function statusBadgeClass(status: BookingChangeRequestData["status"]) {
  if (status === "REQUESTED") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "APPROVED") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

export default function BookingChangeRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const requestId = searchParams.get("requestId");
  const [requests, setRequests] = useState<BookingChangeRequestData[]>([]);
  const [filter, setFilter] = useState<RequestFilter>(
    isRequestFilter(initialFilter) ? initialFilter : requestId ? "ALL" : "REQUESTED"
  );
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [linkedModificationIdInput, setLinkedModificationIdInput] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const currentPath =
    filter === "REQUESTED"
      ? "/admin/booking-change-requests"
      : `/admin/booking-change-requests?status=${filter}`;

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
  }, [filter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function reviewRequest(
    request: BookingChangeRequestData,
    status: "APPROVED" | "REJECTED"
  ) {
    setReviewingId(request.id);
    setError("");
    setSuccess("");

    try {
      const trimmedModificationId = linkedModificationIdInput.trim();
      const response = await fetch(`/api/admin/booking-change-requests/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          adminNotes: adminNotes || undefined,
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

      setAdminNotes("");
      setLinkedModificationIdInput("");
      setSuccess(
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
      setReviewingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Booking Change Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Review locked same-day and past-night booking change requests.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-destructive">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-green-800">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 underline">
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
                className={request.id === requestId ? "border-amber-300" : undefined}
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

                  <div className="rounded-md border bg-slate-50 p-3 text-sm">
                    <p className="font-medium text-slate-900">{summary}</p>
                    {request.reason ? (
                      <p className="mt-2 text-slate-700">{request.reason}</p>
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
                      className="text-blue-600 hover:underline"
                    >
                      Open booking
                    </Link>
                    <Link
                      href={buildHrefWithReturnTo(
                        `/admin/members/${request.booking.member.id}`,
                        currentPath
                      )}
                      className="text-blue-600 hover:underline"
                    >
                      Open member
                    </Link>
                  </div>

                  {request.status === "REQUESTED" ? (
                    <div className="space-y-3 rounded-md border border-slate-200 p-3">
                      <p className="text-xs text-slate-600">
                        Marking a request approved only acknowledges the review.
                        The booking is not edited automatically; open the
                        booking from the link above and apply the change there
                        if it is still feasible. If you have already applied
                        the change, paste the booking modification id below to
                        link the audit trail.
                      </p>
                      <div className="space-y-1">
                        <Label htmlFor={`admin-notes-${request.id}`}>Admin notes</Label>
                        <Textarea
                          id={`admin-notes-${request.id}`}
                          value={reviewingId === request.id ? adminNotes : ""}
                          onChange={(event) => {
                            setReviewingId(request.id);
                            setAdminNotes(event.target.value);
                          }}
                          maxLength={2000}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`linked-modification-${request.id}`}>
                          Linked booking modification id (optional)
                        </Label>
                        <Input
                          id={`linked-modification-${request.id}`}
                          value={
                            reviewingId === request.id
                              ? linkedModificationIdInput
                              : ""
                          }
                          onChange={(event) => {
                            setReviewingId(request.id);
                            setLinkedModificationIdInput(event.target.value);
                          }}
                          placeholder="Paste the BookingModification id from the booking audit"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => reviewRequest(request, "APPROVED")}
                          disabled={reviewingId === request.id && !adminNotes.trim()}
                        >
                          Acknowledge as approved
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => reviewRequest(request, "REJECTED")}
                          disabled={reviewingId === request.id && !adminNotes.trim()}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                      {request.status === "APPROVED" ? "Approved" : "Rejected"}
                      {reviewedAt ? ` on ${reviewedAt}` : ""}
                      {request.reviewedBy
                        ? ` by ${request.reviewedBy.firstName} ${request.reviewedBy.lastName}`
                        : ""}
                      {request.adminNotes ? (
                        <p className="mt-2 text-slate-600">{request.adminNotes}</p>
                      ) : null}
                      {request.linkedModification ? (
                        <p className="mt-2 text-slate-600">
                          Linked booking modification:{" "}
                          <span className="font-mono">
                            {request.linkedModification.id}
                          </span>{" "}
                          ({request.linkedModification.modificationType},{" "}
                          {formatCents(request.linkedModification.priceDiffCents)}{" "}
                          delta)
                        </p>
                      ) : request.status === "APPROVED" ? (
                        <p className="mt-2 text-amber-700">
                          No booking modification linked. The booking edit may
                          still be outstanding.
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
  );
}
