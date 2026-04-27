import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

function getInvoiceSyncEligibility(booking: {
  status: string;
  payment: { id: string; xeroInvoiceId: string | null } | null;
}, linkedPaymentIds: Set<string>, queuedPaymentIds: Set<string>) {
  if (booking.status !== "CONFIRMED" && booking.status !== "PAID") {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason:
        "Only CONFIRMED or PAID bookings can be force-synced to Xero invoices.",
    };
  }

  if (!booking.payment?.id) {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason: "This booking has no payment record to invoice.",
    };
  }

  if (booking.payment.xeroInvoiceId) {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason: "This booking is already linked to a Xero invoice.",
    };
  }

  if (linkedPaymentIds.has(booking.payment.id)) {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason: "This booking is already linked to a Xero invoice.",
    };
  }

  if (queuedPaymentIds.has(booking.payment.id)) {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason: "This booking invoice is already queued for background processing.",
    };
  }

  return {
    canForceSyncInvoice: true,
    forceSyncInvoiceReason: null,
  };
}

/**
 * GET /api/admin/bookings/search?q=searchterm
 * Search bookings by booking ID prefix or member identity.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json(
      { error: "Search query must be at least 2 characters" },
      { status: 400 }
    );
  }

  const limit = Math.min(
    20,
    Math.max(1, parseInt(request.nextUrl.searchParams.get("limit") || "8", 10) || 8)
  );

  try {
    const bookings = await prisma.booking.findMany({
      where: {
        status: { not: "DRAFT" },
        OR: [
          { id: { startsWith: q } },
          {
            member: {
              is: {
                OR: [
                  { firstName: { contains: q, mode: "insensitive" } },
                  { lastName: { contains: q, mode: "insensitive" } },
                  { email: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        checkIn: true,
        checkOut: true,
        updatedAt: true,
        member: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        payment: {
          select: {
            id: true,
            xeroInvoiceId: true,
          },
        },
        _count: {
          select: {
            guests: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
    });

    const paymentIds = bookings
      .map((booking) => booking.payment?.id)
      .filter((paymentId): paymentId is string => Boolean(paymentId));

    const [activeInvoiceLinks, queuedInvoiceOperations] = paymentIds.length
      ? await Promise.all([
          prisma.xeroObjectLink.findMany({
            where: {
              localModel: "Payment",
              localId: { in: paymentIds },
              xeroObjectType: "INVOICE",
              role: "PRIMARY_INVOICE",
              active: true,
            },
            select: {
              localId: true,
            },
          }),
          prisma.xeroSyncOperation.findMany({
            where: {
              direction: "OUTBOUND",
              entityType: "INVOICE",
              operationType: "CREATE",
              localModel: "Payment",
              localId: { in: paymentIds },
              status: {
                in: ["PENDING", "RUNNING"],
              },
            },
            select: {
              localId: true,
            },
          }),
        ])
      : [[], []];

    const linkedPaymentIds = new Set(
      activeInvoiceLinks.map((link) => link.localId)
    );
    const queuedPaymentIds = new Set(
      queuedInvoiceOperations
        .map((operation) => operation.localId)
        .filter((localId): localId is string => Boolean(localId))
    );

    const results = bookings.map((booking) => {
      const eligibility = getInvoiceSyncEligibility(
        booking,
        linkedPaymentIds,
        queuedPaymentIds
      );

      return {
        id: booking.id,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`.trim(),
        memberEmail: booking.member.email,
        checkIn: booking.checkIn.toISOString().split("T")[0],
        checkOut: booking.checkOut.toISOString().split("T")[0],
        status: booking.status,
        guestCount: booking._count.guests,
        paymentId: booking.payment?.id ?? null,
        xeroInvoiceId: booking.payment?.xeroInvoiceId ?? null,
        ...eligibility,
      };
    });

    return NextResponse.json({ bookings: results });
  } catch (err) {
    logger.error({ err, query: q }, "Error searching admin bookings");
    return NextResponse.json({ error: "Failed to search bookings" }, { status: 500 });
  }
}
