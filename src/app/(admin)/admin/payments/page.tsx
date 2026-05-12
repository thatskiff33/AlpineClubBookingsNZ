"use client";

import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format, subMonths } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  DollarSign,
  CreditCard,
  TrendingUp,
  BarChart2,
  ExternalLink,
  FileText,
  X,
} from "lucide-react";
import { paymentStatusClass } from "@/lib/status-colors";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import Link from "next/link";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { auditAndPaymentsDateRangePresets } from "@/lib/date-range-presets";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

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

interface PaymentRow {
  id: string;
  bookingId: string;
  amountCents: number;
  status: string;
  stripePaymentIntentId: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  refundedAmountCents: number;
  createdAt: string;
  updatedAt: string;
  lastUpdatedAt: string;
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

export default function PaymentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [generatingInvoice, setGeneratingInvoice] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [invoiceNotice, setInvoiceNotice] = useState<string | null>(null);
  const [queuedInvoicePaymentIds, setQueuedInvoicePaymentIds] = useState<Record<string, true>>({});
  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [lastUpdatedFrom, setLastUpdatedFrom] = useState(
    searchParams.get("lastUpdatedFrom") || format(subMonths(new Date(), 3), "yyyy-MM-dd")
  );
  const [lastUpdatedTo, setLastUpdatedTo] = useState(
    searchParams.get("lastUpdatedTo") || format(new Date(), "yyyy-MM-dd")
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

  const buildPaymentsSearchParams = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
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
  ]);

  const paymentsQuery = buildPaymentsSearchParams().toString();
  const currentPaymentsPath = paymentsQuery ? `/admin/payments?${paymentsQuery}` : "/admin/payments";

  useEffect(() => {
    const query = buildPaymentsSearchParams().toString();
    router.replace(query ? `/admin/payments?${query}` : "/admin/payments", { scroll: false });
  }, [buildPaymentsSearchParams, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildPaymentsSearchParams();
      params.set("status", status);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      const res = await fetch(`/api/admin/payments?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data); setTotal(json.total); setSummary(json.summary);
      }
    } finally { setLoading(false); }
  }, [
    status,
    sortBy,
    sortDir,
    page,
    pageSize,
    buildPaymentsSearchParams,
  ]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleGenerateInvoice(paymentId: string) {
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

  function clearFilters() {
    setStatus("all");
    setLastUpdatedFrom("");
    setLastUpdatedTo("");
    setCheckInFrom("");
    setCheckInTo("");
    setSearch("");
    setAmountExact("");
    setAmountMin("");
    setAmountMax("");
    setSortBy("lastUpdated");
    setSortDir("desc");
    setPage(1);
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

  function SortIcon({ column }: { column: PaymentSortBy }) {
    if (sortBy !== column) {
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />;
    }

    return sortDir === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3" />
    );
  }

  function SortHeader({
    column,
    children,
    className = "",
  }: {
    column: PaymentSortBy;
    children: ReactNode;
    className?: string;
  }) {
    return (
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => toggleSort(column)}
          className="inline-flex items-center whitespace-nowrap text-left"
        >
          {children}
          <SortIcon column={column} />
        </button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Payments</h1>
        <p className="text-sm text-slate-500 mt-1">View and filter payment records</p>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
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
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="payment-member-search">Member name</Label>
          <Input
            id="payment-member-search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
            placeholder="Name or email..."
            className="w-52"
          />
        </div>
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
            placeholder="125.00"
            className="w-32"
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
            placeholder="50.00"
            className="w-32"
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
            placeholder="250.00"
            className="w-32"
          />
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
        <Button onClick={clearFilters} variant="outline" size="sm">
          <X className="mr-1 h-4 w-4" />
          Clear
        </Button>
      </div>

      {invoiceError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {invoiceError}
          <button onClick={() => setInvoiceError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {invoiceNotice && (
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          {invoiceNotice}
          <button onClick={() => setInvoiceNotice(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Total Revenue</CardTitle><DollarSign className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{formatCents(summary.totalRevenueCents)}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Refunded / Credited</CardTitle><CreditCard className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold text-red-600">{formatCents(summary.refundedCents)}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Payments</CardTitle><BarChart2 className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{summary.count}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Success Rate</CardTitle><TrendingUp className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{successRate}%</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <SortHeader column="lastUpdated">Last Updated</SortHeader>
              <SortHeader column="checkIn">Check In</SortHeader>
              <SortHeader column="member">Member</SortHeader>
              <SortHeader column="booking">Booking</SortHeader>
              <SortHeader column="amount">Amount</SortHeader>
              <SortHeader column="status">Status</SortHeader>
              <SortHeader column="stripe">Stripe</SortHeader>
              <SortHeader column="xeroInvoice">Xero Invoice</SortHeader>
              <SortHeader column="settlement">Settlement</SortHeader>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-slate-500">Loading...</TableCell></TableRow>
              ) : data.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-slate-500">No payments found</TableCell></TableRow>
              ) : (
                data.map((p) => {
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

                  return (
                    <TableRow key={p.id}>
                      <TableCell>{format(new Date(p.lastUpdatedAt), "d MMM yyyy")}</TableCell>
                      <TableCell>{format(new Date(p.booking.checkIn), "d MMM yyyy")}</TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={buildHrefWithReturnTo(`/admin/members/${p.booking.member.id}`, currentPaymentsPath)}
                          className="text-blue-600 hover:underline"
                        >
                          {p.booking.member.lastName}, {p.booking.member.firstName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={buildHrefWithReturnTo(`/bookings/${p.booking.id}`, currentPaymentsPath)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          View
                        </Link>
                      </TableCell>
                      <TableCell>{formatCents(p.amountCents)}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Link href={buildXeroRecordActivityUrl("Payment", p.id, currentPaymentsPath)} className="inline-flex">
                            <Badge className={`${paymentStatusClass(displayStatus.toneStatus)} cursor-pointer`}>
                              {displayStatus.label}
                            </Badge>
                          </Link>
                          {displayStatus.detail && (
                            <p className="max-w-56 text-xs text-slate-500">
                              {displayStatus.detail}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.stripePaymentIntentId ? (
                          <a
                            href={`https://dashboard.stripe.com/${p.stripePaymentIntentId.startsWith("pi_test_") ? "test/" : ""}payments/${p.stripePaymentIntentId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                            title={p.stripePaymentIntentId}
                          >
                            {p.stripePaymentIntentId.slice(0, 12)}...
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {p.xeroInvoiceId ? (
                            <a
                              href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${p.xeroInvoiceId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                            >
                              {p.xeroInvoiceNumber || p.xeroInvoiceId.slice(0, 8)}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : queuedInvoicePaymentIds[p.id] ? (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                              <FileText className="h-3 w-3" />
                              Queued
                            </span>
                          ) : p.status === "SUCCEEDED" ? (
                            <button
                              onClick={() => handleGenerateInvoice(p.id)}
                              disabled={generatingInvoice === p.id}
                              className="text-xs text-orange-600 hover:text-orange-800 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <FileText className="h-3 w-3" />
                              {generatingInvoice === p.id ? "Creating..." : "Generate Invoice"}
                            </button>
                          ) : (
                            <span>—</span>
                          )}
                          <Link
                            href={buildXeroRecordActivityUrl("Payment", p.id, currentPaymentsPath)}
                            className="inline-flex text-xs text-slate-600 hover:text-slate-900 hover:underline"
                          >
                            View activity
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.refundedAmountCents > 0 ? (
                          <div className="space-y-1 text-xs text-slate-600">
                            {settlement.refundToOriginalMethodCents > 0 && (
                              <p>Card refund: {formatCents(settlement.refundToOriginalMethodCents)}</p>
                            )}
                            {settlement.accountCreditCents > 0 && (
                              <p>Account credit: {formatCents(settlement.accountCreditCents)}</p>
                            )}
                            {settlement.restoredAppliedCreditCents > 0 && (
                              <p>Restored credit: {formatCents(settlement.restoredAppliedCreditCents)}</p>
                            )}
                          </div>
                        ) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} of {total}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}
