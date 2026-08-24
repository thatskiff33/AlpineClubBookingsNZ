"use client";

import type { PaymentStatus } from "@prisma/client";
import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import { formatPayloadCalendarDay } from "../_lib/calendar-day";
import { readAdminQueryErrorMessage } from "@/lib/admin-query-error";
import {
  getPaymentsDatasetDefaults,
  PAYMENT_DATASET_QUERY_KEYS,
  resetPaymentsDatasetSearchParams,
  withoutDatasetQueryKeys,
} from "@/lib/admin-dataset-reset-state";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import { useXeroStatus } from "@/hooks/use-xero-status";
import { useXeroOrgShortCode } from "@/hooks/use-xero-org-short-code";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DollarSign,
  CreditCard,
  TrendingUp,
  BarChart2,
  ExternalLink,
  FileText,
  Landmark,
  Receipt,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  MinusCircle,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  AdminFilterBar,
  type AdminFilterChip,
} from "@/components/admin/admin-filter-bar";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { SortHeader } from "@/components/admin/sort-header";
import { Pagination } from "@/components/admin/admin-pagination";
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
import {
  isAppliedPaymentStatus,
  isAppliedPaymentsDate,
  isAppliedPaymentsSearch,
  type AppliedPaymentStatus,
} from "./_applied-query-vocabulary";
import { StatusChip } from "@/components/ui/status-chip";
import { MiniChip } from "@/components/ui/mini-chip";
import { type ChipTone } from "@/lib/chip-tones";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { auditAndPaymentsDateRangePresets } from "@/lib/date-range-presets";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

// #2264 — the id of the single hint shared by the three amount filter boxes.
const PAYMENT_AMOUNT_HINT_ID = "payment-amount-filter-hint";

function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

type PaymentSortBy =
  | "lastUpdated"
  | "checkIn"
  | "member"
  | "booking"
  | "amount"
  | "status"
  | "stripe"
  | "xeroInvoice"
  | "settlement";

type SortDir = "asc" | "desc";
type PaymentSourceFilter = "all" | "STRIPE" | "INTERNET_BANKING";
const paymentSortColumns = new Set<PaymentSortBy>([
  "lastUpdated",
  "checkIn",
  "member",
  "booking",
  "amount",
  "status",
  "stripe",
  "xeroInvoice",
  "settlement",
]);

// The presentational chip family (icon + label) is the shared `MiniChip`, which
// draws its tone -> class map from `@/lib/chip-tones` — the single source shared
// with StatusChip and the other admin tables. This screen uses it for the
// non-status signals it keeps inline (payment source, Xero state, settlement
// kind). Meaning is carried by icon + label, never colour alone.

// Human labels for the active-filter chips. These mirror the option labels shown
// in the filter selects; they are display-only and never affect which rows the
// API returns.
const PAYMENT_STATUS_FILTER_LABELS: Record<AppliedPaymentStatus, string> = {
  PENDING: "Pending",
  PROCESSING: "Processing (awaiting Stripe)",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  REFUNDED: "Refunded / Credited",
  PARTIALLY_REFUNDED: "Partially Refunded / Credited",
};

const PAYMENT_SOURCE_FILTER_LABELS: Record<string, string> = {
  STRIPE: "Stripe",
  INTERNET_BANKING: "Internet Banking",
};

function parsePageParam(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function getSortBy(value: string | null): PaymentSortBy {
  return paymentSortColumns.has(value as PaymentSortBy)
    ? (value as PaymentSortBy)
    : "lastUpdated";
}

function getSortDir(value: string | null): SortDir {
  return value === "asc" ? "asc" : "desc";
}

function getSourceFilter(value: string | null): PaymentSourceFilter {
  return value === "STRIPE" || value === "INTERNET_BANKING" ? value : "all";
}

/** Shown when the refusal carries no field message we can quote (#2685). */
const PAYMENTS_FILTER_FALLBACK_ERROR =
  "That filter could not be applied, so no payments are shown. Check the amount boxes and try again.";

function formatPendingAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) {
    return "Pending age unavailable";
  }

  const ageMs = Math.max(0, Date.now() - created);
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days >= 1) {
    return `Pending ${days}d`;
  }

  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours >= 1) {
    return `Pending ${hours}h`;
  }

  return "Pending <1h";
}

interface PaymentRow {
  id: string;
  bookingId: string;
  amountCents: number;
  source: string;
  reference: string | null;
  status: string;
  stripePaymentIntentId: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  refundedAmountCents: number;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt: string;
  xeroState: string;
  xeroActivity: {
    failed: number;
    partial: number;
    pending: number;
    latestOperationId: string | null;
    latestOperationStatus: string | null;
    latestOperationAt: string | null;
  };
  settlementKind: string;
  booking: {
    id: string;
    status: string;
    checkIn: string;
    checkOut: string;
    creditsFromCancellation: Array<{
      amountCents: number;
      description: string | null;
    }>;
    member: { id: string; firstName: string; lastName: string; email: string };
  };
}

function xeroStateLabel(state: string) {
  switch (state) {
    case "invoiceLinked":
      return "Invoice linked";
    case "invoiceMissing":
      return "Invoice missing";
    case "operationFailed":
      return "Failed activity";
    case "operationPartial":
      return "Partial activity";
    case "operationPending":
      return "Pending activity";
    default:
      return "No invoice needed";
  }
}

// Xero states have no StatusChip `kind`, so they render through the shared
// MiniChip family: a tone + icon carrying the same meaning the old colour-only
// badges did. Restores the distinct hues the five-tone collapse flattened (#156):
// linked = success (green), invoiceMissing = orange (its own accent hue, as the
// old `xeroStateClass` used), partial/pending = warning (amber, distinguished by
// icon), failed = danger (red), not-needed = neutral. Labels are unchanged.
function xeroStateChip(state: string): { tone: ChipTone; icon: LucideIcon } {
  switch (state) {
    case "invoiceLinked":
      return { tone: "success", icon: CheckCircle2 };
    case "invoiceMissing":
      return { tone: "cat4", icon: FileText };
    case "operationFailed":
      return { tone: "danger", icon: XCircle };
    case "operationPartial":
      return { tone: "warning", icon: AlertTriangle };
    case "operationPending":
      return { tone: "warning", icon: Clock };
    default:
      return { tone: "neutral", icon: MinusCircle };
  }
}

// Each cancellation-settlement kind gets a distinct hue (#156): the Settlement
// column previously rendered every kind on the same neutral tone, hiding what
// kind of settlement happened. Icon + label still carry the meaning.
function settlementKindChip(kind: string): { tone: ChipTone; icon: LucideIcon } {
  switch (kind) {
    case "cardRefund":
      return { tone: "info", icon: CreditCard };
    case "accountCredit":
      return { tone: "cat3", icon: Wallet };
    case "mixed":
      // Pulled out of the blue-purple arc (#156): info/indigo/purple crowded
      // three kinds into pale blue, and cardRefund vs mixed co-occur. cat4 orange sits
      // well clear of the other four kinds (info blue / cat3 / cat6 teal).
      return { tone: "cat4", icon: Receipt };
    case "restoredCredit":
      return { tone: "cat6", icon: Wallet };
    case "none":
    default:
      return { tone: "neutral", icon: MinusCircle };
  }
}

function settlementKindLabel(kind: string) {
  switch (kind) {
    case "cardRefund":
      return "Card refund";
    case "accountCredit":
      return "Account credit";
    case "mixed":
      return "Mixed";
    case "restoredCredit":
      return "Restored credit";
    case "none":
    default:
      return "None";
  }
}

function SummaryCard({
  title,
  icon: Icon,
  children,
  valueClassName,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  valueClassName?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-2xl font-bold tabular-nums text-foreground",
            valueClassName,
          )}
        >
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export default function PaymentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Generate Invoice writes the finance-area generate-invoice route; a view-only
  // finance admin browses payments but cannot mint invoices (#1997).
  const canEditFinance = useAdminAreaEditAccess("finance");
  // Org short code for the Xero invoice deep links (#2283). One mount per
  // page; served from the server-side 12h org cache, and null degrades the
  // links to the generic Xero URL rather than hiding them.
  const { connected: xeroConnected } = useXeroStatus();
  const { shortCode: xeroOrgShortCode } = useXeroOrgShortCode(
    xeroConnected === true,
  );
  const [generatingInvoice, setGeneratingInvoice] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [invoiceNotice, setInvoiceNotice] = useState<string | null>(null);
  const [queuedInvoicePaymentIds, setQueuedInvoicePaymentIds] = useState<Record<string, true>>({});
  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [source, setSource] = useState<PaymentSourceFilter>(() =>
    getSourceFilter(searchParams.get("source"))
  );
  const [xeroState, setXeroState] = useState(searchParams.get("xeroState") || "all");
  const [settlement, setSettlement] = useState(searchParams.get("settlement") || "all");
  // The activity window bounds are interpreted in the club time zone by the
  // payments API, so seed the defaults from the club-timezone date rather than
  // the browser's local date (otherwise post-NZ-midnight activity is hidden for
  // operators whose clock trails NZ). Derive the "3 months ago" bound from the
  // same club-day so both ends stay consistent.
  const clubTime = useClubTime();
  const clubToday = clubTime.today();
  const paymentDefaults = getPaymentsDatasetDefaults(clubToday);
  const defaultLastUpdatedFrom = paymentDefaults.lastUpdatedFrom;
  const [lastUpdatedFrom, setLastUpdatedFrom] = useState(
    searchParams.get("lastUpdatedFrom") || defaultLastUpdatedFrom
  );
  const [lastUpdatedTo, setLastUpdatedTo] = useState(
    searchParams.get("lastUpdatedTo") || clubToday
  );
  const [checkInFrom, setCheckInFrom] = useState(searchParams.get("checkInFrom") || "");
  const [checkInTo, setCheckInTo] = useState(searchParams.get("checkInTo") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [amountExact, setAmountExact] = useState(searchParams.get("amountExact") || "");
  const [amountMin, setAmountMin] = useState(searchParams.get("amountMin") || "");
  const [amountMax, setAmountMax] = useState(searchParams.get("amountMax") || "");
  const [sortBy, setSortBy] = useState<PaymentSortBy>(() => getSortBy(searchParams.get("sortBy")));
  const [sortDir, setSortDir] = useState<SortDir>(() => getSortDir(searchParams.get("sortDir")));
  const [page, setPage] = useState(() => parsePageParam(searchParams.get("page")));
  const [pageSize] = useState(25);
  const [data, setData] = useState<PaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ totalRevenueCents: 0, refundedCents: 0, count: 0 });
  const [loading, setLoading] = useState(false);
  /*
    #2685 review — the query the API REFUSED.

    `fetchData` used to be `if (res.ok) { … }` with no `else`, so a 400 left the
    previous query's rows on screen underneath the new filter chip. The operator
    saw a payments table, an active "Amount exact: 007.50" chip, and no
    indication that the two had nothing to do with each other — the commonest
    way to reach it is a leading zero or a thousands separator, neither of which
    looks like a mistake. The rows are now cleared and the reason is rendered
    beside the amount boxes that cause it.
  */
  const [filterError, setFilterError] = useState<string | null>(null);

  // The code the last load failed with, or null. It is state rather than a
  // derivation because the failure is the response's, and it is deliberately NOT
  // the existing `invoiceError`: an invoice action that failed says nothing about
  // whether the list on screen is a list.
  const [loadErrorCode, setLoadErrorCode] =
    useState<DiagnosticsPageErrorCode | null>(null);

  // WHAT THIS PAGE ACTUALLY FILTERED BY, published for AI Diagnostics (#2816,
  // owner decision 13 Aug 2026).
  //
  // WHAT PUBLICATION BUYS OVER READING THE ADDRESS, stated precisely, because the
  // first version of this comment claimed the activity window "is applied without
  // ever reaching the address bar" and that is FALSE (correctness review, 13 Aug
  // 2026): `buildPaymentsSearchParams` sets both bounds unconditionally and the
  // sync effect below `router.replace`s them, so a bare `/admin/payments` rewrites
  // itself to `?lastUpdatedFrom=…&lastUpdatedTo=…` on mount. What is true is
  // narrower and still decisive:
  //   * the window is applied by REACT STATE, and the address only catches up
  //     when that effect commits — every render before it, and any load the
  //     operator asks about in between, is filtered by a window the address does
  //     not name;
  //   * this is exactly the applied, allowlisted set, where the address also
  //     carries `sortBy`, `page`, the amount bounds and any unrelated query keys
  //     the previous screen left behind;
  //   * a value in the address that this page did NOT apply — an unknown status
  //     spelling, a malformed date — is never published as though it had been;
  //   * and when the load FAILED there is no filtered list at all, which the
  //     address cannot express.
  // The default window itself is still the point: `page-context/registry.ts` calls
  // it "the single most common reason a payment an operator expects is not on
  // screen", and it is nowhere in a URL an operator typed or was linked.
  //
  // VALUES ARE CHECKED AGAINST THE API'S OWN VOCABULARY FIRST. `adminPaymentsQuerySchema`
  // is strict, so `?status=succeeded` (wrong case) or `?lastUpdatedFrom=13-45-2026`
  // 400s the WHOLE query and `fetchData` keeps the previous rows — publishing those
  // raw would tell the model a filter was applied by a request that was refused.
  //
  // The keys the registry row does not allowlist (`xeroState`, `settlement`, the
  // amount bounds, sort, page) are not published; the route would drop them, and
  // publishing to be dropped is not a contract.
  //
  // `search` is applied on every keystroke (there is no debounce and no submit —
  // changing it rebuilds `buildPaymentsSearchParams`, which re-runs `fetchData`),
  // so the trimmed value below is genuinely what the list was filtered by. It
  // travels per the owner decision, with the Diagnostics panel disclosing it
  // beside the input.
  //
  // Always an OBJECT, empty when nothing is applied — `undefined` would mean
  // "this page publishes nothing" and hand the widget back to its URL fallback.
  //
  // ASSIGNED BY NAME onto a typed empty object rather than built as a spread
  // literal: a conditional spread loses object-literal freshness, so TypeScript
  // runs no excess-property check and a field renamed in the wire contract would
  // compile clean here (mutation-proven, review 13 Aug 2026).
  const publishedView: DiagnosticsViewState = {};
  if (loadErrorCode) {
    // NO FILTERS ON A FAILED LOAD. `{}` would assert "I applied nothing", so a
    // question about a missing payment would be answered against the activity
    // window when the real cause is an outage; the error code says "there is no
    // list, and here is why". Every registry row allowlists these codes.
    publishedView.errorCode = loadErrorCode;
  } else {
    const filters: Record<string, string> = {};
    if (source !== "all") filters.source = source;
    // The LENGTH is part of the vocabulary too (review finding, 14 Aug 2026): the
    // schema's `max(100)` 400s the whole query, so a 101-character search narrowed
    // nothing and the rows on screen belong to the last request that succeeded.
    if (isAppliedPaymentsSearch(search)) filters.search = search.trim();
    if (isAppliedPaymentsDate(lastUpdatedFrom)) {
      filters.lastUpdatedFrom = lastUpdatedFrom;
    }
    if (isAppliedPaymentsDate(lastUpdatedTo)) {
      filters.lastUpdatedTo = lastUpdatedTo;
    }
    if (isAppliedPaymentsDate(checkInFrom)) filters.checkInFrom = checkInFrom;
    if (isAppliedPaymentsDate(checkInTo)) filters.checkInTo = checkInTo;
    // `all` is the absence of a status filter, not a status.
    if (status !== "all" && isAppliedPaymentStatus(status)) {
      publishedView.status = status;
    }
    if (Object.keys(filters).length > 0) publishedView.filters = filters;
  }
  usePublishDiagnosticsViewState(publishedView);

  const buildPaymentsSearchParams = useCallback(() => {
    const params = withoutDatasetQueryKeys(
      searchParams.toString(),
      PAYMENT_DATASET_QUERY_KEYS,
    );
    if (status !== "all") params.set("status", status);
    if (source !== "all") params.set("source", source);
    if (xeroState !== "all") params.set("xeroState", xeroState);
    if (settlement !== "all") params.set("settlement", settlement);
    if (lastUpdatedFrom) params.set("lastUpdatedFrom", lastUpdatedFrom);
    if (lastUpdatedTo) params.set("lastUpdatedTo", lastUpdatedTo);
    if (checkInFrom) params.set("checkInFrom", checkInFrom);
    if (checkInTo) params.set("checkInTo", checkInTo);
    if (search.trim()) params.set("search", search.trim());
    if (amountExact) params.set("amountExact", amountExact);
    if (amountMin) params.set("amountMin", amountMin);
    if (amountMax) params.set("amountMax", amountMax);
    if (sortBy !== "lastUpdated") params.set("sortBy", sortBy);
    if (sortDir !== "desc") params.set("sortDir", sortDir);
    if (page > 1) params.set("page", String(page));
    return params;
  }, [
    status,
    source,
    xeroState,
    settlement,
    lastUpdatedFrom,
    lastUpdatedTo,
    checkInFrom,
    checkInTo,
    search,
    amountExact,
    amountMin,
    amountMax,
    sortBy,
    sortDir,
    page,
    searchParams,
  ]);

  const paymentsQuery = buildPaymentsSearchParams().toString();
  const currentPaymentsPath = paymentsQuery ? `/admin/payments?${paymentsQuery}` : "/admin/payments";

  useEffect(() => {
    const query = buildPaymentsSearchParams().toString();
    router.replace(query ? `/admin/payments?${query}` : "/admin/payments", { scroll: false });
  }, [buildPaymentsSearchParams, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // #2816: the outcome is recorded so the page can publish "there is no list,
    // and here is why" instead of publishing filters it did not get to apply.
    // A non-ok response has always been ignored here — the rows on screen are
    // then the PREVIOUS query's, or none at all.
    let failure: DiagnosticsPageErrorCode | null = null;
    try {
      const params = buildPaymentsSearchParams();
      params.set("status", status);
      params.set("source", source);
      params.set("xeroState", xeroState);
      params.set("settlement", settlement);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      const res = await fetch(`/api/admin/payments?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data); setTotal(json.total); setSummary(json.summary);
        setFilterError(null);
      } else {
        // #2816 records WHY there is no list, so the page can say so rather than
        // publishing filters it never got to apply. #2685 adds the other half:
        // clear the dataset and name the specific reason next to the boxes that
        // caused it. Leaving the last successful query's rows under a filter
        // chip that was never applied is the defect; an empty table under an
        // explicit reason is the honest state. Both are kept — the page-level
        // code and the field-level message answer different questions.
        failure = diagnosticsPageErrorCodeForStatus(res.status);
        setData([]);
        setTotal(0);
        setSummary({ totalRevenueCents: 0, refundedCents: 0, count: 0 });
        setFilterError(
          await readAdminQueryErrorMessage(res, PAYMENTS_FILTER_FALLBACK_ERROR),
        );
      }
    } catch {
      failure = DIAGNOSTICS_PAGE_NETWORK_ERROR_CODE;
    } finally {
      setLoadErrorCode(failure);
      setLoading(false);
    }
  }, [
    status,
    source,
    xeroState,
    settlement,
    sortBy,
    sortDir,
    page,
    pageSize,
    buildPaymentsSearchParams,
  ]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleGenerateInvoice(paymentId: string) {
    if (!canEditFinance) return;
    setGeneratingInvoice(paymentId);
    setInvoiceError(null);
    setInvoiceNotice(null);
    try {
      const res = await fetch(`/api/admin/payments/${paymentId}/generate-invoice`, { method: "POST" });
      if (res.ok) {
        const result = await res.json();
        if (result.xeroInvoiceId) {
          setData((prev) =>
            prev.map((p) =>
              p.id === paymentId
                ? { ...p, xeroInvoiceId: result.xeroInvoiceId, xeroInvoiceNumber: result.xeroInvoiceNumber }
                : p
            )
          );
          setQueuedInvoicePaymentIds((prev) => {
            const next = { ...prev };
            delete next[paymentId];
            return next;
          });
        } else if (result.queueOperationId) {
          setQueuedInvoicePaymentIds((prev) => ({
            ...prev,
            [paymentId]: true,
          }));
          await fetchData();
        }

        if (result.message) {
          setInvoiceNotice(result.message);
        }
      } else {
        const err = await res.json();
        setInvoiceError(err.error || "Failed to generate invoice");
      }
    } catch {
      setInvoiceError("Failed to generate invoice");
    } finally {
      setGeneratingInvoice(null);
    }
  }

  const totalPages = Math.ceil(total / pageSize);
  const successRate = summary.count > 0
    ? Math.round((data.filter((p) => p.status === "SUCCEEDED").length / Math.max(data.length, 1)) * 100)
    : 0;

  function resetPage() {
    setPage(1);
  }

  const isDatasetDefault =
    status === "all" &&
    source === "all" &&
    xeroState === "all" &&
    settlement === "all" &&
    lastUpdatedFrom === defaultLastUpdatedFrom &&
    lastUpdatedTo === clubToday &&
    checkInFrom === "" &&
    checkInTo === "" &&
    search === "" &&
    amountExact === "" &&
    amountMin === "" &&
    amountMax === "" &&
    sortBy === "lastUpdated" &&
    sortDir === "desc" &&
    page === 1;

  function resetDataset() {
    setStatus("all");
    setSource("all");
    setXeroState("all");
    setSettlement("all");
    setLastUpdatedFrom(defaultLastUpdatedFrom);
    setLastUpdatedTo(clubToday);
    setCheckInFrom("");
    setCheckInTo("");
    setSearch("");
    setAmountExact("");
    setAmountMin("");
    setAmountMax("");
    setSortBy("lastUpdated");
    setSortDir("desc");
    setPage(1);
    const params = resetPaymentsDatasetSearchParams(searchParams.toString(), clubToday);
    const query = params.toString();
    router.replace(query ? `/admin/payments?${query}` : "/admin/payments", {
      scroll: false,
    });
  }

  function toggleSort(column: PaymentSortBy) {
    setPage(1);
    if (sortBy === column) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(column);
    setSortDir(column === "member" || column === "booking" || column === "status" ? "asc" : "desc");
  }

  // Thin wrapper over the shared admin SortHeader (#1805): callback mode, same
  // toggleSort behaviour, with the numeric Amount header right-aligned to sit
  // over its tabular-figures cell.
  function PaymentSortHeader({
    column,
    children,
    align,
  }: {
    column: PaymentSortBy;
    children: ReactNode;
    align?: "left" | "right";
  }) {
    return (
      <SortHeader
        active={sortBy === column}
        direction={sortDir}
        onSort={() => toggleSort(column)}
        align={align}
      >
        {children}
      </SortHeader>
    );
  }

  // Active-filter chips for the filter bar. Removing a chip resets just that
  // filter to its neutral state (the same effect selecting "All" has), so the
  // query semantics are unchanged.
  const advancedActiveCount =
    (amountExact ? 1 : 0) +
    (amountMin ? 1 : 0) +
    (amountMax ? 1 : 0) +
    (checkInFrom ? 1 : 0) +
    (checkInTo ? 1 : 0);

  const filterChips: AdminFilterChip[] = [];
  if (status !== "all") {
    filterChips.push({
      key: "status",
      label: "Status",
      value: isAppliedPaymentStatus(status)
        ? PAYMENT_STATUS_FILTER_LABELS[status]
        : status,
      onRemove: () => { setStatus("all"); resetPage(); },
    });
  }
  if (source !== "all") {
    filterChips.push({
      key: "source",
      label: "Source",
      value: PAYMENT_SOURCE_FILTER_LABELS[source] ?? source,
      onRemove: () => { setSource("all"); resetPage(); },
    });
  }
  if (xeroState !== "all") {
    filterChips.push({
      key: "xeroState",
      label: "Xero",
      value: xeroStateLabel(xeroState),
      onRemove: () => { setXeroState("all"); resetPage(); },
    });
  }
  if (settlement !== "all") {
    filterChips.push({
      key: "settlement",
      label: "Settlement",
      value: settlementKindLabel(settlement),
      onRemove: () => { setSettlement("all"); resetPage(); },
    });
  }
  if (amountExact) {
    filterChips.push({
      key: "amountExact",
      label: "Amount exact",
      value: amountExact,
      onRemove: () => { setAmountExact(""); resetPage(); },
    });
  }
  if (amountMin) {
    filterChips.push({
      key: "amountMin",
      label: "Amount min",
      value: amountMin,
      onRemove: () => { setAmountMin(""); resetPage(); },
    });
  }
  if (amountMax) {
    filterChips.push({
      key: "amountMax",
      label: "Amount max",
      value: amountMax,
      onRemove: () => { setAmountMax(""); resetPage(); },
    });
  }
  if (checkInFrom) {
    filterChips.push({
      key: "checkInFrom",
      label: "Check in from",
      value: checkInFrom,
      onRemove: () => { setCheckInFrom(""); resetPage(); },
    });
  }
  if (checkInTo) {
    filterChips.push({
      key: "checkInTo",
      label: "Check in to",
      value: checkInTo,
      onRemove: () => { setCheckInTo(""); resetPage(); },
    });
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Payments"
        description="View and filter payment records"
      />

      {/* B5 (#2262): cash / off-Xero refunds waiting to be paid back by hand.
          Renders nothing when the queue is empty. */}
      <ManualRefundTaskQueue />

      <AdminFilterBar
        idPrefix="payments-filters"
        advancedActiveCount={advancedActiveCount}
        chips={filterChips}
        search={
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="payment-member-search">Member or reference</Label>
            <Input
              id="payment-member-search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                resetPage();
              }}
              placeholder="Name, email, or ref..."
              className="w-full"
            />
          </div>
        }
        primary={
          <>
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={status} onValueChange={(v) => { setStatus(v); resetPage(); }}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="PROCESSING">Processing (awaiting Stripe)</SelectItem>
                  <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                  <SelectItem value="REFUNDED">Refunded / Credited</SelectItem>
                  <SelectItem value="PARTIALLY_REFUNDED">Partially Refunded / Credited</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Source</Label>
              <Select value={source} onValueChange={(v) => { setSource(getSourceFilter(v)); resetPage(); }}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="STRIPE">Stripe</SelectItem>
                  <SelectItem value="INTERNET_BANKING">Internet Banking</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Xero</Label>
              <Select value={xeroState} onValueChange={(v) => { setXeroState(v); resetPage(); }}>
                <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Xero states</SelectItem>
                  <SelectItem value="invoiceLinked">Invoice linked</SelectItem>
                  <SelectItem value="invoiceMissing">Invoice missing</SelectItem>
                  <SelectItem value="operationFailed">Failed activity</SelectItem>
                  <SelectItem value="operationPartial">Partial activity</SelectItem>
                  <SelectItem value="operationPending">Pending activity</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Settlement</Label>
              <Select value={settlement} onValueChange={(v) => { setSettlement(v); resetPage(); }}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All settlements</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="cardRefund">Card refund</SelectItem>
                  <SelectItem value="accountCredit">Account credit</SelectItem>
                  <SelectItem value="mixed">Mixed</SelectItem>
                  <SelectItem value="restoredCredit">Restored credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DateRangeControls
              presets={auditAndPaymentsDateRangePresets}
              from={lastUpdatedFrom}
              to={lastUpdatedTo}
              presetLabel="Updated Range"
              fromLabel="Updated From"
              toLabel="Updated To"
              idPrefix="payments-updated"
              onFromChange={(value) => {
                setLastUpdatedFrom(value);
                resetPage();
              }}
              onToChange={(value) => {
                setLastUpdatedTo(value);
                resetPage();
              }}
            />
          </>
        }
        actions={
          <DatasetResetButton disabled={isDatasetDefault} onReset={resetDataset} />
        }
        advanced={
          <>
            {/* #2264 — ONE hint for the amount group rather than an example
                parked in each box, where grey text reads as a filter already
                applied. A hook cannot serve three controls, so the shared id is
                wired to each box with `describedByFieldHint`. */}
            <div className="space-y-1">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="payment-amount-exact">Amount exact</Label>
                  <Input
                    id="payment-amount-exact"
                    inputMode="decimal"
                    value={amountExact}
                    onChange={(event) => {
                      setAmountExact(event.target.value);
                      resetPage();
                    }}
                    className="w-32"
                    aria-describedby={describedByFieldHint(PAYMENT_AMOUNT_HINT_ID)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="payment-amount-min">Amount min</Label>
                  <Input
                    id="payment-amount-min"
                    inputMode="decimal"
                    value={amountMin}
                    onChange={(event) => {
                      setAmountMin(event.target.value);
                      resetPage();
                    }}
                    className="w-32"
                    aria-describedby={describedByFieldHint(PAYMENT_AMOUNT_HINT_ID)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="payment-amount-max">Amount max</Label>
                  <Input
                    id="payment-amount-max"
                    inputMode="decimal"
                    value={amountMax}
                    onChange={(event) => {
                      setAmountMax(event.target.value);
                      resetPage();
                    }}
                    className="w-32"
                    aria-describedby={describedByFieldHint(PAYMENT_AMOUNT_HINT_ID)}
                  />
                </div>
              </div>
              <FieldHint id={PAYMENT_AMOUNT_HINT_ID}>
                Amounts in dollars. Example: 125.00
              </FieldHint>
              {/* The refusal sits with the boxes that cause it, not in a banner
                  at the top of a long screen, and is announced rather than only
                  drawn (#2685 review). */}
              {filterError ? (
                <p
                  role="alert"
                  className="text-sm font-medium text-destructive"
                  data-testid="payments-filter-error"
                >
                  {filterError}
                </p>
              ) : null}
            </div>
            <DateRangeControls
              presets={auditAndPaymentsDateRangePresets}
              from={checkInFrom}
              to={checkInTo}
              presetLabel="Check In Range"
              fromLabel="Check In From"
              toLabel="Check In To"
              idPrefix="payments-check-in"
              onFromChange={(value) => {
                setCheckInFrom(value);
                resetPage();
              }}
              onToChange={(value) => {
                setCheckInTo(value);
                resetPage();
              }}
            />
          </>
        }
      />

      {invoiceError && (
        <Alert variant="error">
          {invoiceError}
          <button onClick={() => setInvoiceError(null)} className="ml-2 underline">Dismiss</button>
        </Alert>
      )}

      {invoiceNotice && (
        <Alert variant="warning">
          {invoiceNotice}
          <button onClick={() => setInvoiceNotice(null)} className="ml-2 underline">Dismiss</button>
        </Alert>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard title="Total Revenue" icon={DollarSign}>
          {formatCents(summary.totalRevenueCents)}
        </SummaryCard>
        <SummaryCard title="Refunded / Credited" icon={CreditCard} valueClassName="text-danger">
          {formatCents(summary.refundedCents)}
        </SummaryCard>
        <SummaryCard title="Payments" icon={BarChart2}>
          {summary.count}
        </SummaryCard>
        <SummaryCard title="Success Rate" icon={TrendingUp}>
          {successRate}%
        </SummaryCard>
      </div>

      <AdminDataTable
        aria-label="Payments"
        toolbar={
          <p>
            Showing {data.length} of {total} payment{total === 1 ? "" : "s"}
          </p>
        }
      >
        <TableHeader>
          <TableRow>
            <PaymentSortHeader column="lastUpdated">Last Updated</PaymentSortHeader>
            <PaymentSortHeader column="checkIn">Check In</PaymentSortHeader>
            <PaymentSortHeader column="member">Member</PaymentSortHeader>
            <PaymentSortHeader column="booking">Booking</PaymentSortHeader>
            <PaymentSortHeader column="amount" align="right">Amount</PaymentSortHeader>
            <PaymentSortHeader column="status">Status</PaymentSortHeader>
            <PaymentSortHeader column="stripe">Stripe</PaymentSortHeader>
            <PaymentSortHeader column="xeroInvoice">Xero Invoice</PaymentSortHeader>
            <PaymentSortHeader column="settlement">Settlement</PaymentSortHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={9} className="py-10 text-center">
                <div className="flex justify-center">
                  <Spinner label="Loading payments…" />
                </div>
              </TableCell>
            </TableRow>
          ) : data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="p-0">
                <EmptyState
                  icon={Receipt}
                  title="No payments found"
                  description="No payments match your current filters. Try clearing or adjusting them."
                />
              </TableCell>
            </TableRow>
          ) : (
            data.map((p) => {
              const isInternetBanking = p.source === "INTERNET_BANKING";
              const xeroActivityHref = buildXeroRecordActivityUrl(
                "Payment",
                p.id,
                currentPaymentsPath
              );
              const displayStatus = getPaymentDisplayStatus({
                bookingStatus: p.booking.status,
                paymentStatus: p.status,
                refundedAmountCents: p.refundedAmountCents,
                credits: p.booking.creditsFromCancellation,
              });
              const settlement = getCancellationSettlementBreakdown(
                p.refundedAmountCents,
                p.booking.creditsFromCancellation
              );
              const xeroChip = xeroStateChip(p.xeroState);

              return (
                <TableRow key={p.id}>
                  {/* Two different concepts in adjacent columns, and CT-4
                      (#2870) is the change that stopped treating them alike.
                      `lastUpdatedAt` is a real INSTANT: date-fns `format` read
                      it with HOST-LOCAL getters, so an operator abroad saw
                      their own day. `checkIn` is a CALENDAR DATE from a
                      `@db.Date` column, which takes no zone at all. Both render
                      the same "16 Apr 2026" shape as before. */}
                  <TableCell className="text-sm">{clubTime.instantDate(requireInstant(p.lastUpdatedAt))}</TableCell>
                  <TableCell className="text-sm">{formatPayloadCalendarDay(p.booking.checkIn)}</TableCell>
                  <TableCell className="font-medium">
                    <Link
                      href={buildHrefWithReturnTo(`/admin/members/${p.booking.member.id}`, currentPaymentsPath)}
                      className="rounded-sm text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {p.booking.member.lastName}, {p.booking.member.firstName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={buildHrefWithReturnTo(`/bookings/${p.booking.id}`, currentPaymentsPath)}
                      className="rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      View
                    </Link>
                  </TableCell>
                  <TableCell className="text-right text-sm font-medium tabular-nums">{formatCents(p.amountCents)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Link
                        href={xeroActivityHref}
                        className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <StatusChip
                          kind="payment"
                          value={displayStatus.toneStatus as PaymentStatus}
                          label={displayStatus.label}
                        />
                      </Link>
                      {displayStatus.detail && (
                        <p className="max-w-56 text-xs text-muted-foreground">
                          {displayStatus.detail}
                        </p>
                      )}
                      {isInternetBanking && (
                        <div className="space-y-1">
                          <MiniChip tone="cat6" icon={Landmark}>Internet Banking</MiniChip>
                          {p.reference && (
                            <Link
                              href={xeroActivityHref}
                              className="block max-w-56 truncate rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              title={p.reference}
                            >
                              Ref: {p.reference}
                            </Link>
                          )}
                          {p.status === "PENDING" && (
                            <p className="text-xs text-warning">
                              {formatPendingAge(p.createdAt)}
                            </p>
                          )}
                        </div>
                      )}
                      {p.source === "STRIPE" && (
                        <MiniChip tone="info" icon={CreditCard}>Stripe</MiniChip>
                      )}
                      {/* #2378 D11 — the payment's own id, beside the status the
                          operator is asking about ("why is this still pending?").
                          Renders nothing unless the widget says Diagnostics is
                          available to this admin. */}
                      <DiagnosticsRecordButton
                        recordId={p.id}
                        subject={`the ${formatCents(p.amountCents)} payment for ${p.booking.member.firstName} ${p.booking.member.lastName}`}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    {p.stripePaymentIntentId ? (
                      <a
                        href={`https://dashboard.stripe.com/${p.stripePaymentIntentId.startsWith("pi_test_") ? "test/" : ""}payments/${p.stripePaymentIntentId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={p.stripePaymentIntentId}
                      >
                        {p.stripePaymentIntentId.slice(0, 12)}...
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : isInternetBanking ? (
                      <span className="text-xs text-muted-foreground">
                        Internet Banking
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Link
                        href={buildXeroRecordActivityUrl("Payment", p.id, currentPaymentsPath)}
                        className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <MiniChip tone={xeroChip.tone} icon={xeroChip.icon}>
                          {xeroStateLabel(p.xeroState)}
                        </MiniChip>
                      </Link>
                      {p.xeroInvoiceId ? (
                        <a
                          href={buildXeroInvoiceUrl(p.xeroInvoiceId, {
                            shortCode: xeroOrgShortCode,
                          })}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {p.xeroInvoiceNumber || p.xeroInvoiceId.slice(0, 8)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : queuedInvoicePaymentIds[p.id] ? (
                        <span className="inline-flex items-center gap-1 text-xs text-warning">
                          <FileText className="h-3 w-3" />
                          Queued
                        </span>
                      ) : isInternetBanking ? (
                        <Link
                          href={xeroActivityHref}
                          className="inline-flex rounded-sm text-xs text-warning hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Missing Xero invoice
                        </Link>
                      ) : p.status === "SUCCEEDED" ? (
                        <button
                          onClick={() => handleGenerateInvoice(p.id)}
                          disabled={generatingInvoice === p.id || !canEditFinance}
                          title={
                            !canEditFinance
                              ? ADMIN_VIEW_ONLY_ACTION_REASON
                              : undefined
                          }
                          className="inline-flex items-center gap-1 rounded-sm text-xs text-warning hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        >
                          <FileText className="h-3 w-3" />
                          {generatingInvoice === p.id ? "Creating..." : "Generate Invoice"}
                        </button>
                      ) : (
                        <span>—</span>
                      )}
                      <Link
                        href={xeroActivityHref}
                        className="inline-flex rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        View activity
                      </Link>
                      {p.xeroActivity.failed > 0 ? (
                        <p className="text-xs text-danger">{p.xeroActivity.failed} failed</p>
                      ) : null}
                      {p.xeroActivity.partial > 0 ? (
                        <p className="text-xs text-warning">{p.xeroActivity.partial} partial</p>
                      ) : null}
                      {p.xeroActivity.pending > 0 ? (
                        <p className="text-xs text-muted-foreground">{p.xeroActivity.pending} pending</p>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {(() => {
                        const s = settlementKindChip(p.settlementKind);
                        return (
                          <MiniChip tone={s.tone} icon={s.icon}>
                            {settlementKindLabel(p.settlementKind)}
                          </MiniChip>
                        );
                      })()}
                      {p.refundedAmountCents > 0 ? (
                        <div className="space-y-1 text-xs text-muted-foreground">
                        {settlement.refundToOriginalMethodCents > 0 && (
                          <p className="tabular-nums">Card refund: {formatCents(settlement.refundToOriginalMethodCents)}</p>
                        )}
                        {settlement.accountCreditCents > 0 && (
                          <p className="tabular-nums">Account credit: {formatCents(settlement.accountCreditCents)}</p>
                        )}
                        {settlement.restoredAppliedCreditCents > 0 && (
                          <p className="tabular-nums">Restored credit: {formatCents(settlement.restoredAppliedCreditCents)}</p>
                        )}
                      </div>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </AdminDataTable>

      <Pagination
        as="div"
        aria-label="Payments pagination"
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        summary={`Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}`}
      />
    </div>
  );
}
