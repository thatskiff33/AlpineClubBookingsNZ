import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

export async function generateAdminPaymentInvoice(params: {
  paymentId: string;
  adminMemberId: string;
}): Promise<JsonRouteResult> {
  const { paymentId, adminMemberId } = params;

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      bookingId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      status: true,
    },
  });

  if (!payment) {
    return jsonResult({ error: "Payment not found" }, { status: 404 });
  }

  if (payment.xeroInvoiceId) {
    return jsonResult({ error: "Xero invoice already exists" }, { status: 409 });
  }

  if (payment.status !== "SUCCEEDED") {
    return jsonResult(
      { error: "Can only generate invoices for succeeded payments" },
      { status: 400 }
    );
  }

  try {
    const queuedInvoice = await enqueueXeroBookingInvoiceOperation(payment.bookingId, {
      createdByMemberId: adminMemberId,
      invoiceEmailDelivery: null,
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
          { err: kickErr, paymentId, queueOperationId: queuedInvoice.queueOperationId },
          "Failed to kick queued Xero booking invoice from admin repair route"
        );
      }
    }

    const updated = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { xeroInvoiceId: true, xeroInvoiceNumber: true },
    });

    if (updated?.xeroInvoiceId) {
      await createAuditLog({
        action: "XERO_INVOICE_GENERATED",
        memberId: adminMemberId,
        targetId: payment.bookingId,
        entityType: "Payment",
        entityId: paymentId,
        category: "xero",
        severity: "critical",
        outcome: "success",
        summary: "Xero invoice generated for payment",
        details: `Invoice ${updated.xeroInvoiceNumber ?? updated.xeroInvoiceId} created for payment ${paymentId}${queuedInvoice.queueOperationId ? ` via queued operation ${queuedInvoice.queueOperationId}` : ""}`,
        metadata: {
          bookingId: payment.bookingId,
          paymentId,
          xeroInvoiceId: updated.xeroInvoiceId,
          xeroInvoiceNumber: updated.xeroInvoiceNumber ?? null,
          queueOperationId: queuedInvoice.queueOperationId,
        },
      });

      return jsonResult({
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

      await createAuditLog({
        action: "XERO_INVOICE_GENERATION_QUEUED",
        memberId: adminMemberId,
        targetId: payment.bookingId,
        entityType: "Payment",
        entityId: paymentId,
        category: "xero",
        severity: "important",
        outcome: "success",
        summary: "Xero invoice generation queued for payment",
        details: `Queued booking invoice generation for payment ${paymentId} as operation ${queuedInvoice.queueOperationId}`,
        metadata: {
          bookingId: payment.bookingId,
          paymentId,
          queueOperationId: queuedInvoice.queueOperationId,
          immediateKickFailed,
          kickedImmediately: Boolean(kickResult),
        },
      });

      return jsonResult(
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

    return jsonResult(
      { error: queuedInvoice.message || "Xero invoice already exists" },
      { status: 409 }
    );
  } catch (err) {
    logger.error({ err, paymentId }, "Failed to generate Xero invoice");
    return jsonResult(
      { error: "Failed to generate Xero invoice. Check Xero activity and try again." },
      { status: 500 }
    );
  }
}
