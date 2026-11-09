import { BackLink } from "@/components/admin/back-link";
import { adminHref } from "@/lib/admin-hubs";
import { SiteBannersPanel } from "@/components/admin/site-banners-panel";

export default function SiteBannersAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink href={adminHref("appearance")} label="Site Appearance & Content" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Site Banners
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Publish site-wide notices, such as emergency mountain closures, that
          display above the site header for every visitor during their display
          window. Visitors can dismiss a notice per browser; editing a banner
          shows it again.
        </p>
      </div>

      <SiteBannersPanel />
    </div>
  );
}
