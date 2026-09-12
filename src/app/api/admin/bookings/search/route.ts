import { NextRequest, NextResponse } from "next/server";
import logger from "@/lib/logger";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";
import { formatDateOnly } from "@/lib/date-only";

const adminBookingSearchQuerySchema = z.object({
  q: z.string().trim().min(2),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  deleted: z.enum(["hide", "include", "only"]).default("hide"),
});

const bookingReferencePattern =
  /\bbooking(?:\s+(?:id|ref(?:erence)?(?:\s+number)?))?[\s:#-]+([a-z0-9][a-z0-9_-]{1,})\b/i;

function getBookingIdSearchTerms(query: string) {
  const terms = new Set<string>([query]);
  const lowerQuery = query.toLowerCase();

  terms.add(lowerQuery);

  // The captured reference itself is the condition: the group is mandatory in
  // the pattern, so it is present exactly when the pattern matched, and reading
  // it out of the destructure keeps that one condition with one answer (#2801).
  const [, referenceTerm] = query.match(bookingReferencePattern) ?? [];
  if (referenceTerm !== undefined) {
    terms.add(referenceTerm);
    terms.add(referenceTerm.toLowerCase());
  }

  return Array.from(terms).filter((term) => term.length >= 2);
}

function getInvoiceSyncEligibility(booking: {
  status: string;
  payment: {
    id: string;
    xeroInvoiceId: string | null;
    manuallyMarkedPaidAt: Date | null;
  } | null;
}, linkedPaymentIds: Set<string>, queuedPaymentIds: Set<string>) {
  // B5 (#2262): a cash / off-Xero settlement has no invoice by design, so
  // offering "force sync invoice" would invite an admin to mint (and email) an
  // awaiting-payment invoice for money already collected. Admin UX only — the
  // enqueue choke point refuses regardless of what this returns.
  if (booking.payment?.manuallyMarkedPaidAt) {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason:
        "This booking was manually marked paid (cash / off-Xero) — no Xero invoice is expected.",
    };
  }

  if (booking.status !== "PAID") {
    return {
      canForceSyncInvoice: false,
      forceSyncInvoiceReason:
        "Only paid bookings can be force-synced to Xero invoices.",
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
 * Search bookings by booking ID/reference prefix or member identity.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = adminBookingSearchQuerySchema.safeParse({
    q: request.nextUrl.searchParams.get("q"),
    limit: request.nextUrl.searchParams.get("limit") ?? "8",
    deleted: parseBookingDeletedVisibility(request.nextUrl.searchParams.get("deleted")),
  });

  if (!parsed.success) {
    const qErrors = parsed.error.flatten().fieldErrors.q;

    if (qErrors?.length) {
      return NextResponse.json(
        { error: "Search query must be at least 2 characters" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { q, limit, deleted } = parsed.data;
  const bookingIdSearchTerms = getBookingIdSearchTerms(q);

  try {
    const bookings = await prisma.booking.findMany({
      where: {
        status: { not: "DRAFT" },
        ...buildBookingDeletedWhere(deleted),
        OR: [
          ...bookingIdSearchTerms.map((term) => ({
            id: { startsWith: term },
          })),
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
        deletedAt: true,
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
            // B5 (#2262): manual-settlement provenance gates the force-sync
            // affordance below.
            manuallyMarkedPaidAt: true,
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
        checkIn: formatDateOnly(booking.checkIn),
        checkOut: formatDateOnly(booking.checkOut),
        status: booking.status,
        deletedAt: booking.deletedAt?.toISOString() ?? null,
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
