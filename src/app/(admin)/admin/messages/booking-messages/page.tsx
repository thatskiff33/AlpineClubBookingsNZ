import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { Card, CardContent } from "@/components/ui/card";
import { BookingMessagesPanel } from "@/components/admin/booking-messages/booking-messages-panel";

export default function BookingMessagesPage() {
  return (
    <div className="space-y-8">
      <div>
        <BackLink {...adminLink("notifications")} />
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Booking Messages
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit member-facing copy used by booking, payment, cancellation, and
          group booking screens.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <BookingMessagesPanel />
        </CardContent>
      </Card>
    </div>
  );
}
