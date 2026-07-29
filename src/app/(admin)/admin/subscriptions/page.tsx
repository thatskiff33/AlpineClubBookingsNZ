"use client";

import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { subscriptionStatusLabel } from "@/lib/status-colors";
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups";
import { getAgeTierLabel, useAgeTierOptions } from "@/lib/use-age-tier-options";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  AdminFilterBar,
  type AdminFilterChip,
} from "@/components/admin/admin-filter-bar";
import { SortHeader } from "@/components/admin/sort-header";
import { Pagination } from "@/components/admin/admin-pagination";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Undo2,
  Users,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useXeroStatus } from "@/hooks/use-xero-status";
import { useXeroOrgShortCode } from "@/hooks/use-xero-org-short-code";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { useConfirm } from "@/components/confirm-dialog";
import { SubscriptionBillingPanel } from "./_components/subscription-billing-panel";
import {
  ManualPaymentDialog,
  type ManualPaymentSubmission,
  type ManualPaymentTarget,
} from "./_components/manual-payment-dialog";

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
  manuallyMarkedPaidAt: string | null;
  manualPaymentNote: string | null;
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

function SummaryCard({
  title,
  icon: Icon,
  value,
  valueClassName,
  iconClassName,
}: {
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  valueClassName?: string;
  iconClassName?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon
          className={cn("h-4 w-4", iconClassName ?? "text-muted-foreground")}
          aria-hidden="true"
        />
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-2xl font-bold tabular-nums text-foreground",
            valueClassName,
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ageTierOptions = useAgeTierOptions();
  const canEditFinance = useAdminAreaEditAccess("finance");
  // Org short code for the Xero invoice deep links (#2283). One mount per
  // page; served from the server-side 12h org cache, and null degrades the
  // links to the generic Xero URL rather than hiding them.
  const { connected: xeroConnected } = useXeroStatus();
  const { shortCode: xeroOrgShortCode } = useXeroOrgShortCode(
    xeroConnected === true,
  );
  const { confirm, confirmDialog } = useConfirm();
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
    // #2260: the last browser confirm() on this page. Plain confirmation with
    // no email choice, so the shared useConfirm helper is the right idiom here.
    const confirmed = await confirm(
      mode === "incremental"
        ? {
            title: "Run the incremental Xero refresh?",
            description: `This re-reads paid status from Xero for linked members in the ${seasonYear} season.`,
            confirmLabel: "Run refresh",
          }
        : {
            title: "Run the repair backfill?",
            description:
              "This checks a broader stale-member set for linked members still showing Not Invoiced, and may take longer.",
            confirmLabel: "Run repair",
          },
    );
    if (!confirmed) return;
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

  // Manual mark-paid / mark-unpaid (E14 #1944). Finance-edit only — the whole
  // action column is hidden for finance-view users (E1 gating pattern). The
  // endpoint never calls Xero; it only writes local status + provenance.
  //
  // #2260: confirmation (and the note, and the "email the member or not"
  // choice on the paid path) now happens in ManualPaymentDialog instead of the
  // browser's confirm()/prompt().
  const [manualWorkingId, setManualWorkingId] = useState<string | null>(null);
  const [manualTarget, setManualTarget] = useState<ManualPaymentTarget | null>(
    null,
  );

  function openManualPayment(sub: Subscription, direction: "paid" | "unpaid") {
    // Synthetic NOT_REQUIRED rows have no real subscription row to write to.
    if (sub.id.startsWith("not-required:")) return;
    setManualTarget({
      subscriptionId: sub.id,
      memberName: `${sub.member.firstName} ${sub.member.lastName}`.trim(),
      seasonYear: sub.seasonYear,
      direction,
    });
  }

  async function submitManualPayment(submission: ManualPaymentSubmission) {
    const target = manualTarget;
    if (!target) return;
    setManualTarget(null);
    setManualWorkingId(target.subscriptionId);
    setSyncMessage(null);
    try {
      const res = await fetch(
        `/api/admin/subscriptions/${target.subscriptionId}/manual-payment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            direction: target.direction,
            note: submission.note,
            confirmed: true,
            // The API requires the choice on "paid" and rejects it on
            // "unpaid", so send exactly what the dialog collected.
            ...(submission.notifyMember === undefined
              ? {}
              : { notifyMember: submission.notifyMember }),
          }),
        },
      );
      const json = await res.json();
      if (res.ok) {
        setSyncMessage({ type: "success", text: json.message || "Subscription updated." });
        fetchData();
      } else {
        setSyncMessage({ type: "error", text: json.error || "Manual payment failed." });
      }
    } catch {
      setSyncMessage({ type: "error", text: "Manual payment failed." });
    } finally {
      setManualWorkingId(null);
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
  // The manual mark-paid action column only exists for finance-edit users.
  const columnCount = canEditFinance ? 8 : 7;

  function toggleSort(column: SubscriptionSortBy) {
    setPage(1);
    if (sortBy === column) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortBy(column);
    setSortDir(getDefaultSortDir(column));
  }

  // Thin wrapper over the shared admin SortHeader (#1805): callback mode with the
  // page's existing toggleSort behaviour.
  function SubscriptionSortHeader({
    column,
    children,
  }: {
    column: SubscriptionSortBy;
    children: ReactNode;
  }) {
    return (
      <SortHeader
        active={sortBy === column}
        direction={sortDir}
        onSort={() => toggleSort(column)}
      >
        {children}
      </SortHeader>
    );
  }

  // Active-filter chips. Removing a chip resets just that filter to "all" (the
  // same effect as selecting the "All" option), so query semantics are unchanged.
  const filterChips: AdminFilterChip[] = [];
  if (status !== "all") {
    filterChips.push({
      key: "status",
      label: "Status",
      value: subscriptionStatusLabel(status),
      onRemove: () => { setStatus("all"); setPage(1); },
    });
  }
  if (ageTier !== "all") {
    filterChips.push({
      key: "ageTier",
      label: "Age group",
      value: getAgeTierLabel(ageTierOptions, ageTier),
      onRemove: () => { setAgeTier("all"); setPage(1); },
    });
  }
  if (xeroContactGroup !== "all") {
    filterChips.push({
      key: "xeroContactGroup",
      label: "Xero group",
      value:
        xeroContactGroupsList.find((group) => group.id === xeroContactGroup)?.name ??
        xeroContactGroup,
      onRemove: () => { setXeroContactGroup("all"); setPage(1); },
    });
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      <AdminPageHeader
        title="Subscriptions"
        description="Track member subscription status by season"
        actions={
          <>
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
          </>
        }
      />

      <SubscriptionBillingPanel seasonYear={seasonYear} />

      <AdminFilterBar
        idPrefix="subscriptions-filters"
        chips={filterChips}
        primary={
          <>
            <div>
              <Label className="text-xs">Season Year</Label>
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
              <Label className="text-xs">Status</Label>
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
              <Label className="text-xs">Age Group</Label>
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
                <Label className="text-xs">Xero Contact Group</Label>
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
          </>
        }
      />

      <div className="space-y-2">
        <p className="text-xs text-warning">
          Only linked members are checked in Xero. Unlinked members stay Not
          Invoiced until a Xero contact is linked or created.
        </p>
        <p className="text-xs text-muted-foreground">
          Incremental sync is the normal low-cost refresh. The repair action is a
          manual backfill for linked members who may be stuck after historical
          Xero invoices were created before the link existed.
        </p>
        {!xeroContactGroupsLoaded && (
          <p className="text-xs text-muted-foreground">
            Cached Xero contact groups have not been refreshed yet, so linked
            members may appear without group badges.
          </p>
        )}
      </div>

      {syncMessage && (
        <Alert variant={syncMessage.type === "success" ? "success" : "error"}>
          {syncMessage.text}
        </Alert>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <SummaryCard title="Total" icon={Users} value={summary.total} />
        <SummaryCard
          title="Paid"
          icon={CheckCircle2}
          iconClassName="text-success"
          valueClassName="text-success"
          value={summary.paid}
        />
        <SummaryCard
          title="Unpaid"
          icon={Clock}
          iconClassName="text-warning"
          valueClassName="text-warning"
          value={summary.unpaid}
        />
        <SummaryCard
          title="Overdue"
          icon={AlertCircle}
          iconClassName="text-danger"
          valueClassName="text-danger"
          value={summary.overdue}
        />
        <SummaryCard
          title="Not Required"
          icon={ShieldCheck}
          iconClassName="text-info"
          valueClassName="text-info"
          value={summary.notRequired}
        />
      </div>

      <AdminDataTable
        aria-label="Subscriptions"
        toolbar={
          <p>
            Showing {data.length} of {total} subscription{total === 1 ? "" : "s"}
          </p>
        }
      >
        <TableHeader>
          <TableRow>
            <SubscriptionSortHeader column="member">Member</SubscriptionSortHeader>
            <SubscriptionSortHeader column="email">Email</SubscriptionSortHeader>
            <SubscriptionSortHeader column="ageTier">Age Group</SubscriptionSortHeader>
            <SubscriptionSortHeader column="xeroContactGroup">Xero Contact Group</SubscriptionSortHeader>
            <SubscriptionSortHeader column="status">Status</SubscriptionSortHeader>
            <SubscriptionSortHeader column="xeroInvoice">Xero Invoice</SubscriptionSortHeader>
            <SubscriptionSortHeader column="paidAt">Paid Date</SubscriptionSortHeader>
            {canEditFinance ? <TableHead>Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="py-10 text-center">
                <div className="flex justify-center">
                  <Spinner label="Loading subscriptions…" />
                </div>
              </TableCell>
            </TableRow>
          ) : data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="p-0">
                <EmptyState
                  icon={Users}
                  title="No subscriptions found"
                  description="No subscriptions match your current filters. Try a different season or status."
                />
              </TableCell>
            </TableRow>
          ) : (
            data.map((sub) => (
              <TableRow key={sub.id}>
                <TableCell className="font-medium">
                  <Link
                    href={buildHrefWithReturnTo(`/admin/members/${sub.memberId}?edit=true`, currentSubscriptionsPath)}
                    className="rounded-sm text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {sub.member.lastName}, {sub.member.firstName}
                  </Link>
                </TableCell>
                <TableCell className="text-sm">{sub.member.email}</TableCell>
                <TableCell className="text-sm">{getAgeTierLabel(ageTierOptions, sub.member.ageTier)}</TableCell>
                <TableCell>
                  {sub.xeroContactGroups.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {sub.xeroContactGroups.map((group) => (
                        <Badge key={group.id} variant="secondary">
                          {group.name}
                        </Badge>
                      ))}
                    </div>
                  ) : sub.member.xeroContactId && !sub.xeroContactGroupsLoaded ? (
                    <span className="text-xs text-muted-foreground">Cached groups not refreshed yet</span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <StatusChip
                    kind="subscription"
                    value={sub.status as SubscriptionStatus}
                    label={sub.manuallyMarkedPaidAt ? `${subscriptionStatusLabel(sub.status)} (manual)` : undefined}
                    title={
                      sub.manuallyMarkedPaidAt
                        ? `Marked paid manually${sub.manualPaymentNote ? `: ${sub.manualPaymentNote}` : ""}`
                        : undefined
                    }
                  />
                </TableCell>
                <TableCell>
                  {sub.xeroInvoiceId ? (
                    <a
                      href={buildXeroInvoiceUrl(sub.xeroInvoiceId, {
                        shortCode: xeroOrgShortCode,
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {sub.xeroInvoiceNumber || sub.xeroInvoiceId.slice(0, 8)}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : "—"}
                </TableCell>
                <TableCell className="text-sm">{sub.paidAt ? format(new Date(sub.paidAt), "d MMM yyyy") : "—"}</TableCell>
                {canEditFinance ? (
                  <TableCell>
                    {sub.id.startsWith("not-required:") ? (
                      "—"
                    ) : sub.manuallyMarkedPaidAt ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={manualWorkingId === sub.id}
                        onClick={() => openManualPayment(sub, "unpaid")}
                      >
                        <Undo2 className="h-4 w-4 mr-1" />
                        Mark as unpaid
                      </Button>
                    ) : sub.status !== "PAID" && sub.status !== "NOT_REQUIRED" && !sub.xeroInvoiceId ? (
                      // Manual mark-paid is for cash payments where NO Xero
                      // invoice exists (#1944 owner decision). A row with a Xero
                      // invoice link must be settled against the invoice in
                      // Xero, and a NOT_REQUIRED row has nothing to pay, so
                      // neither offers the action.
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={manualWorkingId === sub.id}
                        onClick={() => openManualPayment(sub, "paid")}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" />
                        Mark as paid (manual)
                      </Button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))
          )}
        </TableBody>
      </AdminDataTable>

      <ManualPaymentDialog
        target={manualTarget}
        submitting={manualWorkingId !== null}
        onCancel={() => setManualTarget(null)}
        onSubmit={submitManualPayment}
      />

      <Pagination
        as="div"
        aria-label="Subscriptions pagination"
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        summary={`Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}`}
      />
    </div>
  );
}
