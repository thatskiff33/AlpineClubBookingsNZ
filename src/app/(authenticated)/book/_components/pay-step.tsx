"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";
import type { CreatedBooking } from "./types";

export function PayStep({
  createdBooking,
}: {
  createdBooking: CreatedBooking;
}) {
  const router = useRouter();

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Complete Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your booking is created. Complete payment to finish securing it.
        </p>
        <BookingPaymentWrapper
          bookingId={createdBooking.id}
          amountCents={createdBooking.amountCents}
          paymentMode={getBookingPaymentMode(createdBooking.status)}
          returnUrl={createdBooking.returnUrl}
          onPaymentComplete={() =>
            router.push(`/bookings/${createdBooking.id}`)
          }
        />
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/bookings/${createdBooking.id}`}
            className="underline"
          >
            View booking details
          </Link>{" "}
          &mdash; you can also pay later from your booking page.
        </p>
      </CardContent>
    </Card>
  );
}
