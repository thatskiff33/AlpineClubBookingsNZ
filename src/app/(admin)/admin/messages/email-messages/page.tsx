import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { Card, CardContent } from "@/components/ui/card";
import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";

export default function EmailMessagesPage() {
  return (
    <div className="space-y-8">
      <div>
        <BackLink {...adminLink("notifications")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Email Messages
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit shared email variables and message wording for audited templates.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <EmailMessageSettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
