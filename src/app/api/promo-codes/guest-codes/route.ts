import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { parseJsonRequestBody } from "@/lib/api-json";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { bookingOwner } from "@/lib/booking-owner";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";
import {
  auditGuestPromoCodeLookup,
  familyGuestCandidatesForParty,
  guestPromoCodeGroups,
  presentGuestCandidatesForBooking,
} from "@/lib/promo-guest-codes";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * `POST /api/promo-codes/guest-codes` — the guest-code chips' lookup (#3492,
 * epic #3813 C4). Which of the booking's guest members' assigned promo codes the
 * booker may opt into. The rules live in `promo-guest-codes.ts`; this door owns
 * who may ask, and the throttle and audit every ask pays.
 *
 * - **Who may ask:** the booking's owner, or an officer holding the
 *   booking-management role. `forMemberId` (booking on behalf, before the
 *   booking exists) is an officer's alone, as on `validate`.
 * - **A booking the caller does not own answers exactly as a missing one** (404),
 *   so the door does not confirm that a booking id exists.
 * - **POST**, so the member ids of a party never reach a URL or an access log.
 * - Behind the `promoCodes` module like every `/api/promo-codes` route
 *   (`feature-routes.ts`); `multiPromoCodes` is reported, not enforced here —
 *   the chips honour it, and every write path refuses a second code while it is off.
 */
const guestCodesSchema = z.union([
  z.object({ bookingId: z.string().min(1).max(64) }).strict(),
  z
    .object({
      lodgeId: z.string().min(1).max(64),
      guestMemberIds: z.array(z.string().min(1).max(64)).max(50),
      forMemberId: z.string().min(1).max(64).optional(),
    })
    .strict(),
]);

const NOT_FOUND = { error: "Booking not found" } as const;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const actorMemberId = session.user.id;

  const rateLimited = await applyMemberScopedRateLimit(
    rateLimiters.promoGuestCodeLookup,
    req,
    actorMemberId,
  );
  if (rateLimited) return rateLimited;

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;
  const parsed = guestCodesSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const isAdmin = bookingManagementAuthorizationRole(session.user) === "ADMIN";

  let lookup: { examined: number; candidates: { guestRef: string; memberId: string }[] };
  let lodgeId: string;
  let bookingId: string | null = null;
  let onBehalfOfMemberId: string | null = null;

  if ("bookingId" in parsed.data) {
    const booking = await prisma.booking.findUnique({
      where: { id: parsed.data.bookingId },
      select: { id: true, memberId: true, organisationId: true, lodgeId: true },
    });
    const ownerMemberId = booking ? bookingOwner(booking).memberId ?? null : null;
    if (!booking || (!isAdmin && ownerMemberId !== actorMemberId)) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }
    bookingId = booking.id;
    lodgeId = booking.lodgeId;
    lookup = await presentGuestCandidatesForBooking(prisma, {
      id: booking.id,
      ownerMemberId,
    });
  } else {
    if (parsed.data.forMemberId && !isAdmin) {
      return NextResponse.json(
        { error: "Only admins can book on behalf of another member" },
        { status: 403 },
      );
    }
    const resolvedLodgeId = await resolveOptionalActiveLodgeId(prisma, parsed.data.lodgeId);
    if (!resolvedLodgeId) {
      return NextResponse.json({ error: "Unknown or inactive lodgeId" }, { status: 400 });
    }
    lodgeId = resolvedLodgeId;
    onBehalfOfMemberId = parsed.data.forMemberId ?? null;
    lookup = await familyGuestCandidatesForParty({
      bookerMemberId: parsed.data.forMemberId ?? actorMemberId,
      guestMemberIds: parsed.data.guestMemberIds,
    });
  }

  const guests = await guestPromoCodeGroups({ candidates: lookup.candidates, lodgeId });

  // Every lookup that reads a booking or names a guest writes its row; a party
  // with no member guest asked about nobody, and only learns the club's switch.
  if (bookingId || lookup.examined > 0) {
    const disclosed = new Set(guests.map((group) => group.guestRef));
    await auditGuestPromoCodeLookup({
      request: req,
      actorMemberId,
      bookingId,
      onBehalfOfMemberId,
      examinedGuestCount: lookup.examined,
      disclosedMemberIds: lookup.candidates
        .filter((candidate) => disclosed.has(candidate.guestRef))
        .map((candidate) => candidate.memberId),
      codeCount: guests.reduce((sum, group) => sum + group.codes.length, 0),
    });
  }

  return NextResponse.json({
    multiPromoCodes: await multiPromoCodesEnabled(prisma),
    guests,
  });
}
