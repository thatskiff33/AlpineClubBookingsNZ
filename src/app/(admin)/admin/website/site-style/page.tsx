import Link from "next/link";
import { BackLink } from "@/components/admin/back-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getClubThemeForAdmin } from "@/lib/club-theme";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { SiteStyleWizard } from "./site-style-wizard";
import { adminHref } from "@/lib/admin-hubs";

export default async function SiteStylePage() {
  const theme = await getClubThemeForAdmin();

  return (
    <div className={`space-y-8 ${clubThemeFontVariableClassName}`}>
      <div>
        <BackLink href={adminHref("appearance")} label="Site Appearance & Content" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">Site Style</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the brand colours and fonts used by the public website, member area,
          and admin area, plus the public logo.
        </p>
        <p className="mt-2 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
          The public site — including the membership application form — stays
          hidden until this is saved.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Club Identity</CardTitle>
          <CardDescription>
            Visual branding is managed here. Club name, public URL, email names,
            and message wording stay with the existing configuration settings.
            Operational status colours are curated and remain fixed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-sm">
          <Link
            href="/admin/setup"
            className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Setup
          </Link>
          <Link
            href="/admin/email-messages"
            className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Email messages
          </Link>
        </CardContent>
      </Card>

      <SiteStyleWizard initialTheme={theme} />
    </div>
  );
}
