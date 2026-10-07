import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  MemberGuestConsentError,
  finaliseMemberGuestConsentTransition,
  respondToMemberGuestConsent,
} from "@/lib/member-guest-consent-service";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { MEMBER_GUEST_MODULE_KEY } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import { clubFormatValues } from "@/lib/club-format-server";

/**
 * Answer one member-guest consent request ("+ Add Member Guest", epic #2305,
 * MG2 #2307).
 *
 * `POST /api/bookings/[id]/guests/[guestId]/consent` with `{ action:
 * "APPROVE" | "DECLINE" }`. A MEMBER route — the target answering for
 * themselves, or a delegate the resolver accepts (owner decisions D-5/D-10) —
 * so it takes no `EXPECTED_ROUTE_AREAS` pin.
 *
 * EVERY AUTHORISATION FAILURE IS THE SAME 403 WITH THE SAME BODY, once the
 * `memberGuests` module is on — with it off the proxy's feature-route gate
 * answers 404 ahead of this handler and nothing here runs (#2435), which tells a
 * caller only that the club does not run the module. "No such booking", "no such
 * guest row", "that row is not a consent request", "already answered" and "you
 * are not the target or an accepted delegate" are indistinguishable from
 * outside, so neither id can be used as an existence oracle. That uniformity is
 * the point and must not be "improved" into helpful messages: IDOR on this
 * endpoint is the primary security concern, because the two ids it takes are
 * exactly the two an attacker would want to probe.
 *
 * EXACTLY ONE ANSWER SITS BELOW THAT LINE, and it is not an exception to the
 * rule above (#2700). A caller who has passed every check in the paragraph
 * above — so is provably the target or an accepted delegate for THIS guest row
 * on THIS booking — gets `404` with `INV-ADDPAY-034`'s shared sentence when the
 * booking has been soft-deleted, instead of a silent 403. It is safe precisely
 * because it is unreachable without first satisfying the target/delegate check:
 * a caller probing two guessed ids never reaches it and still learns nothing.
 * The guard lives in `member-guest-consent-service.ts`
 * (`INV-ADDPAY-035`), NOT here, because this handler's pre-read below proves
 * only that the guest row belongs to the booking — moving it up would hand a
 * 404-versus-403 oracle to exactly the caller the uniform 403 exists to starve.
 * Anything ABOVE the target/delegate check stays byte-identical; add nothing
 * differentiated there.
 *
 * Note what is NOT here: no delegate widening of the booking page. A delegate
 * answering through this endpoint gains no view of the booking; owner decision
 * D-11 gives full booking-page access to a pending GUEST ROW, not to a delegate.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; guestId: string }> },
) {
  const rateLimited = await applyRateLimit(
    rateLimiters.memberGuestConsentRespond,
    request,
  );
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id: bookingId, guestId } = await params;

  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
  } | null;
  const action = body?.action;
  if (action !== "APPROVE" && action !== "DECLINE") {
    return NextResponse.json(
      { error: "action must be 'APPROVE' or 'DECLINE'" },
      { status: 400 },
    );
  }

  // The module gate is a 403 in the same shape as everything else, not a
  // distinct 404 or a "feature disabled" body: a club that has the module off
  // has no consent requests, so an authenticated caller poking this endpoint on
  // such a club learns nothing either way.
  if (!(await isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The club's format (#3565), resolved once per request, before the transition.
  const format = await clubFormatValues();

  try {
    // Read the target BEFORE the transition, because a successful decline or
    // expiry DELETES the guest row: after the fact there is nothing left to read
    // the target's id from, and the audit entry needs it.
    const guest = await prisma.bookingGuest.findUnique({
      where: { id: guestId },
      select: { memberId: true, bookingId: true },
    });
    if (!guest || guest.bookingId !== bookingId || !guest.memberId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const targetMemberId = guest.memberId;

    const outcome = await respondToMemberGuestConsent({
      bookingId,
      guestId,
      actorMemberId: session.user.id,
      action,
      format,
    });

    await finaliseMemberGuestConsentTransition({
      bookingId,
      guestId,
      targetMemberId,
      outcome,
      actorMemberId: session.user.id,
      format,
    });

    if (outcome.outcome === "BLOCKED") {
      // D-14 as ticked: the ordinary self-removal blockers apply to a member who
      // never consented, so a decline is sometimes genuinely refused. The
      // service's plain-English reason goes back VERBATIM — this is the
      // unpredictable settled-payment case #2250 already handles the same way,
      // and paraphrasing it here would be the third place the same sentence has
      // to be maintained.
      return NextResponse.json(
        {
          outcome: outcome.outcome,
          consentStatus: outcome.status,
          reason: outcome.reason,
          error: outcome.message,
        },
        { status: 400 },
      );
    }

    // ALREADY_RESOLVED is reported as success on purpose. Somebody — the other
    // delegate, the target on another device, or the sweep — got there first, and
    // the caller's intent is satisfied. Reporting an error would invite a retry
    // loop against a terminal state.
    return NextResponse.json({ outcome: outcome.outcome });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof MemberGuestConsentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error(
      { err, bookingId, guestId },
      "Failed to record a member-guest consent response",
    );
    return NextResponse.json(
      { error: "Failed to record your answer" },
      { status: 400 },
    );
  }
}
