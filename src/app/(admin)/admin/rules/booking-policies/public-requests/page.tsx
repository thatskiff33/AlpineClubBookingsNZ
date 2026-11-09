import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { PublicBookingRequestsSection } from "@/components/admin/booking-policies/public-booking-requests-section";

export default function PublicBookingRequestsPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink {...adminLink("booking-policies")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Public Booking Requests
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control indicative pricing on the public request form, how long a quote
          link stays valid, and when requesters are reminded before it expires.
        </p>
      </div>

      <PublicBookingRequestsSection />
    </div>
  );
}
