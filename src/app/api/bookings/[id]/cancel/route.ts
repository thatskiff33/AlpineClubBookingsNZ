import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cancelBooking } from "@/lib/booking-cancel";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";

const cancelBookingParamsSchema = z.object({
  id: z.string().min(1),
});

const cancelBookingMutationSchema = z.object({
  refundMethod: z.enum(["card", "credit"]),
  // Issue #1705: the admin-on-behalf per-action email choice. Honored ONLY when
  // the actor holds bookings:edit (see below); a member self-cancel never has
  // that access, so their flag is dropped and the member is always notified.
  notifyMember: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const parsedParams = cancelBookingParamsSchema.safeParse(await params);
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid JSON",
          details: { body: ["Request body must be valid JSON"] },
        },
        { status: 400 }
      );
    }

    const parsed = cancelBookingMutationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Issue #1313 (owner-approved option A2): a Booking Officer (bookings:edit)
    // may cancel any member's booking with the SAME authority — and
    // byte-identical refund / Stripe path / cancellation email / audit — as a
    // Full Admin acting on-behalf. The actor's real authorization role stays
    // honest ("USER" for an officer); this flag ONLY widens the internal
    // authorization gate, never the refund computation (which keys off booking
    // state + policy tier only).
    const hasBookingsEditAccess = hasAdminAreaAccess(session.user, {
      area: "bookings",
      level: "edit",
    });

    const result = await cancelBooking(
      parsedParams.data.id,
      session.user.id,
      authorizationRoleFromAccessRoles(session.user),
      getClientIp(request),
      parsed.data.refundMethod,
      {
        hasBookingsEditAccess,
        // Issue #1705: forward the email choice ONLY for an admin-on-behalf
        // actor (bookings:edit). A member self-cancel lacks that access, so the
        // flag is dropped here and cancelBooking defaults to notifying — the
        // member always receives their cancellation email.
        ...(hasBookingsEditAccess && parsed.data.notifyMember !== undefined
          ? { notifyMember: parsed.data.notifyMember }
          : {}),
      }
    );

    if (result.status === 200) {
      return NextResponse.json(result.data);
    }
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  } catch (error) {
    logger.error({ err: error }, "Error cancelling booking");
    return NextResponse.json(
      { error: "Failed to cancel booking" },
      { status: 500 }
    );
  }
}
