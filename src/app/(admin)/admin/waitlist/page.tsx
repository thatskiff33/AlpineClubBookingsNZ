"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

interface OfferEmailDelivery {
  status: "QUEUED" | "SENT" | "FAILED" | "BOUNCED" | "MISSING";
  emailLogId: string | null;
  attempts: number | null;
  lastAttemptAt: string | null;
  errorMessage: string | null;
  retryState:
    | "delivered"
    | "queued"
    | "retrying"
    | "exhausted"
    | "undeliverable"
    | "missing";
  needsOperatorAction: boolean;
}

interface WaitlistEntry {
  id: string;
  memberName: string;
  memberEmail: string;
  memberId: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
  waitlistPosition: number | null;
  waitlistOfferedAt: string | null;
  waitlistOfferExpiresAt: string | null;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  finalPriceCents: number;
  createdAt: string;
  offerEmailDelivery: OfferEmailDelivery | null;
}

interface ForceConfirmReport {
  bookingId: string;
  status: string | null;
  overbooked: boolean;
  overbookDates: string[];
  auditAction: string | null;
}

function parsePositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePageSize(value: string | null) {
  const parsed = parsePositiveInteger(value, 25);
  return PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : 25;
}

function numberOrFallback(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function getErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function getWaitlistActionContext(entry: WaitlistEntry) {
  if (entry.status === "WAITLIST_OFFERED") {
    const expires = formatDateTime(entry.waitlistOfferExpiresAt);
    return expires ? `Offer expires ${expires}` : "Offer sent; no expiry recorded";
  }

  if (entry.waitlistPosition) {
    return `Position #${entry.waitlistPosition} waiting for capacity`;
  }

  return "Waiting for capacity";
}

function getOfferEmailSummary(delivery: OfferEmailDelivery) {
  switch (delivery.retryState) {
    case "delivered":
      return "Offer email sent";
    case "queued":
      return "Offer email queued";
    case "retrying":
      return `Offer email retrying (${delivery.attempts ?? "?"}/3)`;
    case "exhausted":
      return "Offer email retry exhausted";
    case "undeliverable":
      return "Offer email undeliverable";
    case "missing":
      return "Offer email log missing";
  }
}

function getOfferEmailBadgeClass(delivery: OfferEmailDelivery) {
  if (delivery.needsOperatorAction) {
    return "bg-red-100 text-red-800";
  }

  if (delivery.retryState === "retrying" || delivery.retryState === "queued") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-emerald-100 text-emerald-800";
}

function formatOfferEmailDetail(delivery: OfferEmailDelivery) {
  if (delivery.retryState === "delivered" && delivery.lastAttemptAt) {
    return `Last delivery ${formatDateTime(delivery.lastAttemptAt)}`;
  }

  if (delivery.retryState === "queued" && delivery.lastAttemptAt) {
    return `Queued ${formatDateTime(delivery.lastAttemptAt)}`;
  }

  if (delivery.errorMessage) {
    return delivery.errorMessage;
  }

  if (delivery.lastAttemptAt) {
    return `Last attempt ${formatDateTime(delivery.lastAttemptAt)}`;
  }

  return null;
}

function buildForceConfirmAuditPath(report: ForceConfirmReport) {
  const params = new URLSearchParams({
    eventType: report.auditAction ?? "waitlist.force_confirmed_overbook",
    entityType: "Booking",
    severity: "critical",
    q: report.bookingId,
  });

  return buildPathWithSearch("/admin/audit-log", params);
}

export default function AdminWaitlistPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const queryPage = parsePositiveInteger(searchParams.get("page"), 1);
  const queryPageSize = parsePageSize(searchParams.get("pageSize"));
  const fromParam = searchParams.get("from") ?? "";
  const toParam = searchParams.get("to") ?? "";
  const currentWaitlistPath = buildPathWithSearch("/admin/waitlist", queryString);
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [forceConfirming, setForceConfirming] = useState<string | null>(null);
  const [overbookDialog, setOverbookDialog] = useState<{
    bookingId: string;
    dates: string[];
  } | null>(null);
  const [forceConfirmReport, setForceConfirmReport] =
    useState<ForceConfirmReport | null>(null);
  const [error, setError] = useState("");
  const [from, setFrom] = useState(fromParam);
  const [to, setTo] = useState(toParam);
  const [pagination, setPagination] = useState({
    page: queryPage,
    pageSize: queryPageSize,
    total: 0,
  });

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));
  const resultStart =
    pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const resultEnd = Math.min(pagination.page * pagination.pageSize, pagination.total);

  useEffect(() => {
    setFrom(fromParam);
    setTo(toParam);
  }, [fromParam, toParam]);

  const loadEntries = useCallback(async () => {
    setLoading(true);

    try {
      const res = await fetch(buildPathWithSearch("/api/admin/waitlist", queryString));
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(getErrorMessage(data, "Failed to load waitlist"));
      }

      const nextEntries = Array.isArray(data.entries)
        ? data.entries
        : Array.isArray(data.data)
          ? data.data
          : [];

      setEntries(nextEntries);
      setPagination({
        page: numberOrFallback(data.page, queryPage),
        pageSize: numberOrFallback(data.pageSize, queryPageSize),
        total: numberOrFallback(data.total, nextEntries.length),
      });
      setError("");
    } catch (err) {
      setEntries([]);
      setPagination({
        page: queryPage,
        pageSize: queryPageSize,
        total: 0,
      });
      setError(err instanceof Error ? err.message : "Failed to load waitlist");
    } finally {
      setLoading(false);
    }
  }, [queryPage, queryPageSize, queryString]);

  useEffect(() => {
    let cancelled = false;

    async function initialLoad() {
      if (!cancelled) {
        await loadEntries();
      }
    }

    void initialLoad();

    return () => {
      cancelled = true;
    };
  }, [loadEntries]);

  function updateQuery(mutator: (params: URLSearchParams) => void) {
    const nextParams = new URLSearchParams(queryString);
    mutator(nextParams);
    router.replace(buildPathWithSearch("/admin/waitlist", nextParams), {
      scroll: false,
    });
  }

  function handleApplyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    updateQuery((params) => {
      if (from) {
        params.set("from", from);
      } else {
        params.delete("from");
      }

      if (to) {
        params.set("to", to);
      } else {
        params.delete("to");
      }

      params.set("page", "1");
      params.set("pageSize", String(pagination.pageSize));
    });
  }

  function handleClearFilters() {
    setFrom("");
    setTo("");
    updateQuery((params) => {
      params.delete("from");
      params.delete("to");
      params.set("page", "1");
      params.set("pageSize", String(pagination.pageSize));
    });
  }

  function handlePageSizeChange(nextPageSize: string) {
    updateQuery((params) => {
      params.set("page", "1");
      params.set("pageSize", nextPageSize);
    });
  }

  function handlePageChange(nextPage: number) {
    updateQuery((params) => {
      params.set("page", String(Math.max(1, Math.min(totalPages, nextPage))));
      params.set("pageSize", String(pagination.pageSize));
    });
  }

  async function handleForceConfirm(bookingId: string, allowOverbook = false) {
    setForceConfirming(bookingId);
    setError("");

    const res = await fetch(`/api/admin/bookings/${bookingId}/force-confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowOverbook }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      setOverbookDialog(null);
      setForceConfirmReport({
        bookingId,
        status: readString(data.status),
        overbooked: data.overbooked === true,
        overbookDates: readStringArray(data.overbookDates),
        auditAction: readString(data.auditAction),
      });
      await loadEntries();
    } else if (data.error === "CAPACITY_EXCEEDED" && data.overbookDates) {
      setForceConfirmReport(null);
      setOverbookDialog({ bookingId, dates: data.overbookDates });
    } else {
      setForceConfirmReport(null);
      setError(data.error || "Failed to force-confirm booking");
    }

    setForceConfirming(null);
  }

  if (loading) {
    return <div className="p-6">Loading waitlist...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Waitlist</h1>
        <Badge variant="secondary">{pagination.total} total</Badge>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {forceConfirmReport?.overbooked && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6 space-y-3">
            <div>
              <p className="font-medium text-red-900">
                Force-confirmed overbooked booking
              </p>
              {forceConfirmReport.status && (
                <p className="text-sm text-red-800">
                  New status: {bookingStatusLabel(forceConfirmReport.status)}
                </p>
              )}
            </div>
            {forceConfirmReport.overbookDates.length > 0 && (
              <ul className="list-disc list-inside text-sm text-red-800">
                {forceConfirmReport.overbookDates.map((date) => (
                  <li key={date}>{date}</li>
                ))}
              </ul>
            )}
            <Link
              href={buildForceConfirmAuditPath(forceConfirmReport)}
              className="text-sm text-blue-700 hover:underline"
            >
              View critical audit record
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={handleApplyFilters}
            className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_auto] md:items-end"
          >
            <div className="space-y-2">
              <Label htmlFor="waitlist-from">From</Label>
              <Input
                id="waitlist-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="waitlist-to">To</Label>
              <Input
                id="waitlist-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="waitlist-page-size">Page size</Label>
              <select
                id="waitlist-page-size"
                value={pagination.pageSize}
                onChange={(event) => handlePageSizeChange(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Apply</Button>
              <Button type="button" variant="outline" onClick={handleClearFilters}>
                Clear
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {overbookDialog && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-6 space-y-3">
            <p className="font-medium text-amber-900">
              This will overbook the lodge on the following dates:
            </p>
            <ul className="list-disc list-inside text-sm text-amber-800">
              {overbookDialog.dates.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => setOverbookDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleForceConfirm(overbookDialog.bookingId, true)}
                disabled={forceConfirming === overbookDialog.bookingId}
              >
                {forceConfirming === overbookDialog.bookingId
                  ? "Confirming..."
                  : "Confirm Anyway (Overbook)"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No waitlisted bookings match the current filters
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Showing {resultStart}-{resultEnd} of {pagination.total}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Member</th>
                  <th className="px-3 py-2 font-medium">Stay</th>
                  <th className="px-3 py-2 font-medium">Guests</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2">{entry.waitlistPosition ?? "-"}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={buildHrefWithReturnTo(
                          `/admin/members/${entry.memberId}`,
                          currentWaitlistPath
                        )}
                        className="hover:underline"
                      >
                        <div className="font-medium text-blue-600">{entry.memberName}</div>
                        <div className="text-xs text-gray-500">{entry.memberEmail}</div>
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <div>{entry.checkIn}</div>
                      <div className="text-xs text-gray-500">to {entry.checkOut}</div>
                    </td>
                    <td className="px-3 py-2">{entry.guestCount}</td>
                    <td className="px-3 py-2">
                      ${(entry.finalPriceCents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <Badge variant="secondary" className={bookingStatusClass(entry.status)}>
                          {bookingStatusLabel(entry.status)}
                        </Badge>
                        {entry.requiresAdminReview && (
                          <p className="text-xs text-amber-800">
                            {entry.adminReviewReason || "Admin review required"}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={buildHrefWithReturnTo(
                          `/bookings/${entry.id}`,
                          currentWaitlistPath
                        )}
                        className="text-blue-600 hover:underline"
                      >
                        View booking
                      </Link>
                      <p className="mt-1 text-xs text-gray-500">
                        {getWaitlistActionContext(entry)}
                      </p>
                      {entry.offerEmailDelivery && (
                        <div className="mt-2 space-y-1">
                          <Badge
                            variant="secondary"
                            className={getOfferEmailBadgeClass(entry.offerEmailDelivery)}
                          >
                            {getOfferEmailSummary(entry.offerEmailDelivery)}
                          </Badge>
                          {formatOfferEmailDetail(entry.offerEmailDelivery) && (
                            <p className="max-w-xs text-xs text-gray-500">
                              {formatOfferEmailDetail(entry.offerEmailDelivery)}
                            </p>
                          )}
                          {entry.offerEmailDelivery.needsOperatorAction && (
                            <Link
                              href="/admin/email-deliverability"
                              className="block text-xs text-blue-600 hover:underline"
                            >
                              Review email recovery
                            </Link>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{formatDateTime(entry.createdAt)}</td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleForceConfirm(entry.id)}
                        disabled={forceConfirming === entry.id}
                      >
                        {forceConfirming === entry.id ? "..." : "Force Confirm"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pagination.total > 0 && (
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-500">
            Page {pagination.page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => handlePageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= totalPages}
              onClick={() => handlePageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
