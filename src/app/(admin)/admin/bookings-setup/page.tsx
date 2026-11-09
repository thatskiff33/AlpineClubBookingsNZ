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
import { MemberGuestSettingsCard } from "@/components/admin/member-guest-settings-card";
import { adminHref } from "@/lib/admin-hubs";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";

/**
 * The booking setup pages (S1 #4796): this page's own two cards and the four
 * the Booking Rules page (`/admin/setup/booking-rules`, now redirected here)
 * added, merged as the owner approved on #4468. Both pages were `bookings`.
 * `AdminHubPage` shows each card only to an admin who can OPEN it (the admin
 * layout's own rule), so a Booking Officer keeps Rooms & Beds (lodge OR
 * bookings, #2937), which Booking Rules' per-area filter hid, and stops being
 * offered Booking Messages (`support`), which this page showed to every viewer.
 */
const sections: AdminHubSection[] = [
  {
    href: adminHref("booking-policies"),
    title: "Booking Policies",
    description:
      "Configure cancellation, minimum-stay, public-request, and group-discount rules.",
    icon: XCircle,
  },
  {
    href: adminHref("seasons"),
    title: "Hut Fees & Seasons",
    description:
      "Maintain season windows and member/non-member nightly rates.",
    icon: CalendarRange,
  },
  {
    href: adminHref("age-tier-settings"),
    title: "Age Groups",
    description:
      "Set age-tier boundaries and whether each tier needs a subscription to book.",
    icon: Sliders,
  },
  {
    href: adminHref("promo-codes"),
    title: "Promo Codes",
    description:
      "Manage booking discounts and promotional code eligibility.",
    icon: Tag,
  },
  {
    href: adminHref("rooms-beds"),
    title: "Rooms & Beds",
    description:
      "Configure lodge rooms, active beds, bed-allocation inventory, and this lodge's allocation preferences.",
    icon: BedDouble,
  },
  {
    href: adminHref("booking-messages"),
    title: "Booking Messages",
    description:
      "Edit member-facing booking, payment, cancellation, and group booking copy.",
    icon: MessageSquareText,
  },
];

export default async function BookingsSetupHubPage() {
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <div className="space-y-8">
      <AdminHubPage
        title="Bookings Setup"
        description="Configure the rules and setup pages that shape booking eligibility, pricing, capacity, and member-facing booking copy."
        sections={sections}
        features={features}
        permissionMatrix={permissionMatrix}
      />
      {/* #2307 (owner decision MG2-M-1 as ticked): the member-guest policy card
          lives HERE, beside the other booking-policy configuration, rather than
          on its own admin route. It renders — editable — even while the module
          is off (MG2-M-4), with its own not-in-use banner. */}
      <MemberGuestSettingsCard moduleEnabled={features.memberGuests} />
    </div>
  );
}
