import type { PrismaClient } from "@prisma/client";

import logger from "@/lib/logger";
import {
  loadAdultMemberHostingPolicy,
  readInheritedSplitPairGroupTrips,
} from "@/lib/adult-member-hosting-review";
import {
  deriveKioskAdultCoverSource,
  type KioskAdultCoverDecision,
  type KioskAdultCoverSource,
} from "@/lib/kiosk-adult-cover";
import { hostingModeIsActive } from "@/lib/policies/adult-member-hosting";
import {
  groupTripIdentityOf,
  type GroupTripIdentity,
  type GroupTripIdentityRow,
} from "@/lib/group-trip-identity";
import type { KioskGroupTripCapabilities } from "@/lib/kiosk-access";

/**
 * What the kiosk is allowed to say about a Group Trip, per tier (#3040, epic
 * #2943).
 *
 * ## The disclosure contract this module exists to make structural
 *
 * Once separate bookings can share adult supervision (#3038), the kiosk holds
 * relationship information it never held before. The epic's settled contract
 * splits it in three, and the split is enforced by WHAT IS BUILT, not by what a
 * component chooses to render:
 *
 *  1. **Ordinary staying guest — linkage only.** They may learn that two cards
 *     in front of them belong to one Group Trip. They may not learn who
 *     organised it, which booking or adult supplies the adult cover, or the
 *     group's join credential.
 *  2. **Organiser context — one explicit capability.**
 *  3. **Adult-cover source — a SEPARATE explicit capability.**
 *
 * Both privileged halves are attached to a GROUP CARD ONLY. This issue opened
 * the Group Trip surface and that is its boundary; a booking in no group carries
 * neither line, which is what the operator guide and the UX flow map describe
 * and what keeps the cover line's warning states off every unrelated card.
 *
 * WHAT COVER SOURCE MEANS is not decided here. `kiosk-adult-cover.ts` owns the
 * reading of a canonical hosting snapshot as evidence (`INV-HOST-045`) — a
 * different question, with a different failure mode: this module leaking is a
 * privacy failure, that module overclaiming is a supervision failure.
 *
 * ## Each tier answers from its OWN data (owner decision D1, 1 Sep 2026)
 *
 * Linkage asks "is this booking in a group at all?" and nothing else. It is
 * deliberately NOT gated on the club's `SAME_GROUP_TRIP` cover option, which an
 * earlier round of this file did gate it on: group containers predate that scope
 * (#796), the badge says only "these guests arrived together", and coupling a
 * roster label to an unrelated adult-supervision setting is arbitrary. The
 * accepted cost is that a club which never enabled anything sees a new label
 * after an upgrade.
 *
 * The two privileged halves each keep their own separate capability, and the
 * cover-source half additionally asks whether the club's adult-member-hosting
 * requirement is in force at all — because that is ITS own data, in the same
 * way that group membership is linkage's (see `hostingRequirementInForce`).
 *
 * The rejected design was "send the whole Group Trip object and hide fields in
 * JSX". This is a Next.js application: anything reachable from a client
 * component's props or an RSC flight payload is readable in the browser whether
 * it is rendered or not, so hiding a field in JSX ships it. Every builder below
 * therefore OMITS the key entirely when the capability is absent — there is no
 * `null`, no empty string and no disabled flag for a reader to pick apart, and
 * `JSON.stringify` of the result cannot contain the field name at all.
 *
 * ## Three things this module deliberately does not have
 *
 * **No `joinCode`, in any tier, in any select.** It is the group's join
 * credential; the epic keeps it out of every payload and every tier, and
 * `GROUP_TRIP_IDENTITY_SELECT` already refuses it at the identity layer.
 * `kiosk-group-trip-privacy.test.ts` reads this file off disk and fails on the
 * string.
 *
 * **No `groupBookingId` in the ordinary tier's DTO.** The ordinary tier needs an
 * EQUALITY RELATION ("these two cards are one trip"), not an identifier, so it
 * gets `KioskGroupTripLabel` — a small ordinal assigned per response, in order
 * of first appearance. A durable container id would be a handle a staying guest
 * could carry to another surface and correlate across days; the ordinal is
 * meaningless outside the one response it was built for. There is no field to
 * leak, which is `INV-SSOT`'s "unrepresentable beats policed" applied to a
 * privacy boundary rather than to a call site.
 *
 * **No second answer to "what Group Trip is this booking in?"** Identity comes
 * from `groupTripIdentityOf` over `GROUP_TRIP_IDENTITY_SELECT`, and the #738
 * split-pair carve-out (owner decision D2 on #3038) comes from the canonical
 * seam `readInheritedSplitPairGroupTrips`. Nothing here reads
 * `Booking.parentBookingId` to decide grouping on its own.
 *
 * ## What is NOT imported from the refusal surface
 *
 * Owner decision D1 on #3038 deliberately discloses the per-night cover
 * CATEGORY to a trip member in the booking-refusal body, on the reasoning that a
 * member who has to fix the problem deserves the fullest explanation. That
 * decision was about the refusal, and the epic's kiosk contract is stricter:
 * ordinary staying guests see LINKAGE ONLY, with no cover-source information at
 * all. The two are not in conflict — a refusal is addressed to the one member
 * whose booking is affected, while the kiosk is a screen anybody staying at the
 * lodge can read — and D1's reasoning is not carried over here.
 */

/**
 * The ordinary tier's whole Group Trip disclosure: an ordinal, and nothing else.
 *
 * `label` is 1-based and is assigned per response in order of first appearance
 * among the visible cards, so two cards carrying the same label are in the same
 * Group Trip and cards carrying different labels are not. It is NOT the
 * container's id, not derived from it, and not stable between responses.
 */
export interface KioskGroupTripLabel {
  label: number;
}

/**
 * Capability 1: who organised the trip.
 *
 * `organiserName` is the organiser member's display name and nothing further —
 * no email, no phone, no member id, no booking id. "Do not expose unrelated
 * incidents/account details" is the issue's wording, and a hut leader's
 * operational need is "who do I talk to about this trip", which a name answers.
 * `null` where the container could not be read, so an unreadable row renders as
 * "not available" rather than as somebody else's name.
 */
export interface KioskGroupTripOrganiser {
  /** True when THIS card is the trip's organiser booking. */
  isOrganiser: boolean;
  organiserName: string | null;
}

/**
 * The Booking columns this module needs, and the reason each one is required.
 *
 * The two identity relations come from `GROUP_TRIP_IDENTITY_SELECT` (required,
 * nullable, never optional — see `GroupTripIdentityRow` for why omission is made
 * impossible rather than made safe). `memberId` and `parentBookingId` are the
 * split-pair carve-out's inputs, and `adultMemberHostingReview` with
 * `adultMemberHostingReviewStatus` is the canonical cover evidence and the
 * officer decision taken on it. All required: a call site that forgot one is a
 * compile error rather than a card that quietly reports no Group Trip, or an
 * approved exception that reads as an unapproved violation.
 */
export type KioskGroupTripBookingRow = GroupTripIdentityRow & {
  id: string;
  memberId: string;
  parentBookingId: string | null;
  adultMemberHostingReview: unknown;
  adultMemberHostingReviewStatus: KioskAdultCoverDecision | null;
};

/**
 * A hard ceiling on how many split children one kiosk response resolves.
 *
 * ONE QUERY, NOT ONE PER CARD. An earlier round of this file awaited the
 * carve-out's singular seam once per card, which was a sequential N+1 the
 * issue's data contract forbids by name — and the docblock's claim that it ran
 * for "zero bookings on an ordinary night" was wrong twice over: a #738 split
 * child is created for ANY party mixing member and non-member guests, which is
 * precisely the population the adult-supervision rule targets, and both halves
 * stay the same nights so both appear on the same day list.
 * `readInheritedSplitPairGroupTrips` now answers the whole list in one indexed
 * read over already-loaded ids, so this bounds the SIZE of that one `IN` list.
 *
 * Binding it FAILS CLOSED: the cards past the ceiling get no linkage, which
 * under-discloses. Under-disclosure is the safe direction for every tier this
 * module serves.
 */
export const KIOSK_SPLIT_PAIR_IDENTITY_LOOKUP_LIMIT = 25;

/** Everything the kiosk may add to one booking card, after the tier split. */
export interface KioskBookingGroupTripFields {
  groupTrip?: KioskGroupTripLabel;
  groupTripOrganiser?: KioskGroupTripOrganiser;
  adultCoverSource?: KioskAdultCoverSource;
}

export type KioskGroupTripDb = Pick<
  PrismaClient,
  | "adultMemberHostingPolicy"
  | "booking"
  | "groupBooking"
  | "hostingCoverageIncident"
  | "hostingCoverageReevaluation"
  | "lodge"
>;

/**
 * Is the club's adult-member-hosting requirement in force at this lodge?
 *
 * THIS GATES THE COVER-SOURCE TIER ONLY, AND IT IS NOT THE GROUP TRIP OPTION.
 * Owner decision D1 on #3040 settled that the ordinary linkage badge is not
 * gated on the shared-cover option, and this function is consulted only where
 * the `coverSource` capability is already held — never for linkage, and never
 * for organiser context.
 *
 * WHY THE COVER TIER STILL ASKS SOMETHING. `KioskAdultCoverSource` claims to
 * report what the canonical rule last decided about this booking. The canonical
 * evaluator writes NOTHING when the mode is not a consequence
 * (`evaluateAdultMemberHostingWithPolicy` returns `null` on
 * `!hostingModeIsActive`), so at a club whose requirement is off there is no
 * current evaluation to report at all — and a snapshot frozen while the club DID
 * enforce would otherwise render as current cover for a rule that no longer
 * exists. That is "stale or indeterminate evaluation must never render as
 * positive cover" (`INV-HOST-045`) one step further out: not a stale snapshot,
 * but a snapshot whose whole policy has been withdrawn.
 *
 * ABSENT, NOT `NOT_RECORDED`. Where the requirement is not in force the key is
 * omitted entirely, exactly as for a viewer without the capability. Reporting
 * `NOT_RECORDED` instead would put an amber "Adult cover: not recorded for this
 * booking" line on every card at every club that does not use the feature — a
 * warning about a rule they never switched on, which is noise rather than
 * honesty. An omitted key says "this club does not evaluate adult cover", which
 * is the true statement.
 *
 * THE MODE, NOT THE SCOPE SET. `SAME_GROUP_TRIP` decides whether an adult in a
 * sibling booking may count towards cover, not whether cover is evaluated. A
 * club with the requirement on and that scope off still has real per-night
 * evidence — `SAME_BOOKING` cover — and its hut leaders may see it. Gating the
 * cover line on the Group Trip scope, as an earlier round of this file did, would
 * withhold cover information that has nothing to do with Group Trips.
 *
 * FAILS CLOSED, deliberately. A club with a malformed policy set (two club-wide
 * rows, an unresolvable lodge) makes the resolver throw. On a booking write path
 * that throw is correct — refuse rather than guess. On an unattended wall tablet
 * it would blank the day list, so here it resolves to "not in force": the cover
 * line is withheld and nothing is claimed. Withholding is always the safe
 * direction for this module.
 */
async function hostingRequirementInForce(
  db: KioskGroupTripDb,
  lodgeId: string,
): Promise<boolean> {
  try {
    const resolved = await loadAdultMemberHostingPolicy(lodgeId, db);
    return hostingModeIsActive(resolved.mode);
  } catch {
    return false;
  }
}

/**
 * The canonical Group Trip for each visible booking, split pair included.
 *
 * Two steps, and the second one is ONE query for the whole list or none at all.
 * Direct identity is free — the relations were selected with the booking — and
 * only a booking with a `parentBookingId` and no identity of its own is handed
 * to the canonical carve-out seam, which reads them together.
 */
async function resolveGroupTrips(
  db: KioskGroupTripDb,
  rows: readonly KioskGroupTripBookingRow[],
): Promise<Map<string, GroupTripIdentity>> {
  const identities = new Map<string, GroupTripIdentity>();
  const inherits: KioskGroupTripBookingRow[] = [];
  for (const row of rows) {
    const own = groupTripIdentityOf(row);
    if (own) {
      identities.set(row.id, own);
      continue;
    }
    if (row.parentBookingId) inherits.push(row);
  }
  if (inherits.length === 0) return identities;
  const inherited = await readInheritedSplitPairGroupTrips(
    db,
    inherits.slice(0, KIOSK_SPLIT_PAIR_IDENTITY_LOOKUP_LIMIT),
  );
  for (const [bookingId, identity] of inherited) {
    identities.set(bookingId, identity);
  }
  return identities;
}

/**
 * Ordinals for the trips that are actually VISIBLE more than once.
 *
 * A label is emitted only where at least two cards in this response share a
 * trip, for two reasons. It is the minimum that makes the badge mean anything —
 * a lone "Group trip 1" links to nothing on the screen — and it is the smaller
 * disclosure, because it says "these two cards travel together" rather than
 * "this booking belongs to a group whose other bookings are elsewhere".
 *
 * Order of first appearance, so the numbering follows the list the reader is
 * looking at rather than any internal identifier.
 */
function assignVisibleTripLabels(
  order: readonly string[],
  identities: ReadonlyMap<string, GroupTripIdentity>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bookingId of order) {
    const identity = identities.get(bookingId);
    if (!identity) continue;
    counts.set(
      identity.groupBookingId,
      (counts.get(identity.groupBookingId) ?? 0) + 1,
    );
  }
  const labelByGroup = new Map<string, number>();
  const labelByBooking = new Map<string, number>();
  for (const bookingId of order) {
    const identity = identities.get(bookingId);
    if (!identity) continue;
    const key = identity.groupBookingId;
    if ((counts.get(key) ?? 0) < 2) continue;
    if (!labelByGroup.has(key)) labelByGroup.set(key, labelByGroup.size + 1);
    labelByBooking.set(bookingId, labelByGroup.get(key) as number);
  }
  return labelByBooking;
}

/**
 * Organiser display names for a set of Group Trip containers.
 *
 * ONE query keyed on the primary key, over the group ids the visible cards
 * already resolved to — never per booking. `joinCode` is not selected, and the
 * explicit `select` is the whole reason this is a narrow read rather than a
 * `findMany` that hands back every column the container has.
 *
 * NO LODGE CLAUSE, AND IT NEEDS NONE. The ids are not searched for: every one of
 * them was resolved from a booking the caller has ALREADY put on this lodge's day
 * list, through its own canonical identity relation. So the only containers this
 * can reach are containers a visible booking belongs to, and a lodge filter here
 * could remove a row but never admit one. That is a property of where the ids
 * come from, not of the open "is a Group Trip confined to one lodge?" question in
 * `docs/multi-lodge/lodge-scoping-contract.md` — the answer to which does not
 * change what this read can see.
 */
async function readOrganiserNames(
  db: KioskGroupTripDb,
  groupBookingIds: readonly string[],
): Promise<Map<string, string>> {
  if (groupBookingIds.length === 0) return new Map();
  const groups = await db.groupBooking.findMany({
    where: { id: { in: [...groupBookingIds] } },
    select: {
      id: true,
      organiserMember: { select: { firstName: true, lastName: true } },
    },
  });
  return new Map(
    groups.map((group) => [
      group.id,
      `${group.organiserMember.firstName} ${group.organiserMember.lastName}`.trim(),
    ]),
  );
}

/**
 * The staleness signals, as two indexed reads over already-loaded ids.
 *
 * `HostingCoverageReevaluation` is keyed on `(memberId, lodgeId)` and carries an
 * explicit night list. The night list is deliberately NOT intersected here: a
 * queued item for this owner at this lodge marks every one of their visible
 * bookings stale, which over-marks in the direction that can only withhold a
 * positive claim. Parsing the JSON night list to narrow it would trade a safe
 * over-mark for a parse that can be wrong.
 *
 * `HostingCoverageIncident` is read only for its EXISTENCE. Nothing about an
 * incident reaches any payload — the issue forbids exposing incidents, and this
 * uses one solely to refuse to trust a snapshot that contradicts it.
 *
 * WHAT THIS READ IS BLIND TO, AND WHY THAT IS HANDLED ELSEWHERE. `ownerIds` are
 * the visible bookings' OWN owners, and every enqueue site writes the owner of
 * the booking that CHANGED. So when a Group Trip sibling in ANOTHER account
 * changes, the queue row names their owner and this read never sees it — the one
 * staleness class this epic itself introduces. Widening the read would not fix
 * it either, because #3039's fan-out does not exist to enqueue anything: there
 * is no row to find. The answer is therefore in
 * `deriveKioskAdultCoverSource`, which refuses to assert cover that RESTS on a
 * Group Trip sibling at all until #3039 lands. See the note there for what
 * #3039 must do before that refusal is removed.
 */
async function readStalenessSignals(
  db: KioskGroupTripDb,
  rows: readonly KioskGroupTripBookingRow[],
  lodgeId: string,
): Promise<{ queuedOwners: Set<string>; incidentBookings: Set<string> }> {
  const ownerIds = [...new Set(rows.map((row) => row.memberId))];
  const bookingIds = rows.map((row) => row.id);
  const [queued, incidents] = await Promise.all([
    db.hostingCoverageReevaluation.findMany({
      where: { processedAt: null, lodgeId, memberId: { in: ownerIds } },
      select: { memberId: true },
    }),
    db.hostingCoverageIncident.findMany({
      where: { resolvedAt: null, bookingId: { in: bookingIds } },
      select: { bookingId: true },
    }),
  ]);
  return {
    queuedOwners: new Set(queued.map((row) => row.memberId)),
    incidentBookings: new Set(incidents.map((row) => row.bookingId)),
  };
}


/**
 * Attach the tier-appropriate Group Trip fields to an already-narrowed card
 * list.
 *
 * Takes the cards the route has ALREADY built and filtered, so the linkage
 * question ("do two visible cards share a trip?") is asked of the list the
 * reader will actually see — not of the wider query behind it, where a sibling
 * dropped for having no operationally present guest would produce a badge
 * linking to nothing.
 *
 * The capability gates are applied to the READS as well as to the payload: with
 * `organiser` false no `GroupBooking` row is fetched, and with `coverSource`
 * false neither the hosting policy nor a staleness signal is. A capability
 * nobody holds costs no query and has nothing to leak.
 *
 * WHAT THE ORDINARY TIER COSTS, precisely. Owner decision D1 gave up the
 * "byte-identical payload when the club's cover option is off" property
 * knowingly. Linkage itself is resolved from the identity relations the caller
 * ALREADY selected with the booking (`GROUP_TRIP_IDENTITY_SELECT`), so an
 * ordinary viewer's response issues no additional read — EXCEPT on a day list
 * carrying a #738 split child, which costs exactly one bounded, indexed query
 * for the whole list (`resolveGroupTrips`). An earlier version of this docblock
 * claimed zero unconditionally and was wrong: split children are common, not
 * pathological, and the read was then one round trip per card.
 *
 * FAILS CLOSED ON ANY DATABASE ERROR. This runs on an unattended wall tablet, on
 * the one screen a hut leader uses to know who is in the building. Three of the
 * reads below are new to the ordinary tier, and letting one of them throw would
 * turn a transient database error into a blank day list for every tier —
 * withholding the roster itself, not merely the Group Trip fields. So the whole
 * enrichment is wrapped: on failure the cards go back exactly as they arrived,
 * with no Group Trip fields at all, and the error is logged. Under-disclosure is
 * the safe direction for every tier this module serves, and so is showing the
 * roster.
 */
export async function attachKioskGroupTrip<T extends { bookingId: string }>(
  cards: readonly T[],
  rows: readonly KioskGroupTripBookingRow[],
  context: {
    db: KioskGroupTripDb;
    lodgeId: string;
    capabilities: KioskGroupTripCapabilities;
  },
): Promise<Array<T & KioskBookingGroupTripFields>> {
  // An empty day asks nothing at all. Out of season that is most days, and the
  // split-pair and capability reads below would otherwise run on every one of
  // them.
  if (cards.length === 0) return [];
  try {
    return await buildKioskGroupTripFields(cards, rows, context);
  } catch (err) {
    logger.error(
      { err, lodgeId: context.lodgeId },
      "kiosk Group Trip enrichment failed; returning the day list unenriched",
    );
    return cards.map((card) => ({ ...card }) as T & KioskBookingGroupTripFields);
  }
}

async function buildKioskGroupTripFields<T extends { bookingId: string }>(
  cards: readonly T[],
  rows: readonly KioskGroupTripBookingRow[],
  context: {
    db: KioskGroupTripDb;
    lodgeId: string;
    capabilities: KioskGroupTripCapabilities;
  },
): Promise<Array<T & KioskBookingGroupTripFields>> {
  const visibleIds = new Set(cards.map((card) => card.bookingId));
  const visibleRows = rows.filter((row) => visibleIds.has(row.id));
  const identities = await resolveGroupTrips(context.db, visibleRows);
  const labels = assignVisibleTripLabels(
    cards.map((card) => card.bookingId),
    identities,
  );

  const organiserNames = context.capabilities.organiser
    ? await readOrganiserNames(context.db, [
        ...new Set(
          [...identities.values()].map((identity) => identity.groupBookingId),
        ),
      ])
    : new Map<string, string>();
  // ONE boolean, computed once, governing both the staleness reads and the
  // payload key. The capability is asked first and short-circuits the policy
  // read, so a tier that may not see cover source costs no query for it.
  const coverSource =
    context.capabilities.coverSource &&
    (await hostingRequirementInForce(context.db, context.lodgeId));
  const signals = coverSource
    ? await readStalenessSignals(context.db, visibleRows, context.lodgeId)
    : { queuedOwners: new Set<string>(), incidentBookings: new Set<string>() };
  const rowById = new Map(visibleRows.map((row) => [row.id, row]));

  return cards.map((card) => {
    const identity = identities.get(card.bookingId);
    const label = labels.get(card.bookingId);
    const row = rowById.get(card.bookingId);
    // Built by SPREADING only the permitted keys. An absent capability leaves
    // the field name out of the object, so it cannot appear in the serialized
    // response even as `null` — which is the whole point (see the module
    // docblock: hiding a field in JSX still ships it).
    return {
      ...card,
      ...(label === undefined ? {} : { groupTrip: { label } }),
      ...(context.capabilities.organiser && identity
        ? {
            groupTripOrganiser: {
              isOrganiser: identity.role === "ORGANISER",
              organiserName:
                organiserNames.get(identity.groupBookingId) ?? null,
            },
          }
        : {}),
      // ON A GROUP CARD ONLY, like the organiser line above. #3040 opened the
      // Group Trip surface, and `docs/guides/lodge.md` and `docs/UX_FLOW_MAP.md`
      // both describe these as two extra lines on THOSE cards. Attaching the
      // cover line to every card would also widen the amber warning states onto
      // every ungrouped booking on the list, which is noise on the one screen
      // that has to stay worth reading. Adult cover for an ungrouped booking is
      // the admin review queue's job, not the kiosk's.
      ...(coverSource && row && identity
        ? {
            adultCoverSource: deriveKioskAdultCoverSource(
              row.adultMemberHostingReview,
              {
                queuedReevaluation: signals.queuedOwners.has(row.memberId),
                openIncident: signals.incidentBookings.has(row.id),
              },
              row.adultMemberHostingReviewStatus,
            ),
          }
        : {}),
    };
  });
}
