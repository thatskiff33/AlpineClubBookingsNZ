import { memberWholeLodgeChoosesPaymentMethod } from "@/lib/booking-payment-flow";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { NextRequest, NextResponse } from "next/server";
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
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { requireActiveSession } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  memberWholeLodgeRequestSchema,
  WHOLE_LODGE_REQUEST_ACCEPTED,
} from "@/lib/member-whole-lodge-request-schema";
import { loadMyWholeLodgeRequests } from "@/lib/member-whole-lodge-request-list";
import {
  MY_WHOLE_LODGE_REQUESTS_CONNECTION_SHAPE,
  WHOLE_LODGE_REQUEST_SENT_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-groups";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

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
 *
 * Both methods are also AI app actions (ALP-797): POST is
 * `request_whole_lodge` and GET is `list_my_whole_lodge_requests`, the
 * member's own requests as My bookings lists them (the one loader both read),
 * which is where an app finds the id `withdraw_whole_lodge_request` takes.
 * The request body's schema and the frozen acknowledgement live in
 * `member-whole-lodge-request-schema.ts` so the action describes them once
 * (`INV-SSOT`). Putting account credit towards the request is the member's
 * own choice on the website: a connection's request never carries it.
 */

/**
 * The signed-in member's own whole-lodge requests: the same four member-visible
 * words My bookings shows, never the pipeline status. Reads only the member's
 * own request history, so it says nothing about the calendar either.
 */
export async function GET(request: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const limited = await applyRateLimit(rateLimiters.bookingQuery, request);
  if (limited) return limited;

  const requests = await loadMyWholeLodgeRequests(guard.session.user.id);
  return connectionJson(request, { requests }, MY_WHOLE_LODGE_REQUESTS_CONNECTION_SHAPE);
}

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
  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = memberWholeLodgeRequestSchema.safeParse(body);
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
      // Recorded only when approval will leave the payment method to the
      // member (#4019); the legacy approval ignores it, so a tick sent with
      // either module off is dropped rather than stored as a promise. Approval
      // spends the credit with no further step, so an AI app may not choose
      // it for the member (ALP-797): from a connection it is always no.
      applyAccountCredit:
        parsed.data.applyAccountCredit === true &&
        !arrivesAsMcpConnection(request) &&
        memberWholeLodgeChoosesPaymentMethod(await loadEffectiveModuleFlags()),
    });

    // A connection is sent the same two fields: the body echoes nothing.
    return connectionJson(request, WHOLE_LODGE_REQUEST_ACCEPTED, WHOLE_LODGE_REQUEST_SENT_CONNECTION_SHAPE, {
      status: 201,
    });
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
