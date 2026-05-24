import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";

const querySchema = z.object({
  status: z.enum(["PENDING", "RESOLVED", "DECLINED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = status === "ALL" ? {} : { status };
  const [requests, total] = await Promise.all([
    prisma.bookingChangeRequest.findMany({
      where,
      include: {
        requester: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        reviewedBy: {
          select: { id: true, firstName: true, lastName: true },
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
