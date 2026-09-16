import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";

const querySchema = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "ALL"]).optional().default("REQUESTED"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  // #2524: POLICY_EXCEPTION rows share this table but are decided through the
  // booking-policy exception workflow (#2525) and surface only in the unified
  // queue. Scope this legacy locked-period queue to LOCKED_PERIOD so those rows
  // never inflate the list or its count — the symmetric exclusion to the
  // unified queue's kind:"POLICY_EXCEPTION" filter. Both findMany and count
  // reuse this `where`, so the guard applies to the total as well as the page.
  const where: Prisma.BookingChangeRequestWhereInput =
    status === "ALL"
      ? { kind: "LOCKED_PERIOD" }
      : { kind: "LOCKED_PERIOD", status };
  const [requests, total] = await Promise.all([
    prisma.bookingChangeRequest.findMany({
      where,
      include: {
        requestedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        reviewedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        linkedModification: {
          select: {
            id: true,
            createdAt: true,
            modificationType: true,
            priceDiffCents: true,
            changeFeeCents: true,
          },
        },
        booking: {
          select: {
            id: true,
            checkIn: true,
            checkOut: true,
            status: true,
            finalPriceCents: true,
            member: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
            // #3369: the owner may be an Organisation; bookingOwner() reads both.
            organisation: { select: { name: true, email: true } },
            payment: {
              select: {
                id: true,
                amountCents: true,
                refundedAmountCents: true,
                status: true,
                xeroInvoiceId: true,
                xeroInvoiceNumber: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.bookingChangeRequest.count({ where }),
  ]);

  return NextResponse.json({ data: requests, page, pageSize, total });
}
