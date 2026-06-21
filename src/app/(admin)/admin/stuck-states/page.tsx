import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
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
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import {
  getStuckStateDashboard,
  type StuckStateDomain,
  type StuckStateItem,
  type StuckStateSeverity,
} from "@/lib/stuck-state-dashboard";
import { cn } from "@/lib/utils";

const domainIcons: Record<StuckStateDomain, typeof CreditCard> = {
  payment: CreditCard,
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

function formatGeneratedAt(value: string) {
  return new Date(value).toLocaleString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function severityBadgeVariant(severity: StuckStateSeverity) {
  if (severity === "critical") return "destructive" as const;
  if (severity === "warning") return "warning" as const;
  return "secondary" as const;
}

function severityRing(severity: StuckStateSeverity | null) {
  if (severity === "critical") return "border-red-300 bg-red-50";
  if (severity === "warning") return "border-amber-300 bg-amber-50";
  if (severity === "info") return "border-slate-200 bg-slate-50";
  return "border-slate-200 bg-white";
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
    critical: "border-red-300 bg-red-50 text-red-950",
    warning: "border-amber-300 bg-amber-50 text-amber-950",
    info: "border-slate-200 bg-slate-50 text-slate-900",
    neutral: "border-slate-200 bg-white text-slate-900",
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
    <tr className="border-t align-top">
      <td className="px-4 py-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-slate-500" />
          <span className="text-sm font-medium text-slate-900">
            {item.domainLabel}
          </span>
        </div>
      </td>
      <td className="px-4 py-4">
        <div className="font-medium text-slate-950">{item.title}</div>
        <div className="mt-1 max-w-2xl text-sm text-slate-600">
          {item.summary}
        </div>
      </td>
      <td className="px-4 py-4">
        <Badge variant={severityBadgeVariant(item.severity)}>
          {severityLabels[item.severity]}
        </Badge>
      </td>
      <td className="px-4 py-4 text-sm text-slate-700">{item.owner}</td>
      <td className="px-4 py-4 text-right text-sm font-semibold text-slate-950">
        {item.count}
      </td>
      <td className="px-4 py-4 text-right">
        <Button asChild variant="outline" size="sm">
          <Link href={item.href}>
            Open
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </td>
    </tr>
  );
}

export default async function AdminStuckStatesPage() {
  const dashboard = await getStuckStateDashboard();

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Stuck States</h1>
          <p className="mt-1 text-sm text-slate-500">
            Generated {formatGeneratedAt(dashboard.generatedAt)}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/health">System Health</Link>
        </Button>
      </div>

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
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/80 text-slate-700">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">
                      {domain.label}
                    </p>
                    <p className="text-xs text-slate-600">
                      {domain.itemCount} signal{domain.itemCount === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="text-right text-2xl font-bold text-slate-950">
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
            <ShieldAlert className="h-5 w-5 text-slate-600" />
            Operator Queue
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {dashboard.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <ShieldAlert className="h-10 w-10 text-green-600" />
              <p className="text-sm font-medium text-slate-700">
                No stuck states found.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-left">
                <thead>
                  <tr className="border-t bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-semibold">Domain</th>
                    <th className="px-4 py-3 font-semibold">Signal</th>
                    <th className="px-4 py-3 font-semibold">Severity</th>
                    <th className="px-4 py-3 font-semibold">Owner</th>
                    <th className="px-4 py-3 text-right font-semibold">Count</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.items.map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
