import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";
import { AdminHealthDashboard } from "./_components/health-dashboard";
import { IntegrationReadinessSection } from "./_components/integration-readiness-section";

/**
 * System Health: integration readiness, which was the Operational Integrations
 * page until S1 (#4796) folded it in here, under the heading and above the
 * live checks, so its anchor does not move when they load.
 */
export default async function AdminHealthPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHealthDashboard
      readiness={
        <IntegrationReadinessSection
          features={features}
          permissionMatrix={permissionMatrix}
        />
      }
    />
  );
}
