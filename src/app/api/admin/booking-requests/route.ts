import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BookingRequestStatus } from "@prisma/client";
import {
  buildBookingRequestListWhere,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const statusFilterValues = [
  ...Object.values(BookingRequestStatus),
  "QUEUE",
  "ALL",
] as const;

const querySchema = z.object({
  status: z.enum(statusFilterValues).optional().default("QUEUE"),
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
  const where = buildBookingRequestListWhere(status);

  const [requests, total] = await Promise.all([
    prisma.bookingRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.bookingRequest.count({ where }),
  ]);

  const reviewerIds = Array.from(
    new Set(
      requests.flatMap((request) => [
        request.pricedByMemberId,
        request.reviewedByMemberId,
        request.convertedMemberId,
      ])
    )
  ).filter((id): id is string => Boolean(id));

  const reviewers = reviewerIds.length
    ? await prisma.member.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const reviewerNames = new Map(
    reviewers.map((member) => [member.id, `${member.firstName} ${member.lastName}`])
  );

  const data = requests.map((request) => ({
    ...serializeBookingRequestForAdmin(request),
    pricedByMemberName: request.pricedByMemberId
      ? reviewerNames.get(request.pricedByMemberId) ?? null
      : null,
    reviewedByMemberName: request.reviewedByMemberId
      ? reviewerNames.get(request.reviewedByMemberId) ?? null
      : null,
  }));

  return NextResponse.json({ data, page, pageSize, total });
}
