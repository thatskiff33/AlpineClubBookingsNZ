"use client";

import { useRouter } from "next/navigation";
import { type BookingPaymentMode } from "@/lib/booking-payment-flow";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";

interface BookingPaymentSectionProps {
  bookingId: string;
  amountCents: number;
  paymentMode: BookingPaymentMode;
  returnUrl: string;
}

export function BookingPaymentSection({
  bookingId,
  amountCents,
  paymentMode,
  returnUrl,
}: BookingPaymentSectionProps) {
  const router = useRouter();

  return (
    <BookingPaymentWrapper
      bookingId={bookingId}
      amountCents={amountCents}
      paymentMode={paymentMode}
      returnUrl={returnUrl}
      onPaymentComplete={() => router.refresh()}
    />
  );
}
