import { MailCheck, Plug, Puzzle, RefreshCw } from "lucide-react";
import {
  AdminHubSectionCards,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import type { FeatureFlags } from "@/config/schema";
import { adminHref, type AdminPageAnchor } from "@/lib/admin-hubs";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

/**
 * Integration readiness (S1 #4796): the provider setup pages that were the
 * Operational Integrations page (`/admin/setup/integrations`, now redirected
 * to this section), folded into System Health as the owner approved on #4468.
 * That page was `support`, as System Health is. Its fifth card, Provider
 * Health, was this page. Each card is shown, as there, only where its module
 * is on and to an admin who can view it.
 */
const sections: AdminHubSection[] = [
  {
    href: adminHref("xero-setup"),
    title: "Xero Setup",
    description:
      "Connect Xero and configure accounting settings used by provider-backed workflows.",
    icon: Plug,
  },
  {
    href: adminHref("xero"),
    title: "Xero Sync",
    description:
      "Review operational Xero sync status, mappings, and recent provider activity.",
    icon: RefreshCw,
  },
  {
    href: adminHref("modules"),
    title: "Modules",
    description:
      "Enable provider-backed modules only when the club is ready to operate them.",
    icon: Puzzle,
  },
  {
    href: adminHref("email-deliverability"),
    title: "Email Deliverability",
    description:
      "Review SES/SMTP delivery state and suppression diagnostics.",
    icon: MailCheck,
  },
];

/** The section's element id, typed as an anchor the registry declares for System Health. */
const INTEGRATION_READINESS_ANCHOR: AdminPageAnchor<"health"> = "integration-readiness";

export function IntegrationReadinessSection({
  features,
  permissionMatrix,
}: {
  features: FeatureFlags;
  permissionMatrix: AdminPermissionMatrix;
}) {
  return (
    <section
      id={INTEGRATION_READINESS_ANCHOR}
      aria-labelledby={`${INTEGRATION_READINESS_ANCHOR}-heading`}
      className="space-y-4 px-6 pb-6"
    >
      <div>
        <h2
          id={`${INTEGRATION_READINESS_ANCHOR}-heading`}
          className="text-lg font-semibold text-foreground"
        >
          Integration readiness
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The provider-backed setup pages used by accounting, email and modules.
        </p>
      </div>
      <AdminHubSectionCards
        sections={sections}
        features={features}
        permissionMatrix={permissionMatrix}
      />
    </section>
  );
}
