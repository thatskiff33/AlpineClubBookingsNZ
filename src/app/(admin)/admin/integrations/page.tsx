import {
  Bot,
  CreditCard,
  DatabaseBackup,
  KeyRound,
  Plug,
  Server,
  Video,
} from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { AnalyticsIntegrationCard } from "@/components/admin/analytics-integration-card";
import { canViewAdminHrefWithMatrix } from "@/lib/admin-permissions";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getIntegrationsNeedingReentry } from "@/lib/integration-credentials";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure the accounting settings used by finance workflows.",
    icon: Plug,
  },
  {
    href: "/admin/stripe/setup",
    title: "Stripe Setup",
    description:
      "Enter your Stripe keys, confirm the account, and connect the payment webhook.",
    icon: CreditCard,
  },
  {
    href: "/admin/google/setup",
    title: "Google sign-in Setup",
    description:
      "Enter your Google OAuth credentials and verify a real sign-in round-trip — no environment variables.",
    icon: KeyRound,
  },
  {
    href: "/admin/backups/setup",
    title: "Database Backups",
    description:
      "Set up durable S3 backups step by step — credentials, destination, nightly schedule, and a real verification run.",
    icon: DatabaseBackup,
  },
  {
    href: "/admin/ai-assistant",
    title: "AI help assistant",
    description:
      "Enter your Anthropic API key, set a monthly spend cap, and review AI usage. Hidden until the AI assistant module is enabled.",
    icon: Bot,
  },
  {
    href: "/admin/video-meetings/setup",
    title: "Video meetings",
    description:
      "Point calendar meeting links at your MiroTalk server and store the host sign-in they use — no environment variables.",
    icon: Video,
  },
  {
    href: "/admin/alpine-server/setup",
    title: "Alpine Central Server",
    description:
      "Connect to the Alpine Central Server (ServerNZ): request a connection, store your API key, and upload/download shared data such as the Other Clubs registry.",
    icon: Server,
  },
];

const BASE_DESCRIPTION =
  "Configure connected services used by accounting and other provider-backed workflows.";

// Providers whose encrypted credentials the hub watches for the shared re-entry
// aggregate (#2079). C4/C5/C6 add "stripe" / "google" / "backup" here.
const HUB_PROVIDERS = ["xero", "stripe", "google", "backup", "anthropic"] as const;

export default async function IntegrationsHubPage() {
  const features = await loadEffectiveModuleFlags();

  // Unified "N integrations need credentials re-entered (encryption key
  // changed)" surface, driven by the same GCM-failure detection readiness uses.
  // Fail-open: a DB error must never break the hub, so show no banner.
  let reentryCount = 0;
  try {
    reentryCount = (await getIntegrationsNeedingReentry(HUB_PROVIDERS)).length;
  } catch {
    reentryCount = 0;
  }

  const description =
    reentryCount > 0
      ? `${reentryCount} integration${reentryCount === 1 ? "" : "s"} need credentials re-entered (the app encryption key changed). ${BASE_DESCRIPTION}`
      : BASE_DESCRIPTION;

  // Permission-gate the cards so an admin without support:view does not see the
  // support-area Backups card and dead-end at a redirect (#2095 MINOR-5).
  const permissionMatrix = await loadAdminSetupPermissionMatrix();

  /*
    Google Analytics is a PEER card in the same grid (#2573, owner decision
    section 1), not a link to a page of its own: the decision explicitly rules out a
    dedicated `/admin/analytics/setup` route and asks for the configuration to open
    within the Integrations experience.

    Two gates, both server-side. The `analytics` module flag is the master switch —
    with the module off there is no card, and `src/config/feature-routes.ts` also
    404s the configuration API, so a direct call gets nothing either. `finance` is
    the area every card on this hub already belongs to, so an admin who cannot see
    the hub cannot see this card, and the write route enforces `finance:edit`
    independently of the UI.
  */
  const showAnalyticsCard =
    features.analytics &&
    canViewAdminHrefWithMatrix(permissionMatrix, "/admin/integrations");

  return (
    <AdminHubPage
      title="Integrations"
      description={description}
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      extraCards={showAnalyticsCard ? <AnalyticsIntegrationCard /> : null}
    />
  );
}
