import Link from "next/link";
import { redirect } from "next/navigation";
import { AppProviders } from "@/components/app-providers";
import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { AdminSidebar } from "@/components/admin-sidebar";
import { AdminCommandPalette } from "@/components/admin-command-palette";
import { NavBar } from "@/components/nav-bar";
import { MemberOnboardingWizard } from "@/components/member-onboarding-wizard";
import { ReportIssueWidget } from "@/components/report-issue-widget";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import { HelpWidgetAdmin } from "@/components/help-widget/help-widget-admin";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getAiAssistantAvailability } from "@/lib/ai-assistant-config";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { clubFormatValues } from "@/lib/club-format-server";
import { CardPaymentsRefusedBanner } from "@/components/admin/card-payments-refused-banner";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // THE SECURITY PREAMBLE LIVES IN ONE PLACE (#2378). It used to be inline here, and
  // #2378 was originally going to add a second admin-side layout for a Diagnostics
  // workspace — so a copy of it would have been a second place for the `active` check,
  // the forced password change or the two-factor gate to drift, silently, in the
  // direction that admits somebody.
  //
  // The owner superseded that on 12 Aug 2026: Diagnostics is asked from the Help
  // bubble, and its page lives under `/admin/*` like every other admin screen. The
  // extraction stayed, and is now load-bearing for the opposite reason — that page
  // INHERITS this one guard instead of carrying a second copy of it.
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  const { member, user, permissionMatrix, isFullAdmin: actorIsFullAdmin, nonce } =
    guard;
  const canManageContent = hasAdminAreaAccess(member, {
    area: "content",
    level: "edit",
  });
  const showOnboardingWizard = guard.showOnboardingWizard;
  const [effectiveModules, theme, lodgeCapacity, clubIdentity, clubFormat] =
    await Promise.all([
      loadEffectiveModuleFlags(),
      getWebsiteThemeRenderState(),
      getDefaultLodgeCapacity(),
      getCachedClubIdentity(),
      clubFormatValues(),
    ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };

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
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
          href="#main-content"
        >
          Skip to main content
        </a>
        <NavBar user={user} features={effectiveModules} />
        <HelpWidgetProvider>
        <div className="flex flex-1 flex-col md:flex-row">
          <AdminSidebar
            features={effectiveModules}
            permissionMatrix={permissionMatrix}
            isFullAdmin={actorIsFullAdmin}
            hutLeaderLabel={liveClubIdentity.hutLeaderLabel}
          />
          <AdminCommandPalette
            features={effectiveModules}
            permissionMatrix={permissionMatrix}
            isFullAdmin={actorIsFullAdmin}
            hutLeaderLabel={liveClubIdentity.hutLeaderLabel}
          />
          <div className="flex min-w-0 flex-1 flex-col md:overflow-hidden">
            <main
              id="main-content"
              tabIndex={-1}
              className="flex-1 overflow-y-auto p-6 pb-24 print:overflow-visible print:p-0 md:p-8 md:pb-28"
            >
              {!theme.isComplete && canManageContent && (
                <div className="mb-6 rounded-md border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11 print:hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-medium">
                      Complete your site style before opening the public website.
                    </p>
                    <Link
                      href="/admin/site-style"
                      className="rounded-md bg-brand-gold px-3 py-2 text-sm font-semibold text-brand-charcoal shadow-sm transition-shadow hover:shadow-md"
                    >
                      Open Site Style
                    </Link>
                  </div>
                </div>
              )}
              {/* #3567: card payments refused while the stored currency is unusable. */}
              <CardPaymentsRefusedBanner format={clubFormat} />
              {children}
            </main>
          </div>
        </div>
        <MemberOnboardingWizard initialShouldShow={showOnboardingWizard} />
        <ReportIssueWidget avoidDesktopSidebar />
        {/* AI Diagnostics rides in the Help bubble (AID-7, #2378; owner decision
            12 Aug 2026 superseding Q4). The prop is passed HERE and only here: its
            presence is what grants the tab, and this layout is the surface that has
            already admitted an administrator through `guardAdminLayout`. Owner
            decision Q6 — any admitted admin may open the shell, and the shell is not
            itself a `support:view` permission; every tool re-checks its own area at
            invocation. */}
        <HelpWidgetAdmin
          scope="admin"
          llmEnabled={llmEnabled}
          chatEndpoint="/api/help/chat"
          diagnostics={{ moduleEnabled: effectiveModules.aiDiagnostics }}
        />
        </HelpWidgetProvider>
      </div>
    </AppProviders>
  );
}
