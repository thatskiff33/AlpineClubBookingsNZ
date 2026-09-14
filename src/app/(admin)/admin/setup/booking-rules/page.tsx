import {
  BedDouble,
  CalendarRange,
  MessageSquareText,
  Sliders,
  Tag,
  XCircle,
} from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/booking-policies",
    title: "Booking Policies",
    description:
      "Configure cancellation, minimum-stay, public-request, and group-discount rules.",
    icon: XCircle,
  },
  {
    href: "/admin/seasons",
    title: "Hut Fees & Seasons",
    description:
      "Maintain season windows and member/non-member nightly rates.",
    icon: CalendarRange,
  },
  {
    href: "/admin/age-tier-settings",
    title: "Age Groups",
    description:
      "Set age-tier boundaries and whether each tier needs a subscription to book.",
    icon: Sliders,
  },
  {
    href: "/admin/promo-codes",
    title: "Promo Codes",
    description:
      "Manage booking discounts and promotional code eligibility.",
    icon: Tag,
  },
  {
    href: "/admin/rooms-beds",
    title: "Rooms & Beds",
    description:
      "Configure lodge room and bed inventory used by capacity and allocation workflows, and that lodge's allocation preferences.",
    icon: BedDouble,
  },
  {
    href: "/admin/booking-messages",
    title: "Booking Messages",
    description:
      "Edit booking, payment, cancellation, and group-booking copy.",
    icon: MessageSquareText,
  },
];

export default async function BookingRulesSetupHubPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Booking Rules"
      description="Review the setup pages that shape booking eligibility, pricing, capacity, and member-facing booking copy."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref="/admin/setup"
      backLabel="Setup Wizard"
    />
  );
}
