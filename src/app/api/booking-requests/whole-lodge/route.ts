import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  assertRequestedLodgeActive,
  BookingRequestError,
  createMemberWholeLodgeRequest,
} from "@/lib/booking-request";
import {
  applyRateLimit,
  checkRateLimit,
  rateLimitedResponse,
  rateLimiters,
} from "@/lib/rate-limit";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { requireActiveSession } from "@/lib/session-guards";
import logger from "@/lib/logger";

/*
 * Member-facing "Book the whole lodge" request (#2263, epic #2245).
 *
 * BOUNDARY: member. Deliberately NOT listed in `explicitPublicApiRoutes` —
 * registering it there would EXEMPT it from the boundary test's guard check.
 * The default "member" classification is what enforces the session guard, and
 * the per-method rationale is recorded in `mixedMethodApiRoutes`
 * (src/lib/api-route-security.ts).
 *
 * THE PRIVACY CONTRACT THIS FILE EXISTS TO KEEP (ADR-001 decision 6, D11):
 * a member must never learn from this endpoint whether the lodge is free, full,
 * or already exclusively held for someone else. "Held" and "full" are the same
 * word to a member, and neither may be inferable from a request they make.
 *
 * That is enforced STRUCTURALLY, not cosmetically:
 *
 *   1. ONE frozen success body, byte-identical for every schema-valid
 *      submission. It echoes NOTHING the member sent — no dates, no headcount,
 *      no reference — because an echo is a channel.
 *   2. The handler NEVER queries availability, occupancy, seasons or pricing.
 *      There is no branch to time, because there is no branch. Uniform work is a
 *      property of the code, not of a padding delay someone can tune away.
 *      (The only capacity value read anywhere on this path — in the service, not
 *      here — is the lodge's CONFIGURED capacity, a property of the building,
 *      the same bound the school door applies.)
 *   3. Every rejection that IS observable (401 / 429 / 400 / 422 / 409) is
 *      derived from the member's own session, their own request history, or the
 *      shape of their own payload — never from the state of the calendar.
 */

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const noCrlf = (value: string) => !/[\r\n]/.test(value);

const wholeLodgeRequestSchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  // Approximate party size. Bounded against the lodge's configured capacity
  // below; there is no availability check of any kind.
  headcount: z.number().int().min(1).max(500),
  // Who the group is, in the member's words. No guest names are collected (D5).
  groupDescription: z
    .string()
    .min(1, "Tell us who the group is")
    .max(500)
    .refine(noCrlf, "This cannot contain line breaks"),
  notes: z
    .string()
    .max(400)
    .refine(noCrlf, "Notes cannot contain line breaks")
    .optional()
    .nullable(),
  // The control is visually hidden for one lodge, but the client still sends
  // that sole explicit identity. Unknown scope must never become the default.
  lodgeId: z.string().min(1),
});

/**
 * The one acknowledgement body. A module-level FROZEN OBJECT, not a Response:
 * a Response's body is a one-shot stream, so reusing an instance across requests
 * breaks on the second caller. Each request re-serialises this same object, so
 * every member on every path receives identical bytes.
 */
const WHOLE_LODGE_REQUEST_ACCEPTED = Object.freeze({
  success: true,
  message:
    "Thanks — your whole-lodge request has been sent to the booking officer. They'll be in touch to confirm what's possible. You can see it under My requests on My bookings.",
});

export async function POST(request: NextRequest) {
  // 1. Session. Any login-holder may ask (owner decision D2) — there is no
  //    membership-class predicate, so no 403 exists on this route to probe.
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;

  // 2. Rate limits, per-IP then per-member. Neither is cheaper than the public
  //    school door's.
  const ipLimited = await applyRateLimit(
    rateLimiters.memberWholeLodgeRequest,
    request
  );
  if (ipLimited) return ipLimited;
  const memberLimit = await checkRateLimit(
    rateLimiters.memberWholeLodgeRequest,
    `member:${memberId}`
  );
  if (!memberLimit.success) return rateLimitedResponse(memberLimit);

  // 3. Payload shape.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = wholeLodgeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { checkIn, checkOut, headcount } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }
  // CT-4 (#2870): the club's day, from the persisted ClubTimeSettings zone and
  // not the container's TZ (INV-CONFIG-002, INV-DATE-019), encoded at UTC
  // midnight so it shares a frame with the submitted date-only values.
  const today = await clubTodayDateOnlyInstant();
  if (checkIn < today) {
    return NextResponse.json(
      { error: "Cannot request a stay in the past" },
      { status: 400 }
    );
  }

  try {
    // The explicit lodgeId must name an ACTIVE lodge. Lodge ACTIVITY is
    // configuration, not
    // occupancy — it tells the member nothing about who is staying.
    const lodgeId = await assertRequestedLodgeActive(parsed.data.lodgeId);

    // The headcount-vs-CONFIGURED-capacity bound is NOT duplicated here. It used
    // to be, and the two copies disagreed on the status code (400 here, 422 in
    // the service) — so the same rejection looked like two different failures
    // depending on which layer happened to catch it. The service owns it, throws
    // 422, and no other caller can skip it.

    // 4 + 5. The open-request cap (a 409 derived from this member's own request
    //        history, never from the calendar) and the write both live in the
    //        service, so no other caller can skip the cap.
    await createMemberWholeLodgeRequest({
      // From the session ONLY. A memberId in the body would be an
      // impersonation vector and is never read.
      memberId,
      checkIn,
      checkOut,
      headcount,
      groupDescription: parsed.data.groupDescription,
      notes: parsed.data.notes,
      lodgeId,
    });

    return NextResponse.json(WHOLE_LODGE_REQUEST_ACCEPTED, { status: 201 });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error({ err }, "Unexpected error creating member whole-lodge request");
    return NextResponse.json(
      { error: "Unable to send your whole-lodge request right now" },
      { status: 500 }
    );
  }
}
