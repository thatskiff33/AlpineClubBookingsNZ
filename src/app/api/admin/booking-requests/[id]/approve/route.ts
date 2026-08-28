import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { BookingRequestType } from "@prisma/client";
import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";
import { approveBookingRequest, BookingRequestError } from "@/lib/booking-request";
import {
  approveMemberWholeLodgeRequest,
  approveSchoolBookingRequest,
  memberWholeLodgeApprovalSchema,
  schoolChildCountsSchema,
} from "@/lib/school-booking-request";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  const requestRow = await prisma.bookingRequest.findUnique({
    where: { id },
    // #2263: a member whole-lodge request is `type: GENERAL`, so the type alone
    // cannot select the right approval. Both discriminator columns must be read
    // here or every member request would silently fall through to the non-login
    // payment-link path below.
    select: { type: true, requestedByMemberId: true, exclusivityRequested: true },
  });
  if (!requestRow) {
    return NextResponse.json({ error: "Booking request not found" }, { status: 404 });
  }

  // Optional admin override of the school group's child counts at approval time,
  // plus the optional map-to-existing-contact decision (issue #1255). The body
  // is empty for general requests and for school approvals that keep the
  // submitted numbers, so parse defensively.
  const body = (await req.json().catch(() => ({}))) as {
    childCounts?: unknown;
    ownerContactMemberId?: unknown;
    pricedHeadcount?: unknown;
    priceOverrideCents?: unknown;
    priceAsWholeLodge?: unknown;
  };

  // The map target is an existing non-login Organisation/School contact id. The
  // authoritative guard (canLogin:false, role, not archived) runs inside the
  // approval transaction; here we only normalise the shape.
  let ownerContactMemberId: string | undefined;
  if (body.ownerContactMemberId !== undefined && body.ownerContactMemberId !== null) {
    if (
      typeof body.ownerContactMemberId !== "string" ||
      body.ownerContactMemberId.trim().length === 0 ||
      body.ownerContactMemberId.length > 64
    ) {
      return NextResponse.json(
        { error: "Invalid contact selection" },
        { status: 422 }
      );
    }
    ownerContactMemberId = body.ownerContactMemberId;
  }

  try {
    // #2263: the member whole-lodge branch is tested FIRST. These rows are
    // `type: GENERAL`, so if the SCHOOL check and the GENERAL fallthrough ran in
    // their old order every member request would be approved down the non-login
    // payment-link path — minting a duplicate non-login member for someone who
    // already has an account and emailing them a tokenised payment page.
    if (requestRow.requestedByMemberId && requestRow.exclusivityRequested) {
      const parsedOverride = memberWholeLodgeApprovalSchema.safeParse({
        ...(body.pricedHeadcount !== undefined
          ? { pricedHeadcount: body.pricedHeadcount }
          : {}),
        ...(body.priceOverrideCents !== undefined
          ? { priceOverrideCents: body.priceOverrideCents }
          : {}),
        // #2338: the officer's per-approval "price as whole lodge" toggle.
        ...(body.priceAsWholeLodge !== undefined
          ? { priceAsWholeLodge: body.priceAsWholeLodge }
          : {}),
      });
      if (!parsedOverride.success) {
        return NextResponse.json(
          { error: "Invalid headcount or price override" },
          { status: 422 }
        );
      }

      const result = await approveMemberWholeLodgeRequest({
        requestId: id,
        adminMemberId: session.user.id,
        override: parsedOverride.data,
      });

      if (result.type === "capacityExceeded") {
        return NextResponse.json(
          {
            error:
              "The lodge is at capacity for one or more of the requested nights",
            fullNights: result.fullNights,
          },
          { status: 409 }
        );
      }

      return NextResponse.json({
        success: true,
        type: "MEMBER_WHOLE_LODGE",
        bookingId: result.bookingId,
        memberId: result.memberId,
        priceCents: result.priceCents,
        guestCount: result.guestCount,
        // Whether the receivable went to Xero or to admins to invoice by hand,
        // so the officer's toast can say which (school parity). Null on an
        // idempotent replay — this call raised nothing.
        invoiceMode: result.invoiceMode,
        // ADMIN-ONLY (ADR-001 decision 6): overlapping capacity-holding bookings
        // the officer must resolve by hand. This reaches the admin caller and
        // nothing else — no member surface reads this response.
        exclusiveHoldConflicts: result.exclusiveHoldConflicts,
      });
    }

    if (requestRow.type === BookingRequestType.SCHOOL) {
      let guestOverride: { childCounts: ReturnType<typeof schoolChildCountsSchema.parse> } | undefined;
      if (body.childCounts !== undefined) {
        const parsedCounts = schoolChildCountsSchema.safeParse(body.childCounts);
        if (!parsedCounts.success) {
          return NextResponse.json(
            { error: "Invalid child counts" },
            { status: 422 }
          );
        }
        guestOverride = { childCounts: parsedCounts.data };
      }

      const result = await approveSchoolBookingRequest({
        requestId: id,
        adminMemberId: session.user.id,
        guestOverride,
        ownerContactMemberId,
      });

      if (result.type === "capacityExceeded") {
        return NextResponse.json(
          {
            error: "The lodge is at capacity for one or more of the requested nights",
            fullNights: result.fullNights,
          },
          { status: 409 }
        );
      }

      return NextResponse.json({
        success: true,
        type: "SCHOOL",
        bookingId: result.bookingId,
        memberId: result.schoolMemberId,
        priceCents: result.priceCents,
        invoiceMode: result.invoiceMode,
        teacherCount: result.teacherCount,
        // Overlapping capacity-holding bookings when an exclusive whole-lodge
        // hold was set at approval (issue #119); the officer resolves them
        // manually (decision 1). Empty when no hold was set or nights are clear.
        exclusiveHoldConflicts: result.exclusiveHoldConflicts,
      });
    }

    const result = await approveBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      ownerContactMemberId,
    });

    if (result.type === "capacityExceeded") {
      return NextResponse.json(
        {
          error: "The lodge is at capacity for one or more of the requested nights",
          fullNights: result.fullNights,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      type: "GENERAL",
      bookingId: result.bookingId,
      memberId: result.memberId,
      priceCents: result.priceCents,
      paymentLinkExpiresAt: result.paymentLinkExpiresAt.toISOString(),
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #2569 — the ENFORCED hosting refusal, answered honestly to the OFFICER
    // rather than rethrown. Without this branch the rethrow became a bare 500
    // with no message, which reads as an outage rather than as the club's own
    // rule: a public request is an all-non-member party owned by a non-login
    // contact, so at a lodge set to stop uncovered bookings there is nobody on it
    // who can host and the approval genuinely cannot proceed.
    //
    // No `exceptionRequestPath` here, unlike the six member-facing paths. The
    // exception door is a member-authenticated workflow and this caller IS the
    // authority it leads to; pointing an officer at it would be wrong advice.
    // Their remedies are to put a qualifying adult member in the party, move the
    // request to another lodge, or change the lodge's setting. The frozen
    // sentence already states how many nights and guest-nights are uncovered, and
    // the request itself is untouched — the throw rolled the approval back.
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    throw err;
  }
}
