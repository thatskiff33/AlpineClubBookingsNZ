import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { BookingRequestError, serializeBookingRequestForAdmin } from "@/lib/booking-request";
import { BookingRequestQuoteError } from "@/lib/booking-request-quotes";
import { prisma } from "@/lib/prisma";
import { resolveAcceptedSchoolPendingAdults } from "@/lib/school-pending-adult-resolution";
import { schoolTeacherSchema } from "@/lib/school-teacher-schema";
import { requireAdmin } from "@/lib/session-guards";

const inputSchema = z.object({
  expectedVersion: z.number().int().min(0),
  teachers: z.array(schoolTeacherSchema).min(1).max(50),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the real names for the pending adults", details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }
  try {
    const resolved = await resolveAcceptedSchoolPendingAdults({
      requestId: id,
      adminMemberId: guard.session.user.id,
      expectedVersion: parsed.data.expectedVersion,
      teachers: parsed.data.teachers.map((teacher) => ({
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        email: teacher.email ?? null,
      })),
    });
    const updated = await prisma.bookingRequest.findUnique({ where: { id } });
    return NextResponse.json({
      request: updated ? serializeBookingRequestForAdmin(updated) : null,
      pendingAdultCount: resolved.pendingAdultCount,
      version: resolved.version,
    });
  } catch (err) {
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
