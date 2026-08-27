"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DiagnosticsRecordButton } from "@/components/help-widget/diagnostics-record-button";
import {
  usePublishDiagnosticsViewState,
  type DiagnosticsViewState,
} from "@/components/help-widget/help-widget-context";
import {
  DIAGNOSTICS_PAGE_NETWORK_ERROR_CODE,
  diagnosticsPageErrorCodeForStatus,
} from "@/lib/diagnostics/page-context/error-code";
import type { DiagnosticsPageErrorCode } from "@/lib/diagnostics/page-context/registry";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";
import { FocusedActionError } from "@/components/focused-action-error";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

interface OfferEmailDelivery {
  status: "QUEUED" | "SENT" | "FAILED" | "BOUNCED" | "SKIPPED_NO_EMAILS" | "MISSING";
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
    // #2258: withheld on purpose by the booking's "No emails" switch.
    | "suppressed"
    // #2258: silenced AND still holding a live offer — an operator must act.
    | "suppressed_live_offer"
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
  // #1769b: the review outcome disambiguates whether a force-confirm lands PAID
  // (and emails the member). A $0 no-adult booking that is APPROVED lands PAID
  // even though requiresAdminReview is still set, so the notify dialog must show.
  adminReviewStatus: string | null;
  // #2258: the per-booking "No emails" switch.
  noEmails: boolean;
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
  // #1723 path 1: the force-confirm landed PAYMENT_PENDING on a stay whose
  // check-out has already passed — the admin just created an unpaid finished
  // stay and should hear about it at creation, not discover it on the queue.
  unpaidFinishedStay: boolean;
  // #1769b: the admin's per-action email choice, when one was offered. null
  // means no choice was made (the force-confirm never sends an email, e.g. a
  // priced or parked-for-review outcome). false = the member was not emailed.
  notifiedMember: boolean | null;
  // #2259: the booking's "No emails" switch decided, not the admin.
  noEmails: boolean;
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

// Real INSTANTS, shown in the club's persisted zone rather than the viewer's
// or the build's (CT-4, #2870; INV-CONFIG-002). `parseInstant` is stricter
// than the `new Date()` it replaces: an offset-less ISO string names a
// wall-clock reading in whichever zone happens to be reading it, so it now
// falls to the placeholder instead of being read in the host's zone.
function formatDateTime(clubTime: BoundClubTime, value: string | null) {
  const instant = value === null ? null : parseInstant(value);
  if (instant === null) {
    return null;
  }

  return clubTime.instantDateTime(instant);
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

function getWaitlistActionContext(clubTime: BoundClubTime, entry: WaitlistEntry) {
  if (entry.status === "WAITLIST_OFFERED") {
    const expires = formatDateTime(clubTime, entry.waitlistOfferExpiresAt);
    return expires ? `Offer expires ${expires}` : "Offer sent; no expiry recorded";
  }

  // #2258: a silenced entry is deliberately excluded from offers, so it will sit
  // here indefinitely. Say so plainly — otherwise it reads as an ordinary entry
  // waiting its turn, and an officer wonders why it is never offered. It still
  // occupies its place in the queue and still counts toward the position shown
  // to the members behind it (see docs/DOMAIN_INVARIANTS.md).
  if (entry.noEmails) {
    return entry.waitlistPosition
      ? `Position #${entry.waitlistPosition} — silenced, will not be offered`
      : "Silenced — will not be offered while emails are off";
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
    case "suppressed":
      return "Offer email withheld (No emails)";
    case "suppressed_live_offer":
      return "Offer live but emails are off — member not told";
    case "missing":
      return "Offer email log missing";
  }
}

function getOfferEmailBadgeClass(delivery: OfferEmailDelivery) {
  if (delivery.needsOperatorAction) {
    return "bg-danger-muted text-danger";
  }

  if (delivery.retryState === "retrying" || delivery.retryState === "queued") {
    return "bg-warning-muted text-warning";
  }

  // #2258: deliberate silence is neither a success nor a problem — render it
  // neutral so it never reads as "the member was told".
  if (delivery.retryState === "suppressed") {
    return "bg-muted text-muted-foreground";
  }

  return "bg-success-muted text-success";
}

function formatOfferEmailDetail(clubTime: BoundClubTime, delivery: OfferEmailDelivery) {
  if (delivery.retryState === "delivered" && delivery.lastAttemptAt) {
    return `Last delivery ${formatDateTime(clubTime, delivery.lastAttemptAt)}`;
  }

  if (delivery.retryState === "queued" && delivery.lastAttemptAt) {
    return `Queued ${formatDateTime(clubTime, delivery.lastAttemptAt)}`;
  }

  if (delivery.errorMessage) {
    return delivery.errorMessage;
  }

  if (delivery.lastAttemptAt) {
    return `Last attempt ${formatDateTime(clubTime, delivery.lastAttemptAt)}`;
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
  const clubTime = useClubTime();
  const router = useRouter();
  // Force Confirm writes /api/admin/bookings/[id]/force-confirm (bookings
  // area). A view-only bookings admin browses the queue but cannot act (#1997).
  const canEditBookings = useAdminAreaEditAccess("bookings");
  const searchParams = useSearchParams();
  // Memoized so the React Compiler treats the derived string as immutable
  // when it is passed to helpers and used as a loadEntries dependency.
  const queryString = useMemo(() => searchParams.toString(), [searchParams]);
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
    // #1769b: carry the admin's email choice through a capacity-exceeded retry
    // so the overbook confirm preserves it.
    notifyMember?: boolean;
    // #2259: and carry the silenced flag, so the retry's post-action copy
    // still says the switch decided rather than falling back to "no choice".
    noEmails?: boolean;
  } | null>(null);
  // #1769b: the per-action email-choice dialog, shown before a force-confirm
  // that would actually send the member a confirmation email.
  // #2259: `noEmails` rides along with the booking id so the dialog can drop
  // the email choice for a silenced booking — the entry row already carries the
  // switch, so nothing extra is fetched per action.
  const [notifyDialog, setNotifyDialog] = useState<{
    bookingId: string;
    noEmails: boolean;
  } | null>(null);
  const [forceConfirmReport, setForceConfirmReport] =
    useState<ForceConfirmReport | null>(null);
  const [error, setError] = useState("");
  /** The code the last QUEUE LOAD failed with, or null (#2816). */
  const [loadErrorCode, setLoadErrorCode] =
    useState<DiagnosticsPageErrorCode | null>(null);
  const [errorAttention, setErrorAttention] = useState(0);
  const [from, setFrom] = useState(fromParam);
  const [to, setTo] = useState(toParam);
  const [pagination, setPagination] = useState({
    page: queryPage,
    pageSize: queryPageSize,
    total: 0,
  });

  // WHAT THIS QUEUE ACTUALLY FILTERED BY, published for AI Diagnostics (#2816,
  // owner decision 13 Aug 2026).
  //
  // `from`/`to` STATE IS A DRAFT — the two inputs only reach the list when
  // "Apply filters" writes them to the URL, so the applied values are
  // `fromParam`/`toParam`, which is exactly what `queryString` sent to the API.
  // Publishing the draft would report a window the operator has typed but not
  // applied.
  //
  // AND ONLY WHEN THE LOAD SUCCEEDED. `/api/admin/waitlist` validates the window
  // with zod and answers 400 on a malformed or over-long one, so the rows on
  // screen are then not a filtered list at all — they are no list. That is the
  // same total-rejection trap the bookings page has, arriving over the wire
  // instead of in a `safeParse`. The failure is published as its ERROR CODE, not
  // as `{}`: `{}` asserts "I applied no filters", which sends a model looking for
  // a filtering explanation when the truth is that nothing loaded (review finding,
  // 13 Aug 2026). The code comes from `loadErrorCode`, not from `error`, because
  // `error` also carries force-confirm failures that leave the queue on screen
  // intact.
  //
  // NO STATUS is published: the route pins `status: { in: [WAITLISTED,
  // WAITLIST_OFFERED] }` and the wire's `status` holds one token, so naming
  // either one alone would tell the model half the queue is not on screen.
  //
  // Always an OBJECT, empty when no window applied — never `undefined`, which
  // means "this page publishes nothing" and hands the widget back to its URL
  // fallback, re-reading the address this page has just declined to trust.
  //
  // The object is rebuilt every render on purpose — the publish hook's dependency
  // is the SERIALISED value, so an unchanged window republishes nothing.
  //
  // ASSIGNED BY NAME onto a typed empty object rather than built as a spread
  // literal: a conditional spread loses object-literal freshness, so TypeScript
  // runs no excess-property check and a field renamed in the wire contract would
  // compile clean here (mutation-proven, review 13 Aug 2026).
  const publishedView: DiagnosticsViewState = {};
  if (loadErrorCode) {
    publishedView.errorCode = loadErrorCode;
  } else {
    const filters: Record<string, string> = {};
    if (fromParam) filters.from = fromParam;
    if (toParam) filters.to = toParam;
    if (Object.keys(filters).length > 0) publishedView.filters = filters;
  }
  usePublishDiagnosticsViewState(publishedView);

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
    // #2816: recorded so the page publishes "there is no list, and here is why"
    // rather than a window that filtered nothing.
    let failure: DiagnosticsPageErrorCode | null = null;

    try {
      const res = await fetch(buildPathWithSearch("/api/admin/waitlist", queryString));
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        failure = diagnosticsPageErrorCodeForStatus(res.status);
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
      failure = failure ?? DIAGNOSTICS_PAGE_NETWORK_ERROR_CODE;
      setError(err instanceof Error ? err.message : "Failed to load waitlist");
      setErrorAttention((value) => value + 1);
    } finally {
      setLoadErrorCode(failure);
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
    // Build the mutable copy from searchParams directly (not queryString):
    // mutating an object seeded from queryString makes the React Compiler
    // treat that memoized dependency as mutable and skip the component.
    const nextParams = new URLSearchParams(searchParams.toString());
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
      params.delete("page");
      params.delete("pageSize");
    });
  }

  const isDatasetDefault =
    from === "" &&
    to === "" &&
    queryPage === 1 &&
    queryPageSize === 25;

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

  async function handleForceConfirm(
    bookingId: string,
    allowOverbook = false,
    notifyMember?: boolean,
    // #2259: whether the switch, rather than the admin, decided. Carried
    // separately from `notifyMember` because the suppressed path deliberately
    // sends NO choice (see the dialog) — so "no choice made" and "silenced"
    // would otherwise be indistinguishable in the post-action copy.
    noEmails = false
  ) {
    setForceConfirming(bookingId);
    setError("");

    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/force-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowOverbook,
          ...(notifyMember !== undefined ? { notifyMember } : {}),
        }),
      });
      const data = (await res.json()) as Record<string, unknown>;

      if (res.ok && data.success) {
        setOverbookDialog(null);
        setNotifyDialog(null);
        setForceConfirmReport({
          bookingId,
          status: readString(data.status),
          overbooked: data.overbooked === true,
          overbookDates: readStringArray(data.overbookDates),
          auditAction: readString(data.auditAction),
          unpaidFinishedStay: data.unpaidFinishedStay === true,
          notifiedMember: notifyMember ?? null,
          noEmails,
        });
        await loadEntries();
      } else if (
        data.error === "CAPACITY_EXCEEDED" &&
        Array.isArray(data.overbookDates)
      ) {
        setForceConfirmReport(null);
        setNotifyDialog(null);
        // Preserve the admin's email choice into the overbook retry (#1769b).
        setOverbookDialog({
          bookingId,
          dates: readStringArray(data.overbookDates),
          notifyMember,
          noEmails,
        });
      } else {
        setForceConfirmReport(null);
        setError(readString(data.error) || "Failed to force-confirm booking");
        setErrorAttention((value) => value + 1);
      }
    } catch {
      /*
        #2668: this sentence used to be typed out here by hand. Force-confirm is
        a CAPACITY write — it can place a booking over a lodge's beds — so a
        surface that says "we could not verify" and then drifts out of step with
        the wording every other unverified write uses is the one that matters
        most to keep in the shared builder.
      */
      setForceConfirmReport(null);
      setError(
        unverifiedWriteMessage(
          "this booking was force-confirmed",
          "Reload the waitlist and check the booking before trying again.",
        ),
      );
      setErrorAttention((value) => value + 1);
    } finally {
      setForceConfirming(null);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in the loading branch too
    so the region exists from the first paint rather than from whenever the
    waitlist fetch settles, and it sits OUTSIDE the `space-y-*` stack so the
    empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditBookings} className="mb-6">
      Your admin role can view the waitlist but cannot force-confirm
      bookings.
    </AdminViewOnlySectionBanner>
  );
  const actionErrorAlert = (
    <FocusedActionError
      id="waitlist-action-error"
      error={error}
      attentionKey={errorAttention}
      className="mb-6 scroll-mt-20"
    />
  );

  if (loading) {
    return (
      <div className="p-6">
        {viewOnlyBanner}
        {actionErrorAlert}
        <div>Loading waitlist...</div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      {actionErrorAlert}
      <div className="space-y-6">
      <AdminPageHeader
        title="Waitlist"
        actions={<Badge variant="secondary">{pagination.total} total</Badge>}
      />

      {/* #1723 path 1 (owner decision B): allowed, but the admin is told at
          creation that this booking is already an unpaid finished stay. */}
      {forceConfirmReport?.unpaidFinishedStay && (
        <Card className="border-warning/20 bg-warning-muted">
          <CardContent className="pt-6 space-y-2">
            <p className="font-medium text-warning">
              Unpaid finished stay created
            </p>
            <p className="text-sm text-warning">
              This booking&apos;s check-out date has already passed, so
              force-confirming it created a payment-pending stay that is
              already finished. It now appears on the{" "}
              <span className="font-medium">Unpaid Finished Stays</span> queue
              — follow up on payment or settle the booking.
            </p>
          </CardContent>
        </Card>
      )}

      {/* #1769b: honest post-action copy when the admin suppressed the
          confirmation email. The booking still landed PAID; only the member
          email was skipped, and the choice is in the audit log. */}
      {(forceConfirmReport?.notifiedMember === false ||
        forceConfirmReport?.noEmails) && (
        <Card className="border-success/20 bg-success-muted">
          <CardContent className="pt-6 space-y-1">
            <p className="font-medium text-success">
              Booking force-confirmed
            </p>
            <p className="text-sm text-success">
              {forceConfirmReport?.noEmails
                ? "The member was not emailed: emails are off for this booking. The withheld confirmation is listed on the booking page — tell the member yourself."
                : "The member was not emailed — your choice is recorded in the audit log."}
            </p>
          </CardContent>
        </Card>
      )}

      {forceConfirmReport?.overbooked && (
        <Card className="border-danger/20 bg-danger-muted">
          <CardContent className="pt-6 space-y-3">
            <div>
              <p className="font-medium text-danger">
                Force-confirmed overbooked booking
              </p>
              {forceConfirmReport.status && (
                <p className="text-sm text-danger">
                  New status: {bookingStatusLabel(forceConfirmReport.status)}
                </p>
              )}
            </div>
            {forceConfirmReport.overbookDates.length > 0 && (
              <ul className="list-inside list-disc text-sm text-danger">
                {forceConfirmReport.overbookDates.map((date) => (
                  <li key={date}>{date}</li>
                ))}
              </ul>
            )}
            <Link
              href={buildForceConfirmAuditPath(forceConfirmReport)}
              className="text-sm text-primary hover:underline"
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
              <DatasetResetButton
                disabled={isDatasetDefault}
                onReset={handleClearFilters}
              />
            </div>
          </form>
        </CardContent>
      </Card>

      {overbookDialog && (
        <Card className="border-warning/20 bg-warning-muted">
          <CardContent className="pt-6 space-y-3">
            <p className="font-medium text-warning">
              This will overbook the lodge on the following dates:
            </p>
            <ul className="list-inside list-disc text-sm text-warning">
              {overbookDialog.dates.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setOverbookDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  handleForceConfirm(
                    overbookDialog.bookingId,
                    true,
                    overbookDialog.notifyMember,
                    overbookDialog.noEmails ?? false
                  )
                }
                disabled={forceConfirming === overbookDialog.bookingId}
              >
                <AlertTriangle aria-hidden className="h-4 w-4" />
                {forceConfirming === overbookDialog.bookingId
                  ? "Confirming..."
                  : "Confirm Anyway (Overbook)"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* #1769b (#1705 pattern): a force-confirm that lands PAID ($0 + review
          resolved) sends the member a confirmation email. The admin chooses,
          per action, whether that email is sent; both choices confirm the
          booking identically and the choice is recorded in the audit log.
          Shown only when an email would actually be sent.

          #2259: with the booking's "No emails" switch on there is no choice to
          make — the mailer withholds the confirmation either way — so the
          prompt states that and offers only the send-nothing action. */}
      {notifyDialog && (
        <Card className="border-warning/20 bg-warning-muted">
          <CardContent className="pt-6 space-y-3">
            <p className="font-medium text-warning">
              {notifyDialog.noEmails
                ? "Force-confirm this booking?"
                : "Email the member about this confirmation?"}
            </p>
            <p className="text-sm text-warning">
              Force-confirming this booking confirms it as paid.{" "}
              {notifyDialog.noEmails
                ? ""
                : "Choose whether the member receives the standard booking confirmation email — your choice is recorded in the audit log."}
            </p>
            {notifyDialog.noEmails && <BookingNoEmailsNotice />}
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={() => setNotifyDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  // #2259 H1: with the switch on, send NO choice rather than
                  // notifyMember:false. `false` makes the route skip the send,
                  // so the mailer's gate never runs and no withheld row is
                  // recorded — the booking's banner would then omit the very
                  // confirmation this action suppressed.
                  handleForceConfirm(
                    notifyDialog.bookingId,
                    false,
                    notifyDialog.noEmails ? undefined : false,
                    notifyDialog.noEmails
                  )
                }
                disabled={forceConfirming === notifyDialog.bookingId}
              >
                {notifyDialog.noEmails
                  ? "Force-confirm booking"
                  : "Confirm without emailing"}
              </Button>
              {!notifyDialog.noEmails && (
                <Button
                  onClick={() =>
                    handleForceConfirm(notifyDialog.bookingId, false, true)
                  }
                  disabled={forceConfirming === notifyDialog.bookingId}
                >
                  Confirm and email member
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No waitlisted bookings match the current filters
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Showing {resultStart}-{resultEnd} of {pagination.total}
          </p>
          <AdminDataTable>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>Stay</TableHead>
                <TableHead>Guests</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.waitlistPosition ?? "-"}</TableCell>
                  <TableCell>
                    <Link
                      href={buildHrefWithReturnTo(
                        `/admin/members/${entry.memberId}`,
                        currentWaitlistPath
                      )}
                      className="hover:underline"
                    >
                      <div className="font-medium text-primary">{entry.memberName}</div>
                      <div className="text-xs text-muted-foreground">{entry.memberEmail}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div>{entry.checkIn}</div>
                    <div className="text-xs text-muted-foreground">to {entry.checkOut}</div>
                  </TableCell>
                  <TableCell>{entry.guestCount}</TableCell>
                  <TableCell>
                    ${(entry.finalPriceCents / 100).toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge variant="secondary" className={bookingStatusClass(entry.status)}>
                        {bookingStatusLabel(entry.status)}
                      </Badge>
                      {entry.requiresAdminReview && (
                        <p className="text-xs text-warning">
                          {entry.adminReviewReason || "Admin review required"}
                        </p>
                      )}
                      {/* #2378 D11 — beside the status, which is the thing the
                          operator is asking about. Renders nothing unless the widget
                          says Diagnostics is available to this admin. */}
                      <DiagnosticsRecordButton
                        recordId={entry.id}
                        subject={`the waitlisted booking for ${entry.memberName}, ${entry.checkIn}`}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={buildHrefWithReturnTo(
                        `/bookings/${entry.id}`,
                        currentWaitlistPath
                      )}
                      className="text-primary hover:underline"
                    >
                      View booking
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {getWaitlistActionContext(clubTime, entry)}
                    </p>
                    {entry.offerEmailDelivery && (
                      <div className="mt-2 space-y-1">
                        <Badge
                          variant="secondary"
                          className={getOfferEmailBadgeClass(entry.offerEmailDelivery)}
                        >
                          {getOfferEmailSummary(entry.offerEmailDelivery)}
                        </Badge>
                        {formatOfferEmailDetail(clubTime, entry.offerEmailDelivery) && (
                          <p className="max-w-xs text-xs text-muted-foreground">
                            {formatOfferEmailDetail(clubTime, entry.offerEmailDelivery)}
                          </p>
                        )}
                        {entry.offerEmailDelivery.needsOperatorAction &&
                          (entry.offerEmailDelivery.retryState ===
                          "suppressed_live_offer" ? (
                            // #2258: nothing failed to deliver, so email
                            // recovery is the wrong place to send an officer.
                            // The fix is on the booking itself.
                            <Link
                              href={`/admin/bookings/${entry.id}`}
                              className="block text-xs text-primary hover:underline"
                            >
                              Open the booking — turn emails back on or retract
                              the offer
                            </Link>
                          ) : (
                            <Link
                              href="/admin/email-deliverability"
                              className="block text-xs text-primary hover:underline"
                            >
                              Review email recovery
                            </Link>
                          ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{formatDateTime(clubTime, entry.createdAt)}</TableCell>
                  <TableCell>
                    <ViewOnlyActionButton
                      canEdit={canEditBookings}
                      describeReason={false}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        // #1769b: a force-confirm only emails the member when
                        // it lands PAID ($0 stay with admin review resolved).
                        // Offer the email choice only then; otherwise
                        // force-confirm proceeds directly, exactly as before.
                        // A no-adult booking that is already APPROVED still
                        // carries requiresAdminReview but lands PAID, so treat
                        // APPROVED as resolved (matches the route's gate).
                        entry.finalPriceCents === 0 &&
                        (!entry.requiresAdminReview ||
                          entry.adminReviewStatus === "APPROVED")
                          ? setNotifyDialog({
                              bookingId: entry.id,
                              noEmails: entry.noEmails,
                            })
                          : handleForceConfirm(entry.id)
                      }
                      disabled={forceConfirming === entry.id}
                    >
                      {forceConfirming === entry.id ? "..." : "Force Confirm"}
                    </ViewOnlyActionButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminDataTable>
        </div>
      )}

      {pagination.total > 0 && (
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
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
    </div>
  );
}
