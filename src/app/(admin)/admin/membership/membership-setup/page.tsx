import { BadgeCheck, Lock, Sliders, Tags } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

import { adminLink } from "@/lib/admin-hubs";
const sections: AdminHubSection[] = [
  {
    href: adminLink("membership-types").href,
    title: adminLink("membership-types").label,
    description:
      "Configure seasonal membership categories, booking policy, and subscription rules.",
    icon: BadgeCheck,
  },
  {
    href: adminLink("subscription-categories").href,
    title: adminLink("subscription-categories").label,
    description:
      "Define flat-rate billing categories (e.g. Couple, Family) that are independent of membership type.",
    icon: Tags,
  },
  {
    href: adminLink("member-fields").href,
    title: adminLink("member-fields").label,
    description:
      "Choose the extra profile fields collected from members and applicants.",
    icon: Sliders,
  },
  {
    href: adminLink("subscription-lockout").href,
    title: adminLink("subscription-lockout").label,
    description:
      "Control when unpaid subscriptions block member booking and access actions.",
    icon: Lock,
  },
];

export default async function MembershipSetupHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Membership & Members"
      description="Configure membership categories, member profile fields, and subscription enforcement."
      sections={sections}
      features={features}
    />
  );
}
