import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  sendPartnerLinkRequestEmail,
  sendPartnerLinkConfirmedEmail,
  sendPartnerLinkRemovedEmail,
  sendAdminPartnerShareSweptAlert,
} from "@/lib/email";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";

// Declared Partner/Husband/Wife relationship between two ADULT members
// (#1742). The row is a canonical ordered pair (memberAId < memberBId; DB
// CHECK) with a PENDING -> CONFIRMED consent lifecycle. Declined, withdrawn,
// and dissolved links are hard-deleted (history lives in the audit log) so
// the same pair can re-form later. The one-CONFIRMED-partner-per-member
// invariant is enforced here under pg_advisory_xact_lock on both member ids
// (taken in sorted order to avoid deadlocks) and backstopped by the two raw
// partial unique indexes MemberPartnerLink_memberA/B_confirmed_unique.

type TransactionClient = Prisma.TransactionClient;

// Pure pair-ordering + status vocabulary live in the leaf module so modules
// outside this service graph (double-bed-sharing.ts) can import them without
// dragging in "server-only"/email/audit (#1744); re-exported here so existing
// importers keep working.
export {
  PARTNER_LINK_PENDING,
  PARTNER_LINK_CONFIRMED,
  canonicalPartnerPair,
} from "@/lib/member-partner-link-shared";
import {
  PARTNER_LINK_PENDING,
  PARTNER_LINK_CONFIRMED,
  canonicalPartnerPair,
} from "@/lib/member-partner-link-shared";

const PARTNER_MEMBER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  active: true,
  canLogin: true,
  ageTier: true,
  // #2284 (S4): the `detailsConfirmedByMemberId` voucher the one-step partner
  // declaration is now gated on, replacing the free-text FamilyGroupMember.role.
  // This pointer is SELF-ASSIGNABLE by any adult login co-member sharing the
  // family group (PUT .../family/[memberId]/details stamps it to the requester),
  // so the one-step power is not a single designated adult's — it is open to
  // every adult login co-member, matching #2284's "all adults in a family group
  // are equal" boundary. The gate is real (voucher + shared group); it is only
  // the *framing* of a lone "responsible adult" that would be false.
  detailsConfirmedByMemberId: true,
} as const;

type PartnerMemberRecord = Prisma.MemberGetPayload<{
  select: typeof PARTNER_MEMBER_SELECT;
}>;

export interface PartnerLinkMemberView {
  id: string;
  firstName: string;
  lastName: string;
  canLogin: boolean;
}

export interface PartnerLinkView {
  id: string;
  status: string;
  partner: PartnerLinkMemberView;
  initiatedByMe: boolean;
  assignedByAdmin: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface PartnerLinkState {
  confirmed: PartnerLinkView | null;
  pendingIncoming: PartnerLinkView[];
  pendingOutgoing: PartnerLinkView[];
}

export type PartnerLinkActionResult =
  | { ok: true; linkId: string | null; status: string; message: string; suppressed?: true }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string };

function memberName(member: { firstName: string; lastName: string }) {
  return `${member.firstName} ${member.lastName}`.trim();
}

/**
 * The one reply every by-email partner request gets, whether or not a request
 * was actually created (D9, owner decision 2026-07-11): naming the target or
 * reporting that they already have a confirmed partner would let any
 * logged-in member probe another member's relationship state from an email
 * address. Unknown-email (404) and not-adult (422) feedback stays
 * distinguishable per the same decision.
 */
export const PARTNER_REQUEST_SENT_GENERIC_MESSAGE =
  "If they're eligible, we've sent them a partner request. They can confirm or decline from their profile.";

/**
 * Email both sides of a link about a confirmation/removal, once per distinct
 * address (partners in one-login families often share an email; the single
 * copy that lands there names the other partner).
 */
function notifyBothPartners(
  send: (email: string, partnerName: string) => Promise<void>,
  memberOne: { email: string; firstName: string; lastName: string },
  memberTwo: { email: string; firstName: string; lastName: string },
  linkId: string,
  failureMessage: string
) {
  const emailOne = memberOne.email.toLowerCase();
  const emailTwo = memberTwo.email.toLowerCase();
  send(emailOne, memberName(memberTwo)).catch((err) => {
    logger.error({ err, linkId }, failureMessage);
  });
  if (emailTwo !== emailOne) {
    send(emailTwo, memberName(memberOne)).catch((err) => {
      logger.error({ err, linkId }, failureMessage);
    });
  }
}

/**
 * Post-commit admin alert for a dissolve that swept future shared-double
 * placements (#1756). Fire-and-forget like the partner emails around it: the
 * sweep itself committed with the link delete, so a failed alert only loses
 * the nudge (the audit rows on both bookings and the board's
 * awaiting-allocation queue still tell the story).
 */
function notifyAdminsOfDissolveSweep(
  swept: SweptPartnerSharedAllocation[],
  names: { memberName: string; partnerName: string },
  linkId: string,
) {
  if (swept.length === 0) return;
  sendAdminPartnerShareSweptAlert({
    memberName: names.memberName,
    partnerName: names.partnerName,
    reason: describePartnerSharedSweepReason("partner_link_dissolved"),
    nights: partnerShareSweepNights(swept),
  }).catch((err) => {
    logger.error(
      { err, linkId, sweptCount: swept.length },
      "Failed to send partner share sweep alert"
    );
  });
}

/**
 * Serialise all partner-link writes touching these members. Locks are taken
 * in sorted id order so two transactions locking the same pair cannot
 * deadlock; pg_advisory_xact_lock releases automatically at commit/rollback.
 */
async function lockPartnerMembers(tx: TransactionClient, memberIds: string[]) {
  await acquireMemberPartnerLinkLocks(tx, memberIds);
}

async function memberHasConfirmedPartner(
  tx: TransactionClient,
  memberId: string,
  excludeLinkId?: string
) {
  const existing = await tx.memberPartnerLink.findFirst({
    where: {
      status: PARTNER_LINK_CONFIRMED,
      ...(excludeLinkId ? { id: { not: excludeLinkId } } : {}),
      OR: [{ memberAId: memberId }, { memberBId: memberId }],
    },
    select: { id: true },
  });
  return Boolean(existing);
}

/**
 * The same invariant over a whole pair in one query: which of these members
 * already hold a CONFIRMED link (optionally ignoring one link id). Used where
 * both sides are checked together; requestPartnerLink keeps two separate
 * single-member checks because D9 requires the target's check to run after
 * every requester-side conflict.
 */
async function membersWithConfirmedPartner(
  tx: TransactionClient,
  memberIds: string[],
  excludeLinkId?: string
): Promise<Set<string>> {
  const links = await tx.memberPartnerLink.findMany({
    where: {
      status: PARTNER_LINK_CONFIRMED,
      ...(excludeLinkId ? { id: { not: excludeLinkId } } : {}),
      OR: [
        { memberAId: { in: memberIds } },
        { memberBId: { in: memberIds } },
      ],
    },
    select: { memberAId: true, memberBId: true },
  });
  const candidates = new Set(memberIds);
  const partnered = new Set<string>();
  for (const link of links) {
    if (candidates.has(link.memberAId)) partnered.add(link.memberAId);
    if (candidates.has(link.memberBId)) partnered.add(link.memberBId);
  }
  return partnered;
}

/**
 * Once a link is CONFIRMED, any other PENDING request involving either
 * member is moot (confirming it would trip the one-confirmed-partner
 * invariant), so prune them inside the same transaction. Pruned requesters
 * are not emailed; the deletions are audited via the caller's summary.
 */
async function pruneOtherPendingLinks(
  tx: TransactionClient,
  memberIds: string[],
  keepLinkId: string
) {
  const pruned = await tx.memberPartnerLink.deleteMany({
    where: {
      id: { not: keepLinkId },
      status: PARTNER_LINK_PENDING,
      OR: memberIds.flatMap((memberId) => [
        { memberAId: memberId },
        { memberBId: memberId },
      ]),
    },
  });
  return pruned.count;
}

function toPartnerLinkView(
  link: {
    id: string;
    status: string;
    memberAId: string;
    initiatedByMemberId: string | null;
    assignedByAdminId: string | null;
    confirmedAt: Date | null;
    createdAt: Date;
    memberA: PartnerLinkMemberView & { email?: string };
    memberB: PartnerLinkMemberView & { email?: string };
  },
  viewerMemberId: string
): PartnerLinkView {
  const partner = link.memberAId === viewerMemberId ? link.memberB : link.memberA;
  return {
    id: link.id,
    status: link.status,
    partner: {
      id: partner.id,
      firstName: partner.firstName,
      lastName: partner.lastName,
      canLogin: partner.canLogin,
    },
    initiatedByMe: link.initiatedByMemberId === viewerMemberId,
    assignedByAdmin: Boolean(link.assignedByAdminId),
    confirmedAt: link.confirmedAt,
    createdAt: link.createdAt,
  };
}

const PARTNER_LINK_INCLUDE = {
  memberA: { select: PARTNER_MEMBER_SELECT },
  memberB: { select: PARTNER_MEMBER_SELECT },
} as const;

/**
 * Partner-link state for one member: their CONFIRMED link (at most one) plus
 * PENDING requests they sent and received. Used by the member profile surface
 * and the admin member-detail card.
 */
export async function getPartnerLinkState(memberId: string): Promise<PartnerLinkState> {
  const links = await prisma.memberPartnerLink.findMany({
    where: { OR: [{ memberAId: memberId }, { memberBId: memberId }] },
    include: PARTNER_LINK_INCLUDE,
    orderBy: { createdAt: "desc" },
  });

  const views = links.map((link) => toPartnerLinkView(link, memberId));
  return {
    confirmed: views.find((view) => view.status === PARTNER_LINK_CONFIRMED) ?? null,
    pendingIncoming: views.filter(
      (view) => view.status === PARTNER_LINK_PENDING && !view.initiatedByMe
    ),
    pendingOutgoing: views.filter(
      (view) => view.status === PARTNER_LINK_PENDING && view.initiatedByMe
    ),
  };
}

/**
 * One-step declaration candidates for a member: active no-login ADULT
 * co-members this member is the RECORDED VOUCHER for
 * (`detailsConfirmedByMemberId`), minus anyone who already has a CONFIRMED
 * partner. Computed server-side so the profile UI renders policy instead of
 * re-implementing it.
 *
 * #2284 (S4): re-anchored off the free-text `FamilyGroupMember.role` ADMIN
 * value — which was an accident of which flow created the group — onto the
 * `detailsConfirmedByMemberId` voucher pointer, the same condition
 * `requestPartnerLink`'s one-step path now enforces. Because that pointer is
 * self-assignable by any adult login co-member sharing the group (the
 * delegated-details route stamps it to whoever confirms the member's details),
 * this candidate list is not one designated adult's privilege — any adult login
 * co-member can become the voucher and see the same candidates, consistent with
 * #2284's "all adults are equal" boundary. The shared-family-group conjunct is
 * retained so a stale voucher pointer left behind after a member leaves the
 * group grants nothing.
 */
export async function listOneStepPartnerCandidates(
  memberId: string
): Promise<PartnerLinkMemberView[]> {
  const groupLinks = await prisma.familyGroupMember.findMany({
    where: { memberId },
    select: { familyGroupId: true },
  });
  const groupIds = [...new Set(groupLinks.map((link) => link.familyGroupId))];
  if (groupIds.length === 0) {
    return [];
  }

  const voucheredMembers = await prisma.member.findMany({
    where: {
      canLogin: false,
      active: true,
      ageTier: "ADULT",
      detailsConfirmedByMemberId: memberId,
      id: { not: memberId },
      familyGroupMemberships: { some: { familyGroupId: { in: groupIds } } },
    },
    select: PARTNER_MEMBER_SELECT,
  });

  const candidates = new Map<string, PartnerLinkMemberView>();
  for (const member of voucheredMembers) {
    candidates.set(member.id, {
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      canLogin: member.canLogin,
    });
  }
  if (candidates.size === 0) {
    return [];
  }

  const candidateIds = [...candidates.keys()];
  const confirmedLinks = await prisma.memberPartnerLink.findMany({
    where: {
      status: PARTNER_LINK_CONFIRMED,
      OR: [
        { memberAId: { in: candidateIds } },
        { memberBId: { in: candidateIds } },
      ],
    },
    select: { memberAId: true, memberBId: true },
  });
  for (const link of confirmedLinks) {
    candidates.delete(link.memberAId);
    candidates.delete(link.memberBId);
  }

  return [...candidates.values()];
}

export interface PendingPartnerInviteIntent {
  id: string;
  invitedEmail: string;
  expiresAt: Date;
}

/**
 * An outstanding partner-invite token this member minted with
 * createPartnerLink (#1682/#1742): the partnership will form when the
 * invitee claims. Surfaced on the profile so the token-borne intent is
 * visible to the inviter, who can cancel it before it is claimed (#1754);
 * admins can also revoke the token.
 */
export async function getPendingPartnerInviteIntent(
  memberId: string,
  now = new Date()
): Promise<PendingPartnerInviteIntent | null> {
  const token = await prisma.partnerInviteToken.findFirst({
    where: {
      createdById: memberId,
      createPartnerLink: true,
      confirmedAt: null,
      expiresAt: { gte: now },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, invitedEmail: true, expiresAt: true },
  });
  return token;
}

function checkPartnerEligibility(
  member: PartnerMemberRecord,
  role: "initiator" | "target"
): { status: 422; error: string } | null {
  if (!member.active) {
    return { status: 422, error: "Member is not active." };
  }
  if (member.ageTier !== "ADULT") {
    return {
      status: 422,
      error:
        role === "initiator"
          ? "Only adult members can declare a partner."
          : "Only adult members can be declared as a partner.",
    };
  }
  return null;
}

/**
 * Member-initiated partner request. Two entry shapes:
 * - targetEmail: another registered login adult; creates a PENDING link the
 *   target confirms or declines from their profile (mirrors the family
 *   ADULT_INVITE consent flow).
 * - targetMemberId: a member of the initiator's own family group. If the
 *   target has a login this still creates a PENDING link (they must consent
 *   themselves). If the target has NO login, the initiator must be the adult
 *   currently recorded as the target's details voucher
 *   (`detailsConfirmedByMemberId`) AND still share a family group with them —
 *   the "one login manages the family" case — and the link is created CONFIRMED
 *   in one step. That voucher pointer is self-assignable by any adult login
 *   co-member (see the delegated-details route), so this one-step path is open
 *   to EVERY adult login co-member, not a designated group admin: #2284 (S4)
 *   retired the old `FamilyGroupMember.role` ADMIN gate in favour of the equal
 *   "all adults in a family group" boundary, and #2520 dropped that column
 *   outright (20260803030000), so there is no rank left to re-anchor onto.
 */
export async function requestPartnerLink(params: {
  initiatorMemberId: string;
  targetEmail?: string;
  targetMemberId?: string;
}): Promise<PartnerLinkActionResult> {
  const initiator = await prisma.member.findUnique({
    where: { id: params.initiatorMemberId },
    select: PARTNER_MEMBER_SELECT,
  });
  if (!initiator || !initiator.active) {
    return { ok: false, status: 404, error: "Member not found" };
  }
  if (!initiator.canLogin) {
    return {
      ok: false,
      status: 403,
      error: "Only members with login accounts can declare a partner.",
    };
  }
  const initiatorIneligible = checkPartnerEligibility(initiator, "initiator");
  if (initiatorIneligible) return { ok: false, ...initiatorIneligible };

  let target: PartnerMemberRecord | null = null;
  if (params.targetMemberId) {
    target = await prisma.member.findUnique({
      where: { id: params.targetMemberId },
      select: PARTNER_MEMBER_SELECT,
    });
  } else if (params.targetEmail) {
    const normalizedEmail = params.targetEmail.toLowerCase().trim();
    target = await prisma.member.findFirst({
      where: { email: normalizedEmail, canLogin: true, active: true },
      select: PARTNER_MEMBER_SELECT,
    });
  }

  if (!target) {
    return {
      ok: false,
      status: 404,
      error:
        "This person is not a registered member with a login. For a partner who is not a member yet, use the family group invitation flow; otherwise contact an admin.",
    };
  }
  if (target.id === initiator.id) {
    return { ok: false, status: 422, error: "You cannot partner yourself." };
  }
  const targetIneligible = checkPartnerEligibility(target, "target");
  if (targetIneligible) return { ok: false, ...targetIneligible };

  // One-step "one login manages the family": only when the target has no
  // login of their own to consent with AND the initiator is the adult currently
  // recorded as having vouched for the target's details
  // (`detailsConfirmedByMemberId`) AND still shares a family group with them. A
  // login-holding target always consents personally.
  //
  // #2284 (S4): re-anchored off the free-text `FamilyGroupMember.role` ADMIN
  // value, which was distributed by accident of which flow created the group,
  // onto `detailsConfirmedByMemberId`. Note this is NOT a lone designated
  // "responsible adult": that pointer is self-assignable by ANY adult login
  // co-member sharing the group (the delegated-details route stamps it to
  // whoever confirms the member's details), so every adult login co-member can
  // reach this gate — the equal "all adults in a family group" boundary #2284
  // recorded, not a role privilege. `initiator.id !== target.id` is already
  // enforced above, so a self-confirmed target
  // (`detailsConfirmedByMemberId === target.id`) can never satisfy this gate.
  let oneStep = false;
  if (!target.canLogin) {
    const isRecordedVoucher =
      target.detailsConfirmedByMemberId === initiator.id;
    const sharedGroup = isRecordedVoucher
      ? await prisma.familyGroupMember.findFirst({
          where: {
            memberId: initiator.id,
            familyGroup: { memberships: { some: { memberId: target.id } } },
          },
          select: { familyGroupId: true },
        })
      : null;
    if (!isRecordedVoucher || !sharedGroup) {
      return {
        ok: false,
        status: 403,
        error:
          "This member has no login to confirm the request. Only the adult who confirmed this member's details can declare this partnership directly; otherwise ask an admin.",
      };
    }
    oneStep = true;
  }

  const pair = canonicalPartnerPair(initiator.id, target.id);
  const now = new Date();

  type RequestOutcome =
    | { outcome: "ok"; linkId: string; prunedCount: number }
    | { outcome: "confirmed_exists"; mine: boolean }
    | { outcome: "pair_exists"; theirs: boolean }
    | { outcome: "outgoing_exists" };

  const result = await prisma.$transaction(async (tx): Promise<RequestOutcome> => {
    await lockPartnerMembers(tx, [initiator.id, target.id]);

    if (await memberHasConfirmedPartner(tx, initiator.id)) {
      return { outcome: "confirmed_exists", mine: true };
    }

    const existingPair = await tx.memberPartnerLink.findUnique({
      where: { memberAId_memberBId: pair },
      select: { id: true, initiatedByMemberId: true },
    });
    if (existingPair) {
      return {
        outcome: "pair_exists",
        theirs: existingPair.initiatedByMemberId === target.id,
      };
    }

    // One outstanding outgoing request at a time keeps the intent
    // unambiguous — a partner declaration is exclusive by nature.
    const outstandingOutgoing = await tx.memberPartnerLink.findFirst({
      where: { status: PARTNER_LINK_PENDING, initiatedByMemberId: initiator.id },
      select: { id: true },
    });
    if (outstandingOutgoing) {
      return { outcome: "outgoing_exists" };
    }

    // The target's confirmed-partner state is checked only after every
    // requester-side conflict has answered: were it checked earlier, a
    // requester with, say, an outstanding outgoing request would get the
    // suppressed "request sent" reply for a partnered target but a 422 for a
    // free one, re-opening exactly the probe D9 closes.
    if (await memberHasConfirmedPartner(tx, target.id)) {
      return { outcome: "confirmed_exists", mine: false };
    }

    const link = await tx.memberPartnerLink.create({
      data: {
        ...pair,
        status: oneStep ? PARTNER_LINK_CONFIRMED : PARTNER_LINK_PENDING,
        initiatedByMemberId: initiator.id,
        confirmedAt: oneStep ? now : null,
      },
    });

    const prunedCount = oneStep
      ? await pruneOtherPendingLinks(tx, [initiator.id, target.id], link.id)
      : 0;

    return { outcome: "ok", linkId: link.id, prunedCount };
  });

  if (result.outcome === "confirmed_exists") {
    if (!result.mine && params.targetEmail) {
      // D9: a by-email requester must not learn that the target already has
      // a confirmed partner. Nothing is created and nobody is emailed, but
      // the reply is the same one a real request gets; the attempt is
      // audited so support can explain the missing pending row.
      logAudit({
        action: "MEMBER_PARTNER_LINK_REQUEST_SUPPRESSED",
        memberId: initiator.id,
        targetId: target.id,
        subjectMemberId: target.id,
        entityType: "MemberPartnerLink",
        category: "family",
        outcome: "blocked",
        summary: "Partner link request suppressed: target already has a confirmed partner",
        metadata: {
          initiatorMemberId: initiator.id,
          targetMemberId: target.id,
        },
      });
      logger.info(
        { initiatorId: initiator.id, targetId: target.id },
        "Partner link request suppressed: target already has a confirmed partner"
      );
      return {
        ok: true,
        linkId: null,
        status: PARTNER_LINK_PENDING,
        suppressed: true,
        message: PARTNER_REQUEST_SENT_GENERIC_MESSAGE,
      };
    }
    return {
      ok: false,
      status: 409,
      error: result.mine
        ? "You already have a confirmed partner. Remove that partnership first."
        : "This member already has a confirmed partner.",
    };
  }
  if (result.outcome === "pair_exists") {
    return {
      ok: false,
      status: 409,
      error: result.theirs
        ? "This member has already asked to record you as their partner. Respond to their request from your profile instead."
        : "A partner request between you and this member is already pending.",
    };
  }
  if (result.outcome === "outgoing_exists") {
    return {
      ok: false,
      status: 422,
      error:
        "You already have a pending partner request. Withdraw it before sending another.",
    };
  }

  logAudit({
    action: oneStep ? "MEMBER_PARTNER_LINK_CONFIRMED" : "MEMBER_PARTNER_LINK_REQUESTED",
    memberId: initiator.id,
    targetId: target.id,
    subjectMemberId: target.id,
    entityType: "MemberPartnerLink",
    entityId: result.linkId,
    category: "family",
    outcome: "success",
    summary: oneStep
      ? "Partner link declared one-step by the recorded details voucher"
      : "Partner link requested",
    details: JSON.stringify({
      initiatorMemberId: initiator.id,
      targetMemberId: target.id,
      oneStep,
      prunedPendingCount: result.prunedCount,
    }),
    metadata: {
      initiatorMemberId: initiator.id,
      targetMemberId: target.id,
      oneStep,
    },
  });

  logger.info(
    { linkId: result.linkId, initiatorId: initiator.id, targetId: target.id, oneStep },
    oneStep ? "Partner link declared one-step" : "Partner link requested"
  );

  if (!oneStep) {
    sendPartnerLinkRequestEmail(
      target.email.toLowerCase(),
      memberName(initiator)
    ).catch((err) => {
      logger.error({ err, linkId: result.linkId }, "Failed to send partner link request email");
    });
  } else {
    // One-step forms the link without the target's own consent, so tell them
    // (their address is often the shared family one, which still leaves a
    // visible record in that mailbox).
    sendPartnerLinkConfirmedEmail(
      target.email.toLowerCase(),
      memberName(initiator)
    ).catch((err) => {
      logger.error({ err, linkId: result.linkId }, "Failed to send partner link confirmed email");
    });
  }

  return {
    ok: true,
    linkId: result.linkId,
    status: oneStep ? PARTNER_LINK_CONFIRMED : PARTNER_LINK_PENDING,
    // A by-email success carries the same generic message as a suppressed
    // one (D9) — even the target's name would confirm the email resolves to
    // an eligible member. Family memberId targets get the specific wording:
    // that path is fenced to the requester's own family group.
    message: oneStep
      ? `${memberName(target)} has been recorded as your partner.`
      : params.targetEmail
        ? PARTNER_REQUEST_SENT_GENERIC_MESSAGE
        : `Partner request sent to ${memberName(target)}. They can confirm or decline from their profile.`,
  };
}

/**
 * The requested member confirms or declines a PENDING link. Confirm flips
 * PENDING -> CONFIRMED under the advisory lock with the invariant re-checked;
 * decline hard-deletes the row (mirroring the family-invite decline, no email).
 */
export async function respondToPartnerLink(params: {
  memberId: string;
  linkId: string;
  action: "accept" | "decline";
}): Promise<PartnerLinkActionResult> {
  const link = await prisma.memberPartnerLink.findFirst({
    where: {
      id: params.linkId,
      status: PARTNER_LINK_PENDING,
      OR: [{ memberAId: params.memberId }, { memberBId: params.memberId }],
      NOT: { initiatedByMemberId: params.memberId },
    },
    include: PARTNER_LINK_INCLUDE,
  });
  if (!link) {
    return {
      ok: false,
      status: 404,
      error: "Partner request not found or already processed.",
    };
  }

  const self = link.memberAId === params.memberId ? link.memberA : link.memberB;
  const other = link.memberAId === params.memberId ? link.memberB : link.memberA;

  if (params.action === "decline") {
    const deleted = await prisma.memberPartnerLink.deleteMany({
      where: { id: link.id, status: PARTNER_LINK_PENDING },
    });
    if (deleted.count === 0) {
      return {
        ok: false,
        status: 409,
        error: "Partner request not found or already processed.",
      };
    }

    logAudit({
      action: "MEMBER_PARTNER_LINK_DECLINED",
      memberId: params.memberId,
      targetId: other.id,
      subjectMemberId: params.memberId,
      entityType: "MemberPartnerLink",
      entityId: link.id,
      category: "family",
      outcome: "success",
      summary: "Partner link request declined",
      details: JSON.stringify({ linkId: link.id, initiatorMemberId: other.id }),
      metadata: { linkId: link.id, initiatorMemberId: other.id },
    });

    return {
      ok: true,
      linkId: link.id,
      status: "DECLINED",
      message: "Partner request declined.",
    };
  }

  if (self.ageTier !== "ADULT" || !self.active) {
    return {
      ok: false,
      status: 422,
      error: "Only active adult members can confirm a partner request.",
    };
  }
  // The request may be stale: the initiator could have been deactivated or
  // re-tiered since sending it. Never confirm a link a fresh request could
  // not create (decline remains available to clear the row).
  if (other.ageTier !== "ADULT" || !other.active) {
    return {
      ok: false,
      status: 409,
      error:
        "This request is no longer valid — the member who sent it is not an active adult member. You can decline it.",
    };
  }

  const now = new Date();
  type ConfirmOutcome =
    | { outcome: "ok"; prunedCount: number }
    | { outcome: "confirmed_exists"; mine: boolean }
    | { outcome: "race_lost" };

  const result = await prisma.$transaction(async (tx): Promise<ConfirmOutcome> => {
    await lockPartnerMembers(tx, [link.memberAId, link.memberBId]);

    const partnered = await membersWithConfirmedPartner(
      tx,
      [params.memberId, other.id],
      link.id
    );
    if (partnered.size > 0) {
      // The caller's own conflict takes precedence when both sides have one.
      return { outcome: "confirmed_exists", mine: partnered.has(params.memberId) };
    }

    const updated = await tx.memberPartnerLink.updateMany({
      where: { id: link.id, status: PARTNER_LINK_PENDING },
      data: {
        status: PARTNER_LINK_CONFIRMED,
        confirmedByMemberId: params.memberId,
        confirmedAt: now,
      },
    });
    if (updated.count !== 1) {
      return { outcome: "race_lost" };
    }

    const prunedCount = await pruneOtherPendingLinks(
      tx,
      [link.memberAId, link.memberBId],
      link.id
    );
    return { outcome: "ok", prunedCount };
  });

  if (result.outcome === "confirmed_exists") {
    return {
      ok: false,
      status: 409,
      error: result.mine
        ? "You already have a confirmed partner. Remove that partnership before confirming a new one."
        : "This member already has a confirmed partner.",
    };
  }
  if (result.outcome === "race_lost") {
    return {
      ok: false,
      status: 409,
      error: "Partner request not found or already processed.",
    };
  }

  logAudit({
    action: "MEMBER_PARTNER_LINK_CONFIRMED",
    memberId: params.memberId,
    targetId: other.id,
    subjectMemberId: params.memberId,
    entityType: "MemberPartnerLink",
    entityId: link.id,
    category: "family",
    outcome: "success",
    summary: "Partner link confirmed",
    details: JSON.stringify({
      linkId: link.id,
      initiatorMemberId: other.id,
      prunedPendingCount: result.prunedCount,
    }),
    metadata: { linkId: link.id, initiatorMemberId: other.id },
  });

  logger.info(
    { linkId: link.id, memberId: params.memberId, partnerId: other.id },
    "Partner link confirmed"
  );

  sendPartnerLinkConfirmedEmail(other.email.toLowerCase(), memberName(self)).catch(
    (err) => {
      logger.error({ err, linkId: link.id }, "Failed to send partner link confirmed email");
    }
  );

  return {
    ok: true,
    linkId: link.id,
    status: PARTNER_LINK_CONFIRMED,
    message: `${memberName(other)} is now recorded as your partner.`,
  };
}

/**
 * Remove a link the acting member is part of: withdraw their own PENDING
 * request, or dissolve a CONFIRMED partnership (either partner may do this
 * unilaterally; the other partner is emailed). Hard delete + audit.
 */
export async function removeOwnPartnerLink(params: {
  memberId: string;
  linkId: string;
}): Promise<PartnerLinkActionResult> {
  const link = await prisma.memberPartnerLink.findFirst({
    where: {
      id: params.linkId,
      OR: [{ memberAId: params.memberId }, { memberBId: params.memberId }],
    },
    include: PARTNER_LINK_INCLUDE,
  });
  if (!link) {
    return { ok: false, status: 404, error: "Partner link not found." };
  }

  const wasConfirmed = link.status === PARTNER_LINK_CONFIRMED;
  // A PENDING request may only be deleted by its initiator (the requested
  // member uses decline instead, which audits the refusal explicitly).
  if (!wasConfirmed && link.initiatedByMemberId !== params.memberId) {
    return {
      ok: false,
      status: 403,
      error: "Use decline to respond to a partner request you received.",
    };
  }

  const self = link.memberAId === params.memberId ? link.memberA : link.memberB;
  const other = link.memberAId === params.memberId ? link.memberB : link.memberA;

  // Delete + stale-share sweep commit together (#1756): a dissolved CONFIRMED
  // link must not leave the pair sharing a double bed on future nights, so the
  // pair's future isSecondOccupant allocations are swept back to the
  // awaiting-allocation queue in the same transaction (audited against both
  // bookings inside the sweep; admins alerted post-commit).
    // #3123 / INV-LOCK-004 — the club's day, resolved before this transaction
    // opens and passed into both the lock prefix and the sweep. Resolving the
    // club's persisted timezone is a `clubTimeSettings.findUnique`, and inside
    // this transaction that would take a second pooled connection while the
    // global cohort key, every affected lodge key and both member keys are
    // held. One value also means the lodge set that was LOCKED and the rows the
    // sweep JUDGES are derived from the same day.
  const clubTodayForSweep = await clubTodayDateOnlyInstant();
  const { deletedCount, sweptShares } = await prisma.$transaction(async (tx) => {
    if (wasConfirmed) {
      await acquireFuturePartnerSharedAllocationLocks(
        tx,
        [link.memberAId, link.memberBId],
        clubTodayForSweep,
      );
    }
    await lockPartnerMembers(tx, [link.memberAId, link.memberBId]);
    const deleted = await tx.memberPartnerLink.deleteMany({
      where: { id: link.id, status: link.status },
    });
    if (deleted.count === 0) {
      return { deletedCount: 0, sweptShares: [] as SweptPartnerSharedAllocation[] };
    }
    const swept = wasConfirmed
      ? await sweepFuturePartnerSharedAllocationsWithLocksHeld({
          memberId: link.memberAId,
          partnerMemberId: link.memberBId,
          reason: "partner_link_dissolved",
          db: tx,
          today: clubTodayForSweep,
        })
      : [];
    return { deletedCount: deleted.count, sweptShares: swept };
  });
  if (deletedCount === 0) {
    return { ok: false, status: 409, error: "Partner link not found or already changed." };
  }

  logAudit({
    action: wasConfirmed ? "MEMBER_PARTNER_LINK_DISSOLVED" : "MEMBER_PARTNER_LINK_WITHDRAWN",
    memberId: params.memberId,
    targetId: other.id,
    subjectMemberId: params.memberId,
    entityType: "MemberPartnerLink",
    entityId: link.id,
    category: "family",
    outcome: "success",
    summary: wasConfirmed ? "Partner link dissolved" : "Partner link request withdrawn",
    details: JSON.stringify({ linkId: link.id, partnerMemberId: other.id, wasConfirmed }),
    metadata: { linkId: link.id, partnerMemberId: other.id, wasConfirmed },
  });

  logger.info(
    { linkId: link.id, memberId: params.memberId, partnerId: other.id, wasConfirmed },
    wasConfirmed ? "Partner link dissolved" : "Partner link request withdrawn"
  );

  // Always notify the other partner's address on dissolve — the UI promises
  // it, and in shared-email families the copy still leaves a visible record.
  if (wasConfirmed) {
    sendPartnerLinkRemovedEmail(other.email.toLowerCase(), memberName(self)).catch(
      (err) => {
        logger.error({ err, linkId: link.id }, "Failed to send partner link removed email");
      }
    );
  }

  notifyAdminsOfDissolveSweep(
    sweptShares,
    { memberName: memberName(self), partnerName: memberName(other) },
    link.id
  );

  return {
    ok: true,
    linkId: link.id,
    status: "REMOVED",
    message: wasConfirmed ? "Partner relationship removed." : "Partner request withdrawn.",
  };
}

/**
 * Admin directly assigns a CONFIRMED partner link (no consent round-trip;
 * assignedByAdminId records who). An existing PENDING request between the
 * same pair is promoted rather than duplicated. Both members are emailed
 * (once, if they share an address).
 */
export async function adminAssignPartnerLink(params: {
  adminMemberId: string;
  memberOneId: string;
  memberTwoId: string;
  // #1769a: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the member emails. Only recorded in the audit when a
  // notification was actually suppressed.
  notifyMember?: boolean;
}): Promise<PartnerLinkActionResult> {
  if (params.memberOneId === params.memberTwoId) {
    return { ok: false, status: 422, error: "A member cannot partner themselves." };
  }

  const [memberOne, memberTwo] = await Promise.all([
    prisma.member.findUnique({
      where: { id: params.memberOneId },
      select: PARTNER_MEMBER_SELECT,
    }),
    prisma.member.findUnique({
      where: { id: params.memberTwoId },
      select: PARTNER_MEMBER_SELECT,
    }),
  ]);
  if (!memberOne || !memberTwo) {
    return { ok: false, status: 404, error: "Member not found" };
  }
  for (const member of [memberOne, memberTwo]) {
    const ineligible = checkPartnerEligibility(member, "target");
    if (ineligible) {
      return {
        ok: false,
        status: ineligible.status,
        error: `${memberName(member)}: ${ineligible.error}`,
      };
    }
  }

  const pair = canonicalPartnerPair(memberOne.id, memberTwo.id);
  const now = new Date();

  type AssignOutcome =
    | { outcome: "ok"; linkId: string; promoted: boolean; prunedCount: number }
    | { outcome: "confirmed_exists"; member: PartnerMemberRecord }
    | { outcome: "already_partners" };

  const result = await prisma.$transaction(async (tx): Promise<AssignOutcome> => {
    await lockPartnerMembers(tx, [memberOne.id, memberTwo.id]);

    const existingPair = await tx.memberPartnerLink.findUnique({
      where: { memberAId_memberBId: pair },
      select: { id: true, status: true },
    });
    if (existingPair?.status === PARTNER_LINK_CONFIRMED) {
      return { outcome: "already_partners" };
    }

    const partnered = await membersWithConfirmedPartner(
      tx,
      [memberOne.id, memberTwo.id],
      existingPair?.id
    );
    if (partnered.size > 0) {
      return {
        outcome: "confirmed_exists",
        member: partnered.has(memberOne.id) ? memberOne : memberTwo,
      };
    }

    let linkId: string;
    if (existingPair) {
      await tx.memberPartnerLink.update({
        where: { id: existingPair.id },
        data: {
          status: PARTNER_LINK_CONFIRMED,
          assignedByAdminId: params.adminMemberId,
          confirmedAt: now,
        },
      });
      linkId = existingPair.id;
    } else {
      const link = await tx.memberPartnerLink.create({
        data: {
          ...pair,
          status: PARTNER_LINK_CONFIRMED,
          assignedByAdminId: params.adminMemberId,
          confirmedAt: now,
        },
      });
      linkId = link.id;
    }

    const prunedCount = await pruneOtherPendingLinks(
      tx,
      [memberOne.id, memberTwo.id],
      linkId
    );
    return { outcome: "ok", linkId, promoted: Boolean(existingPair), prunedCount };
  });

  if (result.outcome === "already_partners") {
    return {
      ok: false,
      status: 422,
      error: "These members are already confirmed partners.",
    };
  }
  if (result.outcome === "confirmed_exists") {
    return {
      ok: false,
      status: 409,
      error: `${memberName(result.member)} already has a confirmed partner. Remove that partnership first.`,
    };
  }

  // #1769a: only record the notify choice when a member email was actually
  // suppressed — an assign always sends unless the admin opted out.
  const notifyAuditFields = params.notifyMember === false ? { notifyMember: false } : {};

  logAudit({
    action: "MEMBER_PARTNER_LINK_ADMIN_ASSIGNED",
    memberId: params.adminMemberId,
    targetId: memberOne.id,
    subjectMemberId: memberOne.id,
    entityType: "MemberPartnerLink",
    entityId: result.linkId,
    category: "family",
    outcome: "success",
    summary: "Partner link assigned by admin",
    details: JSON.stringify({
      memberOneId: memberOne.id,
      memberTwoId: memberTwo.id,
      promotedPendingRequest: result.promoted,
      prunedPendingCount: result.prunedCount,
      ...notifyAuditFields,
    }),
    metadata: {
      memberOneId: memberOne.id,
      memberTwoId: memberTwo.id,
      promotedPendingRequest: result.promoted,
      ...notifyAuditFields,
    },
  });

  logger.info(
    {
      linkId: result.linkId,
      adminId: params.adminMemberId,
      memberOneId: memberOne.id,
      memberTwoId: memberTwo.id,
    },
    "Partner link assigned by admin"
  );

  // #1769a: assign always emails both members unless the admin chose not to
  // notify (default is notify; the suppression is audited above).
  if (params.notifyMember !== false) {
    notifyBothPartners(
      sendPartnerLinkConfirmedEmail,
      memberOne,
      memberTwo,
      result.linkId,
      "Failed to send partner link confirmed email"
    );
  }

  return {
    ok: true,
    linkId: result.linkId,
    status: PARTNER_LINK_CONFIRMED,
    message: `${memberName(memberOne)} and ${memberName(memberTwo)} are now recorded as partners.`,
  };
}

/**
 * Admin removes a link in any status. Hard delete + audit; both members are
 * emailed when a CONFIRMED partnership is removed (once, if they share an
 * address). memberScopeId restricts the lookup to links involving that
 * member — pass it from member-scoped admin routes so a foreign link id
 * cannot be deleted through them.
 */
export async function adminRemovePartnerLink(params: {
  adminMemberId: string;
  linkId: string;
  memberScopeId?: string;
  // #1769a: admin per-action email choice. Only meaningful when a CONFIRMED
  // link is removed (a PENDING removal emails no one either way); absent =
  // notify (default), false = suppress the removal emails.
  notifyMember?: boolean;
}): Promise<PartnerLinkActionResult> {
  const link = await prisma.memberPartnerLink.findFirst({
    where: {
      id: params.linkId,
      ...(params.memberScopeId
        ? {
            OR: [
              { memberAId: params.memberScopeId },
              { memberBId: params.memberScopeId },
            ],
          }
        : {}),
    },
    include: PARTNER_LINK_INCLUDE,
  });
  if (!link) {
    return { ok: false, status: 404, error: "Partner link not found." };
  }

  const wasConfirmed = link.status === PARTNER_LINK_CONFIRMED;
  // Same delete + stale-share sweep transaction as removeOwnPartnerLink
  // (#1756): the admin dissolve must also clear the pair's future shared
  // double-bed placements.
    // #3123 / INV-LOCK-004 — the club's day, resolved before this transaction
    // opens and passed into both the lock prefix and the sweep. Resolving the
    // club's persisted timezone is a `clubTimeSettings.findUnique`, and inside
    // this transaction that would take a second pooled connection while the
    // global cohort key, every affected lodge key and both member keys are
    // held. One value also means the lodge set that was LOCKED and the rows the
    // sweep JUDGES are derived from the same day.
  const clubTodayForSweep = await clubTodayDateOnlyInstant();
  const { deletedCount, sweptShares } = await prisma.$transaction(async (tx) => {
    if (wasConfirmed) {
      await acquireFuturePartnerSharedAllocationLocks(
        tx,
        [link.memberAId, link.memberBId],
        clubTodayForSweep,
      );
    }
    await lockPartnerMembers(tx, [link.memberAId, link.memberBId]);
    const deleted = await tx.memberPartnerLink.deleteMany({
      where: { id: link.id, status: link.status },
    });
    if (deleted.count === 0) {
      return { deletedCount: 0, sweptShares: [] as SweptPartnerSharedAllocation[] };
    }
    const swept = wasConfirmed
      ? await sweepFuturePartnerSharedAllocationsWithLocksHeld({
          memberId: link.memberAId,
          partnerMemberId: link.memberBId,
          reason: "partner_link_dissolved",
          db: tx,
          today: clubTodayForSweep,
        })
      : [];
    return { deletedCount: deleted.count, sweptShares: swept };
  });
  if (deletedCount === 0) {
    return { ok: false, status: 409, error: "Partner link not found or already changed." };
  }

  // #1769a: honesty rule — only record the notify choice when a removal email
  // was actually suppressed. A PENDING removal emails no one, so it never
  // records a notifyMember field even if the flag was threaded through.
  const notifyAuditFields =
    wasConfirmed && params.notifyMember === false ? { notifyMember: false } : {};

  logAudit({
    action: "MEMBER_PARTNER_LINK_ADMIN_REMOVED",
    memberId: params.adminMemberId,
    targetId: link.memberA.id,
    subjectMemberId: link.memberA.id,
    entityType: "MemberPartnerLink",
    entityId: link.id,
    category: "family",
    outcome: "success",
    summary: wasConfirmed
      ? "Confirmed partner link removed by admin"
      : "Pending partner link removed by admin",
    details: JSON.stringify({
      linkId: link.id,
      memberAId: link.memberA.id,
      memberBId: link.memberB.id,
      wasConfirmed,
      ...notifyAuditFields,
    }),
    metadata: { linkId: link.id, wasConfirmed, ...notifyAuditFields },
  });

  // #1769a: a CONFIRMED removal emails both members unless the admin chose not
  // to notify (default is notify); a PENDING removal never emails.
  if (wasConfirmed && params.notifyMember !== false) {
    notifyBothPartners(
      sendPartnerLinkRemovedEmail,
      link.memberA,
      link.memberB,
      link.id,
      "Failed to send partner link removed email"
    );
  }

  notifyAdminsOfDissolveSweep(
    sweptShares,
    { memberName: memberName(link.memberA), partnerName: memberName(link.memberB) },
    link.id
  );

  return {
    ok: true,
    linkId: link.id,
    status: "REMOVED",
    message: "Partner link removed.",
  };
}

export type ClaimPartnerLinkOutcome =
  | { formed: true; linkId: string; promoted: boolean }
  | {
      formed: false;
      reason:
        | "inviter_ineligible"
        | "claimer_ineligible"
        | "existing_confirmed_partner"
        | "already_partners";
    };

/**
 * Called inside the partner-invite-token claim transaction (#1682 flow) when
 * the token was minted with createPartnerLink: forms the CONFIRMED link
 * between the inviter and the claimer — the claim itself is the partner's
 * consent. Never throws for business conflicts: the family-group join must
 * succeed even when the link cannot form (the caller audits the outcome).
 */
export async function formPartnerLinkOnClaim(params: {
  tx: TransactionClient;
  inviterMemberId: string;
  claimerMemberId: string;
  now: Date;
}): Promise<ClaimPartnerLinkOutcome> {
  const { tx, inviterMemberId, claimerMemberId, now } = params;

  await lockPartnerMembers(tx, [inviterMemberId, claimerMemberId]);

  // Re-validate BOTH parties here rather than trusting caller preconditions:
  // the inviter's standing (including canLogin, required to initiate a
  // request) may have lapsed since the token was minted, and a future caller
  // must not be able to form an ineligible link through this helper.
  const inviter = await tx.member.findUnique({
    where: { id: inviterMemberId },
    select: PARTNER_MEMBER_SELECT,
  });
  if (!inviter || !inviter.canLogin || checkPartnerEligibility(inviter, "initiator")) {
    return { formed: false, reason: "inviter_ineligible" };
  }
  const claimer = await tx.member.findUnique({
    where: { id: claimerMemberId },
    select: PARTNER_MEMBER_SELECT,
  });
  if (!claimer || checkPartnerEligibility(claimer, "target")) {
    return { formed: false, reason: "claimer_ineligible" };
  }

  const pair = canonicalPartnerPair(inviterMemberId, claimerMemberId);
  const existingPair = await tx.memberPartnerLink.findUnique({
    where: { memberAId_memberBId: pair },
    select: { id: true, status: true },
  });
  if (existingPair?.status === PARTNER_LINK_CONFIRMED) {
    return { formed: false, reason: "already_partners" };
  }

  const partnered = await membersWithConfirmedPartner(
    tx,
    [inviterMemberId, claimerMemberId],
    existingPair?.id
  );
  if (partnered.size > 0) {
    return { formed: false, reason: "existing_confirmed_partner" };
  }

  let linkId: string;
  if (existingPair) {
    await tx.memberPartnerLink.update({
      where: { id: existingPair.id },
      data: {
        status: PARTNER_LINK_CONFIRMED,
        confirmedByMemberId: claimerMemberId,
        confirmedAt: now,
      },
    });
    linkId = existingPair.id;
  } else {
    const link = await tx.memberPartnerLink.create({
      data: {
        ...pair,
        status: PARTNER_LINK_CONFIRMED,
        initiatedByMemberId: inviterMemberId,
        confirmedByMemberId: claimerMemberId,
        confirmedAt: now,
      },
    });
    linkId = link.id;
  }

  await pruneOtherPendingLinks(tx, [inviterMemberId, claimerMemberId], linkId);
  return { formed: true, linkId, promoted: Boolean(existingPair) };
}
