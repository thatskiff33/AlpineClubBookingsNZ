import { prisma } from "@/lib/prisma";

export async function markBookingPaymentSucceeded({
  bookingId,
  paymentIntentId,
  amountCents,
  paymentMethodId,
}: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { bookingId },
      data: {
        stripePaymentIntentId: paymentIntentId,
        stripePaymentMethodId: paymentMethodId,
        status: "SUCCEEDED",
        amountCents,
      },
    });

    await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ["CONFIRMED", "PENDING", "DRAFT"] },
      },
      data: {
        status: "PAID",
        draftExpiresAt: null,
      },
    });
  });
}

export async function markBookingSetupIntentSucceeded({
  bookingId,
  setupIntentId,
  paymentMethodId,
}: {
  bookingId: string;
  setupIntentId: string;
  paymentMethodId: string;
}) {
  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntentId,
    },
  });
}
