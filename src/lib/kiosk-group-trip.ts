import type { PrismaClient } from "@prisma/client";

import {
  loadAdultMemberHostingPolicy,
  parseStoredHostingReview,
  readInheritedSplitPairGroupTrip,
} from "@/lib/adult-member-hosting-review";
import {
  ADULT_MEMBER_HOST_SCOPES,
  type AdultMemberHostScope,
} from "@/lib/booking-policy-exceptions";
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
 * seam `readInheritedSplitPairGroupTrip`. Nothing here reads
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
 * How much the canonical hosting evaluation can be trusted for this booking.
 *
 * The order matters: only `EVALUATED` may carry night rows, and every other
 * value carries an EMPTY `nights` array. That is what makes "stale, failed or
 * indeterminate evaluation never renders as positive cover" a property of the
 * data rather than a rule the UI has to remember.
 */
export type KioskCoverEvidenceStatus =
  /**
   * No canonical snapshot on the booking. The evaluator writes nothing when the
   * policy is off, when the party has no non-member guest-nights, AND when every
   * such night is covered — the three are indistinguishable from the stored
   * column, so the honest answer is that cover SOURCE is unknown here. It is
   * emphatically not "covered".
   */
  | "NOT_RECORDED"
  /**
   * A snapshot exists but is not the canonical shape: hand-edited, partially
   * written, or frozen before the per-night host evidence existed. Treated as a
   * failed evaluation.
   */
  | "UNREADABLE"
  /**
   * The snapshot is readable but known to be out of date, so nothing it says may
   * be shown as current cover. Two signals produce it, both cheap and both
   * indexed: a queued `HostingCoverageReevaluation` for this booking's owner at
   * this lodge, and an open `HostingCoverageIncident` on a booking whose snapshot
   * reports nothing uncovered — a contradiction that can only mean one of the
   * two is behind.
   *
   * WHY THIS MATTERS TODAY. #3039 (the Group Trip re-evaluation fan-out) is not
   * built yet, so a sibling change genuinely can leave a snapshot stale with
   * nothing correcting it. Reporting that plainly is the design the issue asks
   * for, not a workaround for the missing child.
   */
  | "STALE"
  /** Readable, and no staleness signal. `nights` is the canonical evidence. */
  | "EVALUATED";

/** One lodge-night of canonical cover evidence. */
export interface KioskAdultCoverNight {
  /** NZ lodge night, YYYY-MM-DD. */
  night: string;
  covered: boolean;
  /**
   * The scope CATEGORIES that supplied this night's cover — never who. Member
   * ids live on the snapshot and are deliberately dropped here: the privileged
   * kiosk need is "is this booking's supervision resting on another booking",
   * and naming the adult on another account answers a question nobody asked.
   */
  scopes: AdultMemberHostScope[];
}

/**
 * Capability 2: where this booking's adult cover comes from, as last evaluated.
 *
 * DERIVED, NEVER RECALCULATED. Every field comes from the frozen violation
 * snapshot the canonical evaluator wrote (`Booking.adultMemberHostingReview`,
 * produced by `evaluateAdultMemberHostingWithPolicy` and read through
 * `parseStoredHostingReview`). The issue rejects independent recalculation for
 * display by name, and it is right to: a display that re-derives cover drifts
 * from the rule that actually decided compliance, and then two screens disagree
 * about whether a booking is legal.
 *
 * PARTIAL NIGHTS AND MULTIPLE SOURCES ARE THE NORMAL CASE, not an edge. Cover is
 * decided per night, so one booking can be covered on Friday by an adult on its
 * own booking and on Saturday by an adult in a sibling Group Trip booking, and
 * uncovered on Sunday. `nights` is therefore the whole answer and `scopes` is
 * only the union across covered nights — a convenience for a heading, never a
 * substitute for the rows.
 *
 * ABSENT ALTOGETHER in two cases, which read the same to a consumer and mean the
 * same thing: the viewer does not hold the `coverSource` capability, or the
 * club's adult-member-hosting requirement is not in force, so no evaluation of
 * this booking exists to report (`hostingRequirementInForce`).
 */
export interface KioskAdultCoverSource {
  status: KioskCoverEvidenceStatus;
  /** Night rows in date order. EMPTY unless `status` is `EVALUATED`. */
  nights: KioskAdultCoverNight[];
  /** Union of `nights[].scopes`. EMPTY unless `status` is `EVALUATED`. */
  scopes: AdultMemberHostScope[];
}

/**
 * The Booking columns this module needs, and the reason each one is required.
 *
 * The two identity relations come from `GROUP_TRIP_IDENTITY_SELECT` (required,
 * nullable, never optional — see `GroupTripIdentityRow` for why omission is made
 * impossible rather than made safe). `memberId` and `parentBookingId` are the
 * split-pair carve-out's inputs, and `adultMemberHostingReview` is the canonical
 * cover evidence. All required: a call site that forgot one is a compile error
 * rather than a card that quietly reports no Group Trip.
 */
export type KioskGroupTripBookingRow = GroupTripIdentityRow & {
  id: string;
  memberId: string;
  parentBookingId: string | null;
  adultMemberHostingReview: unknown;
};

/**
 * A hard ceiling on the split-pair identity lookups one kiosk response may make.
 *
 * The carve-out's canonical seam takes one booking at a time, so it is the only
 * per-booking read here. It runs ONLY for a visible card that has a
 * `parentBookingId` AND resolved to no Group Trip of its own, which is zero
 * bookings on an ordinary night; a split pair exists only where one party mixes
 * member and non-member guests. The ceiling bounds the pathological case rather
 * than the expected one, and binding it FAILS CLOSED: the affected cards get no
 * linkage, which under-discloses. Under-disclosure is the safe direction for
 * every tier this module serves.
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
 * Two steps, and the second one usually does nothing. Direct identity is free —
 * the relations were selected with the booking — and only a booking with a
 * `parentBookingId` and no identity of its own asks the canonical carve-out
 * seam.
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
  for (const row of inherits.slice(0, KIOSK_SPLIT_PAIR_IDENTITY_LOOKUP_LIMIT)) {
    const inherited = await readInheritedSplitPairGroupTrip(db, row);
    if (inherited) identities.set(row.id, inherited);
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
 * The canonical snapshot, read as cover evidence for one booking.
 *
 * Pure, and exported so the privacy suite can drive every status without a
 * database. The `coveredByScopes` fallback is the field's own documented reading
 * (`QualifyingHostsForNight`): absent means the snapshot predates per-scope
 * evidence, when the only scope that existed was `SAME_BOOKING`. Inventing a
 * different reading here would be a second definition of what the column means.
 */
export function deriveKioskAdultCoverSource(
  review: unknown,
  signals: { queuedReevaluation: boolean; openIncident: boolean },
): KioskAdultCoverSource {
  const empty = { nights: [], scopes: [] };
  if (review === null || review === undefined) {
    return { status: "NOT_RECORDED", ...empty };
  }
  const parsed = parseStoredHostingReview(review);
  // `parseStoredHostingReview` validates the fields the RECONCILER compares and
  // stops there, so `qualifyingHostsByNight` is still unvalidated JSON at this
  // point — a snapshot frozen before the per-night host evidence existed has no
  // such key at all. Re-widening to `unknown` is what keeps that a readable
  // UNREADABLE rather than a runtime throw inside a kiosk response.
  const hostsByNight: unknown = parsed?.requirements.qualifyingHostsByNight;
  if (!parsed || !Array.isArray(hostsByNight)) {
    return { status: "UNREADABLE", ...empty };
  }
  const nights: KioskAdultCoverNight[] = hostsByNight
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((row): row is Record<string, unknown> & { night: string } =>
      typeof row.night === "string",
    )
    .map((row) => {
      const memberIds = row.memberIds;
      const covered = Array.isArray(memberIds) && memberIds.length > 0;
      const declared = row.coveredByScopes;
      const scopes: AdultMemberHostScope[] = !covered
        ? []
        : Array.isArray(declared) && declared.length > 0
          ? ADULT_MEMBER_HOST_SCOPES.filter((scope) => declared.includes(scope))
          : ["SAME_BOOKING"];
      return { night: row.night, covered, scopes };
    })
    .sort((a, b) => a.night.localeCompare(b.night));

  // The contradiction that makes an otherwise readable snapshot untrustworthy:
  // an OPEN incident says this booking is carrying uncovered nights right now,
  // and a snapshot reporting none disagrees with it. One of the two is behind,
  // and a display must not pick the optimistic one.
  const contradicted =
    signals.openIncident && nights.every((night) => night.covered);
  if (signals.queuedReevaluation || contradicted) {
    return { status: "STALE", ...empty };
  }
  return {
    status: "EVALUATED",
    nights,
    scopes: ADULT_MEMBER_HOST_SCOPES.filter((scope) =>
      nights.some((night) => night.scopes.includes(scope)),
    ),
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
 * SO THE ORDINARY TIER COSTS ZERO EXTRA QUERIES, still. Owner decision D1 gave
 * up the "byte-identical payload when the club's cover option is off" property
 * knowingly, and it is worth being precise about what that did and did not cost:
 * linkage is resolved from the identity relations the caller ALREADY selected
 * with the booking (`GROUP_TRIP_IDENTITY_SELECT`), so an ordinary viewer's
 * response issues no additional read at all — with the one bounded exception of
 * the split-pair carve-out below, which needs a booking that has a
 * `parentBookingId` and no group of its own.
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
      ...(coverSource && row
        ? {
            adultCoverSource: deriveKioskAdultCoverSource(
              row.adultMemberHostingReview,
              {
                queuedReevaluation: signals.queuedOwners.has(row.memberId),
                openIncident: signals.incidentBookings.has(row.id),
              },
            ),
          }
        : {}),
    };
  });
}
