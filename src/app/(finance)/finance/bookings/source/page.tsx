import Link from "next/link";
import { ArrowLeft, Database } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireFinanceViewer } from "@/lib/finance-auth";
import { bookingStatusClass, paymentStatusClass } from "@/lib/status-colors";
import { buildFinanceBookingsSourcePageModel } from "@/lib/finance-bookings-source-page";

type FinanceBookingsSourcePageSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

export default async function FinanceBookingsSourcePage({
  searchParams,
}: {
  searchParams?: FinanceBookingsSourcePageSearchParams;
}) {
  await requireFinanceViewer("/finance/bookings/source");
  const model = await buildFinanceBookingsSourcePageModel({
    searchParams: searchParams ? await searchParams : undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Badge variant="outline" className="w-fit">
            Finance booking sources
          </Badge>
          <h1 className="text-2xl font-semibold text-slate-900">
            {model.pipelineLabel} {model.statusLabel} bookings
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-600">
            Generated {model.generatedOn} from live TACBookings booking rows.
            This finance-scoped list preserves the report filters without
            opening admin-only booking surfaces.
          </p>
        </div>
        <Button asChild variant="outline" className="w-fit">
          <Link href={model.returnHref}>
            <ArrowLeft className="h-4 w-4" />
            Back to report
          </Link>
        </Button>
      </div>

      {model.filterWarnings.length > 0 ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="text-lg text-amber-950">
              Some filters were reset
            </CardTitle>
            <CardDescription className="space-y-2 text-amber-900">
              {model.filterWarnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {model.loadError ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="text-lg text-amber-950">
              Drill-down unavailable
            </CardTitle>
            <CardDescription className="text-amber-900">
              {model.loadError}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Source bookings</CardDescription>
                <CardTitle className="text-3xl text-slate-900">
                  {model.totals.bookingCount}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Booking nights</CardDescription>
                <CardTitle className="text-3xl text-slate-900">
                  {model.totals.contributingNights}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Guest nights</CardDescription>
                <CardTitle className="text-3xl text-slate-900">
                  {model.totals.guestNights}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardDescription>Allocated revenue</CardDescription>
                <CardTitle className="text-3xl text-slate-900">
                  {model.totals.allocatedRevenue}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg text-slate-900">
                <Database className="h-5 w-5 text-slate-500" />
                Source filter
              </CardTitle>
              <CardDescription className="text-sm leading-6 text-slate-600">
                {model.sectionLabel}. Requested window: {model.requestedWindow}.
                Effective source window: {model.effectiveWindow}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {model.rows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                  No source bookings match this status, pipeline, and report
                  window.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Member</TableHead>
                        <TableHead>Stay</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Guests</TableHead>
                        <TableHead className="text-right">Booking nights</TableHead>
                        <TableHead className="text-right">Guest nights</TableHead>
                        <TableHead className="text-right">Allocated revenue</TableHead>
                        <TableHead className="text-right">Booking total</TableHead>
                        <TableHead>Payment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {model.rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <div className="font-medium text-slate-900">
                              {row.memberName}
                            </div>
                            <div className="text-xs text-slate-500">
                              {row.memberEmail}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div>{row.checkIn}</div>
                            <div className="text-xs text-slate-500">
                              to {row.checkOut}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={bookingStatusClass(row.status)}
                            >
                              {row.statusLabel}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{row.guestCount}</TableCell>
                          <TableCell className="text-right">
                            {row.contributingNights}
                          </TableCell>
                          <TableCell className="text-right">{row.guestNights}</TableCell>
                          <TableCell className="text-right font-medium text-slate-900">
                            {row.allocatedRevenue}
                          </TableCell>
                          <TableCell className="text-right">{row.bookingTotal}</TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={paymentStatusClass(row.paymentStatus)}
                            >
                              {row.paymentStatusLabel}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
