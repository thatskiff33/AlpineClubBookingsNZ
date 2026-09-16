import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import {
  findPaymentTransactionByIntentId,
  markPaymentIntentTransactionSucceeded,
} from "@/lib/payment-transactions";
import {
  kickQueuedXeroOutboxOperationsIfConnected,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";
import { hasAdminAccess } from "@/lib/access-roles";
import { raiseDeletedBookingModificationRefundTask } from "@/lib/deleted-booking-modification-payment";

const schema = z.object({
  paymentIntentId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);

  const { id: bookingId } = await params;

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { paymentIntentId } = parsed.data;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      // #2700: `deletedAt` beside the authority field. Nothing on this path read
      // `status` or `deletedAt` before, which is how `INV-ADDPAY-032` came to
      // list this handler as a write still reachable on a deleted booking.
      include: { booking: { select: { memberId: true, deletedAt: true } } },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (
      bookingOwner(payment.booking).memberId !== session.user.id &&
      !isAdmin
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (payment.additionalPaymentIntentId !== paymentIntentId) {
      return NextResponse.json(
        { error: "PaymentIntent does not match booking" },
        { status: 400 }
      );
    }

    const paymentTransaction = await findPaymentTransactionByIntentId({
      paymentIntentId,
    });
    if (!paymentTransaction) {
      return NextResponse.json({ error: "Payment transaction not found" }, { status: 404 });
    }

    if (
      paymentTransaction.status === "SUCCEEDED" ||
      paymentTransaction.status === "PARTIALLY_REFUNDED" ||
      paymentTransaction.status === "REFUNDED"
    ) {
      const released = await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
        paymentIntentId
      );
      if (released.released > 0) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released });
      }
      return NextResponse.json({ success: true });
    }

    const pi = await getPaymentIntent(paymentIntentId);
    if (pi.status !== "succeeded") {
      return NextResponse.json(
        { error: `Payment has not succeeded (status: ${pi.status})` },
        { status: 400 }
      );
    }

    if (pi.amount !== paymentTransaction.amountCents) {
      return NextResponse.json(
        { error: "Payment amount does not match booking modification" },
        { status: 400 }
      );
    }

    await markPaymentIntentTransactionSucceeded({
      paymentIntentId: pi.id,
      amountCents: pi.amount,
      paymentMethodId:
        typeof pi.payment_method === "string"
          ? pi.payment_method
        : pi.payment_method?.id ?? null,
    });

    // #2700 — the booking was deleted while this payment was in flight.
    //
    // The rule is `INV-ADDPAY-036`; `INV-ADDPAY-032`, which tracked this as an
    // open decision, is now a superseded stub pointing there. Read -036 before
    // changing anything below: it also records that the older #1350 webhook
    // path already auto-refunds an additional capture on a CANCELLED booking,
    // and closes the task raised here when it does.
    //
    // THIS IS NOT A REFUSAL, and that is the decision. Stripe has already
    // captured the money by the time this endpoint is called; a 404 here would
    // leave a captured payment with no ledger row, which is worse than a ledger
    // row against a deleted booking. So the payment is recorded exactly as it
    // would be on a live booking — and then a human is told, because a ledger
    // row nobody looks at is not "accounted for".
    //
    // THE FLAG IS RE-READ HERE, NOT TRUSTED FROM THE OPENING READ, and that is
    // load-bearing rather than defensive. The read at the top of this handler
    // happens before `getPaymentIntent` — a live Stripe round trip — and before
    // `markPaymentIntentTransactionSucceeded`. A DELETE committing inside that
    // window is exactly the race this endpoint exists for, and deciding it from
    // the stale value handled only ONE of the two orderings: booking already
    // deleted when we looked. The other ordering — deleted while we were
    // talking to Stripe — recorded the capture and raised nothing, the precise
    // state `INV-ADDPAY-036` promises cannot occur. Either read seeing a
    // deletion is enough, because a booking is never un-deleted (there is one
    // writer of `deletedAt` in the tree and no restore path), so the two reads
    // can only disagree in one direction. The raise is idempotent on the
    // intent, so a redundant one is a no-op.
    //
    // The task is raised AFTER the record above and before the audit entry, so
    // the audit trail already carries the payment when the queue row appears.
    // Raising it is best-effort in the sense that a failure must not turn a
    // recorded capture into a 500 the member sees — the money IS recorded, and
    // re-confirming would take the already-captured early return above and never
    // reach here again. A failure is logged loudly instead. The re-read is
    // inside the same try for the same reason: a database blip while checking
    // must not undo a recorded capture.
    //
    // Why no automatic refund, and why the webhook may still close this task:
    // `deleted-booking-modification-payment.ts`.
    try {
      const freshBooking = payment.booking.deletedAt
        ? null
        : await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { deletedAt: true },
          });
      const deletedAt = payment.booking.deletedAt ?? freshBooking?.deletedAt ?? null;

      if (deletedAt) {
        const task = await raiseDeletedBookingModificationRefundTask({
          bookingId,
          paymentId: payment.id,
          paymentIntentId: pi.id,
          amountCents: paymentTransaction.amountCents,
        });
        logger.warn(
          {
            bookingId,
            paymentIntentId: pi.id,
            additionalAmountCents: paymentTransaction.amountCents,
            manualRefundTaskId: task.taskId,
            taskCreated: task.created,
            alreadyRefunded: task.alreadyRefunded,
            deletionSeenOnlyOnRecheck: payment.booking.deletedAt === null,
          },
          "Modification payment captured against a deleted booking - recorded and raised for manual decision"
        );
      }
    } catch (err) {
      logger.error(
        { err, bookingId, paymentIntentId: pi.id },
        "Recorded a modification payment on a deleted booking but FAILED to raise the manual refund task"
      );
    }

    const released = await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
      pi.id
    );
    if (released.released > 0) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released });
    }

    logAudit({
      action: "booking.modification.payment.confirmed",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: bookingOwner(payment.booking).memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      outcome: "success",
      summary: "Booking modification payment confirmed",
      details: JSON.stringify({
        paymentIntentId,
        additionalAmountCents: paymentTransaction.amountCents,
      }),
      metadata: {
        paymentIntentId,
        paymentTransactionId: paymentTransaction.id,
        additionalAmountCents: paymentTransaction.amountCents,
      },
      ipAddress,
    });

    logger.info(
      { bookingId, paymentIntentId, additionalAmountCents: paymentTransaction.amountCents },
      "Modification additional payment confirmed"
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    // #1888 — never echo an unexpected error's message to the client; the raw
    // error stays in the log only.
    logger.error({ err, bookingId }, "Failed to confirm modification payment");
    return NextResponse.json(
      { error: "Failed to confirm payment" },
      { status: 500 }
    );
  }
}
