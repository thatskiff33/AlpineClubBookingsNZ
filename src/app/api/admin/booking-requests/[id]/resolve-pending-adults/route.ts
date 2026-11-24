import { NextRequest, NextResponse } from "next/server";

import { adminBookingRequestResolvePendingAdultsBodySchema } from "@/lib/admin-bookings-schemas/requests";
import { parseJsonRequestBody } from "@/lib/api-json";
import { BookingRequestError, serializeBookingRequestForAdmin } from "@/lib/booking-request";
import { BookingRequestQuoteError } from "@/lib/booking-request-quotes";
import {
  ADMIN_BOOKING_REQUEST_PENDING_ADULTS_CONNECTION_SHAPE,
  type AdminBookingRequestPendingAdultsAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { prisma } from "@/lib/prisma";
import { resolveAcceptedSchoolPendingAdults } from "@/lib/school-pending-adult-resolution";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

/**
 * POST /api/admin/booking-requests/[id]/resolve-pending-adults — give an
 * accepted school request's pending adults their real names, on its held
 * beds, without changing the deal. Also the AI app action
 * `name_school_pending_adults` (ALP-719).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const jsonBody = await parseJsonRequestBody(req, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = adminBookingRequestResolvePendingAdultsBodySchema.safeParse(body);
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
    const answer: AdminBookingRequestPendingAdultsAnswer = {
      request: updated ? serializeBookingRequestForAdmin(updated) : null,
      pendingAdultCount: resolved.pendingAdultCount,
      version: resolved.version,
    };
    return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_PENDING_ADULTS_CONNECTION_SHAPE);
  } catch (err) {
    // `INV-LOCK-006`: the naming's one transaction rolled back.
    const contended = transactionContendedResponse(
      err,
      "School pending-adult naming contended for the lock(1) budget",
      { context: { requestId: id } },
    );
    if (contended) return contended;
    if (err instanceof BookingRequestError || err instanceof BookingRequestQuoteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
