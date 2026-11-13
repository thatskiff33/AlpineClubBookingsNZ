import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { deleteBooking } from "@/lib/booking-delete";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const deleteBookingParamsSchema = z.object({
  id: z.string().min(1),
});

const deleteBookingBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

async function readDeleteBody(request: NextRequest) {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const parsedParams = deleteBookingParamsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const body = await readDeleteBody(request);
    if (body === null) {
      return NextResponse.json(
        {
          error: "Invalid JSON",
          details: { body: ["Request body must be valid JSON"] },
        },
        { status: 400 }
      );
    }

    const parsedBody = deleteBookingBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const result = await deleteBooking({
      bookingId: parsedParams.data.id,
      actor: {
        memberId: session.user.id,
        role: authorizationRoleFromAccessRoles(session.user),
        ipAddress: getClientIp(request),
      },
      reason: parsedBody.data.reason,
    });

    if (result.status === 200) {
      return NextResponse.json(result.data);
    }

    return NextResponse.json(
      {
        error: result.error,
        ...(result.blockers ? { blockers: result.blockers } : {}),
      },
      { status: result.status }
    );
  } catch (error) {
    // The delete is one lock(1) transaction (INV-LOCK-005); its Stripe
    // clean-up runs only after it commits.
    const contended = transactionContendedResponse(
      error,
      "Booking delete contended for the lock(1) budget",
      { context: { bookingId: (await params).id } },
    );
    if (contended) return contended;
    logger.error({ err: error }, "Error deleting booking");
    return NextResponse.json(
      { error: "Failed to delete booking" },
      { status: 500 }
    );
  }
}
