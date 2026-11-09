import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { GroupDiscountSection } from "@/components/admin/booking-policies/group-discount-section";

export default function GroupDiscountPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("booking-policies")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Group Discount
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Charge all guests at member rates once a booking reaches a minimum
          group size.
        </p>
      </div>

      <GroupDiscountSection />
    </div>
  );
}
