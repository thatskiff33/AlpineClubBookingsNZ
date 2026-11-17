import { AdminHubPage } from "@/components/admin-hub-page";
import { adminLink, getAdminPage } from "@/lib/admin-hubs";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { foundationsSetupSections } from "../hub-cards";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

export default async function FoundationsSetupHubPage() {
  const back = adminLink("setup");
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title={getAdminPage("setup-foundations").label}
      description="Club identity, module activation, lodge records, and system health."
      sections={foundationsSetupSections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref={back.href}
      backLabel={back.label}
    />
  );
}
