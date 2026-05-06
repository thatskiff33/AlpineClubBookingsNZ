import { prisma } from "@/lib/prisma";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";

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
    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents,
        status: PaymentStatus.PENDING,
      },
      update: {},
    });

    await upsertPaymentIntentTransaction({
      paymentId: payment.id,
      kind: PaymentTransactionKind.PRIMARY,
      paymentIntentId,
      amountCents,
      status: PaymentStatus.SUCCEEDED,
      paymentMethodId,
      store: tx,
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
