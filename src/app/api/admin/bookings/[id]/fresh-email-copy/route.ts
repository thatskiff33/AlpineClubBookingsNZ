import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRequestContext } from "@/lib/audit";
import { sendBookingFreshEmailCopy } from "@/lib/booking-fresh-email-copy";
import { BOOKING_FRESH_COPY_TEMPLATES } from "@/lib/booking-fresh-email-copy-templates";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

// The template is the ONLY input. `.strict()` refuses any other key, so a
// caller can never name a recipient, a body, a token or an amount: those are
// all read from the booking (or minted) by the service.
const freshEmailCopySchema = z
  .object({
    template: z.enum(BOOKING_FRESH_COPY_TEMPLATES),
  })
  .strict();

/**
 * POST /api/admin/bookings/[id]/fresh-email-copy — send a freshly rendered copy
 * of a booking email whose body is never kept: the booking confirmation, the
 * pre-arrival reminder, or the split guests' payment link.
 *
 * Authorisation mirrors the sibling admin booking actions: `bookings:edit`, and
 * any other caller gets a 403 from `requireAdmin`. Refusals say what really
 * happened: 404 no booking, 409 the booking cannot be sent this email (deleted,
 * wrong status, no address, "No emails" on, or a non-live installation), 422
 * the address is suppressed or a placeholder, 429 a copy just went out, 502 the
 * mail transport failed, and 503 a setting could not be read or is incomplete.
 * Only a 200 means the member was sent the message.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = freshEmailCopySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose which booking email to send a fresh copy of." },
      { status: 400 },
    );
  }

  try {
    const result = await sendBookingFreshEmailCopy({
      bookingId,
      template: parsed.data.template,
      actorMemberId: session.user.id,
      auditRequest: getAuditRequestContext(request),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      success: true,
      template: result.template,
      sentTo: result.sentTo,
      archivedFailureCount: result.archivedFailureCount,
      warning: result.warning,
    });
  } catch (err) {
    logger.error(
      { err, bookingId, template: parsed.data.template },
      "Failed to send a fresh copy of a booking email",
    );
    return NextResponse.json(
      {
        error:
          "The fresh copy could not be sent. Nothing is retried automatically for this email, so please try again.",
      },
      { status: 500 },
    );
  }
}
