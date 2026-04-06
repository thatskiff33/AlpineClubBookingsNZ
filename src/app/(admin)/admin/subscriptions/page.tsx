"use client";

import { useState, useEffect, useCallback } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Users, CheckCircle, AlertCircle, Clock } from "lucide-react";

function getSeasonYear(date: Date): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

const currentYear = getSeasonYear(new Date());
const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

const statusColors: Record<string, string> = {
  PAID: "bg-green-100 text-green-800",
  UNPAID: "bg-yellow-100 text-yellow-800",
  OVERDUE: "bg-red-100 text-red-800",
  NOT_INVOICED: "bg-slate-100 text-slate-800",
};

interface Subscription {
  id: string;
  memberId: string;
  seasonYear: number;
  status: string;
  xeroInvoiceId: string | null;
  paidAt: string | null;
  member: { firstName: string; lastName: string; email: string };
}

interface Summary { total: number; paid: number; unpaid: number; overdue: number; notInvoiced: number; }

export default function SubscriptionsPage() {
  const [seasonYear, setSeasonYear] = useState(currentYear);
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [data, setData] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary>({ total: 0, paid: 0, unpaid: 0, overdue: 0, notInvoiced: 0 });
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        seasonYear: String(seasonYear), status, page: String(page), pageSize: String(pageSize),
      });
      const res = await fetch(`/api/admin/subscriptions?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data); setTotal(json.total); setSummary(json.summary);
      }
    } finally { setLoading(false); }
  }, [seasonYear, status, page, pageSize]);

  useEffect(() => { fetchData(); }, [fetchData]);
  const totalPages = Math.ceil(total / pageSize);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Subscriptions</h1>
        <p className="text-sm text-slate-500 mt-1">Track member subscription status by season</p>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs font-medium text-slate-500">Season Year</label>
          <Select value={String(seasonYear)} onValueChange={(v) => { setSeasonYear(Number(v)); setPage(1); }}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>{y} - {y + 1} (Apr-Mar)</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500">Status</label>
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="PAID">Paid</SelectItem>
              <SelectItem value="UNPAID">Unpaid</SelectItem>
              <SelectItem value="OVERDUE">Overdue</SelectItem>
              <SelectItem value="NOT_INVOICED">Not Invoiced</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Total</CardTitle><Users className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{summary.total}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Paid</CardTitle><CheckCircle className="h-4 w-4 text-green-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-green-700">{summary.paid}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Unpaid</CardTitle><Clock className="h-4 w-4 text-yellow-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-yellow-700">{summary.unpaid}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Overdue</CardTitle><AlertCircle className="h-4 w-4 text-red-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-red-700">{summary.overdue}</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Member</TableHead><TableHead>Email</TableHead><TableHead>Status</TableHead><TableHead>Xero Invoice</TableHead><TableHead>Paid Date</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-slate-500">Loading...</TableCell></TableRow>
              ) : data.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-slate-500">No subscriptions found</TableCell></TableRow>
              ) : (
                data.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell className="font-medium">{sub.member.lastName}, {sub.member.firstName}</TableCell>
                    <TableCell>{sub.member.email}</TableCell>
                    <TableCell><Badge className={statusColors[sub.status] || ""}>{sub.status.replace("_", " ")}</Badge></TableCell>
                    <TableCell className="text-xs text-slate-500">{sub.xeroInvoiceId || "—"}</TableCell>
                    <TableCell>{sub.paidAt ? format(new Date(sub.paidAt), "d MMM yyyy") : "—"}</TableCell>
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