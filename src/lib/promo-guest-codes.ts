import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { createStructuredAuditLog, getAuditRequestContext } from "@/lib/audit";
import { formatPromoBenefit } from "@/lib/admin-member-detail-helpers";
import { getClubFormat } from "@/lib/club-format-settings";
import { getAssignedPromoCodeSummariesForMember, promoLodgeRestrictionRefusal } from "@/lib/promo";
import { resolveMemberFamily } from "@/lib/resolve-member-family";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";

/**
 * Guest-code chips (#3492, epic #3813 C4): which of a booking's guest members'
 * assigned promo codes the booker may be OFFERED, as chips they opt into.
 *
 * WHO COUNTS AS A GUEST WHOSE CODES MAY BE SHOWN — the owner's privacy decision
 * (D-3492-3): a family guest, or a cross-family guest who has ALREADY ACCEPTED
 * the guest link. Pending or declined guests never. Two doors, one rule:
 *
 * - a booking that exists: its guests are read here, server-side, through
 *   `OPERATIONALLY_PRESENT_GUEST_WHERE` (consent null = family/no consent
 *   needed, or CONFIRMED) — never from the request;
 * - a party that does not exist yet: the ids the client supplied, intersected
 *   with the booker's family (`resolveMemberFamily`). A cross-family guest
 *   cannot have accepted a link to a booking that does not exist, so they are
 *   never offered before it does.
 *
 * WHAT IS RETURNED: per guest REFERENCE — an index into the supplied ids, or the
 * booking-guest row id — never a member id, and per code only the code and a
 * one-line benefit summary. A guest with no offerable code is OMITTED, which is
 * also what an unlinked, non-family or unknown member id looks like: there is no
 * answer that tells a caller whether an id is a member, in the family, or simply
 * holds no codes (the no-probe rule of #3770 / INV-GUEST-020).
 */

/** One code a guest's chip offers: the code and what it gives, nothing else. */
export type GuestPromoCodeChip = { code: string; benefit: string };

/** One guest's offerable codes, keyed by a reference that is never a member id. */
export type GuestPromoCodeGroup = { guestRef: string; codes: GuestPromoCodeChip[] };

/** A guest to look up: the reference the caller is answered with, and the member. */
type GuestCandidate = { guestRef: string; memberId: string };

export const GUEST_PROMO_CODE_LOOKUP_AUDIT_ACTION = "promo_code.guest_lookup";

/**
 * The booking's guests whose codes may be offered: staying guests only
 * (family, or a cross-family guest who accepted), excluding the booker, each
 * referenced by its booking-guest row id.
 */
export async function presentGuestCandidatesForBooking(
  db: Pick<Prisma.TransactionClient, "bookingGuest">,
  booking: { id: string; ownerMemberId: string | null },
): Promise<{ examined: number; candidates: GuestCandidate[] }> {
  const rows = await db.bookingGuest.findMany({
    where: {
      bookingId: booking.id,
      memberId: { not: null },
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
    },
    select: { id: true, memberId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const candidates = rows.flatMap((row) =>
    row.memberId && row.memberId !== booking.ownerMemberId
      ? [{ guestRef: row.id, memberId: row.memberId }]
      : [],
  );
  return { examined: candidates.length, candidates };
}

/**
 * A party before the booking exists: the supplied ids that are in the booker's
 * family, referenced by their position in the supplied list. The booker is never
 * their own guest here.
 */
export async function familyGuestCandidatesForParty(params: {
  bookerMemberId: string;
  guestMemberIds: readonly string[];
}): Promise<{ examined: number; candidates: GuestCandidate[] }> {
  const supplied = params.guestMemberIds.map((id) => id.trim());
  const examined = supplied.filter((id) => id && id !== params.bookerMemberId).length;
  if (examined === 0) return { examined, candidates: [] };
  const family = await resolveMemberFamily(params.bookerMemberId);
  const familyIds = new Set(
    (family?.familyMembers ?? [])
      .map((member) => member.id)
      .filter((id) => id !== params.bookerMemberId),
  );
  const seen = new Set<string>();
  const candidates: GuestCandidate[] = [];
  supplied.forEach((memberId, index) => {
    if (!familyIds.has(memberId) || seen.has(memberId)) return;
    seen.add(memberId);
    candidates.push({ guestRef: String(index), memberId });
  });
  return { examined, candidates };
}

/**
 * Each candidate's assigned, member-visible, non-internal codes that are
 * redeemable at this lodge, as chips. `getAssignedPromoCodeSummariesForMember`
 * already excludes internal (working-bee) codes and decides visibility, so the
 * chip list is exactly what that member would see as their own chips.
 */
export async function guestPromoCodeGroups(params: {
  candidates: readonly GuestCandidate[];
  lodgeId: string;
}): Promise<GuestPromoCodeGroup[]> {
  if (params.candidates.length === 0) return [];
  const format = await getClubFormat();
  const groups: GuestPromoCodeGroup[] = [];
  for (const candidate of params.candidates) {
    const visible = (await getAssignedPromoCodeSummariesForMember(candidate.memberId)).filter(
      (summary) => summary.visibleToMember,
    );
    if (visible.length === 0) continue;
    const lodgeRows = await prisma.promoCodeLodge.findMany({
      where: { promoCodeId: { in: visible.map((summary) => summary.id) } },
      select: { promoCodeId: true, lodgeId: true },
    });
    const codes = visible
      .filter(
        (summary) =>
          !promoLodgeRestrictionRefusal(
            { lodges: lodgeRows.filter((row) => row.promoCodeId === summary.id) },
            params.lodgeId,
          ),
      )
      .map((summary) => ({ code: summary.code, benefit: formatPromoBenefit(summary, format) }));
    if (codes.length > 0) groups.push({ guestRef: candidate.guestRef, codes });
  }
  return groups;
}

/**
 * The privacy audit row every lookup that names a guest writes (#3492).
 *
 * `privacy` because the domain is one member reading another member's
 * entitlements (`INV-PRIV-012`: category follows the domain, a literal at the
 * site). No subject member: one lookup can cover several guests, and naming one
 * of them would misstate it; the members whose codes were DISCLOSED are listed
 * in `metadata` for an officer, and no member-facing text is declared, so the
 * booker's own timeline shows the summary alone (`INV-PRIV-018`).
 *
 * Awaited and fail-open, like the member-guest finder's audit: a failed write is
 * logged and never turns into a failed lookup.
 */
export async function auditGuestPromoCodeLookup(params: {
  request: Request;
  actorMemberId: string;
  bookingId: string | null;
  onBehalfOfMemberId: string | null;
  examinedGuestCount: number;
  disclosedMemberIds: readonly string[];
  codeCount: number;
}): Promise<void> {
  await createStructuredAuditLog({
    action: GUEST_PROMO_CODE_LOOKUP_AUDIT_ACTION,
    actor: { memberId: params.actorMemberId },
    entity: params.bookingId ? { type: "Booking", id: params.bookingId } : undefined,
    category: "privacy",
    severity: "info",
    outcome: "success",
    summary: "A booker looked up their guests' promo codes",
    metadata: {
      examinedGuestCount: params.examinedGuestCount,
      disclosedMemberIds: [...params.disclosedMemberIds],
      codeCount: params.codeCount,
      ...(params.onBehalfOfMemberId ? { onBehalfOfMemberId: params.onBehalfOfMemberId } : {}),
    },
    request: getAuditRequestContext(params.request),
    retentionClass: "sensitive_access",
  }).catch((err) => {
    logger.error({ err }, "Failed to audit a guest promo-code lookup");
  });
}
