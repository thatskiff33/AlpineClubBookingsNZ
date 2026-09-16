import { BedDouble, MessageSquareText } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { MemberGuestSettingsCard } from "@/components/admin/member-guest-settings-card";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const sections: AdminHubSection[] = [
  {
    href: "/admin/rooms-beds",
    title: "Rooms & Beds",
    description:
      "Configure lodge rooms, active beds, bed-allocation inventory, and this lodge's allocation preferences.",
    icon: BedDouble,
  },
  {
    href: "/admin/booking-messages",
    title: "Booking Messages",
    description:
      "Edit member-facing booking, payment, cancellation, and group booking copy.",
    icon: MessageSquareText,
  },
];

export default async function BookingsSetupHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <div className="space-y-8">
      <AdminHubPage
        title="Bookings Setup"
        description="Configure booking-related setup pages that operators revisit less often than daily booking queues."
        sections={sections}
        features={features}
      />
      {/* #2307 (owner decision MG2-M-1 as ticked): the member-guest policy card
          lives HERE, beside the other booking-policy configuration, rather than
          on its own admin route. It renders — editable — even while the module
          is off (MG2-M-4), with its own not-in-use banner. */}
      <MemberGuestSettingsCard moduleEnabled={features.memberGuests} />
    </div>
  );
}
