import Link from "next/link";
import { ArrowRight, Database, KeyRound, LayoutPanelTop } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const nextSteps = [
  {
    title: "Separate finance Xero boundary",
    description:
      "Phase 2 will add independent finance OAuth credentials, token storage, and usage metering.",
    icon: KeyRound,
  },
  {
    title: "Daily finance snapshots",
    description:
      "Phase 3 replaces CSV refreshes with Postgres-backed sync jobs and observable run status.",
    icon: Database,
  },
  {
    title: "Native reporting pages",
    description:
      "Later phases will rebuild revenue, bookings, cash, and balance sheet views directly in TACBookings.",
    icon: LayoutPanelTop,
  },
];

export default function FinancePage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Phase 1 scaffold is live</CardTitle>
          <CardDescription>
            Finance access now sits behind named-user TACBookings
            authentication instead of a shared dashboard password.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm text-slate-600">
            This route is intentionally minimal. It exists to prove the access
            model, guard strategy, and finance route boundary before Xero sync
            and reporting work starts.
          </p>
          <Button asChild variant="outline">
            <Link href="/dashboard">
              Back to dashboard
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {nextSteps.map(({ title, description, icon: Icon }) => (
          <Card key={title}>
            <CardHeader>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                <Icon className="h-5 w-5" />
              </div>
              <CardTitle className="text-lg">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6 text-slate-600">{description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
