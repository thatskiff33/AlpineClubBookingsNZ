import { after, NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { getMissingXeroInvoiceBookings } from "@/lib/xero-admin-health";
import {
  enqueueXeroBookingInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  try {
    const snapshot = await getMissingXeroInvoiceBookings({ limit: 50 });
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, "Failed to load bookings missing Xero invoices");
    return NextResponse.json(
      { error: "Failed to load bookings missing Xero invoices" },
      { status: 500 }
    );
  }
}

export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  try {
    const snapshot = await getMissingXeroInvoiceBookings({ limit: 200 });

    if (snapshot.count === 0) {
      return NextResponse.json({
        ok: true,
        found: 0,
        queued: 0,
        skipped: 0,
        message: "No missing booking invoices found.",
      });
    }

    let queued = 0;
    let skipped = 0;
    const queuedOperationIds: string[] = [];
    const skippedBookings: Array<{ bookingId: string; reason: string }> = [];

    for (const booking of snapshot.bookings) {
      try {
        const result = await enqueueXeroBookingInvoiceOperation(booking.bookingId, {
          createdByMemberId: session.user.id,
          invoiceEmailDelivery: null,
        });

        if (result.queueOperationId) {
          queued += 1;
          queuedOperationIds.push(result.queueOperationId);
        } else {
          skipped += 1;
          skippedBookings.push({
            bookingId: booking.bookingId,
            reason: result.message,
          });
        }
      } catch (error) {
        skipped += 1;
        skippedBookings.push({
          bookingId: booking.bookingId,
          reason: "Failed to queue invoice",
        });
        logger.error(
          { err: error, bookingId: booking.bookingId },
          "Failed to queue missing Xero invoice"
        );
      }
    }

    if (queuedOperationIds.length > 0) {
      scheduleAfterResponse(async () => {
        try {
          await processQueuedXeroOutboxOperations({ limit: queuedOperationIds.length });
        } catch (error) {
          logger.error(
            { err: error, queuedOperationIds },
            "Failed to kick queued Xero invoice outbox worker"
          );
        }
      });
    }

    await createAuditLog({
      action: "XERO_TRIGGER_MISSING_INVOICES",
      memberId: session.user.id,
      entityType: "XeroSyncOperation",
      category: "xero",
      severity: "important",
      outcome: "success",
      summary: "Queued missing Xero invoices",
      details: `Queued ${queued} missing booking invoices (${skipped} skipped)`,
      metadata: {
        found: snapshot.count,
        queued,
        skipped,
        queuedOperationIds,
        skippedBookings,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        found: snapshot.count,
        queued,
        skipped,
        skippedBookings,
        message:
          queued > 0
            ? `Queued ${queued} missing booking invoice${queued === 1 ? "" : "s"} for background processing.`
            : "No missing booking invoices could be queued.",
      },
      { status: queued > 0 ? 202 : 200 }
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to trigger missing Xero invoices");
    return NextResponse.json(
      { error: "Failed to trigger missing Xero invoices" },
      { status: 500 }
    );
  }
}
