/**
 * The SHAPE of the missing-Xero-contact tool (#2939, `INV-INT-022` and
 * `INV-INT-023`): what the
 * census returns, what a run returns, and the constants both are measured
 * against. The census is `xero-missing-contact-seeding.ts`; the run is
 * `xero-missing-contact-seeding-run.ts`; the design is in
 * `docs/xero/ARCHITECTURE.md` and the operator guide in `docs/guides/xero.md`.
 *
 * ## WHY THIS IS ITS OWN MODULE, AND WHY IT IMPORTS NOTHING
 *
 * Two reasons, and the second is the one that made it necessary.
 *
 * The admin panel needs these unions. Keying its reason-to-copy maps on
 * `Record<MissingContactAmbiguity, string>` rather than on `Record<string,
 * string>` is what turns a new ambiguity class into a compile error there
 * instead of a fallback sentence shipped silently to an operator — and that
 * costs nothing, because a union is a pure type. But the panel is a
 * `"use client"` file, and reaching into a module that imports `prisma` for it
 * is the shape `INV-OPS-013` exists to catch. A leaf that imports nothing at
 * all cannot put anything on the browser graph, whatever a later reader adds to
 * the engine. `stable-json.ts` was split out for exactly this reason before
 * #3218 collapsed it back, and the lesson recorded there — "split the
 * client-safe values into a module that imports nothing" — is the one followed
 * here.
 *
 * The second reason is the file-size ratchet, which refuses an allowance for a
 * NEW over-budget file: an allowance lets an already-over-budget file grow, and
 * is not a way to ARRIVE over budget. The census and the run were one module of
 * about twelve hundred lines, two thirds of it the comment that records why
 * each classification is not guessed. Splitting the shape out is the seam that
 * costs the least: neither the census nor the run reads the other's internals,
 * and both read exactly these declarations.
 */

/**
 * Xero's per-minute API budget, which is what really bounds a chunk. Stated
 * here rather than imported because it is used as an ARITHMETIC BASIS for the
 * chunk sizes below, not as the limiter — `callXeroApi` owns the enforcement.
 */
export const XERO_CALLS_PER_MINUTE = 60;

/**
 * Provider calls one member costs, measured from what the funnel really does
 * rather than from what the run asks for.
 *
 * With contact grouping switched OFF it is two: the email search, and the
 * create (a member the search matches spends the second call on nothing, so two
 * is the ceiling). With grouping ON the funnel's tail also runs
 * `syncManagedXeroContactGroupForMember`, which short-circuits before any
 * provider call ONLY when the mode is `NONE`; otherwise it reads the contact
 * back (`getContact`) and may then write group membership. So three is the
 * floor and four the realistic ceiling.
 *
 * An earlier revision of this file said "at most two Xero calls" without the
 * grouping tail and sized the chunk at a flat 25, which is >=75 calls against a
 * 60-per-minute budget on any club that groups its contacts — guaranteed to
 * trip the limit rather than "far inside" it.
 */
export const CALLS_PER_MEMBER_WITHOUT_GROUPING = 2;
export const CALLS_PER_MEMBER_WITH_GROUPING = 4;

/**
 * Members per chunk, DERIVED from the cost above so the two cannot drift: half
 * a minute's budget, which leaves room for whatever else the site is doing with
 * the same quota and still gives the operator a checkpoint often enough to stop
 * a run that is going wrong.
 */
export const DEFAULT_SEEDING_CHUNK = Math.floor(
  XERO_CALLS_PER_MINUTE / 2 / CALLS_PER_MEMBER_WITHOUT_GROUPING,
);
export const DEFAULT_SEEDING_CHUNK_WITH_GROUPING = Math.floor(
  XERO_CALLS_PER_MINUTE / 2 / CALLS_PER_MEMBER_WITH_GROUPING,
);

/**
 * Wall-clock budget for one chunk. A route that runs past its host's timeout
 * loses the WHOLE result — the summary audit row is written after the run
 * returns — while the contacts it created stay in Xero. So the loop stops on
 * its own and returns what it did, which is strictly better than a partial run
 * nobody can see.
 */
export const CHUNK_WALL_CLOCK_BUDGET_MS = 45_000;

/** Beyond this the cached contact list is old enough to mislead (#2939). */
export const CONTACT_CACHE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;


/**
 * Why a member is not in the seeding population at all. The first two are the
 * school rule (`Role.SCHOOL`, and a record invented as a school's booking
 * contact whatever role it carries — both belong to an `Organisation` since
 * #3367); then an approved deletion's anonymised marker; then a dependant who
 * LOST the address they used to inherit (#2716), which is its own reason
 * because "their arrangement broke" reads nothing like "they never had one";
 * then any other club-internal `.invalid` address, which is not an address; and
 * the funnel's own create gate answering no. The operator-facing wording for
 * each lives in the panel.
 */
export type MissingContactExclusion =
  | "SCHOOL_MEMBER_RECORD"
  | "SCHOOL_BOOKING_CONTACT"
  | "ANONYMISED_ACCOUNT"
  | "INHERITED_ADDRESS_LOST"
  | "NO_REAL_EMAIL_ADDRESS"
  | "INCOMPLETE_DETAILS";

/**
 * Why a member the tool would otherwise push is handed back for an operator to
 * resolve instead. Each is a question with more than one defensible answer, so
 * none of them is guessed: a school already owns the only contact on this
 * address; another member already holds it; two unlinked members share the
 * address; several Xero contacts carry it; the one that does carries a
 * different name; or — on the OTHER axis entirely — Xero already holds an
 * active contact with this member's exact name under a different address.
 *
 * THE LAST ONE IS THE NAME AXIS, and it exists because the census looked only
 * along the email axis while the funnel did not. Xero enforces contact-name
 * uniqueness, so a create for a member whose name an old contact already
 * carries is refused by the provider, and the funnel's recovery then adopts
 * that contact on a normalised-name match with no email comparison at all. A
 * new John Smith and a fifteen-year-old John Smith at another address would
 * link silently. Seeing it HERE costs one extra map over rows already in
 * memory, and the run refuses the same adoption underneath
 * (`requireAuthoritativeMatch`) so a name that only appears between the review
 * and the run is caught too.
 */
export type MissingContactAmbiguity =
  | "XERO_CONTACT_BELONGS_TO_A_SCHOOL"
  | "ANOTHER_MEMBER_HOLDS_THE_CONTACT"
  | "MEMBERS_SHARE_THE_EMAIL_ADDRESS"
  | "SEVERAL_XERO_CONTACTS_SHARE_THE_EMAIL"
  | "XERO_CONTACT_NAME_DIFFERS"
  | "XERO_CONTACT_ALREADY_HAS_THIS_NAME";

/**
 * What the dry run expects the funnel to do: adopt the cached contact that
 * matches this member by address and by name, or find nothing cached and go on
 * to search Xero live before creating.
 */
export type MissingContactEvidence = "CACHED_CONTACT_MATCH" | "NO_CACHED_MATCH";

export interface MissingContactMemberRef {
  memberId: string;
  memberName: string;
  memberEmail: string;
}

export interface PushableMemberRow extends MissingContactMemberRef {
  evidence: MissingContactEvidence;
  /**
   * The cached contact the dry run expects to be linked, when there is one.
   * Advisory: the funnel asks Xero itself, and a live answer outranks this.
   */
  cachedXeroContactId: string | null;
}

export interface ExcludedMemberRow extends MissingContactMemberRef {
  reason: MissingContactExclusion;
}

export interface AmbiguousMemberRow extends MissingContactMemberRef {
  reason: MissingContactAmbiguity;
  /** Ids only — whose contact it is belongs on the screen, not in a log. */
  xeroContactIds: string[];
}

export interface MissingContactSnapshot {
  /** False until a contact sync has run once. Every count below is then zero. */
  cacheReady: boolean;
  contactCacheLastRefreshedAt: string | null;
  /**
   * How old that cache is, in whole hours, and whether it is old enough to
   * mislead. EXISTENCE was checked from the start; AGE was not, and age is
   * exactly what turns a "no cached match" row into a duplicate — a six-month
   * old cache reads identically to a five-minute-old one.
   */
  contactCacheAgeHours: number | null;
  contactCacheStale: boolean;
  /** Digest of the full pushable plan, before any row limit is applied. */
  plannedDigest: string;
  /** Members this installation processes per chunk, derived from call cost. */
  chunkSize: number;
  /** Upper bound of Xero calls one full chunk costs at that size. */
  estimatedXeroCallsPerChunk: number;
  /** Person members considered — the population after exclusions. */
  eligible: number;
  alreadyLinked: number;
  unlinked: number;
  pushable: number;
  excluded: number;
  ambiguous: number;
  pushableRows: PushableMemberRow[];
  excludedRows: ExcludedMemberRow[];
  ambiguousRows: AmbiguousMemberRow[];
}

/**
 * Why one member's push did not happen, in the operator's terms. Each of these
 * has a different remedy, which is why the kind reaches the screen rather than
 * only a message: `PARTIAL_SUCCESS` is the one class this repository already
 * has standing operator guidance for, and that guidance is DO NOT REPEAT THE
 * ACTION.
 */
export type SeedingFailureKind =
  | "TWO_HOMES_REFUSAL"
  | "PROVIDER_ANSWER_UNAVAILABLE"
  | "NAME_ALREADY_IN_XERO"
  | "PLAN_DIVERGED"
  | "PARTIAL_SUCCESS"
  | "OTHER";

/** What the run did for ONE member, named. */
export interface SeedingMemberOutcome extends MissingContactMemberRef {
  outcome: "created" | "linked" | "unlabelled" | "failed";
  /** The contact this member ended up on, when the run resolved one. */
  xeroContactId: string | null;
  /** What the reviewed plan said would happen, carried through for the report. */
  plannedEvidence: MissingContactEvidence;
  /** Set when `outcome` is `failed`. */
  kind: SeedingFailureKind | null;
  error: string | null;
}

/** Why a reviewed member was not touched at all. */
export type SeedingSkipReason = "ALREADY_DONE" | "NO_LONGER_PUSHABLE";

export interface SeedingSkippedMember {
  memberId: string;
  reason: SeedingSkipReason;
}

export interface SeedingRunResult {
  /** Members the run resolved a contact for this chunk. */
  processed: number;
  /** How many of those the funnel linked to a contact Xero already held. */
  linkedExisting: number;
  /** How many it created. */
  created: number;
  /** How many resolved through a path the link ledger does not label. */
  resolvedUnlabelled: number;
  failed: number;
  failures: Array<{ memberId: string; kind: SeedingFailureKind; error: string }>;
  /**
   * Every member this chunk touched, named, with what happened to them and
   * which contact they ended up on.
   *
   * Counts alone are not a report: "three created, twenty-two linked" tells an
   * operator nothing about WHICH contact each member was linked to, and that is
   * the one thing a silent wrong adoption would show up in.
   */
  outcomes: SeedingMemberOutcome[];
  /**
   * Reviewed ids the run did not touch, each with WHY.
   *
   * The two reasons are not the same event and were previously conflated.
   * `ALREADY_DONE` is an earlier chunk of this same review having already given
   * the member a contact — expected, and the reason a multi-chunk run exists at
   * all. `NO_LONGER_PUSHABLE` is a member the operator explicitly approved whom
   * the run then declined to touch, which is something they need to see.
   */
  skipped: SeedingSkippedMember[];
  /** Reviewed, still pushable, and not reached by this chunk. */
  remaining: number;
  /**
   * Outstanding across the WHOLE population rather than the reviewed slice.
   *
   * `remaining` answers "what is left of what I just confirmed"; past the row
   * limit those are different numbers, and reporting only the first is how the
   * button said "next 25 of 900" while the result said "475 still to do" on the
   * same screen.
   */
  outstandingPushable: number;
  done: boolean;
  haltedByDailyLimit: boolean;
  /** The loop stopped on its own wall-clock budget, with work still to do. */
  haltedByTimeBudget: boolean;
}

/**
 * The reviewed plan no longer matches what a dry run of the same state would
 * produce, so nothing was done (#2939, modelled on the sibling
 * grouping-resync's `plan_changed`).
 */
export class SeedingPlanChangedError extends Error {
  readonly code = "XERO_SEEDING_PLAN_CHANGED";

  constructor() {
    super(
      "What would happen has changed since the dry run you reviewed — a " +
        "member's Xero contact was found, archived or claimed in between. " +
        "Nothing was created. Run the dry run again and review the new plan.",
    );
    this.name = "SeedingPlanChangedError";
  }
}
