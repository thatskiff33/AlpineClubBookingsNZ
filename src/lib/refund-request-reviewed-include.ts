// What `PUT /api/admin/refund-requests/[id]` re-reads to answer with once a
// review is recorded, moved verbatim from that route to keep it under its size
// ceiling (#5145) when the lock(1) budget follow-up added its contention answer.
import type { Prisma } from "@prisma/client";

export const reviewedRefundRequestInclude = {
  booking: {
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      finalPriceCents: true,
      status: true,
      payment: {
        select: {
          amountCents: true,
          refundedAmountCents: true,
        },
      },
    },
  },
  member: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} satisfies Prisma.RefundRequestInclude;
