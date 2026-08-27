import { NextRequest, NextResponse } from "next/server";
import { clubTime } from "@/lib/club-time/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";
import {
  approveAndExecutePolicyExceptionRequest,
  modificationExceptionRequestStore,
  newBookingExceptionRequestStore,
  parseProposalSnapshot,
  resolvePolicyExceptionRequestTerminal,
  type PolicyExceptionRequestStore,
} from "@/lib/booking-exception-execution";
import {
  buildPolicyExceptionApprovalHooks,
  resolveNewBookingExecutionParams,
  PolicyExceptionExecutionCapacityError,
} from "@/lib/booking-exception-approval";
import { parseFrozenEvidence } from "@/lib/booking-exception-requests";
import { parseDateOnly } from "@/lib/date-only";
import { sendBookingPolicyExceptionRefusedEmail } from "@/lib/email";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement";
import {
  BookingGuestValidationError,
  computeMemberGuestBoundary,
} from "@/lib/booking-guests";
import {
  buildSameOwnerCoverageOverrideRequiredBody,
  hostingCoverageOverrideSchema,
  SameOwnerCoverageOverrideRequiredError,
} from "@/lib/adult-member-hosting-same-owner";

/**
 * #2526 — the Booking Officer's DECISION endpoint for a booking-policy exception
 * request, for both request flavours.
 *
 * `GET` returns the one request in full (frozen evidence, the exact proposal an
 * approval would execute, the member's message, the request's age); `PATCH`
 * approves or refuses it.
 *
 * An approval is NOT a status flip: it hands #2525's atomic approve-and-execute
 * engine the real hooks (#2526's `booking-exception-approval.ts`) and the engine
 * claims the request AND runs the canonical booking service in ONE transaction.
 * Every non-executed outcome therefore leaves the request exactly as it was, and
 * this route reports that honestly — in particular a capacity conflict answers
 * "still pending", never "approved".
 */

const decisionSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    source: z.enum(["MODIFICATION", "NEW_BOOKING"]),
    /**
     * The `version` the officer's screen was showing. A decision made against a
     * stale screen loses the guarded CAS instead of deciding a request that
     * changed underneath it.
     */
    expectedVersion: z.coerce.number().int().min(1),
    /**
     * The MEMBER-FACING decision explanation (#2562). The member reads this on
     * their own request list, and on an approval it is interpolated into the
     * approval email — so the officer screen says so beside the field, and this
     * field name is deliberately unchanged from #2526 rather than renamed, which
     * would have silently repointed every existing decision.
     */
    adminNotes: z.string().trim().max(2000).optional(),
    /**
     * The officer's PRIVATE note (#2562). Stored on its own column and read only
     * by admin-guarded surfaces. It is never a substitute for the member-facing
     * explanation: a refusal still requires `adminNotes`, so an officer cannot
     * refuse a request with an internal note and nothing for the member.
     */
    internalNotes: z.string().trim().max(2000).optional(),
    /**
     * Explicit confirmation that the officer means to apply the reviewed
     * override. Required on approve — an approval creates or rewrites a real
     * booking, so it is never a single mis-click.
     */
    confirm: z.boolean().optional(),
    /** How a refund arising from an approved modification is settled. */
    settlementMethod: z.enum(["card", "credit"]).optional(),
    /**
     * Second-step confirmation for a modification that would strand another
     * same-owner booking. The first attempt deliberately omits it so the
     * canonical service can identify the exact affected bookings and nights.
     */
    hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
  })
  .strict();

function storeFor(source: "MODIFICATION" | "NEW_BOOKING"): PolicyExceptionRequestStore {
  return source === "NEW_BOOKING"
    ? newBookingExceptionRequestStore
    : modificationExceptionRequestStore;
}

const ACTOR_SELECT = {
  select: { id: true, firstName: true, lastName: true, email: true },
} as const;

/**
 * Read one request from whichever table holds it. Ids are cuids, so probing both
 * tables is unambiguous and spares the officer UI from having to remember which
 * flavour a deep link pointed at.
 */
async function loadRequestDetail(id: string) {
  const modification = await prisma.bookingChangeRequest.findFirst({
    where: { id, kind: "POLICY_EXCEPTION" },
    include: {
      requestedBy: ACTOR_SELECT,
      reviewedBy: { select: { id: true, firstName: true, lastName: true } },
      booking: {
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          status: true,
          finalPriceCents: true,
          lodgeId: true,
          member: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      },
    },
  });
  if (modification) return { source: "MODIFICATION" as const, row: modification };

  const newBooking = await prisma.newBookingPolicyExceptionRequest.findUnique({
    where: { id },
    include: {
      requestedBy: ACTOR_SELECT,
      reviewedBy: { select: { id: true, firstName: true, lastName: true } },
      lodge: { select: { id: true, name: true } },
    },
  });
  if (newBooking) return { source: "NEW_BOOKING" as const, row: newBooking };
  return null;
}

/**
 * Tell the member their request was refused (#2562 review).
 *
 * WHY IT IS ITS OWN FUNCTION and awaited nowhere: the refusal is already
 * committed by the time this runs, so every failure inside it is a logged
 * notification problem and never a failed decision. That is the same
 * "log, never surface" discipline the approval path's post-commit notifications
 * use, and the reason the caller marks it `void`.
 *
 * WHICH DATES. The PROPOSED nights out of the frozen snapshot, because those are
 * the nights the member asked about and the ones they will recognise. A snapshot
 * that will not parse falls back to the live booking's own envelope on the change
 * path; on the new-booking path there is nothing else to fall back to, so the
 * notice is skipped and logged rather than sent with invented dates.
 *
 * WHICH NOTE. `adminNotes` only. `internalNotes` reaches no member surface, and an
 * email is a member surface.
 */
async function notifyMemberOfRefusal(args: {
  source: "MODIFICATION" | "NEW_BOOKING";
  row: {
    id: string;
    requestedByMemberId: string;
    requestedBy: { id: string; firstName: string; email: string } | null;
    bookingId?: string | null;
    lodgeId?: string | null;
    booking?: { id: string; checkIn: Date; checkOut: Date; lodgeId: string | null } | null;
  };
  snapshot: { proposed: { checkIn: string; checkOut: string } } | null;
  adminNotes: string | undefined;
}): Promise<void> {
  try {
    const recipient = args.row.requestedBy;
    if (!recipient?.email) return;
    const proposedCheckIn = args.snapshot
      ? parseDateOnly(args.snapshot.proposed.checkIn)
      : null;
    const proposedCheckOut = args.snapshot
      ? parseDateOnly(args.snapshot.proposed.checkOut)
      : null;
    const checkIn =
      proposedCheckIn && !Number.isNaN(proposedCheckIn.getTime())
        ? proposedCheckIn
        : (args.row.booking?.checkIn ?? null);
    const checkOut =
      proposedCheckOut && !Number.isNaN(proposedCheckOut.getTime())
        ? proposedCheckOut
        : (args.row.booking?.checkOut ?? null);
    if (!checkIn || !checkOut) {
      logger.error(
        { requestId: args.row.id, source: args.source },
        "Refused a booking-policy exception request but could not resolve its nights, so the member was not emailed",
      );
      return;
    }
    await sendBookingPolicyExceptionRefusedEmail({
      // A refused CHANGE belongs to its booking, so the per-booking "No emails"
      // switch can withhold it. A refused NEW booking has no booking at all.
      bookingContext:
        args.source === "MODIFICATION" && args.row.bookingId
          ? { bookingId: args.row.bookingId }
          : "none",
      email: recipient.email,
      recipientMemberId: args.row.requestedByMemberId,
      firstName: recipient.firstName,
      checkIn,
      checkOut,
      adminNotes: args.adminNotes ?? null,
      source: args.source,
      lodgeId: args.row.booking?.lodgeId ?? args.row.lodgeId ?? null,
    });
  } catch (err) {
    logger.error(
      { err, requestId: args.row.id, source: args.source },
      "Failed to email a member about their refused booking-policy exception request",
    );
  }
}

/** One proposed guest, as the officer needs to see them before deciding. */
interface ProposedPartyGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  nights: string[];
  /** True when this guest is a MEMBER being attached to the booking. */
  isMemberGuest: boolean;
  /**
   * True when that member is OUTSIDE the requester's family group — the case the
   * member's own booking path either refuses outright or turns into a consent
   * request. Null when there is no member id to judge.
   */
  beyondFamily: boolean | null;
}

/**
 * Describe the exact party an approval would create or leave behind, including
 * whether each member guest sits outside the requester's family.
 *
 * Read-only and best-effort: a snapshot that will not parse yields an empty list
 * rather than failing the read, because the PATCH path refuses such a request
 * with its own message and the officer still needs to see the rest of the card.
 */
async function describeProposedParty(
  snapshot: ReturnType<typeof parseProposalSnapshot>,
  requestedByMemberId: string,
): Promise<ProposedPartyGuest[]> {
  if (!snapshot) return [];
  const guests = snapshot.proposed.guests;
  const memberIds = [
    ...new Set(
      guests
        .map((guest) => guest.memberId)
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ];
  const boundary =
    memberIds.length > 0
      ? await computeMemberGuestBoundary(prisma, requestedByMemberId, memberIds)
      : null;
  const beyondFamily = new Set(boundary?.beyondFamilyMemberIds ?? []);
  return guests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    nights: [...guest.nights],
    isMemberGuest: Boolean(guest.memberId),
    beyondFamily: guest.memberId ? beyondFamily.has(guest.memberId) : null,
  }));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const found = await loadRequestDetail(id);
  if (!found) {
    return NextResponse.json(
      { error: "Booking-policy exception request not found" },
      { status: 404 },
    );
  }

  const { source, row } = found;
  const snapshot = parseProposalSnapshot(row.proposalSnapshot);
  const evidence = parseFrozenEvidence(row.frozenEvidence);
  // WHO the approval would put on the booking (#2526 review). Approving executes
  // this party for real, so an officer who is only shown "Guests: 2" is being
  // asked to take responsibility for a decision they had no way to make — an
  // unrelated member attached to somebody else's stay, or a party of minors with
  // no adult, are both invisible behind a count. `beyondFamily` is resolved from
  // the LIVE family boundary, because that is what the execution will apply.
  const proposedGuests = await describeProposedParty(
    snapshot,
    row.requestedByMemberId,
  );
  return NextResponse.json({
    source,
    id: row.id,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    // The queue's "request age" is derived client-side from createdAt so it
    // stays live while the screen is open; the server sends the fact, not the
    // rendering.
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    requestedBy: row.requestedBy,
    memberMessage: row.memberMessage,
    // The member-facing explanation and the private note, side by side (#2562).
    // Both are safe HERE and only here: this endpoint is behind
    // `requireAdmin({ bookings: view })`. The member's own read
    // (`GET /api/bookings/exception-requests`) goes through the member DTO, which
    // has no slot for `internalNotes` and never selects the column.
    adminNotes: row.adminNotes,
    internalNotes: row.internalNotes,
    proposalHash: row.proposalHash,
    aggregateCapacityMode: row.aggregateCapacityMode,
    conflictCount: row.conflictCount,
    lastConflictAt: row.lastConflictAt,
    lastConflictReason: row.lastConflictReason,
    supersededByRequestId: row.supersededByRequestId,
    proposal: snapshot,
    proposedGuests,
    evidence,
    booking: source === "MODIFICATION" ? row.booking : null,
    lodge: source === "NEW_BOOKING" ? row.lodge : null,
    createdBookingId: source === "NEW_BOOKING" ? row.createdBookingId : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const {
    action,
    source,
    expectedVersion,
    adminNotes,
    internalNotes,
    confirm,
    settlementMethod,
    hostingCoverageOverride,
  } = parsed.data;
  const store = storeFor(source);
  const ipAddress = getClientIp(req);

  // Read the frozen facts BEFORE deciding: the proposal (for the new-booking
  // execution parameters, which need the module client) and the reviewed reason
  // codes (which decide whether a written reason is mandatory). Both are
  // re-read authoritatively inside the engine's transaction — this pre-read only
  // shapes the request-validation and never substitutes for the guarded read.
  const found = await loadRequestDetail(id);
  if (!found || found.source !== source) {
    return NextResponse.json(
      { error: "Booking-policy exception request not found" },
      { status: 404 },
    );
  }
  const snapshot = parseProposalSnapshot(found.row.proposalSnapshot);
  const evidence = parseFrozenEvidence(found.row.frozenEvidence);
  const reviewedReasonCodes = evidence?.reasonCodes ?? [];

  if (action === "reject") {
    // A refusal the member will read: always give them the reason. #2562 added a
    // separate internal note, and this gate deliberately still reads
    // `adminNotes` — an officer must not be able to refuse a request with private
    // commentary and nothing at all for the member.
    if (!adminNotes) {
      return NextResponse.json(
        {
          error:
            "Give the member a reason for the refusal. An internal note is not a substitute — the member never sees it.",
        },
        { status: 400 },
      );
    }
    const result = await resolvePolicyExceptionRequestTerminal({
      requestId: id,
      expectedVersion,
      to: "REJECTED",
      actorMemberId: session.user.id,
      adminNotes,
      internalNotes,
      store,
    });
    if (!result.claimed) {
      return NextResponse.json(
        {
          error:
            "This request is no longer open, or it changed while you were reviewing it. Reload the queue and try again.",
        },
        { status: 409 },
      );
    }
    logAudit({
      action: "booking-policy-exception-request.reject",
      memberId: session.user.id,
      targetId: found.source === "MODIFICATION" ? found.row.bookingId : id,
      subjectMemberId: found.row.requestedByMemberId,
      entityType:
        source === "MODIFICATION"
          ? "BookingChangeRequest"
          : "NewBookingPolicyExceptionRequest",
      entityId: id,
      category: "booking",
      outcome: "success",
      summary: "Booking-policy exception request refused",
      details: adminNotes,
      metadata: {
        source,
        requestId: id,
        reasonCodes: reviewedReasonCodes,
        releasedReservationNights: result.released,
        // WHETHER an internal note was left, never its text (#2562). The audit
        // log is read by more surfaces than the officer queue, and a private note
        // copied into it would be private in one place and not the other.
        internalNoteRecorded: Boolean(internalNotes),
      },
      ipAddress,
    });
    // #2562 review: TELL THE MEMBER. Before this the refusal branch recorded a
    // mandatory member-facing explanation and delivered it nowhere — no email, and
    // this app has no in-app notification centre — so the member's only signal was
    // a badge they had to go looking for, and their realistic next act was the
    // phone call this workflow exists to remove.
    //
    // Fire-and-forget, AFTER the claim has committed: the refusal is recorded, so a
    // mail failure must never be reported to the officer as a failed decision.
    // `adminNotes` and never `internalNotes` — the private note reaches no member
    // surface, and this is one of them.
    void notifyMemberOfRefusal({
      source: found.source,
      row: found.row,
      snapshot,
      adminNotes,
    });
    return NextResponse.json({
      id,
      status: "REJECTED",
      releasedReservationNights: result.released,
    });
  }

  // ---- approve -----------------------------------------------------------
  if (confirm !== true) {
    return NextResponse.json(
      {
        error:
          "Confirm the approval: it applies the reviewed exception and creates or changes a real booking.",
      },
      { status: 400 },
    );
  }
  if (!snapshot) {
    return NextResponse.json(
      {
        error:
          "This request's stored proposal cannot be read. Ask the member to resubmit it.",
      },
      { status: 409 },
    );
  }
  // D-R4: an adult-member hosting exception is accepted only with an explicit,
  // attributable reason — never a bare click. The same rule the on-behalf create
  // path enforces, enforced here for the officer approving somebody's request.
  if (reviewedReasonCodes.includes("ADULT_MEMBER_HOSTING_REQUIRED") && !adminNotes) {
    return NextResponse.json(
      {
        error:
          "Approving an adult-member hosting exception needs a written reason for the record. Put it in the member-facing explanation — an internal note does not satisfy this.",
      },
      { status: 400 },
    );
  }

  const { hooks, outcome } = buildPolicyExceptionApprovalHooks({
    requestId: id,
    actorMemberId: session.user.id,
    // #3123 review — the CLUB's day (`INV-CONFIG-002`), resolved HERE because
    // this is the last position on the approve-and-execute path that is outside
    // a transaction. `approveAndExecutePolicyExceptionRequest` opens one, takes
    // `pg_advisory_xact_lock(1)` and the per-lodge capacity key, and then hands
    // that transaction to `modifyBookingBatch` / `createConfirmedBooking` — so
    // neither service can read the club's persisted zone for itself without
    // taking a second pooled connection under both locks (`INV-LOCK-004`).
    // One day for the whole approval, which is also what stops a change fee and
    // a refund tier being priced on different days across club midnight.
    todayAtClub: (await clubTime()).today(),
    ipAddress,
    adminNotes,
    internalNotes,
    settlementMethod,
    hostingCoverageOverride,
    // The member's own words, carried onto any adult-supervision review this
    // approval opens — the officer never decides that rule (#2526 review), so the
    // reason on the record has to be the member's.
    memberMessage: found.row.memberMessage,
    // The hold decision reads booking periods on the module client, so it is
    // resolved here rather than inside the approval transaction.
    newBookingExecution:
      snapshot.kind === "NEW_BOOKING"
        ? await resolveNewBookingExecutionParams(snapshot)
        : undefined,
  });

  let result;
  try {
    result = await approveAndExecutePolicyExceptionRequest({
      requestId: id,
      expectedVersion,
      actorMemberId: session.user.id,
      hooks,
      store,
    });
  } catch (error) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(error);
    if (hostingRetry) return hostingRetry;
    if (error instanceof SameOwnerCoverageOverrideRequiredError) {
      // #2576 section 7 is deliberately two-step. The first execution attempt
      // rolls back and returns the authoritative dependent bookings/nights; only
      // a second submission can acknowledge those exact consequences with its
      // own private reason. `adminNotes` remains the member-facing exception
      // explanation and is never silently reused as override authority.
      return NextResponse.json(
        {
          id,
          status: "REQUESTED",
          keptPending: true,
          ...buildSameOwnerCoverageOverrideRequiredBody(error),
        },
        { status: error.status },
      );
    }
    if (error instanceof PolicyExceptionExecutionCapacityError) {
      // The canonical create refused on capacity, so the whole transaction rolled
      // back: the request is STILL REQUESTED at its original version, and saying
      // so is the truth, not a consolation. Never reported as approved.
      logAudit({
        action: "booking-policy-exception-request.kept-pending",
        memberId: session.user.id,
        targetId: id,
        subjectMemberId: found.row.requestedByMemberId,
        entityType:
          source === "MODIFICATION"
            ? "BookingChangeRequest"
            : "NewBookingPolicyExceptionRequest",
        entityId: id,
        category: "booking",
        outcome: "failure",
        summary: "Booking-policy exception approval kept pending on capacity",
        details: error.message,
        metadata: { source, requestId: id, fullNights: error.fullNights },
        ipAddress,
      });
      return NextResponse.json(
        { id, status: "REQUESTED", keptPending: true, error: error.message },
        { status: 409 },
      );
    }
    if (error instanceof BookingModificationSettlementMethodRequiredError) {
      // NOT a kept-pending answer: nothing is waiting on capacity or on anybody
      // else — the officer simply has to say where the refund goes, and the queue
      // can ask them (#2526 review). Reporting it as "still pending" made the
      // archetypal shorten-the-stay exception permanently un-approvable, because
      // the message named no action and the screen offered none.
      return NextResponse.json(
        {
          id,
          status: "REQUESTED",
          needsSettlementMethod: true,
          error:
            "This change reduces the price, so choose whether the refund goes back to the card or to account credit, then approve again.",
        },
        { status: 400 },
      );
    }
    if (error instanceof BookingGuestValidationError) {
      // A guest-authorisation refusal from the new-booking executor's pipeline
      // (#2526 review): a member id the requester may not book, an incomplete
      // member profile, a beyond-family member with the module off. The
      // transaction rolled back, so the request is untouched — and this is not a
      // capacity wait, so it is not reported as kept pending.
      return NextResponse.json(
        { id, status: "REQUESTED", error: error.message, code: error.code },
        { status: error.status },
      );
    }
    if (error instanceof ApiError) {
      // A canonical-service refusal (capacity, an edit rule). The transaction
      // rolled back with it, so the request is untouched.
      return NextResponse.json(
        { id, status: "REQUESTED", keptPending: true, error: error.message },
        { status: error.status },
      );
    }
    logger.error(
      { err: error, requestId: id, source },
      "Booking-policy exception approval failed",
    );
    return NextResponse.json(
      {
        id,
        status: "REQUESTED",
        keptPending: true,
        error: "The approval could not be completed. The request is still pending.",
      },
      { status: 500 },
    );
  }

  switch (result.outcome) {
    case "executed":
      logAudit({
        action: "booking-policy-exception-request.approve",
        memberId: session.user.id,
        targetId:
          outcome.createdBookingId ??
          (found.source === "MODIFICATION" ? found.row.bookingId : id),
        subjectMemberId: found.row.requestedByMemberId,
        entityType:
          source === "MODIFICATION"
            ? "BookingChangeRequest"
            : "NewBookingPolicyExceptionRequest",
        entityId: id,
        category: "booking",
        outcome: "success",
        summary: "Booking-policy exception request approved and executed",
        details: adminNotes ?? reviewedReasonCodes.join(", "),
        metadata: {
          source,
          requestId: id,
          reasonCodes: reviewedReasonCodes,
          createdBookingId: outcome.createdBookingId,
          // See the refusal audit above: presence, never the text (#2562).
          internalNoteRecorded: Boolean(internalNotes),
          hostingDecisionRecorded: outcome.hostingDecisionRecorded,
          followUpFailed: result.followUpFailed === true,
          proposalHash: found.row.proposalHash,
        },
        ipAddress,
      });
      return NextResponse.json({
        id,
        status: "APPROVED",
        createdBookingId: outcome.createdBookingId,
        // The approval COMMITTED; only the post-commit follow-ups (member email,
        // Xero queueing, audit events) threw. Saying "still pending" here was a
        // false keep-pending after the fact — the officer would retry, get a 409
        // blaming a third party, or create the booking again by hand (#2526
        // review). Report the truth: it is done, and something afterwards needs
        // a look.
        ...(result.followUpFailed ? { followUpFailed: true } : {}),
      });

    case "notFound":
      return NextResponse.json(
        { error: "Booking-policy exception request not found" },
        { status: 404 },
      );

    case "notAuthorized":
      // Fresh-DB reauthorization refused even though the session guard passed:
      // the officer's access changed between opening the queue and deciding.
      return NextResponse.json(
        { error: "Your account is no longer allowed to approve booking changes." },
        { status: 403 },
      );

    case "claimLost":
      return NextResponse.json(
        {
          error:
            "This request changed while you were reviewing it. Reload the queue and decide again.",
        },
        { status: 409 },
      );

    case "proposalDrift":
      return NextResponse.json(
        { id, status: "REQUESTED", error: result.message },
        { status: 409 },
      );

    case "policyDrift":
      return NextResponse.json(
        {
          id,
          status: "REQUESTED",
          error: result.message,
          changedReviewed: result.changedReviewed,
          newViolations: result.newViolations,
        },
        { status: 409 },
      );

    case "keptPendingCapacity":
      logAudit({
        action: "booking-policy-exception-request.kept-pending",
        memberId: session.user.id,
        targetId: id,
        subjectMemberId: found.row.requestedByMemberId,
        entityType:
          source === "MODIFICATION"
            ? "BookingChangeRequest"
            : "NewBookingPolicyExceptionRequest",
        entityId: id,
        category: "booking",
        outcome: "failure",
        summary: "Booking-policy exception approval kept pending on capacity",
        details: result.message,
        metadata: { source, requestId: id },
        ipAddress,
      });
      return NextResponse.json(
        { id, status: "REQUESTED", keptPending: true, error: result.message },
        { status: 409 },
      );
  }
}
