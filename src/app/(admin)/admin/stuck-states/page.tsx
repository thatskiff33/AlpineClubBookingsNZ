import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CalendarCheck,
  CreditCard,
  Mail,
  RefreshCw,
  ShieldAlert,
  TentTree,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatClubInstantCompactDateTime,
  parseInstant,
  type BoundClubTime,
} from "@/lib/club-time";
import { clubTime as resolveClubTime } from "@/lib/club-time/server";
import { auth } from "@/lib/auth";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import {
  getStuckStateDashboard,
  type StuckStateDomain,
  type StuckStateItem,
  type StuckStateSeverity,
} from "@/lib/stuck-state-dashboard";
import { cn } from "@/lib/utils";

const domainIcons: Record<StuckStateDomain, typeof CreditCard> = {
  payment: CreditCard,
  booking: CalendarCheck,
  xero: RefreshCw,
  email: Mail,
  waitlist: AlertTriangle,
  bed_allocation: BedDouble,
  lodge: TentTree,
};

const severityLabels: Record<StuckStateSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

// #2264: deliberately not the medium date-time — this "generated at" stamp sits
// in a dense operations header, so it drops the year and keeps 2-digit fields to
// match the system-health timestamps beside it. `generatedAt` is a real INSTANT,
// projected through the club's PERSISTED zone (CT-4, #2870; INV-CONFIG-002).
//
// #3566 moved it onto the kernel's `compactDateTime` house shape, which the
// health dashboard shares: it used to be a local formatter here, built from
// `APP_LOCALE` — the build's locale, not the club's — beside an identical one on
// the health page that already followed the club, so the two screens could
// disagree about the same moment. The binding now carries the club's locale.
function formatGeneratedAt(clubTime: BoundClubTime, value: string) {
  const instant = parseInstant(value);
  if (instant === null) return "an unknown time";
  return formatClubInstantCompactDateTime(
    instant,
    clubTime.zone,
    clubTime.format,
  );
}

function severityBadgeVariant(severity: StuckStateSeverity) {
  if (severity === "critical") return "destructive" as const;
  if (severity === "warning") return "warning" as const;
  return "secondary" as const;
}

function severityRing(severity: StuckStateSeverity | null) {
  if (severity === "critical") return "border-danger/30 bg-danger-muted";
  if (severity === "warning") return "border-warning/30 bg-warning-muted";
  if (severity === "info") return "border-info/30 bg-info-muted";
  return "border-border bg-card";
}

function SummaryCard({
  title,
  value,
  tone,
}: {
  title: string;
  value: number;
  tone: "critical" | "warning" | "info" | "neutral";
}) {
  const toneClasses = {
    critical: "border-danger/30 bg-danger-muted text-danger",
    warning: "border-warning/30 bg-warning-muted text-warning",
    info: "border-info/30 bg-info-muted text-info",
    neutral: "border-border bg-card text-card-foreground",
  };

  return (
    <Card className={toneClasses[tone]}>
      <CardContent className="pt-5">
        <div className="text-3xl font-bold">{value}</div>
        <div className="mt-1 text-sm font-medium">{title}</div>
      </CardContent>
    </Card>
  );
}

function ItemRow({ item }: { item: StuckStateItem }) {
  const Icon = domainIcons[item.domain];

  return (
    <TableRow className="align-top">
      <TableCell>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{item.domainLabel}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium">{item.title}</div>
        <div className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {item.summary}
        </div>
        {item.details && item.details.length > 0 ? (
          <ul className="mt-3 space-y-2" aria-label={`${item.title} details`}>
            {item.details.map((detail) => (
              <li
                key={detail.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted p-2"
              >
                <div>
                  <div className="text-sm font-medium">{detail.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {detail.summary}
                  </div>
                </div>
                <Button asChild variant="ghost" size="sm">
                  <Link href={detail.href}>Open booking</Link>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant={severityBadgeVariant(item.severity)}>
          {severityLabels[item.severity]}
        </Badge>
      </TableCell>
      <TableCell className="text-sm">{item.owner}</TableCell>
      <TableCell className="text-right text-sm font-semibold">
        {item.count}
      </TableCell>
      <TableCell className="text-right">
        <Button asChild variant="outline" size="sm">
          <Link href={item.href}>
            Open
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default async function AdminStuckStatesPage() {
  // #2823: this page is admitted by the (admin) layout at support:view. The
  // named member / booking-owner detail rows are membership-roll surface, so
  // gate them separately on membership:view — the same permission the members
  // admin requires. Mirrors the in-page permission read on /admin/bookings.
  // Fail closed: no session ⇒ no names.
  const session = await auth();
  const viewerCanViewMembership = session?.user
    ? hasAdminAreaAccess(session.user, { area: "membership", level: "view" })
    : false;
  const dashboard = await getStuckStateDashboard({ viewerCanViewMembership });
  const clubTime = await resolveClubTime();

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Stuck States"
        description={`Generated ${formatGeneratedAt(clubTime, dashboard.generatedAt)}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/health">System Health</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Critical records"
          value={dashboard.totals.critical}
          tone="critical"
        />
        <SummaryCard
          title="Warning records"
          value={dashboard.totals.warning}
          tone="warning"
        />
        <SummaryCard
          title="Info records"
          value={dashboard.totals.info}
          tone="info"
        />
        <SummaryCard
          title="Open signals"
          value={dashboard.totals.itemCount}
          tone="neutral"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {dashboard.domains.map((domain) => {
          const Icon = domainIcons[domain.domain];
          return (
            <Card
              key={domain.domain}
              className={cn("border", severityRing(domain.highestSeverity))}
            >
              <CardContent className="flex items-center justify-between gap-4 pt-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-card text-foreground">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {domain.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {domain.itemCount} signal{domain.itemCount === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="text-right text-2xl font-bold text-foreground">
                  {domain.count}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            Operator Queue
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {dashboard.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <ShieldAlert className="h-10 w-10 text-success" />
              <p className="text-sm font-medium text-muted-foreground">
                No stuck states found.
              </p>
            </div>
          ) : (
            <AdminDataTable className="min-w-[840px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.items.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </TableBody>
            </AdminDataTable>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
