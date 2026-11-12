"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type BookingPaymentMode } from "@/lib/booking-payment-flow";
import BookingPaymentWrapper from "@/components/stripe/BookingPaymentWrapper";
import { Button } from "@/components/ui/button";
import { hasStripeReturn } from "@/lib/stripe-return";

interface BookingPaymentSectionProps {
  bookingId: string;
  amountCents: number;
  paymentMode: BookingPaymentMode;
  showOnMount?: boolean;
  gateDescription?: string;
  gateCtaLabel?: string;
}

export function BookingPaymentSection({
  bookingId,
  amountCents,
  paymentMode,
  showOnMount = true,
  gateDescription,
  gateCtaLabel = "Continue to Payment",
}: BookingPaymentSectionProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(showOnMount);
  // ALP-569: a payer back from a redirect method is not asked to continue
  // again; the payment section opens and reads the return.
  useEffect(() => {
    if (hasStripeReturn("booking")) setIsOpen(true);
  }, []);

  if (!isOpen) {
    return (
      <div className="space-y-4 rounded-md border border-info-6 bg-info-3 p-4 text-sm text-info-11">
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
      onPaymentComplete={() => router.refresh()}
    />
  );
}
