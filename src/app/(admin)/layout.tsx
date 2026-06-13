import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AdminSidebar } from "@/components/admin-sidebar";
import { NavBar } from "@/components/nav-bar";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { clubIdentity } from "@/config/club-identity";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { hasFinanceViewerAccess } from "@/lib/finance-auth";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { isClubThemeComplete } from "@/lib/club-theme";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import {
  MEMBER_ONBOARDING_GATE_SELECT,
  shouldShowMemberOnboarding,
} from "@/lib/member-onboarding";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  // Check DB directly for force password change and active status (JWT may be stale)
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: MEMBER_ONBOARDING_GATE_SELECT,
  });

  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  const user = {
    name: session.user.name ?? "Admin",
    email: session.user.email ?? "",
    role: (session.user as { role?: string }).role ?? "ADMIN",
    canAccessFinance: hasFinanceViewerAccess(member.financeAccessLevel),
    isHutLeader: false,
    isStayingGuest: false,
  };
  const showOnboardingWizard = shouldShowMemberOnboarding(member);
  const [effectiveModules, siteStyleComplete, lodgeCapacity] =
    await Promise.all([
      loadEffectiveModuleFlags(),
      isClubThemeComplete(),
      getLodgeCapacity(),
    ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div className="app-theme-scope min-h-screen flex flex-col bg-background text-foreground">
        <NavBar user={user} features={effectiveModules} />
        <div className="flex flex-1">
          <AdminSidebar features={effectiveModules} />
          <div className="flex flex-1 flex-col md:overflow-hidden">
            <main className="flex-1 overflow-y-auto p-6 print:overflow-visible print:p-0 md:p-8">
              {!siteStyleComplete && (
                <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 print:hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-medium">
                      Complete your site style before opening the public website.
                    </p>
                    <Link
                      href="/admin/site-style"
                      className="rounded-md bg-brand-gold px-3 py-2 text-sm font-semibold text-brand-charcoal shadow-sm transition-colors hover:bg-brand-gold/90"
                    >
                      Open Site Style
                    </Link>
                  </div>
                </div>
              )}
              {children}
            </main>
          </div>
        </div>
        <MemberOnboardingWizard initialShouldShow={showOnboardingWizard} />
        <ReportIssueWidget avoidDesktopSidebar />
      </div>
    </AppProviders>
  );
}
