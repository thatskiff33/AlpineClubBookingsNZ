import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";
import { CLUB_CONTACT_EMAIL, CLUB_NAME } from "@/config/club-identity";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { CSP_NONCE_HEADER } from "@/lib/csp";

export default async function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, theme, requestHeaders] = await Promise.all([
    auth(),
    getWebsiteThemeRenderState(),
    headers(),
  ]);
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;
  const themeStyle = (
    <style
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: theme.css }}
      data-site-style="club-theme"
    />
  );

  if (!theme.isComplete) {
    return (
      <div
        className={`${clubThemeFontVariableClassName} website-theme min-h-screen bg-background text-foreground`}
      >
        {themeStyle}
        <main className="flex min-h-screen items-center justify-center px-4 py-16">
          <section className="mx-auto max-w-2xl text-center">
            <p className="website-eyebrow mb-4">Site setup in progress</p>
            <h1 className="font-heading text-4xl font-bold text-brand-charcoal sm:text-5xl">
              {CLUB_NAME} is getting ready.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-brand-deep/80 sm:text-lg">
              The public website will open after an administrator completes the
              site style setup.
            </p>
            <p className="mt-6 text-sm text-brand-ridge">
              Contact{" "}
              <a
                href={`mailto:${CLUB_CONTACT_EMAIL}`}
                className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
              >
                {CLUB_CONTACT_EMAIL}
              </a>
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div
      className={`${clubThemeFontVariableClassName} website-theme min-h-screen flex flex-col bg-background text-foreground`}
    >
      {themeStyle}
      <WebsiteHeader
        isAuthenticated={!!session?.user}
        logoDataUrl={theme.logoDataUrl}
      />
      <main className="flex-1">{children}</main>
      <WebsiteFooter logoDataUrl={theme.logoDataUrl} />
    </div>
  );
}
