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

type PublicRequestFilter =
  | "QUEUE"
  | "NEW"
  | "VERIFIED"
  | "PRICED"
  | "APPROVED"
  | "DECLINED"
  | "CONVERTED"
  | "ALL";

const publicRequestFilters = new Set<PublicRequestFilter>([
  "QUEUE",
  "NEW",
  "VERIFIED",
  "PRICED",
  "APPROVED",
  "DECLINED",
  "CONVERTED",
  "ALL",
]);

function isPublicRequestFilter(value: string | null): value is PublicRequestFilter {
  return publicRequestFilters.has(value as PublicRequestFilter);
}

interface PublicBookingRequestData {
  id: string;
  type: string;
  status: "NEW" | "VERIFIED" | "PRICED" | "APPROVED" | "DECLINED" | "CONVERTED";
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string | null;
  checkIn: string;
  checkOut: string;
  guests: Array<{ firstName: string; lastName: string; ageTier: string }>;
  message: string | null;
  indicativePriceCents: number | null;
  priceCents: number | null;
  verifiedAt: string | null;
  pricedAt: string | null;
  pricedByMemberId: string | null;
  pricedByMemberName: string | null;
  reviewedAt: string | null;
  reviewedByMemberId: string | null;
  reviewedByMemberName: string | null;
  declineReason: string | null;
  convertedBookingId: string | null;
  convertedMemberId: string | null;
  createdAt: string;
}

function formatDate(value: string) {
  return formatNZDate(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return null;
  return formatNZDateTime(new Date(value));
}

function statusBadgeClass(status: PublicBookingRequestData["status"]) {
  if (status === "NEW") return "border-slate-200 bg-slate-100 text-slate-700";
  if (status === "VERIFIED" || status === "PRICED") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "APPROVED" || status === "CONVERTED") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

interface PublicBookingRequestsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
}

const EMPTY_SEARCH_PARAMS: Record<string, string> = {};

const FILTER_LABELS: Record<PublicRequestFilter, string> = {
  QUEUE: "Queue",
  NEW: "Awaiting verification",
  VERIFIED: "Verified",
  PRICED: "Priced",
  APPROVED: "Approved",
  DECLINED: "Declined",
  CONVERTED: "Converted",
  ALL: "All",
};

function buildPublicRequestsPath(
  basePath: string,
  fixedSearchParams: Record<string, string>,
  status: PublicRequestFilter,
  requestId: string | null,
) {
  const params = new URLSearchParams(fixedSearchParams);

  if (requestId) {
    params.set("requestId", requestId);
  }

  if (status !== "QUEUE") {
    params.set("status", status);
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function PublicBookingRequestsPanel({
  basePath = "/admin/booking-requests",
  fixedSearchParams = EMPTY_SEARCH_PARAMS,
  showHeading = true,
}: PublicBookingRequestsPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const requestId = searchParams.get("requestId");
  const [requests, setRequests] = useState<PublicBookingRequestData[]>([]);
  const [filter, setFilter] = useState<PublicRequestFilter>(
    isPublicRequestFilter(initialFilter) ? initialFilter : "QUEUE"
  );
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [declineReasons, setDeclineReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const currentPath = buildPublicRequestsPath(basePath, fixedSearchParams, filter, requestId);

  useEffect(() => {
    router.replace(currentPath, { scroll: false });
  }, [currentPath, router]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-requests?status=${filter}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load booking requests");
      }
      setRequests(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load booking requests");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  function priceInputValue(request: PublicBookingRequestData) {
    if (request.id in priceInputs) return priceInputs[request.id];
    const cents = request.priceCents ?? request.indicativePriceCents;
    return cents != null ? (cents / 100).toFixed(2) : "";
  }

  async function handleSetPrice(request: PublicBookingRequestData) {
    const raw = priceInputValue(request);
    const dollars = Number.parseFloat(raw);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError("Enter a valid price");
      return;
    }
    const priceCents = Math.round(dollars * 100);

    setActioningId(request.id);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${request.id}/price`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceCents }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to set price");
      }
      setSuccess("Price saved");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set price");
    } finally {
      setActioningId(null);
    }
  }

  async function handleApprove(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${request.id}/approve`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(data.fullNights)) {
          throw new Error(
            `The lodge is at capacity for: ${data.fullNights
              .map((d: string) => formatDate(d))
              .join(", ")}`
          );
        }
        throw new Error(data.error || "Failed to approve request");
      }
      setSuccess("Request approved. A payment link has been emailed to the requester.");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve request");
    } finally {
      setActioningId(null);
    }
  }

  async function handleDecline(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    setSuccess("");
    try {
      const reason = declineReasons[request.id]?.trim();
      const response = await fetch(`/api/admin/booking-requests/${request.id}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to decline request");
      }
      setSuccess("Request declined");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to decline request");
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div className="space-y-6">
      {showHeading ? (
        <div>
          <h1 className="text-3xl font-bold">Public booking requests</h1>
          <p className="mt-1 text-muted-foreground">
            Review, price and approve booking requests submitted by non-members from the website.
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

      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-green-800">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(Object.keys(FILTER_LABELS) as PublicRequestFilter[]).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {FILTER_LABELS[status]}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No booking requests found for this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => {
            const isActioning = actioningId === request.id;

            return (
              <Card
                key={request.id}
                className={request.id === requestId ? "border-amber-300" : undefined}
              >
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {request.contactFirstName} {request.contactLastName}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {request.contactEmail}
                        {request.contactPhone ? ` · ${request.contactPhone}` : ""}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Submitted {formatDateTime(request.createdAt)}
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
                      {formatDate(request.checkIn)} to {formatDate(request.checkOut)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Guests:</span> {request.guests.length}
                    </div>
                    {request.indicativePriceCents != null ? (
                      <div>
                        <span className="text-muted-foreground">Indicative price:</span>{" "}
                        {formatCents(request.indicativePriceCents)}
                      </div>
                    ) : null}
                    {request.priceCents != null ? (
                      <div>
                        <span className="text-muted-foreground">Quoted price:</span>{" "}
                        {formatCents(request.priceCents)}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-1 text-sm">
                    {request.guests.map((guest, index) => (
                      <Badge key={index} variant="secondary">
                        {guest.firstName} {guest.lastName} — {guest.ageTier}
                      </Badge>
                    ))}
                  </div>

                  {request.message ? (
                    <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
                      {request.message}
                    </div>
                  ) : null}

                  {request.status === "NEW" ? (
                    <p className="text-sm text-amber-700">
                      Waiting for the requester to verify their email address.
                    </p>
                  ) : null}

                  {(request.status === "VERIFIED" || request.status === "PRICED") ? (
                    <div className="space-y-3 rounded-md border border-slate-200 p-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="space-y-1">
                          <Label htmlFor={`price-${request.id}`}>Price (NZD)</Label>
                          <Input
                            id={`price-${request.id}`}
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-32"
                            value={priceInputValue(request)}
                            onChange={(event) =>
                              setPriceInputs((prev) => ({ ...prev, [request.id]: event.target.value }))
                            }
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSetPrice(request)}
                          disabled={isActioning}
                        >
                          Save price
                        </Button>
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor={`decline-reason-${request.id}`}>Decline reason (optional)</Label>
                        <Textarea
                          id={`decline-reason-${request.id}`}
                          value={declineReasons[request.id] ?? ""}
                          onChange={(event) =>
                            setDeclineReasons((prev) => ({ ...prev, [request.id]: event.target.value }))
                          }
                          maxLength={2000}
                          placeholder="Shown to the requester in the decline email"
                        />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleApprove(request)}
                          disabled={isActioning || request.status !== "PRICED"}
                        >
                          Approve &amp; send payment link
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDecline(request)}
                          disabled={isActioning}
                        >
                          Decline
                        </Button>
                      </div>
                      {request.status === "VERIFIED" ? (
                        <p className="text-xs text-muted-foreground">
                          Set a price before approving.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {request.status === "DECLINED" ? (
                    <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                      Declined
                      {formatDateTime(request.reviewedAt) ? ` on ${formatDateTime(request.reviewedAt)}` : ""}
                      {request.reviewedByMemberName ? ` by ${request.reviewedByMemberName}` : ""}
                      {request.declineReason ? <p className="mt-2">{request.declineReason}</p> : null}
                    </div>
                  ) : null}

                  {(request.status === "APPROVED" || request.status === "CONVERTED") ? (
                    <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                      Approved
                      {formatDateTime(request.reviewedAt) ? ` on ${formatDateTime(request.reviewedAt)}` : ""}
                      {request.reviewedByMemberName ? ` by ${request.reviewedByMemberName}` : ""}
                      {request.pricedByMemberName ? ` · Priced by ${request.pricedByMemberName}` : ""}
                      {request.convertedBookingId ? (
                        <p className="mt-2">
                          <Link
                            href={buildHrefWithReturnTo(
                              `/bookings/${request.convertedBookingId}`,
                              currentPath
                            )}
                            className="text-blue-600 hover:underline"
                          >
                            Open booking
                          </Link>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
