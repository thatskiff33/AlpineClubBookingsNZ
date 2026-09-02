import {
  ADULT_MEMBER_HOST_SCOPES,
  type AdultMemberHostScope,
} from "@/lib/booking-policy-exceptions";
import { parseStoredHostingReview } from "@/lib/adult-member-hosting-review";

/**
 * Reading a canonical adult-member-hosting snapshot as kiosk cover evidence
 * (#3040, epic #2943, `INV-HOST-045`).
 *
 * ONE RULE, ONE FILE. `kiosk-group-trip.ts` decides WHICH TIER is told what;
 * this decides WHAT THE STORED EVALUATION SUPPORTS SAYING, which is a different
 * question with a different failure mode — the tier split leaks, this one lies —
 * and it is the half the privileged kiosk display and its tests spend all their
 * time on. They were one module until the file-size ratchet asked, and the seam
 * was already there.
 *
 * The whole of the contract is on `KioskCoverEvidenceStatus` and
 * `deriveKioskAdultCoverSource` below. Nothing here reads the database, and
 * nothing here recomputes cover: the issue rejects independent recalculation for
 * display by name, because a display that re-derives the rule drifts from the
 * rule that actually decided compliance.
 */

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
   * No canonical snapshot on the booking, and no signal contradicting that.
   *
   * WITH THE REQUIREMENT IN FORCE — the only case the kiosk asks about at all,
   * see `hostingRequirementInForce` in `kiosk-group-trip.ts` — an absent
   * snapshot means the canonical evaluator recorded NO
   * VIOLATION: either the party has no non-member guest-nights, or every one of
   * them is covered (`evaluateAdultMemberHostingWithPolicy` returns `null` in
   * both cases, and the reconciler then clears the column). It is therefore the
   * ORDINARY, UNREMARKABLE state of most bookings and must not be presented as a
   * problem. It is equally not a positive claim: the column cannot distinguish
   * "evaluated and clean" from "never evaluated since the club switched the rule
   * on", so the honest reading is "no adult-cover issue is recorded here".
   */
  | "NOT_RECORDED"
  /**
   * A snapshot exists but is not the canonical shape: hand-edited, partially
   * written, frozen before the per-night host evidence existed, or internally
   * inconsistent with its own `uncovered` list. Treated as a failed evaluation.
   */
  | "UNREADABLE"
  /**
   * What is recorded cannot be trusted as CURRENT, so nothing it says may be
   * shown as cover. Four signals produce it, and none of them is a parse
   * failure:
   *
   *  1. a queued `HostingCoverageReevaluation` for this booking's owner at this
   *     lodge — the reconciler itself saying the recorded answer is pending
   *     recomputation. Checked FIRST, before the snapshot is even read, because
   *     it invalidates the ABSENCE of a snapshot exactly as much as it
   *     invalidates one that is present;
   *  2. an open `HostingCoverageIncident` on a booking with NO snapshot — the
   *     incident says this booking is carrying uncovered nights right now, and
   *     the empty column says the writer found nothing to record. One of the two
   *     is behind, and a display must not pick the optimistic one. (Where a
   *     snapshot IS present and reports uncovered nights, the two agree and the
   *     snapshot stands — that is the normal state of a booking an officer is
   *     already looking at.);
   *  3. a readable snapshot with NOTHING uncovered. The evaluator never writes
   *     one: it returns `null` when `uncovered` is empty and the reconciler
   *     clears the column. So a stored snapshot claiming full cover is one the
   *     world has moved past, and reporting it as current cover would be the
   *     precise failure `INV-HOST-045` exists to prevent;
   *  4. a covered night resting on `SAME_GROUP_TRIP`, while #3039 is unbuilt.
   *     See `deriveKioskAdultCoverSource` for why that claim is unverifiable
   *     today and must therefore be withheld rather than shown.
   */
  | "STALE"
  /**
   * Readable, self-consistent, no staleness signal — a recorded adult-cover
   * PROBLEM with its per-night evidence. Carries at least one night and at least
   * one UNCOVERED night, because a snapshot with none of either is signal 3
   * above.
   */
  | "EVALUATED";

/**
 * What a Booking Officer has said about the recorded hosting violation.
 *
 * `Booking.adultMemberHostingReviewStatus`, unchanged. An APPROVED exception
 * leaves the violation snapshot exactly where it is, so without this a
 * hut leader cannot tell an officer-approved arrangement from an unapproved one:
 * both render the identical "1 of 2 nights covered / Not covered: …". "Matches
 * canonical evaluation" includes the decision taken on it.
 */
export type KioskAdultCoverDecision = "PENDING" | "APPROVED" | "REJECTED";

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
 * ABSENT ALTOGETHER in three cases, which read the same to a consumer and mean
 * the same thing — nothing is being claimed: the viewer does not hold the
 * `coverSource` capability, the club's adult-member-hosting requirement is not in
 * force so no evaluation of this booking exists to report
 * (`hostingRequirementInForce`), or the card is in no Group Trip at all, which is
 * the boundary of the surface this issue opened (see `attachKioskGroupTrip`).
 *
 * A DISCRIMINATED UNION, so "empty unless `EVALUATED`" is a property of the TYPE
 * rather than of one function plus three tests. `INV-HOST-045` and this module's
 * docblock both claimed it structurally before it was; it now is. A consumer
 * that reaches for `nights` on a `STALE` value gets the empty tuple the compiler
 * knows about, and a future edit cannot attach rows to a status that must carry
 * none without changing this type on purpose (`INV-SSOT`, unrepresentable beats
 * policed).
 */
export type KioskAdultCoverSource =
  | {
      status: Exclude<KioskCoverEvidenceStatus, "EVALUATED">;
      nights: readonly [];
      scopes: readonly [];
    }
  | {
      status: "EVALUATED";
      /**
       * Night rows in date order. At least one, and at least one of them
       * uncovered — see signal 3 on `KioskCoverEvidenceStatus`.
       */
      nights: KioskAdultCoverNight[];
      /** Union of `nights[].scopes` across the COVERED nights. */
      scopes: AdultMemberHostScope[];
      /** The officer's decision on this violation, `null` where none is recorded. */
      decision: KioskAdultCoverDecision | null;
    };

/** The three statuses that carry no evidence, as one construction. */
const NO_COVER_EVIDENCE = { nights: [], scopes: [] } as const;

/**
 * The canonical snapshot, read as cover evidence for one booking.
 *
 * Pure, and exported so the privacy suite can drive every status without a
 * database. The `coveredByScopes` fallback is the field's own documented reading
 * (`QualifyingHostsForNight`): ABSENT means the snapshot predates per-scope
 * evidence, when the only scope that existed was `SAME_BOOKING`. An empty ARRAY
 * on a covered night is a different thing and is not read that way — the writer
 * fills the scope set from the same hosts it counted, so hosts without scopes is
 * an inconsistency, not a legacy shape.
 *
 * ## The order of the checks is the invariant, not a style choice
 *
 * The staleness signals are consulted BEFORE the snapshot, because an earlier
 * round of this function consulted them after — and every positive branch it
 * guarded was unreachable as a result. A persisted snapshot always records at
 * least one uncovered night (`evaluateAdultMemberHostingWithPolicy` returns
 * `null` when `uncovered` is empty, and `reconcileAdultMemberHostingReview`
 * clears the column when the violation is `null`), so "an open incident
 * contradicts an all-covered snapshot" could never fire on real data, while the
 * contradiction it was written to catch — an open incident on a booking with NO
 * snapshot — returned `NOT_RECORDED` before either signal was looked at. The
 * test that covered it used a snapshot no writer can produce.
 *
 * ## Fails closed on a PARTIALLY readable snapshot
 *
 * A malformed night row is not skipped. Dropping one and keeping `EVALUATED`
 * would report "1 of 1 nights covered" from a half-unreadable snapshot, and
 * dropping all of them would report a clean bill of health from rubble. Any row
 * this cannot read, and any snapshot that disagrees with its own `uncovered`
 * list, is `UNREADABLE`.
 *
 * ## SAME_GROUP_TRIP cover is withheld until #3039 lands
 *
 * A night covered by an adult in a SIBLING booking can be silently invalidated by
 * a change on that sibling's account, and nothing today notices: the
 * re-evaluation queue is keyed on the owner of the booking that changed, so the
 * row names the sibling's owner and `readStalenessSignals` — reading this
 * booking's own owner — never finds it. #3039 is the fan-out that fixes it.
 * Until it exists, a cover claim resting on a Group Trip sibling is
 * unverifiable, and `INV-HOST-045` forbids showing an unverifiable claim as
 * cover. So the whole snapshot reports `STALE`.
 *
 * WHAT #3039 MUST DO BEFORE THIS IS REMOVED. Either enqueue a re-evaluation row
 * for every DEPENDENT owner (not only the changed booking's owner), so this
 * booking's own-owner read finds it, or extend `readStalenessSignals` to the
 * owners of the whole group. Removing this refusal without one of those in place
 * restores exactly the hole it closes. It is deliberately whole-snapshot rather
 * than per-night: marking the night `covered: false` instead would put a
 * fabricated "Not covered: <date>" on a child-supervision screen, and a false
 * alarm there is how a screen gets ignored.
 */
export function deriveKioskAdultCoverSource(
  review: unknown,
  signals: { queuedReevaluation: boolean; openIncident: boolean },
  decision: KioskAdultCoverDecision | null = null,
): KioskAdultCoverSource {
  const stale = { status: "STALE", ...NO_COVER_EVIDENCE } as const;
  // The reconciler itself saying the recorded answer is pending recomputation.
  // It invalidates an ABSENT snapshot exactly as much as a present one, so it is
  // asked first of all.
  if (signals.queuedReevaluation) return stale;

  if (review === null || review === undefined) {
    // An open incident says this booking IS carrying uncovered nights, and the
    // empty column says the writer found nothing to record. THIS is the
    // contradiction: one of the two is behind.
    return signals.openIncident
      ? stale
      : { status: "NOT_RECORDED", ...NO_COVER_EVIDENCE };
  }
  const unreadable = { status: "UNREADABLE", ...NO_COVER_EVIDENCE } as const;
  const parsed = parseStoredHostingReview(review);
  // `parseStoredHostingReview` validates the fields the RECONCILER compares and
  // stops there, so `qualifyingHostsByNight` is still unvalidated JSON at this
  // point — a snapshot frozen before the per-night host evidence existed has no
  // such key at all. Re-widening to `unknown` is what keeps that a readable
  // UNREADABLE rather than a runtime throw inside a kiosk response.
  const hostsByNight: unknown = parsed?.requirements.qualifyingHostsByNight;
  if (!parsed || !Array.isArray(hostsByNight)) return unreadable;

  const nights: KioskAdultCoverNight[] = [];
  for (const entry of hostsByNight) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (typeof row.night !== "string") return unreadable;
    const memberIds = row.memberIds;
    if (!Array.isArray(memberIds)) return unreadable;
    const covered = memberIds.length > 0;
    const declared = row.coveredByScopes;
    if (declared !== undefined && !Array.isArray(declared)) return unreadable;
    const scopes: AdultMemberHostScope[] = !covered
      ? []
      : Array.isArray(declared)
        ? ADULT_MEMBER_HOST_SCOPES.filter((scope) => declared.includes(scope))
        : ["SAME_BOOKING"];
    // Hosts but no scope to attribute them to — an empty list, or one naming
    // only scopes this deployment does not have. The writer fills both from the
    // same pass, so this is a snapshot that has been altered, not an old one,
    // and the `SAME_BOOKING` reading above is for an ABSENT key only.
    if (covered && scopes.length === 0) return unreadable;
    nights.push({ night: row.night, covered, scopes });
  }
  nights.sort((a, b) => a.night.localeCompare(b.night));
  if (new Set(nights.map((night) => night.night)).size !== nights.length) {
    return unreadable;
  }

  // The snapshot cross-checked against its OWN uncovered list, which
  // `parseStoredHostingReview` has already established is an array. On canonical
  // data the two agree exactly: a night is in `uncovered` precisely when no
  // qualifying host was found for it, so the sets are equal in both directions.
  const declaredUncovered = new Set(
    // An entry with no readable night becomes a value no lodge night can equal,
    // so it fails the membership test below rather than being skipped.
    (parsed.requirements.uncovered as Array<{ night?: unknown }>).map((row) =>
      typeof row?.night === "string" ? row.night : "«unreadable»",
    ),
  );
  const derivedUncovered = new Set(
    nights.filter((night) => !night.covered).map((night) => night.night),
  );
  if (declaredUncovered.size !== derivedUncovered.size) return unreadable;
  for (const night of declaredUncovered) {
    if (!derivedUncovered.has(night)) return unreadable;
  }

  // A readable snapshot with nothing uncovered is one the world has moved past:
  // the evaluator never writes one and the reconciler clears the column when the
  // violation goes away, so its continued existence means the recorded answer is
  // behind the facts. Never the optimistic reading.
  if (derivedUncovered.size === 0) return stale;
  // #3039 is unbuilt, so a claim resting on a sibling booking is unverifiable.
  if (nights.some((night) => night.scopes.includes("SAME_GROUP_TRIP"))) {
    return stale;
  }

  return {
    status: "EVALUATED",
    nights,
    scopes: ADULT_MEMBER_HOST_SCOPES.filter((scope) =>
      nights.some((night) => night.scopes.includes(scope)),
    ),
    decision,
  };
}
