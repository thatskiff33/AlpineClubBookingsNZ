"use client";

import { useRouter } from "next/navigation";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";

interface BookingPaymentSectionProps {
  bookingId: string;
  amountCents: number;
  hasNonMembers: boolean;
  checkInDaysAway: number;
  returnUrl: string;
}

export function BookingPaymentSection({
  bookingId,
  amountCents,
  hasNonMembers,
  checkInDaysAway,
  returnUrl,
}: BookingPaymentSectionProps) {
  const router = useRouter();

  return (
    <BookingPaymentWrapper
      bookingId={bookingId}
      amountCents={amountCents}
      hasNonMembers={hasNonMembers}
      checkInDaysAway={checkInDaysAway}
      returnUrl={returnUrl}
      onPaymentComplete={() => router.refresh()}
    />
  );
}
