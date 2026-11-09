import { BackLink } from "@/components/admin/back-link";
import { SiteBannersPanel } from "@/components/admin/site-banners-panel";
import { adminLink } from "@/lib/admin-hubs";

export default function SiteBannersAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("appearance")} />
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
