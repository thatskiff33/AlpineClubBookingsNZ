"use client";

import type { AgeTier } from "@prisma/client";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { subscriptionStatusClass, subscriptionStatusLabel } from "@/lib/status-colors";
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups";
import { getAgeTierLabel, useAgeTierOptions } from "@/lib/use-age-tier-options";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
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
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Users,
  Clock,
} from "lucide-react";

function getSeasonYear(date: Date): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

const currentYear = getSeasonYear(new Date());
const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);


interface Subscription {
  id: string;
  memberId: string;
  seasonYear: number;
  status: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  paidAt: string | null;
  xeroContactGroupsLoaded: boolean;
  xeroContactGroups: Array<{ id: string; name: string }>;
  member: {
    firstName: string;
    lastName: string;
    email: string;
    ageTier: AgeTier;
    xeroContactId: string | null;
  };
}

interface Summary { total: number; paid: number; unpaid: number; overdue: number; notInvoiced: number; notRequired: number; }
interface XeroContactGroup { id: string; name: string; contactCount: number; }
type MembershipSyncMode = "incremental" | "backfill";
type SubscriptionSortBy =
  | "member"
  | "email"
  | "ageTier"
  | "xeroContactGroup"
  | "status"
  | "xeroInvoice"
  | "paidAt";
type SortDir = "asc" | "desc";

const subscriptionSortColumns = new Set<SubscriptionSortBy>([
  "member",
  "email",
  "ageTier",
  "xeroContactGroup",
  "status",
  "xeroInvoice",
  "paidAt",
]);

function parsePageParam(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function parseSeasonYearParam(value: string | null) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2020 && year <= 2040
    ? year
    : currentYear;
}

function getSortBy(value: string | null): SubscriptionSortBy {
  return subscriptionSortColumns.has(value as SubscriptionSortBy)
    ? (value as SubscriptionSortBy)
    : "member";
}

function getSortDir(value: string | null): SortDir {
  return value === "desc" ? "desc" : "asc";
}

function getDefaultSortDir(sortBy: SubscriptionSortBy): SortDir {
  return sortBy === "paidAt" ? "desc" : "asc";
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ageTierOptions = useAgeTierOptions();
  const [seasonYear, setSeasonYear] = useState(() => parseSeasonYearParam(searchParams.get("seasonYear")));
  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [ageTier, setAgeTier] = useState<AgeTier | "all">(
    (searchParams.get("ageTier") as AgeTier | "all" | null) || "all"
  );
  const [xeroContactGroup, setXeroContactGroup] = useState(searchParams.get("xeroContactGroup") || "all");
  const [sortBy, setSortBy] = useState<SubscriptionSortBy>(() => getSortBy(searchParams.get("sortBy")));
  const [sortDir, setSortDir] = useState<SortDir>(() => getSortDir(searchParams.get("sortDir")));
  const [page, setPage] = useState(() => parsePageParam(searchParams.get("page")));
  const [pageSize] = useState(25);
  const [data, setData] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary>({ total: 0, paid: 0, unpaid: 0, overdue: 0, notInvoiced: 0, notRequired: 0 });
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState<MembershipSyncMode | null>(null);
  const [syncMessage, setSyncMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [xeroContactGroupsList, setXeroContactGroupsList] = useState<XeroContactGroup[]>([]);
  const [xeroContactGroupsLoaded, setXeroContactGroupsLoaded] = useState(true);

  async function handleSync(mode: MembershipSyncMode) {
    const label =
      mode === "incremental"
        ? "Run the incremental Xero subscription refresh for this season?"
        : "Run the repair backfill for linked members still showing Not Invoiced? This checks a broader stale-member set and may take longer.";
    if (!confirm(label)) return;
    setSyncing(mode);
    setSyncMessage(null);
    try {
      const res = await fetch(
        `/api/admin/xero/sync-memberships?seasonYear=${seasonYear}&mode=${mode}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (res.ok) {
        setSyncMessage({
          type: "success",
          text:
            mode === "incremental"
              ? `Incremental sync checked ${data.checked} members (${data.updated} updated)`
              : `Backfill repair checked ${data.checked} members (${data.updated} updated)`,
        });
        fetchData();
      } else {
        setSyncMessage({ type: "error", text: data.error || "Sync failed" });
      }
    } catch {
      setSyncMessage({ type: "error", text: "Sync failed — check Xero connection" });
    } finally {
      setSyncing(null);
    }
  }

  useEffect(() => {
    loadAdminXeroContactGroups()
      .then((result) => setXeroContactGroupsList(result.groups))
      .catch(() => setXeroContactGroupsList([]));
  }, []);

  const buildSubscriptionsSearchParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("seasonYear", String(seasonYear));
    if (status !== "all") params.set("status", status);
    if (ageTier !== "all") params.set("ageTier", ageTier);
    if (xeroContactGroup !== "all") params.set("xeroContactGroup", xeroContactGroup);
    if (sortBy !== "member") params.set("sortBy", sortBy);
    if (sortDir !== getDefaultSortDir(sortBy)) params.set("sortDir", sortDir);
    if (page > 1) params.set("page", String(page));
    return params;
  }, [seasonYear, status, ageTier, xeroContactGroup, sortBy, sortDir, page]);

  const subscriptionsQuery = buildSubscriptionsSearchParams().toString();
  const currentSubscriptionsPath = subscriptionsQuery
    ? `/admin/subscriptions?${subscriptionsQuery}`
    : "/admin/subscriptions";

  useEffect(() => {
    const query = buildSubscriptionsSearchParams().toString();
    router.replace(query ? `/admin/subscriptions?${query}` : "/admin/subscriptions", { scroll: false });
  }, [buildSubscriptionsSearchParams, router]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildSubscriptionsSearchParams();
      params.set("status", status);
      params.set("ageTier", ageTier);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      const res = await fetch(`/api/admin/subscriptions?${params}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
        setTotal(json.total);
        setSummary(json.summary);
        setXeroContactGroupsLoaded(json.xeroContactGroupsLoaded !== false);
      }
    } finally { setLoading(false); }
  }, [ageTier, buildSubscriptionsSearchParams, page, pageSize, sortBy, sortDir, status]);

  useEffect(() => { fetchData(); }, [fetchData]);
  const totalPages = Math.ceil(total / pageSize);

  function toggleSort(column: SubscriptionSortBy) {
    setPage(1);
    if (sortBy === column) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortBy(column);
    setSortDir(getDefaultSortDir(column));
  }

  function SortIcon({ column }: { column: SubscriptionSortBy }) {
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
  }: {
    column: SubscriptionSortBy;
    children: ReactNode;
  }) {
    return (
      <TableHead>
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
        <h1 className="text-2xl font-bold text-slate-900">Subscriptions</h1>
        <p className="text-sm text-slate-500 mt-1">Track member subscription status by season</p>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs font-medium text-slate-500">Season Year</label>
          <Select value={String(seasonYear)} onValueChange={(v) => { setSeasonYear(Number(v)); setPage(1); setSyncMessage(null); }}>
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
              <SelectItem value="NOT_REQUIRED">Not Required</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500">Age Group</label>
          <Select value={ageTier} onValueChange={(v) => { setAgeTier(v as AgeTier | "all"); setPage(1); }}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Age Groups</SelectItem>
              {ageTierOptions.map((option) => (
                <SelectItem key={option.tier} value={option.tier}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {xeroContactGroupsList.length > 0 && (
          <div>
            <label className="text-xs font-medium text-slate-500">Xero Contact Group</label>
            <Select value={xeroContactGroup} onValueChange={(v) => { setXeroContactGroup(v); setPage(1); }}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Xero Contact Groups</SelectItem>
                {xeroContactGroupsList.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name} ({group.contactCount})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button
          variant="outline"
          onClick={() => handleSync("incremental")}
          disabled={syncing !== null}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
          {syncing === "incremental" ? "Syncing..." : "Incremental Sync"}
        </Button>
        <Button
          variant="outline"
          onClick={() => handleSync("backfill")}
          disabled={syncing !== null}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
          {syncing === "backfill" ? "Repairing..." : "Repair Stale Linked Members"}
        </Button>
      </div>
      <p className="text-xs text-amber-700">
        Only linked members are checked in Xero. Unlinked members stay Not
        Invoiced until a Xero contact is linked or created.
      </p>
      <p className="text-xs text-slate-500">
        Incremental sync is the normal low-cost refresh. The repair action is a
        manual backfill for linked members who may be stuck after historical
        Xero invoices were created before the link existed.
      </p>
      {!xeroContactGroupsLoaded && (
        <p className="text-xs text-slate-500">
          Cached Xero contact groups have not been refreshed yet, so linked
          members may appear without group badges.
        </p>
      )}

      {syncMessage && (
        <div className={`rounded-md p-3 text-sm ${syncMessage.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          {syncMessage.text}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Total</CardTitle><Users className="h-4 w-4 text-slate-400" /></CardHeader><CardContent><div className="text-2xl font-bold">{summary.total}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Paid</CardTitle><CheckCircle className="h-4 w-4 text-green-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-green-700">{summary.paid}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Unpaid</CardTitle><Clock className="h-4 w-4 text-yellow-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-yellow-700">{summary.unpaid}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Overdue</CardTitle><AlertCircle className="h-4 w-4 text-red-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-red-700">{summary.overdue}</div></CardContent></Card>
        <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-medium text-slate-500">Not Required</CardTitle><ShieldCheck className="h-4 w-4 text-blue-500" /></CardHeader><CardContent><div className="text-2xl font-bold text-blue-700">{summary.notRequired}</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <SortHeader column="member">Member</SortHeader>
              <SortHeader column="email">Email</SortHeader>
              <SortHeader column="ageTier">Age Group</SortHeader>
              <SortHeader column="xeroContactGroup">Xero Contact Group</SortHeader>
              <SortHeader column="status">Status</SortHeader>
              <SortHeader column="xeroInvoice">Xero Invoice</SortHeader>
              <SortHeader column="paidAt">Paid Date</SortHeader>
            </TableRow></TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-slate-500">Loading...</TableCell></TableRow>
              ) : data.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-slate-500">No subscriptions found</TableCell></TableRow>
              ) : (
                data.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={buildHrefWithReturnTo(`/admin/members/${sub.memberId}?edit=true`, currentSubscriptionsPath)}
                        className="text-blue-600 hover:underline"
                      >
                        {sub.member.lastName}, {sub.member.firstName}
                      </Link>
                    </TableCell>
                    <TableCell>{sub.member.email}</TableCell>
                    <TableCell>{getAgeTierLabel(ageTierOptions, sub.member.ageTier)}</TableCell>
                    <TableCell>
                      {sub.xeroContactGroups.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {sub.xeroContactGroups.map((group) => (
                            <Badge key={group.id} variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                              {group.name}
                            </Badge>
                          ))}
                        </div>
                      ) : sub.member.xeroContactId && !sub.xeroContactGroupsLoaded ? (
                        <span className="text-xs text-slate-400">Cached groups not refreshed yet</span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell><Badge className={subscriptionStatusClass(sub.status)}>{subscriptionStatusLabel(sub.status)}</Badge></TableCell>
                    <TableCell>
                      {sub.xeroInvoiceId ? (
                        <a
                          href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${sub.xeroInvoiceId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                        >
                          {sub.xeroInvoiceNumber || sub.xeroInvoiceId.slice(0, 8)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : "—"}
                    </TableCell>
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
