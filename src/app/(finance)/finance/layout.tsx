import { headers } from "next/headers";
import { AppProviders } from "@/components/app-providers";
import { Badge } from "@/components/ui/badge";
import { NavBar } from "@/components/nav-bar";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { CLUB_NAME, clubIdentity } from "@/config/club-identity";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
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
  const [effectiveModules, lodgeCapacity] = await Promise.all([
    loadEffectiveModuleFlags(),
    getLodgeCapacity(),
  ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div className="app-theme-scope min-h-screen flex flex-col bg-background text-foreground">
        <NavBar
          features={effectiveModules}
          user={{
            name: fullName,
            email: member.email,
            role: member.role,
            canAccessFinance: true,
          }}
        />
        <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-8 flex flex-col gap-3 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
                Finance
              </p>
              <h1 className="text-3xl font-semibold text-foreground">
                {CLUB_NAME} finance workspace
              </h1>
              <p className="text-sm text-muted-foreground">
                Review finance reports, booking performance, and sync status in
                one place.
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
    </AppProviders>
  );
}
