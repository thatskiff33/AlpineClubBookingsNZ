import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/**
 * POST /api/admin/payments/[id]/generate-invoice
 * Generates a Xero invoice for a payment that doesn't have one.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    select: {
      id: true,
      bookingId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      status: true,
    },
  });

  if (!payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  if (payment.xeroInvoiceId) {
    return NextResponse.json({ error: "Xero invoice already exists" }, { status: 409 });
  }

  if (payment.status !== "SUCCEEDED") {
    return NextResponse.json({ error: "Can only generate invoices for succeeded payments" }, { status: 400 });
  }

  try {
    const queuedInvoice = await enqueueXeroBookingInvoiceOperation(payment.bookingId, {
      createdByMemberId: session.user.id,
    });

    let immediateKickFailed = false;
    let kickResult:
      | Awaited<ReturnType<typeof kickQueuedXeroOutboxOperationsIfConnected>>
      | null = null;

    if (queuedInvoice.queueOperationId) {
      try {
        kickResult = await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      } catch (kickErr) {
        immediateKickFailed = true;
        logger.error(
          { err: kickErr, paymentId: id, queueOperationId: queuedInvoice.queueOperationId },
          "Failed to kick queued Xero booking invoice from admin repair route"
        );
      }
    }

    const updated = await prisma.payment.findUnique({
      where: { id },
      select: { xeroInvoiceId: true, xeroInvoiceNumber: true },
    });

    if (updated?.xeroInvoiceId) {
      logAudit({
        action: "XERO_INVOICE_GENERATED",
        memberId: session.user.id,
        targetId: payment.bookingId,
        details: `Invoice ${updated.xeroInvoiceNumber ?? updated.xeroInvoiceId} created for payment ${id}${queuedInvoice.queueOperationId ? ` via queued operation ${queuedInvoice.queueOperationId}` : ""}`,
      });

      return NextResponse.json({
        status: "generated",
        xeroInvoiceId: updated.xeroInvoiceId,
        xeroInvoiceNumber: updated.xeroInvoiceNumber ?? null,
        queueOperationId: queuedInvoice.queueOperationId,
      });
    }

    if (queuedInvoice.queueOperationId) {
      const message = immediateKickFailed
        ? "Xero booking invoice queued. The immediate worker kick failed, but the operation will retry automatically."
        : kickResult
          ? "Xero booking invoice queued for background processing. Refresh shortly if it does not appear immediately."
          : "Xero booking invoice queued, but Xero is currently disconnected. The operation will run automatically once the connection is restored.";

      logAudit({
        action: "XERO_INVOICE_GENERATION_QUEUED",
        memberId: session.user.id,
        targetId: payment.bookingId,
        details: `Queued booking invoice generation for payment ${id} as operation ${queuedInvoice.queueOperationId}`,
      });

      return NextResponse.json(
        {
          status: "queued",
          queueOperationId: queuedInvoice.queueOperationId,
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          message,
        },
        { status: 202 }
      );
    }

    return NextResponse.json(
      { error: queuedInvoice.message || "Xero invoice already exists" },
      { status: 409 }
    );
  } catch (err) {
    logger.error({ err, paymentId: id }, "Failed to generate Xero invoice");
    return NextResponse.json(
      { error: "Failed to generate Xero invoice. Check Xero activity and try again." },
      { status: 500 }
    );
  }
}
