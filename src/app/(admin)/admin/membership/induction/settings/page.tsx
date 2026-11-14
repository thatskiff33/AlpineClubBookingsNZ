import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { InductionSettingsPanel } from "@/components/admin/induction-settings-panel";
import { InductionTemplateManager } from "@/components/admin/induction-template-manager";

export default function AdminInductionSettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <div className="mb-2">
          <BackLink {...adminLink("induction")} />
        </div>
        <h1 className="text-2xl font-bold">Induction Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure the nomination eligibility gate and manage the induction
          checklist template.
        </p>
      </div>

      <InductionSettingsPanel />
      <InductionTemplateManager />
    </div>
  );
}
