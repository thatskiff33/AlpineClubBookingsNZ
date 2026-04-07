"use client";

import { useState, useEffect, useCallback } from "react";
import { format, subMonths } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { DollarSign, CreditCard, TrendingUp, BarChart2, ExternalLink } from "lucide-react";
import { paymentStatusClass } from "@/lib/status-colors";
import Link from "next/link";

function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
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
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    member: { firstName: string; lastName: string; email: string };
  };
}

export default function PaymentsPage() {
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState(format(subMonths(new Date(), 3), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [data, setData] = useState<PaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ totalRevenueCents: 0, refundedCents: 0, count: 0 });
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`/api/admin/payments?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data); setTotal(json.total); setSummary(json.summary);
      }
    } finally { setLoading(false); }
  }, [status, from, to, page, pageSize]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalPages = Math.ceil(total / pageSize);
  const successRate = summary.count > 0
    ? Math.round((data.filter((p) => p.status === "SUCCEEDED").length / Math.max(data.length, 1)) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Payments</h1>
        <p className="text-sm text-slate-500 mt-1">View and filter payment records</p>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="PROCESSING">Processing</SelectItem>
              <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
              <SelectItem value="REFUNDED">Refunded</SelectItem>
              <SelectItem value="PARTIALLY_REFUNDED">Partially Refunded</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-40" />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-40" />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Total Revenue</CardTitle><DollarSign className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{formatCents(summary.totalRevenueCents)}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Refunded</CardTitle><CreditCard className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold text-red-600">{formatCents(summary.refundedCents)}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Payments</CardTitle><BarChart2 className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{summary.count}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Success Rate</CardTitle><TrendingUp className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{successRate}%</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Member</TableHead><TableHead>Booking</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Stripe</TableHead><TableHead>Xero Invoice</TableHead><TableHead>Refund</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-slate-500">Loading...</TableCell></TableRow>
              ) : data.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-slate-500">No payments found</TableCell></TableRow>
              ) : (
                data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{format(new Date(p.booking.checkIn), "d MMM yyyy")}</TableCell>
                    <TableCell className="font-medium">{p.booking.member.lastName}, {p.booking.member.firstName}</TableCell>
                    <TableCell>
                      <Link href={`/bookings/${p.booking.id}`} className="text-xs text-blue-600 hover:underline">
                        View
                      </Link>
                    </TableCell>
                    <TableCell>{formatCents(p.amountCents)}</TableCell>
                    <TableCell><Badge className={paymentStatusClass(p.status)}>{p.status.replace("_", " ")}</Badge></TableCell>
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
                      ) : "—"}
                    </TableCell>
                    <TableCell>{p.refundedAmountCents > 0 ? formatCents(p.refundedAmountCents) : "—"}</TableCell>
                  </TableRow>
                ))
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
