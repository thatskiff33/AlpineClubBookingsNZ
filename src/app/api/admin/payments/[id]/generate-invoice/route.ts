import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { createXeroInvoiceForBooking, isXeroConnected } from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

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
    select: { id: true, bookingId: true, xeroInvoiceId: true, status: true },
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

  const connected = await isXeroConnected();
  if (!connected) {
    return NextResponse.json({ error: "Xero is not connected" }, { status: 400 });
  }

  try {
    const xeroInvoiceId = await createXeroInvoiceForBooking(payment.bookingId, {
      createdByMemberId: session.user.id,
    });

    const updated = await prisma.payment.findUnique({
      where: { id },
      select: { xeroInvoiceId: true, xeroInvoiceNumber: true },
    });

    logAudit({
      action: "XERO_INVOICE_GENERATED",
      memberId: session.user.id,
      targetId: payment.bookingId,
      details: `Invoice ${updated?.xeroInvoiceNumber ?? xeroInvoiceId} created for payment ${id}`,
    });

    return NextResponse.json({
      xeroInvoiceId: updated?.xeroInvoiceId ?? xeroInvoiceId,
      xeroInvoiceNumber: updated?.xeroInvoiceNumber ?? null,
    });
  } catch (err) {
    logger.error({ err, paymentId: id }, "Failed to generate Xero invoice");
    return NextResponse.json({ error: "Failed to generate Xero invoice. Check Xero connection and try again." }, { status: 500 });
  }
}
