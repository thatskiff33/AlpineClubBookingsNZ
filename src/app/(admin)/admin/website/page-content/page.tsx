import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { PageContentPanel } from "@/components/admin/page-content-panel";
import { PublicContentSettingsPanel } from "@/components/admin/public-content-settings-panel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function PageContentAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("appearance")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">Page Content</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create and edit database-backed website pages, then control their menu
          display order.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Editable Pages</CardTitle>
          <CardDescription>
            Add pages, edit content, and set the menu order shown on the public
            website header.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PageContentPanel />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Public fee and policy blocks</CardTitle>
          <CardDescription>Explicitly enable the authoritative data families that Page Content tokens may publish.</CardDescription>
        </CardHeader>
        <CardContent><PublicContentSettingsPanel /></CardContent>
      </Card>
    </div>
  );
}
