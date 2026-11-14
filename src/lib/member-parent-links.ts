import type { Prisma } from "@prisma/client";
import {
  EMAIL_SOURCE_SELECT,
  isUsableEmailSource,
} from "@/lib/member-email-inheritance";
import type { prisma } from "@/lib/prisma";

type ParentLinkKind = "PRIMARY" | "SECONDARY";

type ParentLinkClient = Prisma.TransactionClient | typeof prisma;

export type ParentLinkSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier?: string;
  active?: boolean;
  canLogin?: boolean;
  inheritEmailFromId?: string | null;
  parentLinkType: ParentLinkKind;
};

/**
 * The FLAT, one-hop reading of "whose email does a dependant of this parent
 * inherit?": the parent's own source if the parent inherits, else the parent.
 *
 * Kept because stored inheritance is always flat (see
 * {@link resolveInheritedEmailSourceId}), so this is the right answer whenever
 * the parent is itself a usable source. NOTHING GUARANTEES THAT ANY MORE: the
 * admin link route used to require an active, non-archived ADULT parent, and
 * #2282 removed the adult half — parentage is recorded at any age. A parent may
 * now be a minor, so this reading is correct only where the caller has already
 * established that the parent can receive mail. Everywhere else — and in every
 * WRITE path without exception — use the async resolver, which applies the full
 * usable-source test.
 *
 * #2716: since inheritance is one hop, a parent who themselves inherits is not a
 * source at all, and the `parent.inheritEmailFromId` branch below survives only
 * as a SELECTION alias — the admin UI shows a mailbox where the parent has one,
 * and {@link matchParentLinkIdForNotification} has to be able to map that back
 * to the parent it came from. It never decides a mailbox.
 */
export function getParentEmailSourceId(
  parent: { id: string; inheritEmailFromId?: string | null } | null | undefined
) {
  if (!parent) return null;
  return parent.inheritEmailFromId || parent.id;
}

/**
 * What every writer says when a dependant was meant to inherit a parent's email
 * and that parent has no real address. Refused rather than silently stored as
 * "no inheritance": the admin asked for the mail to reach a parent, and quietly
 * leaving it on the dependant's own (often placeholder) address is how a family
 * stops receiving anything without anyone noticing.
 *
 * #2716 rewrote the sentence with the rule. It used to offer "no parent OR
 * ANCESTOR in this family has a real email address", which described a walk that
 * no longer happens: inheritance is one hop, so the only member whose address
 * can fix this is the parent themselves. Naming the grandparent as a possible
 * remedy would send an admin to record an address that changes nothing.
 */
export const NO_INHERITABLE_EMAIL_SOURCE_MESSAGE =
  "This parent has no email address the club can send to, so there is nothing for the dependant to inherit. Record an email address for the parent first, or link without inheriting.";

export type InheritedEmailSourceResolution = {
  /** The member whose address the dependant should inherit; null if none. */
  sourceId: string | null;
};

/**
 * DIRECT-PARENT email inheritance (#2716, owner decision on #2708, 9 Aug 2026).
 *
 * Given the parent an admin chose, this answers "whose mailbox does the
 * dependant's mail go to?" — and the answer is now **that parent or nobody**.
 *
 * It used to be a level-order walk UP the family tree to the nearest ancestor
 * who could receive mail, bounded by the four-generation link cap (#2255, D9).
 * That was an agent-taken decision flagged for the owner, and the owner narrowed
 * it: an address that travels an arbitrary number of hops is unpredictable to
 * the person whose address it is, and a grandparent who supplies an email for
 * one grandchild does not thereby expect notifications for a branch of the
 * family they may have no involvement with. One hop is explainable to a member
 * in a sentence; three is not.
 *
 * THE DEPTH CAP IS UNCHANGED. Four generations still governs how deep family
 * links may run (`member-family-link-depth.ts`); it never governed the address
 * hop, and this function no longer has any reason to consult it — which is why
 * `MAX_PARENT_LINK_CHAIN_LENGTH` is gone from this module rather than merely
 * left unused.
 *
 * THE ACCEPTED COST, which no caller may hide: where the chosen parent has no
 * address of their own, this returns `null` and the dependant inherits NOBODY.
 * Callers either refuse the write with
 * {@link NO_INHERITABLE_EMAIL_SOURCE_MESSAGE} or record the choice and leave the
 * member on the admin "no reachable email address" surface
 * (`unreachableMemberWhere`). A gap somebody can see beats a message going
 * somewhere nobody chose.
 *
 * WHAT IT RETURNS is still a TERMINAL source — a member who does not themselves
 * inherit — so stored inheritance stays FLAT and every reader keeps its single
 * `inheritEmailFrom` join. Terminality is now trivially true rather than
 * carefully arranged: a parent who inherits is not a usable source, so there is
 * nothing left to chain through.
 */
export async function resolveInheritedEmailSourceId(
  db: ParentLinkClient,
  parentId: string,
): Promise<InheritedEmailSourceResolution> {
  const parent = await db.member.findUnique({
    where: { id: parentId },
    select: EMAIL_SOURCE_SELECT,
  });
  if (!parent) return { sourceId: null };
  return { sourceId: isUsableEmailSource(parent) ? parent.id : null };
}

export function buildParentLinks(member: {
  parent?: Omit<ParentLinkSummary, "parentLinkType"> | null;
  secondaryParent?: Omit<ParentLinkSummary, "parentLinkType"> | null;
}) {
  const links: ParentLinkSummary[] = [];
  if (member.parent) {
    links.push({ ...member.parent, parentLinkType: "PRIMARY" });
  }
  if (member.secondaryParent && member.secondaryParent.id !== member.parent?.id) {
    links.push({ ...member.secondaryParent, parentLinkType: "SECONDARY" });
  }
  return links;
}

/**
 * A parent as one MEMBER may see another member's parent: the name and the link
 * type always, the email address and the status fields only where the rule
 * below allows them. Every optional field here is optional because the guard
 * can withhold it, not merely because a select might omit it.
 */
export type MemberFacingParentLink = Omit<ParentLinkSummary, "email"> & {
  email?: string;
};

/** A parent row read with the family groups it belongs to (#2424). */
export type ParentLinkWithGroups = Omit<ParentLinkSummary, "parentLinkType"> & {
  familyGroupMemberships?: Array<{ familyGroupId: string }> | null;
};

/**
 * MEMBER-FACING parent links: name and relationship always, the parent's EMAIL
 * ADDRESS only when the VIEWER shares a family group with that parent (#2424,
 * owner decision 2026-08-01).
 *
 * A parent link carries no shared-group requirement of its own — the admin link
 * route will record a parent who is in none of the child's groups — so the
 * member family payload was handing every viewer the address of people outside
 * their own family entirely. #2282 widened that further by allowing parentage at
 * any age, so the reachable set stopped being "other adults" and started
 * including children.
 *
 * The rule is enforced HERE, server-side, and never by a client choosing not to
 * render the field: the JSON is the leak, not the screen. The visible shape is
 * built by WHITELIST rather than by deleting `email` from a spread, so a field
 * added to the query later cannot leak by default.
 *
 * The withheld set is EMAIL PLUS THE STATUS FIELDS — `ageTier`, `active` and
 * `canLogin`. Those are facts about a person the viewer has no family
 * relationship with, and `ageTier` in particular says whether a named stranger
 * is a child, which is the same disclosure this issue exists to stop. No
 * member-facing client reads any of the three: the family page renders a parent
 * as name plus the notifications marker
 * (`src/components/profile/family-group-section.tsx`), and the
 * onboarding wizard does not read parent links at all. So an out-of-group
 * parent yields exactly `id`, `firstName`, `lastName`, `parentLinkType` and
 * `inheritEmailFromId` — the last stays because the notifications marker is
 * matched on it, and an id pointing at a mailbox owner is not itself a contact
 * detail.
 *
 * The viewer's own groups are the yardstick, not the subject member's: the
 * subject is by construction someone the viewer already shares a group with, and
 * it is the parent hanging off them who may not be.
 */
export function buildMemberFacingParentLinks(
  member: {
    parent?: ParentLinkWithGroups | null;
    secondaryParent?: ParentLinkWithGroups | null;
  },
  viewerFamilyGroupIds: Iterable<string>,
): MemberFacingParentLink[] {
  const viewerGroupIds = new Set(viewerFamilyGroupIds);
  const groupIdsByParentId = new Map<string, string[]>();
  for (const parent of [member.parent, member.secondaryParent]) {
    if (!parent) continue;
    groupIdsByParentId.set(
      parent.id,
      (parent.familyGroupMemberships ?? []).map(
        (membership) => membership.familyGroupId,
      ),
    );
  }

  return buildParentLinks(member).map((link) => {
    const visible: MemberFacingParentLink = {
      id: link.id,
      firstName: link.firstName,
      lastName: link.lastName,
      parentLinkType: link.parentLinkType,
    };
    if (link.inheritEmailFromId !== undefined) {
      visible.inheritEmailFromId = link.inheritEmailFromId;
    }

    const sharesFamilyGroupWithViewer = (
      groupIdsByParentId.get(link.id) ?? []
    ).some((groupId) => viewerGroupIds.has(groupId));
    if (sharesFamilyGroupWithViewer) {
      visible.email = link.email;
      if (link.ageTier !== undefined) visible.ageTier = link.ageTier;
      if (link.active !== undefined) visible.active = link.active;
      if (link.canLogin !== undefined) visible.canLogin = link.canLogin;
    }
    return visible;
  });
}

/**
 * Which of a member's linked parents an admin's "notification email" selection
 * names. Selection-matching only — it deliberately does not decide the mailbox,
 * because that needs the chosen parent's own row (#2716,
 * {@link resolveInheritedEmailSourceId}) and this runs on plain arrays.
 *
 * Three outcomes, all meaningful:
 *  - `null`   — nothing selected: the member keeps their own email.
 *  - `undefined` — the selection names nobody this member is linked to; the
 *                  caller rejects the request rather than guessing.
 *  - a parent id — resolve the mailbox by walking up from that parent.
 *
 * The second lookup accepts a parent's already-flattened SOURCE id as well as
 * the parent's own id, because that is what the admin UI round-trips for a
 * parent who themselves inherits (it shows the mailbox, not the middleman).
 */
export function matchParentLinkIdForNotification(
  parentLinks: Array<{ id: string; inheritEmailFromId?: string | null }>,
  selectedId: string | null | undefined
): string | null | undefined {
  const normalized = selectedId?.trim() || null;
  if (!normalized) return null;

  const parent = parentLinks.find((link) => link.id === normalized);
  if (parent) {
    return parent.id;
  }

  const viaSource = parentLinks.find(
    (link) => getParentEmailSourceId(link) === normalized
  );
  return viaSource ? viaSource.id : undefined;
}
