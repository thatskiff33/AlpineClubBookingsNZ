import { headers } from "next/headers";
import { AppProviders } from "@/components/app-providers";
import { Badge } from "@/components/ui/badge";
import { NavBar } from "@/components/nav-bar";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import { HelpWidgetAdmin } from "@/components/help-widget/help-widget-admin";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getAiAssistantAvailability } from "@/lib/ai-assistant-config";
import { requireFinanceViewer } from "@/lib/finance-auth";
import { AdminSidebar } from "@/components/admin-sidebar";
import { AdminCommandPalette } from "@/components/admin-command-palette";
import { isFullAdmin } from "@/lib/access-roles";
import { resolveMemberAdminNavPanels } from "@/lib/admin-nav-panels";
import {
  getAdminPermissionMatrix,
  hasAdminPortalAccess,
  hasFinanceManagerAccess,
} from "@/lib/admin-permissions";

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const member = await requireFinanceViewer("/finance");
  const fullName = `${member.firstName} ${member.lastName}`.trim() || "Member";
  const isManager = hasFinanceManagerAccess(member);
  // The admin sidebar's role panels (#108): menu display only, filtered item by
  // item exactly as on /admin; every admin page still runs its own guard.
  const permissionMatrix = getAdminPermissionMatrix(member);
  const actorIsFullAdmin = isFullAdmin(member);
  const adminNavPanels = resolveMemberAdminNavPanels(member);
  const [effectiveModules, lodgeCapacity, theme, clubIdentity] = await Promise.all([
    loadEffectiveModuleFlags(),
    getDefaultLodgeCapacity(),
    getWebsiteThemeRenderState(),
    getCachedClubIdentity(),
  ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  // Paid AI free-text path: module on AND a usable Anthropic key stored. Budget
  // is deliberately not checked at render (runtime fallback handles it).
  const llmEnabled =
    effectiveModules.aiAssistant &&
    (await getAiAssistantAvailability(effectiveModules));

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div
        className={`${clubThemeFontVariableClassName} app-theme-scope min-h-screen flex flex-col bg-background text-foreground`}
      >
        <style
          dangerouslySetInnerHTML={{ __html: theme.appCss }}
          data-site-style="club-theme"
        />
        <NavBar
          features={effectiveModules}
          user={{
            name: fullName,
            email: member.email,
            role: member.role,
            canAccessAdmin: hasAdminPortalAccess(member),
            canAccessFinance: true,
          }}
          surface="staff"
        />
        <HelpWidgetProvider>
        <div className="flex flex-1 flex-col md:flex-row">
        <AdminSidebar
          features={effectiveModules}
          permissionMatrix={permissionMatrix}
          isFullAdmin={actorIsFullAdmin}
          panels={adminNavPanels}
          hutLeaderLabel={liveClubIdentity.hutLeaderLabel}
        />
        <AdminCommandPalette
          features={effectiveModules}
          permissionMatrix={permissionMatrix}
          isFullAdmin={actorIsFullAdmin}
          hutLeaderLabel={liveClubIdentity.hutLeaderLabel}
        />
        <main className="reports-print-root min-w-0 flex-1 mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-8 flex flex-col gap-3 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Finance
              </p>
              <h1 className="text-3xl font-semibold text-foreground">
                {liveClubIdentity.name} finance workspace
              </h1>
              <p className="text-sm text-muted-foreground">
                Review finance reports, booking performance, and sync status in
                one place.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={isManager ? "default" : "secondary"}>
                {isManager ? "Finance manager" : "Finance viewer"}
              </Badge>
            </div>
          </div>
          {children}
        </main>
        </div>
        <ReportIssueWidget avoidDesktopSidebar />
        <HelpWidgetAdmin
          scope="finance"
          llmEnabled={llmEnabled}
          chatEndpoint="/api/help/chat"
        />
        </HelpWidgetProvider>
      </div>
    </AppProviders>
  );
}
