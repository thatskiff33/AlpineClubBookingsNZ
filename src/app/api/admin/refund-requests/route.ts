import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT } from "@/lib/manual-refund-task-settlement-rules";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
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
                // #2932: the screen derives its refund ceiling through
                // `getRemainingRefundableCents`, which answers 0 unless the
                // payment actually captured. #3827 (`INV-PAY-118`): less every
                // hand-back still open on the payment and the late-cash credit
                // in `creditsFromCancellation` above (`refundAppealCeiling`),
                // the figure the approve route caps at.
                status: true,
                amountCents: true,
                refundedAmountCents: true,
                stripePaymentIntentId: true,
                manualRefundTasks: OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT,
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
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.refundRequest.count({ where }),
  ]);

  return NextResponse.json({ data: requests, page, pageSize, total });
}
