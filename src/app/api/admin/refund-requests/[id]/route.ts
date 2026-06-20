import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { isXeroConnected } from "@/lib/xero";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { sendEmail } from "@/lib/email";
import { refundRequestResolvedTemplate } from "@/lib/email-templates";
import logger from "@/lib/logger";
import { getRemainingRefundableCents } from "@/lib/booking-payment-state";
import { refundPaymentTransactions } from "@/lib/payment-transactions";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { formatNZDate } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNotes: z.string().max(2000).optional(),
  approvedAmountCents: z.number().int().min(0).optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  const refundRequest = await prisma.refundRequest.findUnique({
    where: { id },
    include: {
      booking: { include: { payment: true, member: true } },
      member: true,
    },
  });

  if (!refundRequest) {
    return NextResponse.json({ error: "Refund request not found" }, { status: 404 });
  }

  if (refundRequest.status !== "PENDING") {
    return NextResponse.json(
      { error: "This refund request has already been reviewed" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, adminNotes, approvedAmountCents } = parsed.data;
  const booking = refundRequest.booking;
  const payment = booking.payment;

  if (status === "APPROVED") {
    if (!approvedAmountCents || approvedAmountCents <= 0) {
      return NextResponse.json(
        { error: "Approved amount is required for approval" },
        { status: 400 }
      );
    }

    if (!payment) {
      return NextResponse.json(
        { error: "No payment found for this booking" },
        { status: 400 }
      );
    }

    const maxRefundable = getRemainingRefundableCents(payment);
    if (approvedAmountCents > maxRefundable) {
      return NextResponse.json(
        {
          error: `Amount exceeds maximum refundable of $${(maxRefundable / 100).toFixed(2)}`,
        },
        { status: 400 }
      );
    }

    // Claim the request before moving any money. Winning the PENDING ->
    // APPROVED transition is what authorises the refund, so two admins
    // approving the same request concurrently cannot both issue a Stripe
    // refund — the loser gets a 409 and never calls Stripe (issue #818).
    const claim = await prisma.refundRequest.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "APPROVED",
        adminNotes,
        approvedAmountCents,
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
      },
    });

    if (claim.count !== 1) {
      return NextResponse.json(
        { error: "This refund request has already been reviewed" },
        { status: 409 }
      );
    }

    try {
      await refundPaymentTransactions({
        paymentId: payment.id,
        amountCents: approvedAmountCents,
        metadata: {
          bookingId: booking.id,
          reason: "refund_appeal_approved",
          refundRequestId: id,
        },
        idempotencyKeyPrefix: `refund_request_${id}`,
      });
    } catch (err) {
      // Release the claim back to PENDING so the refund can be retried. The
      // stable idempotency key (refund_request_<id>) makes a retry safe
      // against double-refunding if Stripe did process the first attempt.
      await prisma.refundRequest
        .updateMany({
          where: { id, status: "APPROVED" },
          data: {
            status: "PENDING",
            approvedAmountCents: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        })
        .catch((revertErr) => {
          logger.error(
            { err: revertErr, refundRequestId: id },
            "Failed to revert refund request claim after Stripe refund failure"
          );
        });
      logger.error({ err, refundRequestId: id }, "Failed to process Stripe refund for appeal");
      return NextResponse.json(
        { error: "Failed to process Stripe refund" },
        { status: 500 }
      );
    }

    // Queue the Xero credit note durably and try to kick the worker.
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        payment.id,
        approvedAmountCents,
        {
          createdByMemberId: session.user.id,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, refundRequestId: id, paymentId: payment.id },
            "Failed to kick Xero refund credit note outbox worker for refund appeal"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, refundRequestId: id },
        "Failed to queue Xero credit note for refund appeal"
      );
    }

    await createAuditLog({
      action: "refund-request.approve",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: booking.memberId,
      entityType: "RefundRequest",
      entityId: id,
      category: "payment",
      outcome: "success",
      summary: "Refund appeal approved",
      details: `Approved refund appeal for $${(approvedAmountCents / 100).toFixed(2)} on booking ${booking.id}`,
      metadata: {
        bookingId: booking.id,
        approvedAmountCents,
      },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    });

    // Email the member
    const memberEmail =
      booking.member.email ||
      refundRequest.member.email;
    if (memberEmail) {
      sendEmail({
        to: memberEmail,
        subject: `Refund Appeal Approved — ${CLUB_BOOKINGS_NAME}`,
        html: refundRequestResolvedTemplate({
          firstName: refundRequest.member.firstName,
          status: "APPROVED",
          amountCents: approvedAmountCents,
          adminNotes: adminNotes ?? null,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        }),
        templateName: "refund-request-resolved",
        templateData: {
          firstName: refundRequest.member.firstName,
          status: "APPROVED",
          amount: formatCents(approvedAmountCents),
          adminNotes: adminNotes ?? "",
          checkIn: formatNZDate(booking.checkIn),
          checkOut: formatNZDate(booking.checkOut),
        },
      }).catch((err) =>
        logger.error({ err }, "Failed to send refund appeal resolved email")
      );
    }
  } else {
    // REJECTED
    const rejected = await prisma.refundRequest.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "REJECTED",
        adminNotes,
        approvedAmountCents: 0,
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
      },
    });

    if (rejected.count !== 1) {
      return NextResponse.json(
        { error: "This refund request has already been reviewed" },
        { status: 409 }
      );
    }

    await createAuditLog({
      action: "refund-request.reject",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: booking.memberId,
      entityType: "RefundRequest",
      entityId: id,
      category: "payment",
      outcome: "success",
      summary: "Refund appeal rejected",
      details: `Rejected refund appeal for booking ${booking.id}`,
      metadata: {
        bookingId: booking.id,
        adminNotes: adminNotes ?? null,
      },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    });

    // Email the member
    const memberEmail =
      booking.member.email ||
      refundRequest.member.email;
    if (memberEmail) {
      sendEmail({
        to: memberEmail,
        subject: `Refund Appeal Update — ${CLUB_BOOKINGS_NAME}`,
        html: refundRequestResolvedTemplate({
          firstName: refundRequest.member.firstName,
          status: "REJECTED",
          amountCents: null,
          adminNotes: adminNotes ?? null,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        }),
        templateName: "refund-request-resolved",
        templateData: {
          firstName: refundRequest.member.firstName,
          status: "REJECTED",
          amount: "",
          adminNotes: adminNotes ?? "",
          checkIn: formatNZDate(booking.checkIn),
          checkOut: formatNZDate(booking.checkOut),
        },
      }).catch((err) =>
        logger.error({ err }, "Failed to send refund appeal resolved email")
      );
    }
  }

  const updated = await prisma.refundRequest.findUnique({
    where: { id },
    include: {
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
    },
  });

  return NextResponse.json(updated);
}
