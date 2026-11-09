import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { MinimumNightStaySection } from "@/components/admin/booking-policies/minimum-night-stay-section";

export default function MinimumStayPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("booking-policies")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Minimum Night Stay
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Require a minimum number of nights when a booking touches specific days
          of the week within a date range.
        </p>
      </div>

      <MinimumNightStaySection />
    </div>
  );
}
