import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  checkMembershipStatus,
  findOrCreateXeroContact,
  XeroContactValidationError,
} from "@/lib/xero";
import {
  enqueueXeroBookingInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";

const forceSyncSchema = z.object({
  syncType: z.enum(["CONTACT", "INVOICE", "MEMBERSHIP"]),
  query: z.string().trim().min(1, "Query is required"),
});

class ForceSyncLookupError extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "ForceSyncLookupError";
    this.status = status;
  }
}

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

async function resolveMember(query: string) {
  if (query.includes("@")) {
    const matches = await prisma.member.findMany({
      where: {
        email: {
          equals: query,
          mode: "insensitive",
        },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
      },
      take: 3,
    });

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new ForceSyncLookupError(
        "Multiple members share that email. Use a member ID instead."
      );
    }

    return null;
  }

  const matches = await prisma.member.findMany({
    where: {
      id: {
        startsWith: query,
      },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    take: 3,
  });

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new ForceSyncLookupError("Member ID is ambiguous. Use the full member ID.");
  }

  return null;
}

async function resolveBooking(query: string) {
  const matches = await prisma.booking.findMany({
    where: {
      id: {
        startsWith: query,
      },
    },
    select: {
      id: true,
      memberId: true,
      status: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
        },
      },
    },
    take: 3,
  });

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new ForceSyncLookupError("Booking ID is ambiguous. Use the full booking ID.");
  }

  return null;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = forceSyncSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { syncType, query } = parsed.data;

  try {
    if (syncType === "CONTACT" || syncType === "MEMBERSHIP") {
      const member = await resolveMember(query);
      if (!member) {
        return NextResponse.json({ error: "Member not found" }, { status: 404 });
      }

      if (syncType === "CONTACT") {
        const xeroContactId = await findOrCreateXeroContact(member.id, {
          createdByMemberId: session.user.id,
          repairExistingLink: true,
        });

        logAudit({
          action: "XERO_FORCE_SYNC_CONTACT",
          memberId: session.user.id,
          targetId: member.id,
          subjectMemberId: member.id,
          entityType: "Member",
          entityId: member.id,
          category: "xero",
          outcome: "success",
          summary: "Xero contact force-synced",
          details: `Force-synced Xero contact for ${member.email}`,
          metadata: {
            memberEmail: member.email,
            xeroContactId,
          },
        });

        return NextResponse.json({
          ok: true,
          syncType,
          message: `Synced Xero contact for ${member.firstName} ${member.lastName}.`,
          memberId: member.id,
          memberEmail: member.email,
          xeroContactId,
        });
      }

      const result = await checkMembershipStatus(member.id, undefined, {
        forceRefreshOnlineInvoiceUrl: true,
      });

      logAudit({
        action: "XERO_FORCE_SYNC_MEMBERSHIP",
        memberId: session.user.id,
        targetId: member.id,
        subjectMemberId: member.id,
        entityType: "Member",
        entityId: member.id,
        category: "xero",
        outcome: "success",
        summary: "Xero membership status refreshed",
        details: `Force-refreshed membership status for ${member.email}`,
        metadata: {
          memberEmail: member.email,
          status: result.status,
          xeroInvoiceId: result.xeroInvoiceId ?? null,
        },
      });

      return NextResponse.json({
        ok: true,
        syncType,
        message: `Refreshed membership status for ${member.firstName} ${member.lastName}.`,
        memberId: member.id,
        memberEmail: member.email,
        status: result.status,
        xeroInvoiceId: result.xeroInvoiceId ?? null,
        xeroInvoiceUrl: result.xeroInvoiceId
          ? buildXeroInvoiceUrl(result.xeroInvoiceId)
          : null,
      });
    }

    const booking = await resolveBooking(query);
    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    if (booking.status !== "PAID") {
      return NextResponse.json(
        {
          error: "Only paid bookings can be force-synced to Xero invoices.",
        },
        { status: 409 }
      );
    }

    if (!booking.payment?.id) {
      return NextResponse.json(
        { error: "This booking has no payment record to invoice." },
        { status: 409 }
      );
    }

    const queueResult = await enqueueXeroBookingInvoiceOperation(booking.id, {
      createdByMemberId: session.user.id,
    });

    if (queueResult.queueOperationId) {
      scheduleAfterResponse(async () => {
        try {
          await processQueuedXeroOutboxOperations({ limit: 1 });
        } catch (error) {
          logger.error(
            { err: error, bookingId: booking.id },
            "Failed to kick queued Xero booking invoice worker"
          );
        }
      });
    }

    logAudit({
      action: "XERO_FORCE_SYNC_INVOICE",
      memberId: session.user.id,
      targetId: booking.id,
      subjectMemberId: booking.memberId,
      entityType: "Booking",
      entityId: booking.id,
      category: "xero",
      outcome: "success",
      summary: "Xero booking invoice force-sync queued",
      details: queueResult.message,
      metadata: {
        bookingStatus: booking.status,
        paymentId: booking.payment.id,
        xeroInvoiceId: booking.payment.xeroInvoiceId ?? null,
        queueOperationId: queueResult.queueOperationId ?? null,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        syncType,
        bookingId: booking.id,
        queueOperationId: queueResult.queueOperationId,
        message: queueResult.message,
      },
      { status: queueResult.queueOperationId ? 202 : 200 }
    );
  } catch (error) {
    if (error instanceof ForceSyncLookupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof XeroContactValidationError) {
      return NextResponse.json(
        {
          error: `Complete these fields before syncing to Xero: ${error.missingFields.join(", ")}`,
          missingFields: error.missingFields,
        },
        { status: 422 }
      );
    }

    logger.error({ err: error, syncType, query }, "Failed targeted Xero sync");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed targeted Xero sync" },
      { status: 500 }
    );
  }
}
