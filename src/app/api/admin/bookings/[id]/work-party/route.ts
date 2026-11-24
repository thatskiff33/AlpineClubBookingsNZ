import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { ApiError } from "@/lib/api-error";
import logger from "@/lib/logger";
import { clubTime } from "@/lib/club-time/server";
import { clubFormatValues } from "@/lib/club-format-server";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { getDefaultLodgeId } from "@/lib/lodges";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";
import { findActiveWorkPartyEventsForRange } from "@/lib/work-party";
import { readWorkPartyBookingFacts, WORK_PARTY_BOOKING_SELECT } from "@/lib/work-party-booking-facts";
import { prepareBatchModificationForCallerTransaction } from "@/lib/booking-batch-modification-service";
import { EditFinancialReviewPendingError } from "@/lib/edit-financial-review";
import { getXeroLockGuardErrorResponse } from "@/lib/xero-period-lock-guard";
import {
  addBookingToWorkParty,
  removeBookingFromWorkParty,
  workPartyBookingEligibility,
  WorkPartyCorrectionFiguresChangedError,
  workPartyRemovalEligibility,
} from "@/lib/work-party-booking-correction";
import { workPartyCorrectionBodySchema as bodySchema } from "@/lib/work-party-correction-request";
import {
  ADMIN_BOOKING_WORK_PARTY_OPTIONS_CONNECTION_SHAPE,
  type AdminBookingWorkPartyOptionsAnswer,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * The work parties this booking could be added to (fork triyder/AlpineClubBookingsNZ#119): every open work
 * party whose window overlaps the stay, each with the shared eligibility rule's
 * answer, so the admin booking page lists them with the reason a refused one
 * cannot be chosen. Booking Officers and Full Admins (`bookings:view`). Also the
 * AI app action `get_booking_work_party_options` (ALP-719).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "bookings", level: "view" } });
  if (!guard.ok) return guard.response;
  // The action exists only with the Work Parties module on: a switched-off
  // module can never affect a booking's price (as at booking create).
  if (!(await loadEffectiveModuleFlags()).workParties) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await params;

  const booking = await prisma.booking.findUnique({ where: { id }, select: WORK_PARTY_BOOKING_SELECT });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  // The service's own facts, for this officer: their own or family's booking
  // (owner decision 3, #5149) is greyed out with its reason, as the service
  // refuses it again under its locks.
  const [facts, bookingLodgeId, today, multiPromoCodes, events] = await Promise.all([
    readWorkPartyBookingFacts(prisma, id, booking, guard.session.user.id),
    booking.lodgeId ?? getDefaultLodgeId(prisma),
    clubTodayDateOnlyInstant(),
    multiPromoCodesEnabled(prisma),
    // Every lodge's, so one at another lodge is listed with its reason.
    findActiveWorkPartyEventsForRange(booking.checkIn, booking.checkOut, prisma),
  ]);
  const current = facts.current;

  // fork triyder/AlpineClubBookingsNZ#130: whether the work party on the booking can be taken off it.
  const removal = current ? workPartyRemovalEligibility(facts.remove, { today }, current.id) : null;

  const answer: AdminBookingWorkPartyOptionsAnswer = {
    currentWorkParty: current,
    removal: removal && { eligible: removal.ok, reason: removal.ok ? null : removal.reason },
    workParties: events.map((event) => {
      const eligibility = workPartyBookingEligibility(
        facts.add,
        { bookingLodgeId, today, multiPromoCodes },
        event,
      );
      return {
        id: event.id,
        name: event.name,
        startDate: calendarDateOfDateOnlyInstant(event.startDate),
        endDate: calendarDateOfDateOnlyInstant(event.endDate),
        discountPercent: event.discountPercent,
        lodgeName: event.lodge?.name ?? null,
        eligible: eligibility.ok,
        reason: eligibility.ok ? null : eligibility.reason,
      };
    }),
  };
  return connectionJson(req, answer, ADMIN_BOOKING_WORK_PARTY_OPTIONS_CONNECTION_SHAPE);
}

/**
 * "Add booking to work party" (fork triyder/AlpineClubBookingsNZ#119), and with `action: "remove"`
 * "Remove from work party" (fork triyder/AlpineClubBookingsNZ#130). `mode: "preview"` runs the whole
 * change and rolls it back, returning the figures and the settlement methods
 * offered (`settlementOptions`, triyder/AlpineClubBookingsNZ#129) for the confirm dialog;
 * `mode: "apply"` saves it, refusing if the figures moved since the preview.
 * Booking Officers and Full Admins (`bookings:edit`); the service re-authorises
 * the officer under its locks. The work and the money rules are in
 * `src/lib/work-party-booking-correction.ts`.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "bookings", level: "edit" } });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  if (!(await loadEffectiveModuleFlags()).workParties) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await params;

  // INV-AUTH-010: the handler can refund through the canonical booking edit (to
  // the card, a bank hand-back, or the group organiser), so it asks for a fresh
  // proof after the guard and before it reads the body.
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Everything the transaction must not read under its locks (INV-LOCK-004).
  const [club, format, preTransaction] = await Promise.all([
    clubTime(),
    clubFormatValues(),
    prepareBatchModificationForCallerTransaction({ audience: "admin" }),
  ]);
  const common = {
    bookingId: id,
    workPartyEventId: parsed.data.workPartyEventId,
    ...(parsed.data.settlementMethod === undefined
      ? {}
      : { settlementMethod: parsed.data.settlementMethod }),
    actorMemberId: session.user.id,
    ipAddress: getClientIp(req),
    todayAtClub: club.today(),
    format,
    preTransaction,
  };

  try {
    const mode =
      parsed.data.mode === "preview"
        ? ({ dryRun: true } as const)
        : {
            dryRun: false as const,
            expectedFigures: parsed.data.expectedFigures,
            ...(parsed.data.notifyMember === undefined
              ? {}
              : { notifyMember: parsed.data.notifyMember }),
          };
    // Two direct calls, not a chosen function: the step-up census (#4619)
    // follows each to the refund and ask operations the edit reaches.
    const result =
      parsed.data.action === "remove"
        ? await removeBookingFromWorkParty({ ...common, ...mode })
        : await addBookingToWorkParty({ ...common, ...mode });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkPartyCorrectionFiguresChangedError) {
      return NextResponse.json(
        { error: error.message, code: error.code, figures: error.actual, settlementOptions: error.settlementOptions },
        { status: 409 },
      );
    }
    const xeroLock = getXeroLockGuardErrorResponse(error);
    if (xeroLock) {
      return NextResponse.json(xeroLock.body, { status: xeroLock.status });
    }
    if (error instanceof EditFinancialReviewPendingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error(
      { err: error, bookingId: id, workPartyEventId: parsed.data.workPartyEventId, action: parsed.data.action },
      "Changing a booking's work party failed",
    );
    return NextResponse.json(
      {
        error:
          parsed.data.action === "remove"
            ? "The booking could not be removed from the work party. Nothing was changed."
            : "The booking could not be added to the work party. Nothing was changed.",
      },
      { status: 500 },
    );
  }
}
