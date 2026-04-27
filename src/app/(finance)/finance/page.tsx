import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarRange,
  Database,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  requireFinanceManager,
  requireFinanceViewer,
} from "@/lib/finance-auth";
import {
  buildDefaultFinanceBalanceSheetReportFilters,
  buildFinanceBalanceSheetReportHref,
} from "@/lib/finance-balance-sheet-report-page";
import {
  buildDefaultFinanceCostsReportFilters,
  buildFinanceCostsReportHref,
} from "@/lib/finance-costs-report-page";
import {
  buildDefaultFinancePricingSensitivityFilters,
  buildFinancePricingSensitivityReportHref,
} from "@/lib/finance-pricing-sensitivity-page";
import {
  buildDefaultFinanceWorkingCapitalReportFilters,
  buildFinanceWorkingCapitalReportHref,
} from "@/lib/finance-working-capital-report-page";
import {
  buildFinanceLandingPageModel,
  type FinanceLandingManagerAction,
  type FinanceLandingManagerWorkspace,
  type FinanceLandingSectionSummary,
} from "@/lib/finance-landing-page";
import { buildFinanceBookingsReportHref } from "@/lib/finance-bookings-report-page";
import {
  buildDefaultFinanceCashReportFilters,
  buildFinanceCashReportHref,
} from "@/lib/finance-cash-report-page";
import { disconnectFinanceXero } from "@/lib/finance-xero";
import { buildFinanceRevenueReportHref } from "@/lib/finance-revenue-report-page";

const sectionIcons = {
  "sync-health": Activity,
  "realized-bookings": Database,
  "forward-pipeline": TrendingUp,
} as const;

function FinanceSection({
  section,
}: {
  section: FinanceLandingSectionSummary;
}) {
  const Icon =
    sectionIcons[section.id as keyof typeof sectionIcons] ?? Activity;

  return (
    <section id={section.id} className="scroll-mt-24 space-y-4">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Icon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            {section.eyebrow}
          </p>
          <h2 className="text-2xl font-semibold text-slate-900">
            {section.title}
          </h2>
          <p className="text-sm leading-6 text-slate-600">
            {section.description}
          </p>
        </div>
      </div>

      {section.error ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-amber-950">
              <ShieldAlert className="h-5 w-5" />
              Data unavailable
            </CardTitle>
            <CardDescription className="text-amber-900">
              {section.error}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {section.cards.map((card) => (
            <Card key={card.title}>
              <CardHeader className="pb-3">
                <CardDescription>{card.title}</CardDescription>
                <CardTitle className="text-3xl text-slate-900">
                  {card.value}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm leading-6 text-slate-600">
                  {card.description}
                </p>
                {card.footnote ? (
                  <p className="text-xs font-medium text-slate-500">
                    {card.footnote}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function FinanceStatusNotice({
  tone,
  title,
  description,
}: {
  tone: "success" | "warning" | "destructive";
  title: string;
  description: string;
}) {
  const toneClass =
    tone === "success"
      ? "border-green-200 bg-green-50/70 text-green-950"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50/70 text-amber-950"
        : "border-red-200 bg-red-50/70 text-red-950";
  const descriptionClass =
    tone === "destructive" ? "text-red-900" : "text-inherit";

  return (
    <Card className={toneClass}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription className={descriptionClass}>
          {description}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function ManagerActionButton({
  action,
  disconnectAction,
}: {
  action: FinanceLandingManagerAction;
  disconnectAction: (formData: FormData) => Promise<void>;
}) {
  if (action.kind === "disconnect") {
    return (
      <form action={disconnectAction}>
        <Button
          type="submit"
          variant="destructive"
          className="w-full justify-between"
        >
          <span className="text-left">
            <span className="block text-sm font-medium">{action.label}</span>
            <span className="block text-xs text-red-100/90">
              {action.description}
            </span>
          </span>
          <ArrowRight className="ml-3 h-4 w-4 shrink-0" />
        </Button>
      </form>
    );
  }

  if (!action.href) {
    return null;
  }

  const isConnectAction = action.kind === "connect";

  return (
    <Button
      asChild
      variant={isConnectAction ? "default" : "outline"}
      className="w-full justify-between"
    >
      <Link
        href={action.href}
        target={action.kind === "link" ? "_blank" : undefined}
        rel={action.kind === "link" ? "noreferrer" : undefined}
      >
        <span className="text-left">
          <span className="block text-sm font-medium">{action.label}</span>
          <span className="block text-xs text-slate-500">
            {action.description}
          </span>
        </span>
        {action.kind === "link" ? (
          <ArrowUpRight className="ml-3 h-4 w-4 shrink-0" />
        ) : (
          <ArrowRight className="ml-3 h-4 w-4 shrink-0" />
        )}
      </Link>
    </Button>
  );
}

function FinanceManagerWorkspace({
  workspace,
  disconnectAction,
}: {
  workspace: FinanceLandingManagerWorkspace;
  disconnectAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              {workspace.eyebrow}
            </p>
            <CardTitle className="text-lg text-slate-900">
              {workspace.title}
            </CardTitle>
            <CardDescription className="text-sm text-slate-600">
              {workspace.description}
            </CardDescription>
          </div>
          <Badge variant={workspace.badgeVariant}>{workspace.badgeLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {workspace.error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm leading-6 text-amber-950">
            {workspace.error}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {workspace.cards.map((card) => (
              <Card key={card.title}>
                <CardHeader className="pb-3">
                  <CardDescription>{card.title}</CardDescription>
                  <CardTitle className="text-2xl text-slate-900">
                    {card.value}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm leading-6 text-slate-600">
                    {card.description}
                  </p>
                  {card.footnote ? (
                    <p className="text-xs font-medium text-slate-500">
                      {card.footnote}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {workspace.configIssues.length > 0 ||
        workspace.tokenStorageIssues.length > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm leading-6 text-amber-950">
            <p className="font-semibold">Setup issues to fix</p>
            {workspace.configIssues.length > 0 ? (
              <p>OAuth config: {workspace.configIssues.join(" ")}</p>
            ) : null}
            {workspace.tokenStorageIssues.length > 0 ? (
              <p>Token storage: {workspace.tokenStorageIssues.join(" ")}</p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          {workspace.actions.map((action) => (
            <ManagerActionButton
              key={`${action.kind}:${action.label}`}
              action={action}
              disconnectAction={disconnectAction}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    xero?: string;
  }>;
}) {
  const params = await searchParams;

  async function disconnectFinanceXeroAction(formData: FormData) {
    "use server";

    void formData;
    await requireFinanceManager("/finance");
    await disconnectFinanceXero();
    revalidatePath("/finance");
    redirect("/finance?xero=disconnected");
  }

  const member = await requireFinanceViewer("/finance");
  const model = await buildFinanceLandingPageModel({ member });
  const bookingsReportHref = buildFinanceBookingsReportHref({
    realizedFrom: model.windows.realized.from,
    realizedTo: model.windows.realized.to,
    realizedCutoff: model.windows.realized.to,
    forwardFrom: model.windows.forward.from,
    forwardTo: model.windows.forward.to,
    forwardAsOf: model.windows.forward.asOfDate,
  });
  const revenueReportHref = buildFinanceRevenueReportHref({
    periods: 6,
  });
  const cashReportHref = buildFinanceCashReportHref(
    buildDefaultFinanceCashReportFilters(),
  );
  const balanceSheetReportHref = buildFinanceBalanceSheetReportHref(
    buildDefaultFinanceBalanceSheetReportFilters(),
  );
  const costsReportHref = buildFinanceCostsReportHref(
    buildDefaultFinanceCostsReportFilters(),
  );
  const pricingSensitivityReportHref = buildFinancePricingSensitivityReportHref(
    buildDefaultFinancePricingSensitivityFilters(),
  );
  const workingCapitalReportHref = buildFinanceWorkingCapitalReportHref(
    buildDefaultFinanceWorkingCapitalReportFilters(),
  );
  const notice =
    params.error
      ? {
          tone: "destructive" as const,
          title: "Finance Xero action failed",
          description: params.error,
        }
      : params.connected === "true"
        ? {
            tone: "success" as const,
            title: "Finance Xero connected",
            description:
              "The finance Xero connection completed successfully. Check the manager status cards before relying on the latest synced data.",
          }
        : params.xero === "disconnected"
          ? {
              tone: "success" as const,
              title: "Finance Xero disconnected",
              description:
                "The saved finance Xero connection was cleared. Reconnect it before running checks that depend on fresh Xero data.",
            }
          : null;

  return (
    <div className="space-y-8">
      {notice ? (
        <FinanceStatusNotice
          tone={notice.tone}
          title={notice.title}
          description={notice.description}
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Finance overview
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Finance summary and report access
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                Use this page to check sync status, review booking activity,
                and open the main finance reports.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {model.sectionLinks.map((link) => (
                <Button key={link.href} asChild variant="outline" size="sm">
                  <Link href={link.href}>{link.label}</Link>
                </Button>
              ))}
              <Button asChild size="sm">
                <Link href={bookingsReportHref}>
                  Open bookings report
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={revenueReportHref}>
                  Open revenue report
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={costsReportHref}>
                  Open costs report
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={pricingSensitivityReportHref}>
                  Open pricing sensitivity
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={workingCapitalReportHref}>
                  Open working capital
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={cashReportHref}>
                  Open cash report
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={balanceSheetReportHref}>
                  Open balance sheet report
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn}. Realized booking cards use the
              current month to date. Forward pipeline cards use the next 90 days
              after today in New Zealand local time.
            </div>
          </CardContent>
        </Card>

        {model.managerWorkspace ? (
          <FinanceManagerWorkspace
            workspace={model.managerWorkspace}
            disconnectAction={disconnectFinanceXeroAction}
          />
        ) : (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-lg text-slate-900">
                    Finance workspace actions
                  </CardTitle>
                  <CardDescription className="text-sm text-slate-600">
                    This page shows shared finance summaries. Manager-only
                    connection tools stay hidden from viewers.
                  </CardDescription>
                </div>
                <Badge variant={model.sync.badgeVariant}>
                  {model.sync.badgeLabel}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                Viewer access does not include Xero setup tools or technical
                diagnostics.
              </div>

              <Button asChild variant="ghost" className="w-full justify-between">
                <Link href="/dashboard">
                  Back to dashboard
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <FinanceSection section={model.sync} />
      <FinanceSection section={model.realized} />
      <FinanceSection section={model.forward} />

      <section id="data-sources" className="scroll-mt-24 space-y-4">
        <div className="flex items-start gap-3">
          <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
            <CalendarRange className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Data sources
            </p>
            <h2 className="text-2xl font-semibold text-slate-900">
              What each number represents
            </h2>
            <p className="text-sm leading-6 text-slate-600">
              This page combines booking information with sync status. These
              notes explain where each section gets its numbers.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {model.dataSources.map((item) => (
            <Card key={item.label}>
              <CardHeader>
                <CardTitle className="text-lg text-slate-900">
                  {item.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-slate-600">
                  {item.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
