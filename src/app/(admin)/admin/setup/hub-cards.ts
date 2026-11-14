import {
  Activity,
  BadgeCheck,
  BadgeInfo,
  Bell,
  BookOpenCheck,
  Building2,
  Landmark,
  ListChecks,
  Plug,
  Puzzle,
  RefreshCw,
  UserX,
} from "lucide-react";
import type { AdminHubSection } from "@/components/admin-hub-page";
import {
  adminAnchorHref,
  adminHref,
  adminTabHref,
  getAdminPage,
} from "@/lib/admin-hubs";

/**
 * The cards on the Setup page and its two drill-downs. A card that opens a
 * registry page is titled with its label (INV-SSOT-008). The Setup page is the
 * checklist, so no card on a drill-down links back to it; each drill-down's
 * back link does (#4968).
 */
export const setupHubCards: AdminHubSection[] = [
  {
    href: adminHref("setup-foundations"),
    title: getAdminPage("setup-foundations").label,
    description: "Club identity, modules, lodge records, and system health.",
    icon: ListChecks,
  },
  {
    href: adminHref("setup-finance"),
    title: getAdminPage("setup-finance").label,
    description:
      "Open finance reporting, Xero setup, sync tools, and the collapsed report-mapping editor.",
    icon: Landmark,
  },
  // S1 (#4796): the next three cards open the pages the setup drill-downs
  // they replaced were merged into.
  {
    href: adminHref("bookings-setup"),
    title: getAdminPage("bookings-setup").label,
    description:
      "Review booking policy, seasons, age groups, promo codes, inventory, and booking copy.",
    icon: BookOpenCheck,
  },
  {
    href: adminAnchorHref("health", "integration-readiness"),
    title: "Integration Readiness",
    description:
      "Check external-provider readiness, Xero connection, modules, and delivery health.",
    icon: Plug,
  },
  {
    href: adminHref("membership-setup"),
    title: getAdminPage("membership-setup").label,
    description:
      "Configure membership types, member fields, and subscription lockout policy.",
    icon: BadgeCheck,
  },
  {
    href: adminTabHref("membership-cancellations", "settings"),
    title: getAdminPage("membership-cancellations").label,
    description:
      "Review cancellation settings and the cancellation request queue.",
    icon: UserX,
  },
  {
    href: adminHref("notifications"),
    title: getAdminPage("notifications").label,
    description:
      "Manage delivery rules, recipients, email templates, and member-facing message text.",
    icon: Bell,
  },
];

export const foundationsSetupSections: AdminHubSection[] = [
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
    href: adminHref("modules"),
    title: getAdminPage("modules").label,
    description:
      "Enable or disable optional club features before opening related workflows.",
    icon: Puzzle,
  },
  {
    href: adminHref("lodges"),
    title: getAdminPage("lodges").label,
    description:
      "Create and maintain lodge records used by multi-lodge configuration.",
    icon: Building2,
  },
  {
    href: adminHref("health"),
    title: getAdminPage("health").label,
    description:
      "Check runtime, database, provider, and background-job readiness.",
    icon: Activity,
  },
];

export const financeSetupLinks: AdminHubSection[] = [
  {
    href: "/finance",
    title: "Finance Dashboard",
    description:
      "Open revenue, cost, sync health, and finance reporting views.",
    icon: Landmark,
  },
  {
    href: adminHref("xero-setup"),
    title: getAdminPage("xero-setup").label,
    description:
      "Connect Xero and configure accounting settings used by finance workflows.",
    icon: Plug,
  },
  {
    href: adminAnchorHref("xero", "xero-section-mappings"),
    title: "Xero Mappings",
    description:
      "Review account, item-code, and entrance-fee mappings used by Xero sync.",
    icon: RefreshCw,
  },
];
