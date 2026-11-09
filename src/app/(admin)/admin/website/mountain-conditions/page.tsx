import { BackLink } from "@/components/admin/back-link";
import { adminHref } from "@/lib/admin-hubs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MountainConditionsPanel } from "./_components/mountain-conditions-panel";

export default function MountainConditionsAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink href={adminHref("appearance")} label="Site Appearance & Content" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Mountain Conditions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review and edit the cached Whakapapa mountain conditions JSON payload.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Whakapapa cache</CardTitle>
          <CardDescription>
            Save changes to freeze automatic upstream updates for 12 hours, or
            use Update from upstream to refresh immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MountainConditionsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
