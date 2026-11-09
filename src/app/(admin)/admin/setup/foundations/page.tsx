import { Activity, BadgeInfo, Building2, ListChecks, Puzzle } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { adminHref, getAdminPage } from "@/lib/admin-hubs";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/setup",
    title: "Setup Checklist",
    description:
      "Review readiness KPIs, blockers, provider tests, and setup progress.",
    icon: ListChecks,
  },
  {
    // Cross-link to the content-gated identity cards under Admin > Appearance
    // (E3 follow-up #1966): admins who followed the "Setup" wording find the
    // club name / short name / hut-leader label overrides here. The href gates
    // on the content area via canViewAdminHrefWithMatrix, matching the
    // /api/admin/club-identity content:view/edit guard.
    href: adminHref("club-identity"),
    title: getAdminPage("club-identity").label,
    description:
      "Override the club name, short name, hut-leader label, and your lodge's public details shown across the site and emails.",
    icon: BadgeInfo,
  },
  {
    href: "/admin/modules",
    title: "Modules",
    description:
      "Enable or disable optional club features before opening related workflows.",
    icon: Puzzle,
  },
  {
    href: "/admin/lodges",
    title: "Lodges",
    description:
      "Create and maintain lodge records used by multi-lodge configuration.",
    icon: Building2,
  },
  {
    href: "/admin/health",
    title: "System Health",
    description:
      "Check runtime, database, provider, and background-job readiness.",
    icon: Activity,
  },
];

export default async function FoundationsSetupHubPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Initial Setup"
      description="Start with first-install readiness, module activation, lodge records, and system health."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref="/admin/setup"
      backLabel="Setup Wizard"
    />
  );
}
