import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getClubThemeForAdmin } from "@/lib/club-theme";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { SiteStyleWizard } from "./site-style-wizard";

export default async function SiteStylePage() {
  const theme = await getClubThemeForAdmin();

  return (
    <div className={`space-y-8 ${clubThemeFontVariableClassName}`}>
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Site Style</h1>
        <p className="mt-1 text-sm text-slate-500">
          Set the public website colours, fonts, and logo for this club.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Club Identity</CardTitle>
          <CardDescription>
            Visual branding is managed here. Club name, public URL, email names,
            and message wording stay with the existing configuration settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 text-sm">
          <Link
            href="/admin/setup"
            className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Setup
          </Link>
          <Link
            href="/admin/notifications"
            className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Email messages
          </Link>
        </CardContent>
      </Card>

      <SiteStyleWizard initialTheme={theme} />
    </div>
  );
}
