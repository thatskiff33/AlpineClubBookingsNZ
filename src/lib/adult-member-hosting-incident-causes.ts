/**
 * The vocabulary of a hosting-coverage incident's CAUSE: the labels, how much of
 * a story each one tells, the one officer-facing phrase for each, and the one
 * stored sentence a declined linked move records.
 *
 * SPLIT OUT OF `adult-member-hosting-coverage-incidents.ts` (#3241), which had
 * grown to two jobs — this vocabulary, and the writer that opens and folds the
 * incident row. They are read by different people: two officer surfaces and an
 * audit line want the words and nothing else, while the writer wants the ranks.
 * `INV-HOST-052` and `INV-HOST-053` are the rules these constants serve, and
 * this file is their one home (`INV-SSOT-001`).
 */

/**
 * Why the cover went away. Mirrors the Prisma enum without importing it.
 *
 * `OWNER_DECLINED_LINKED_MOVE` is WRITTEN BY EXACTLY ONE ARM, the owner-declined
 * branch of `hostingCoverageActorOptions`, censused by
 * `hosting-coverage-incident-cause-expand.test.ts` (#3232 D3, #3241). A NEW value
 * here owes that one's two-release sequence: registered while nothing writes it,
 * written the release after. `INV-HOST-052` is both rules.
 */
export const HOSTING_COVERAGE_INCIDENT_CAUSES = [
  "OFFICER_OVERRIDE",
  "SYSTEM_CHANGE",
  "OWNER_DECLINED_LINKED_MOVE",
] as const;

export type HostingCoverageIncidentCause =
  (typeof HOSTING_COVERAGE_INCIDENT_CAUSES)[number];

/**
 * HOW MUCH OF A STORY A CAUSE TELLS, and so the order the fold promotes in (#3241,
 * `INV-HOST-053`). One re-evaluation row reaches several bookings and only one of
 * them owns its story, so the explained cause has to be able to overwrite the
 * unexplained one — otherwise drain order decides what an officer is told. It
 * never runs downhill.
 */
const CAUSE_ATTRIBUTION_RANK = {
  OFFICER_OVERRIDE: 2,
  OWNER_DECLINED_LINKED_MOVE: 1,
  SYSTEM_CHANGE: 0,
} satisfies Record<HostingCoverageIncidentCause, number>;

export function hostingCoverageCauseAttributionRank(cause: string): number {
  // A label this build has never heard of ranks 0: an older colour meeting a
  // future cause treats it as unexplained rather than crashing, and the guard
  // below is `notIn` for the same reason.
  return CAUSE_ATTRIBUTION_RANK[cause as HostingCoverageIncidentCause] ?? 0;
}

/**
 * The stored reason on the incident a declined offer opens (#3232).
 *
 * IT STILL HAS TO STAND ALONE now the cause names the decision too (#3241): the
 * label says a member declined, and only this sentence says they were asked about
 * THIS booking while editing another. It is read on its own in the booking's
 * history. So no issue reference (no other stored human-read string
 * in this repository carries one — compare `ADULT_SUPERVISION_REVIEW_REASON`), and
 * no product jargon: "the linked move" is a name from this codebase that no
 * officer has ever met. What it says instead is what happened.
 */
export const LINKED_MOVE_DECLINED_INCIDENT_REASON =
  "The member was asked whether to move this booking to the same new nights as " +
  "the booking they were editing, and chose to move only that one — leaving " +
  "this booking without adult member coverage.";

/**
 * The one officer-facing phrase for a recorded cause (#3232 D3).
 *
 * ONE HOME, because there are two officer surfaces and they had drifted into two
 * different answers for the same stored value: the bookings queue said
 * "qualification changed" and the stuck-state dashboard said "system change"
 * (`INV-SSOT-001`). Both are now this function, so a third surface cannot invent
 * a third wording and the follow-up release's new cause needs no screen change.
 *
 * `SYSTEM_CHANGE` deliberately no longer says "qualification changed", nor "cover
 * REMOVED by a later change": the phrase has to be true of EVERY writer, and two
 * remove nothing — a club that tightened its own policy moved the rule, and an
 * officer confirming pending guests ADDED people the cover no longer stretches to.
 * "No longer covered after a later change" is true of those, of an administrative
 * cancellation, of a lifecycle transition and of a data correction. It is no
 * longer asked to carry a member who declined the move: that is its own recorded
 * cause since #3241, with the decision still in words in the audit history. An
 * unrecognised value is described rather than crashing an officer's queue — a
 * screen is a bad place to discover a schema addition.
 */
export function describeHostingCoverageIncidentCause(cause: string): string {
  switch (cause) {
    case "OFFICER_OVERRIDE":
      return "officer override";
    case "SYSTEM_CHANGE":
      return "no longer covered after a later change";
    case "OWNER_DECLINED_LINKED_MOVE":
      return "member chose not to move this booking too";
    default:
      return "cause not recognised";
  }
}
