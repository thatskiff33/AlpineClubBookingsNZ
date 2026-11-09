import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";
import { AdminHealthDashboard } from "./_components/health-dashboard";
import { IntegrationReadinessSection } from "./_components/integration-readiness-section";

/**
 * System Health: the live checks, then integration readiness, which was the
 * Operational Integrations page until S1 (#4796) folded it in here.
 */
export default async function AdminHealthPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <div>
      <AdminHealthDashboard />
      <IntegrationReadinessSection
        features={features}
        permissionMatrix={permissionMatrix}
      />
    </div>
  );
}
