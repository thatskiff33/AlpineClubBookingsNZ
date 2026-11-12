import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  ADMIN_LIST_DEFAULT_PAGE_SIZE,
  ADMIN_LIST_MAX_PAGE_SIZE,
  adminListPage,
  adminQueueCreatedOrder,
} from "@/lib/admin-list-page";
import { OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT, refundAppealCeilingParts } from "@/lib/manual-refund-task-settlement-rules";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { organiserCardAppealCeilingFor } from "@/lib/organiser-child-refund";
import { readApprovedAppealOutcomes } from "@/lib/refund-appeal-outcome";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIST_MAX_PAGE_SIZE)
    .optional()
    .default(ADMIN_LIST_DEFAULT_PAGE_SIZE),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = status === "ALL" ? {} : { status };
  // The pending queue reads oldest first (INV-OPS-017).
  const direction = adminQueueCreatedOrder(status === "PENDING");

  const [requests, total] = await Promise.all([
    prisma.refundRequest.findMany({
      where,
      include: {
        booking: {
          select: {
            id: true,
            checkIn: true,
            checkOut: true,
            finalPriceCents: true,
            status: true,
            // #2259: the review queue's notify prompt must not offer an email
            // choice the mailer will not honour. Admin-only route, so the field
            // never reaches a member.
            noEmails: true,
            // #3956: whether the group organiser paid for it by card.
            organiserSettled: true,
            parentBookingId: true,
            creditsFromCancellation: {
              select: {
                amountCents: true,
                description: true,
                // The restore test reads both (`isCancellationCreditRestoreRow`).
                type: true,
                restoredFromBookingId: true,
              },
            },
            payment: {
              select: {
                // #2932: the refund ceiling is derived through
                // `getRemainingRefundableCents`, which answers 0 unless the
                // payment actually captured. #3827 (`INV-PAY-118`): less every
                // hand-back still open on the payment and the late-cash credit
                // in `creditsFromCancellation` above, and (#4124) the card
                // refunds still owed (`refundAppealCeilingParts`) - the figure
                // the approve route caps at. Worked out below; the hand-back
                // and card-refund rows never reach the screen.
                id: true,
                source: true,
                status: true,
                amountCents: true,
                refundedAmountCents: true,
                stripePaymentIntentId: true,
                manualRefundTasks: OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT,
                // #4124: the open card-refund debts the ceiling also nets.
                ...netCollectedCardRefundSelect,
              },
            },
          },
        },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.refundRequest.count({ where }),
  ]);

  // #4117: what each approved appeal has still to give back (`readApprovedAppealOutcomes`).
  const outcomes = await readApprovedAppealOutcomes(prisma, requests);

  // #3956 (`INV-PAY-123`): a pending appeal on a booking the group organiser
  // paid for by card is capped at what the organiser's combined payment can
  // still return - the approve route's own cap, read here unlocked as advice -
  // so the screen offers the figure the approval will accept.
  const data = await Promise.all(
    requests.map(async (listed) => {
      // #4124: the ceiling is worked out here, where the card-refund rows are
      // Dates, and only the figures go to the screen - the ceiling, and the
      // card refund still owed that it netted (`appealCardRefundOwedCents`, the
      // screen's "Less ... not yet made" line) - never the rows.
      const { payment: loadedPayment, ...bookingRest } = listed.booking;
      const ceiling = refundAppealCeilingParts(loadedPayment, listed.booking.creditsFromCancellation);
      // The payment's own columns only, named: never its hand-back or card-refund rows.
      const screenPayment = loadedPayment && {
        id: loadedPayment.id,
        source: loadedPayment.source,
        status: loadedPayment.status,
        amountCents: loadedPayment.amountCents,
        refundedAmountCents: loadedPayment.refundedAmountCents,
        stripePaymentIntentId: loadedPayment.stripePaymentIntentId,
      };
      const request = {
        ...listed,
        ...outcomes.get(listed.id),
        booking: {
          ...bookingRest,
          payment: screenPayment,
          appealCeilingCents: ceiling.ceilingCents,
          appealCardRefundOwedCents: ceiling.cardRefundOwedCents,
        },
      };
      const payment = loadedPayment;
      if (request.status !== "PENDING" || !payment) return request;
      const organiserCard = await organiserCardAppealCeilingFor(prisma, listed.booking, payment);
      if (organiserCard === null) return request;
      return {
        ...request,
        booking: {
          ...request.booking,
          organiserCardMaxRefundableCents: organiserCard.ceilingCents,
          organiserCardCombinedRefundPending: organiserCard.combinedRefundPending,
        },
      };
    }),
  );

  return NextResponse.json({ data, ...adminListPage({ page, pageSize, total }) });
}
