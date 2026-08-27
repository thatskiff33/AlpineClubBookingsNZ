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
import {
  refundRequestApprovedTemplate,
  refundRequestDeclinedTemplate,
} from "@/lib/email-templates/refunds";
import {
  composeOptionalEmailLine,
} from "@/lib/email-message-notes";
import logger from "@/lib/logger";
import { getRemainingRefundableCents } from "@/lib/booking-payment-state";
import {
  planStripeRefundAllocation,
  refundPaymentTransactions,
} from "@/lib/payment-transactions";
import { enqueueRefundRequestRefundRecovery } from "@/lib/payment-recovery";
import { buildRefundRequestRefundMetadata } from "@/lib/payment-recovery-keys";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { calendarDateOfDateOnlyInstant, formatClubDate } from "@/lib/club-time";
import { formatCents } from "@/lib/utils";
import { renderEmailHtml } from "@/lib/email-theme";

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNotes: z.string().max(2000).optional(),
  approvedAmountCents: z.number().int().min(0).optional(),
  // #1792: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the member outcome email. A non-boolean is rejected 400 by
  // this parse. Only affects the outcome notice — refund execution, ledger math,
  // and Stripe/Xero are unchanged.
  notifyMember: z.boolean().optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
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

  const { status, adminNotes, approvedAmountCents, notifyMember } = parsed.data;
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

    // B5 (#2262): this booking was settled in cash / by an off-Xero bank
    // transfer, so there is NO Stripe money to refund. Approving here would
    // plan $0, log the drift, tell the member their refund is on its way, and
    // hand nothing back — the exact silent-$0 hazard this feature exists to
    // avoid. Refuse and point at the flow that can actually return the money.
    if (payment.manuallyMarkedPaidAt) {
      return NextResponse.json(
        {
          error:
            "This booking was paid in cash or by an off-Xero bank transfer, so there is no card payment to refund. Cancel the booking to raise a manual refund task, then pay the member back and close the task on the payments board.",
        },
        { status: 409 }
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

    // #1510: freeze the refund allocation the inline attempt will execute and
    // pass the SAME slices to both the inline refund and the durable recovery
    // enqueue below, mirroring the booking-cancellation frozen plan (#1349).
    // For a multi-transaction payment with partial refund progress, deriving a
    // fresh newest-first plan at replay time — over ledger state the completed
    // slices have already moved — would compute different slice amounts, and
    // therefore different `refund_request_<id>_<txn>_<amount>` Stripe
    // idempotency keys, so the replay would mint NEW refunds instead of
    // replaying the originals. Freezing the plan makes the replay re-request
    // byte-identical slices under identical keys, which Stripe answers with the
    // original refunds (the PaymentRefund ledger dedupes on refund id). This
    // also makes the inline path deterministic.
    const { slices: refundPlan, plannedAmountCents } =
      await planStripeRefundAllocation({
        paymentId: payment.id,
        amountCents: approvedAmountCents,
      });

    if (plannedAmountCents < approvedAmountCents) {
      // Stripe-refundable is less than the approved amount (e.g. a mixed
      // Stripe + Internet Banking payment, whose IB portion is settled by the
      // Xero credit note below, not Stripe): refund what the ledger shows
      // Stripe-refundable, mirroring the booking-cancel drift log (#1349).
      logger.error(
        {
          refundRequestId: id,
          paymentId: payment.id,
          approvedAmountCents,
          plannedAmountCents,
        },
        "Approved refund appeal plan covers less than the approved amount; refunding what the payment ledger shows Stripe-refundable"
      );
    }

    try {
      await refundPaymentTransactions({
        paymentId: payment.id,
        amountCents: plannedAmountCents,
        allocation: refundPlan,
        // #1507: build the Stripe metadata from the shared helper so the
        // recovery cron's replay (under the same refund_request_<id> key) sends
        // a byte-identical body and Stripe replays the original refund instead
        // of rejecting the reused idempotency key with idempotency_error.
        metadata: buildRefundRequestRefundMetadata(booking.id, id),
        idempotencyKeyPrefix: `refund_request_${id}`,
      });
    } catch (err) {
      // The approval stands: complete the refund through the durable payment
      // recovery queue instead of releasing the claim (#1039 item 1, PR #846
      // residual). Bouncing back to PENDING would create two retry paths —
      // a second admin approval and the recovery cron — with two distinct
      // Stripe idempotency scopes for the same money. The recovery operation
      // reuses the original refund_request_<id> Stripe key prefix, so a
      // refund that succeeded on Stripe without being recorded is replayed,
      // not repeated.
      logger.error(
        { err, refundRequestId: id },
        "Stripe refund failed for approved appeal - enqueueing durable recovery"
      );
      // Persist the SAME frozen slices the inline attempt executed (#1510), not
      // a remainder or a re-derivation: the recovery cron replays the full plan
      // under the identical `refund_request_<id>_<txn>_<amount>` Stripe keys, so
      // a slice the inline path already completed is replayed by Stripe (not
      // repeated) and the PaymentRefund ledger dedupes on refund id, while an
      // uncompleted slice moves the remaining money. This is the #1349 booking-
      // cancellation guarantee applied to refund appeals; it supersedes the
      // #1097 remainder heuristic, which could still re-derive a shifted plan.
      try {
        if (plannedAmountCents > 0) {
          await enqueueRefundRequestRefundRecovery({
            bookingId: booking.id,
            paymentId: payment.id,
            refundRequestId: id,
            amountCents: plannedAmountCents,
            allocationPlan: refundPlan,
          });
        }
      } catch (enqueueErr) {
        // No durable row could be written: fall back to the pre-#1039
        // behaviour and release the claim so an admin can retry manually.
        logger.error(
          { err: enqueueErr, refundRequestId: id },
          "Failed to enqueue refund recovery - releasing the claim for manual retry"
        );
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
        return NextResponse.json(
          { error: "Failed to process Stripe refund" },
          { status: 500 }
        );
      }
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

    // #1792: resolve the member email BEFORE the audit so the notify choice can
    // be recorded honestly. Only stamp notifyMember:false when there was an
    // email to suppress; otherwise there was nothing to opt out of.
    const memberEmail = booking.member.email || refundRequest.member.email;
    const recipientMemberId = booking.member.email
      ? booking.member.id
      : refundRequest.member.id;
    const notifyAuditFields =
      memberEmail && notifyMember === false ? { notifyMember: false } : {};

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
        ...notifyAuditFields,
      },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    });

    // Email the member unless the admin chose not to notify (#1792).
    if (memberEmail && notifyMember !== false) {
      sendEmail({
        to: memberEmail,
        subject: `Refund Appeal Approved — ${CLUB_BOOKINGS_NAME}`,
        html: await renderEmailHtml(() => refundRequestApprovedTemplate({
          firstName: refundRequest.member.firstName,
          amountCents: approvedAmountCents,
          adminNotes: adminNotes ?? null,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        })),
        // Member-facing and booking-scoped: the per-booking "No emails"
        // switch withholds it (#2258).
        bookingContext: {
          bookingId: booking.id,
          recipient: { kind: "member", memberId: recipientMemberId },
        },
        templateName: "refund-request-approved",
        templateData: {
          firstName: refundRequest.member.firstName,
          // #2321: {{status}} is gone — the template name carries the
          // outcome, and a flat body could never have branched on it.
          amount: formatCents(approvedAmountCents),
          adminNotes: adminNotes ?? "",
          // #2268: pre-composed optional line — the flat body has no
          // conditional syntax, so a resolution with no admin note must not
          // print a bare "Notes:" heading over nothing.
          adminNotesLine: composeOptionalEmailLine("Notes", adminNotes),
          // Lodge nights are CALENDAR DAYS (`@db.Date`), rendered with no zone at all
          // (CT-4, #2870). The zoned instant formatter this replaced projected UTC
          // midnight through the club zone: the identity in New Zealand, and the
          // PREVIOUS DAY for any club behind UTC.
          checkIn: formatClubDate(calendarDateOfDateOnlyInstant(booking.checkIn)),
          checkOut: formatClubDate(calendarDateOfDateOnlyInstant(booking.checkOut)),
        },
      }).catch((err) =>
        logger.error({ err }, "Failed to send refund appeal approved email")
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

    // #1792: resolve the member email BEFORE the audit so the notify choice can
    // be recorded honestly. Only stamp notifyMember:false when there was an
    // email to suppress; otherwise there was nothing to opt out of.
    const memberEmail = booking.member.email || refundRequest.member.email;
    const recipientMemberId = booking.member.email
      ? booking.member.id
      : refundRequest.member.id;
    const notifyAuditFields =
      memberEmail && notifyMember === false ? { notifyMember: false } : {};

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
        ...notifyAuditFields,
      },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    });

    // Email the member unless the admin chose not to notify (#1792).
    if (memberEmail && notifyMember !== false) {
      sendEmail({
        to: memberEmail,
        subject: `Refund Appeal Update — ${CLUB_BOOKINGS_NAME}`,
        html: await renderEmailHtml(() => refundRequestDeclinedTemplate({
          firstName: refundRequest.member.firstName,
          adminNotes: adminNotes ?? null,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        })),
        // Member-facing and booking-scoped: the per-booking "No emails"
        // switch withholds it (#2258).
        bookingContext: {
          bookingId: booking.id,
          recipient: { kind: "member", memberId: recipientMemberId },
        },
        templateName: "refund-request-declined",
        templateData: {
          firstName: refundRequest.member.firstName,
          // #2321: NO amount is supplied on a decline — there is no refund
          // to state. The token is not in this template's allowed set
          // either, so an override that reaches for {{amount}} is refused
          // at save time rather than rendering an empty figure into
          // "A refund of  will be processed".
          adminNotes: adminNotes ?? "",
          // #2268: pre-composed optional line (see the approved branch).
          adminNotesLine: composeOptionalEmailLine("Notes", adminNotes),
          // Calendar days, no zone — see the approved branch above.
          checkIn: formatClubDate(calendarDateOfDateOnlyInstant(booking.checkIn)),
          checkOut: formatClubDate(calendarDateOfDateOnlyInstant(booking.checkOut)),
        },
      }).catch((err) =>
        logger.error({ err }, "Failed to send refund appeal declined email")
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
