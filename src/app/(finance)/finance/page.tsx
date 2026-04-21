import Link from "next/link";
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
import { requireFinanceViewer } from "@/lib/finance-auth";
import {
  buildFinanceLandingPageModel,
  type FinanceLandingSectionSummary,
} from "@/lib/finance-landing-page";
import { buildFinanceBookingsReportHref } from "@/lib/finance-bookings-report-page";
import {
  buildDefaultFinanceCashReportFilters,
  buildFinanceCashReportHref,
} from "@/lib/finance-cash-report-page";
import { buildFinanceRevenueReportHref } from "@/lib/finance-revenue-report-page";

const sectionIcons = {
  "sync-health": Activity,
  "realized-bookings": Database,
  "forward-pipeline": TrendingUp,
} as const;

function FinanceSection({ section }: { section: FinanceLandingSectionSummary }) {
  const Icon = sectionIcons[section.id as keyof typeof sectionIcons] ?? Activity;

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
          <h2 className="text-2xl font-semibold text-slate-900">{section.title}</h2>
          <p className="text-sm leading-6 text-slate-600">{section.description}</p>
        </div>
      </div>

      {section.error ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-amber-950">
              <ShieldAlert className="h-5 w-5" />
              Section unavailable
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

export default async function FinancePage() {
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
    buildDefaultFinanceCashReportFilters()
  );

  return (
    <div className="space-y-8">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,0.85fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit">
              Native finance landing page
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl text-slate-900">
                Live finance state inside TACBookings
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6 text-slate-600">
                This shell turns the landed finance sync diagnostics and booking
                metrics boundaries into a single finance entry point for
                viewers and managers without broadening into full reporting
                pages.
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
                <Link href={cashReportHref}>
                  Open cash report
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Generated {model.generatedOn}. Realized booking cards use the
              current month to date. Forward pipeline cards use the next 90
              days after today in New Zealand local time.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-lg text-slate-900">
                  Finance workspace actions
                </CardTitle>
                <CardDescription className="text-sm text-slate-600">
                  Viewer-safe summaries stay on this page. Manager-only
                  diagnostics remain separate.
                </CardDescription>
              </div>
              <Badge variant={model.sync.badgeVariant}>{model.sync.badgeLabel}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {model.managerActions.length > 0 ? (
              model.managerActions.map((action) => (
                <Button
                  key={action.href}
                  asChild
                  variant="outline"
                  className="w-full justify-between"
                >
                  <Link href={action.href} target="_blank" rel="noreferrer">
                    <span className="text-left">
                      <span className="block text-sm font-medium">
                        {action.label}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {action.description}
                      </span>
                    </span>
                    <ArrowUpRight className="ml-3 h-4 w-4 shrink-0" />
                  </Link>
                </Button>
              ))
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                Finance viewer access does not expose manager-only diagnostics
                or Xero connection actions here.
              </div>
            )}

            <Button asChild variant="ghost" className="w-full justify-between">
              <Link href="/dashboard">
                Back to dashboard
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
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
              This landing page combines booking-derived and sync-derived
              finance context. The source boundary for each section stays
              explicit here so later reporting pages can build on it safely.
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
