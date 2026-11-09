import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { BookingPeriodsSection } from "@/components/admin/booking-policies/booking-periods-section";

export default function BookingPeriodsPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("booking-policies")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Date-Specific Periods
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Override the default cancellation policy for specific date ranges.
        </p>
      </div>

      <BookingPeriodsSection />
    </div>
  );
}
