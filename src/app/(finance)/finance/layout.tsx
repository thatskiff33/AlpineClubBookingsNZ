import { Badge } from "@/components/ui/badge";
import { NavBar } from "@/components/nav-bar";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import {
  hasFinanceManagerAccess,
  requireFinanceViewer,
} from "@/lib/finance-auth";

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const member = await requireFinanceViewer("/finance");
  const fullName = `${member.firstName} ${member.lastName}`.trim() || "Member";
  const isManager = hasFinanceManagerAccess(member.financeAccessLevel);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <NavBar
        user={{
          name: fullName,
          email: member.email,
          role: member.role,
          canAccessFinance: true,
        }}
      />
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
              Finance
            </p>
            <h1 className="text-3xl font-semibold text-slate-900">
              TAC finance workspace
            </h1>
            <p className="text-sm text-slate-600">
              Native finance reporting now lives inside TACBookings. This
              Phase 1 slice establishes the access boundary and route shape.
            </p>
          </div>
          <Badge variant={isManager ? "default" : "secondary"}>
            {isManager ? "Finance manager" : "Finance viewer"}
          </Badge>
        </div>
        {children}
      </main>
      <ReportIssueWidget />
    </div>
  );
}
