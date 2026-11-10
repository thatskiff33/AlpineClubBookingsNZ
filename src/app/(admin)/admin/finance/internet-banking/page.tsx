import { BackLink } from "@/components/admin/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { InternetBankingSettingsPanel } from "@/components/admin/internet-banking/internet-banking-settings-panel";
import { adminLink } from "@/lib/admin-hubs";

export default function InternetBankingAdminPage() {
  return (
    <div className="space-y-8">
      <div>
        <BackLink {...adminLink("xero-setup")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Internet Banking
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure bed holds and booking lead-time rules for Xero-invoiced
          Internet Banking payments.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <InternetBankingSettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
