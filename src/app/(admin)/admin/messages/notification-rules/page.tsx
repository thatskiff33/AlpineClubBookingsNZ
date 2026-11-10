import { BackLink } from "@/components/admin/back-link";
import { adminLink, getAdminPage } from "@/lib/admin-hubs";
import { Card, CardContent } from "@/components/ui/card";
import { listNotificationDeliveryPolicySettings } from "@/lib/notification-delivery-policies";
import { NotificationDeliveryPolicySettings } from "@/components/admin/email-settings/notification-delivery-policy-settings";

export default async function NotificationRulesPage() {
  const deliveryPolicySettings = await listNotificationDeliveryPolicySettings();

  return (
    <div className="space-y-8">
      <div>
        <BackLink {...adminLink("notifications")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          {getAdminPage("notification-rules").label}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control which admin and system emails are sent when jobs or alerts
          run.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <NotificationDeliveryPolicySettings
            initialPolicies={deliveryPolicySettings.policies}
            initialStalePolicyCount={deliveryPolicySettings.stalePolicyCount}
          />
        </CardContent>
      </Card>
    </div>
  );
}
