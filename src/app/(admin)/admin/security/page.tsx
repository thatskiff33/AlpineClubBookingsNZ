import type { Metadata } from "next";
import { GoogleSecurityCard } from "@/components/admin/google-security-card";
import { MagicLinkSecurityCard } from "@/components/admin/magic-link-security-card";
import { OfficerTwoFactorCard } from "@/components/admin/security/officer-two-factor-card";
import { PasswordPolicyCard } from "@/components/admin/security/password-policy-card";
import { isFullAdmin } from "@/lib/access-roles";
import { auth } from "@/lib/auth";
import { getGoogleSetupState } from "@/lib/google-config";
import { loadLoginSecuritySettings } from "@/lib/login-security-settings";
import { loadClubModuleSettings } from "@/lib/module-settings";
import { loadOfficerTwoFactorReport } from "@/lib/officer-two-factor";
import { OFFICER_SIGN_IN_RELEASE_ENABLED } from "@/lib/officer-sign-in-release";
import { clubFormatValues } from "@/lib/club-format-server";

// Login & Security admin page (epic #2030, child #2033). Scaffolds the page and
// hosts the password-policy card, the magic-link sign-in card (#2034), and the
// Google sign-in card (#2035). Every card loads read-only and stages its own
// edits behind a per-section Edit → Save/Cancel step (#2103).
// Route access is governed by the `support` admin area (see admin-permissions.ts).
//
// The magic-link card writes its own edits: the enable toggle through
// PUT /api/admin/modules (GET-fresh-then-merge to avoid clobbering sibling
// modules) and the link expiry through PUT /api/admin/security/magic-link. This
// server component passes only serialisable props — the configured TTL is passed
// as `initialTtlMinutes` so the card round-trips the persisted value — and does
// not inject an `onSaveTtlMinutes` handler (a React Server Component cannot pass
// a function prop; the card's built-in route call is the production write path).

export const metadata: Metadata = {
  title: "Login & Security",
};

export default async function AdminSecurityPage() {
  // The club's format (#3565), resolved once per render pass.
  const format = await clubFormatValues();
  const [{ settings: moduleSettings }, loginSecurity, googleState] =
    await Promise.all([
      loadClubModuleSettings(format),
      loadLoginSecuritySettings(),
      // Fail-open: a store error degrades to "not configured / not verified" so
      // the card renders (and the enable gate shows) rather than the page 500ing.
      getGoogleSetupState().catch(() => ({
        clientIdSet: false,
        clientSecretSet: false,
        needsReentry: false,
        verified: false,
      })),
    ]);
  const googleConfigured = googleState.clientIdSet && googleState.clientSecretSet;
  const session = OFFICER_SIGN_IN_RELEASE_ENABLED ? await auth() : null;
  const viewerIsFullAdmin = session?.user ? isFullAdmin(session.user) : false;
  const officerReport =
    OFFICER_SIGN_IN_RELEASE_ENABLED && viewerIsFullAdmin
      ? await loadOfficerTwoFactorReport()
      : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Login &amp; Security</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Control how members sign in and how strong their passwords must be.
          These settings apply across the club.
        </p>
      </div>

      <div className="grid gap-6">
        <PasswordPolicyCard />
        <MagicLinkSecurityCard
          moduleSettings={moduleSettings}
          initialTtlMinutes={loginSecurity.policy.magicLinkTtlMinutes}
        />
        <GoogleSecurityCard
          moduleSettings={moduleSettings}
          credentialsConfigured={googleConfigured}
          verified={googleState.verified}
          needsReentry={googleState.needsReentry}
        />
        {OFFICER_SIGN_IN_RELEASE_ENABLED ? (
          <OfficerTwoFactorCard canEdit={viewerIsFullAdmin} />
        ) : null}
        {OFFICER_SIGN_IN_RELEASE_ENABLED && viewerIsFullAdmin ? (
          <section className="space-y-3 rounded-lg border p-6">
            <h2 className="text-base font-semibold">Officers still to set up</h2>
            <p className="text-sm text-muted-foreground">
              People who must use an authenticator app or a passkey, and have
              not yet. A reset ends grace: the next sign-in goes to set-up.
            </p>
            {officerReport.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everyone required is set up.</p>
            ) : (
              <ul className="divide-y text-sm">
                {officerReport.map((row) => (
                  <li key={row.memberId} className="flex items-baseline justify-between gap-4 py-2">
                    <span>
                      {row.name}{" "}
                      <span className="text-muted-foreground">{row.email}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {row.grace === "not-started"
                        ? "Grace not started"
                        : row.grace === "ended"
                          ? "Grace ended"
                          : `By ${row.grace}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
