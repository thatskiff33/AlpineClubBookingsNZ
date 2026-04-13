"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { type BookingPaymentMode } from "@/lib/booking-payment-flow";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";
import { Button } from "@/components/ui/button";

interface BookingPaymentSectionProps {
  bookingId: string;
  amountCents: number;
  paymentMode: BookingPaymentMode;
  returnUrl: string;
  showOnMount?: boolean;
  gateDescription?: string;
  gateCtaLabel?: string;
}

export function BookingPaymentSection({
  bookingId,
  amountCents,
  paymentMode,
  returnUrl,
  showOnMount = true,
  gateDescription,
  gateCtaLabel = "Continue to Payment",
}: BookingPaymentSectionProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(showOnMount);

  if (!isOpen) {
    return (
      <div className="space-y-4 rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <p>
          {gateDescription ??
            "This booking is still a draft. Review the details above, then continue when you're ready to confirm and pay."}
        </p>
        <Button type="button" onClick={() => setIsOpen(true)}>
          {gateCtaLabel}
        </Button>
      </div>
    );
  }

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
