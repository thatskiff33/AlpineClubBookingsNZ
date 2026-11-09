import { BackLink } from "@/components/admin/back-link";
import { SiteContentPanel } from "@/components/admin/site-content-panel";
import { adminHref } from "@/lib/admin-hubs";

export default function SiteContentAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink href={adminHref("appearance")} label="Site Appearance & Content" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">Site Content</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit the shared site chrome shown on every public page. The footer
          columns below render exactly as written (after sanitising); the
          logo, copyright line, and privacy/terms links stay managed by the
          system.
        </p>
      </div>

      <SiteContentPanel />
    </div>
  );
}
