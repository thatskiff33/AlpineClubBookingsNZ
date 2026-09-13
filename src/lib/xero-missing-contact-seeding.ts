/**
 * Bulk seeding of the MISSING Xero contacts for unlinked person members
 * (#2939, a child of MAD programme #2725). The rule is `INV-INT-022`; the rule
 * this must not break is `INV-INT-018`; the operator guide is
 * `docs/guides/xero.md` -> "Create the missing Xero contacts in bulk" and the
 * longer design rationale is `docs/xero/ARCHITECTURE.md`.
 *
 * ## What this is for
 *
 * A club arriving at this application already has years of Xero history and a
 * membership list that only partly matches it. `findOrCreateXeroContact` gives
 * a member a Xero customer the first time somebody raises a document for them,
 * which is fine month to month and useless before a first UAT run: nobody knows
 * how many members have no Xero customer, which of them Xero already holds one
 * for, or which ones the club would be inventing a duplicate for. This answers
 * all three, and then does the work in bounded chunks.
 *
 * ## IT RESOLVES NOTHING ITSELF. That is the whole design.
 *
 * Every contact this creates or links is resolved by
 * {@link findOrCreateXeroContact} — the one funnel every Xero document writer
 * already uses — called once per member. Nothing here talks to Xero, mints an
 * idempotency key, writes a `Member.xeroContactId`, or decides whether a
 * provider contact already exists. Five rules therefore come with the funnel
 * rather than being re-implemented here, and each is one this issue could
 * otherwise have got subtly wrong: link-before-create by asking the PROVIDER
 * rather than the local cache; convergent retry and replay, through a
 * member-scoped reservation and idempotency key; the two-homes refusal
 * (`INV-INT-018`); the undeclared-installation refusal (`INV-CONFIG-005`, epic
 * #2986); and contact-email containment on a copy of the club's site.
 *
 * ## ONE THING IT DOES ASK THE FUNNEL TO DO DIFFERENTLY
 *
 * `requireAuthoritativeMatch`. The funnel's defaults are tuned for a document
 * writer, where the expensive outcome is a blocked invoice: a failed Xero
 * search falls through to a create, and a create Xero refuses on its
 * contact-name uniqueness rule is recovered by adopting the existing same-named
 * contact, on the NAME ALONE with no email comparison. Both trades INVERT here.
 * Nothing is blocked by refusing; what is expensive is a duplicate customer in
 * a ledger with no merge API, or worse, a new member silently linked to a
 * fifteen-year-old contact that happens to share their name — after which every
 * invoice, statement and reminder for them lands on somebody else's account.
 *
 * So this run passes the option, and a member the provider could not be asked
 * about authoritatively is recorded as a FAILURE the next run retries rather
 * than as a success. It then compares the contact id the funnel returned
 * against the one the reviewed plan promised, because a plan digest cannot see
 * a divergence that happens INSIDE the funnel after the plan already matched.
 *
 * ## WHY THIS IS NOT THE `INV-INT-019` BULK EXCEPTION
 *
 * That exception — one bulk path that does not take the two-homes refusal — was
 * written while this issue was unbuilt, and its parenthetical said bulk seeding
 * was #2939's subject, which reads as though whatever #2939 built would inherit
 * it. It does not, and the reason is structural rather than careful. The
 * refusal is unaffordable to a path holding ONE transaction open across many
 * contacts, because the contact-home key would then be held for the whole run.
 * This path holds no such transaction: it is a loop of independent per-member
 * calls, each opening the funnel's own short phase-2 transaction and closing it
 * before the next member starts. The lock is taken and released once per
 * member, exactly as for a single invoice — so a bulk run is
 * indistinguishable, from the lock's point of view, from the members being
 * invoiced one at a time, which is the state this tool exists to bring forward.
 * #2939 also closed the inbound exception rather than leaving it standing; see
 * `xero-contact-create-recovery.ts` and `xero-member-import.ts`.
 *
 * ## The dry run reads, and only reads
 *
 * {@link getXeroMissingContactSnapshot} makes no provider call and writes
 * nothing — no `Member` row, no `XeroSyncOperation`, no outbox entry, no audit.
 * It classifies from the local `XeroContactCache`, and REFUSES to answer until
 * that cache has been refreshed once: without it every member looks like "no
 * contact in Xero", which is the one answer that would send an operator
 * confidently towards duplicates. It also reports how OLD that cache is and
 * whether it is stale, because a six-month-old cache reads identically to a
 * five-minute-old one and staleness is exactly what turns a "no cached match"
 * row into a duplicate.
 *
 * It classifies on BOTH axes the funnel can match on — the email address and
 * the contact NAME — because a census that looks only along the email axis
 * cannot see the collision the provider's own uniqueness rule will raise.
 *
 * ## What the run may touch
 *
 * The intersection of the ids the operator reviewed with a freshly recomputed
 * pushable set, and nothing else. Both halves are load-bearing; `INV-INT-022`
 * is where that is written down, and
 * {@link runXeroMissingContactSeedingChunk} says what each half excludes.
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { stableDigest } from "@/lib/stable-digest";
import { isDeletedAccountMarker } from "@/lib/xero-contact-create-recovery";
import {
  isInheritanceLostEmail,
  isPlaceholderContactEmail,
} from "@/lib/placeholder-contact-email";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { namesAppearToMatchMemberAndContact } from "@/lib/xero-contact-link-mismatches";
import { normalizeXeroContactMatchValue } from "@/lib/xero-contact-name-match";
import {
  XeroContactTwoHomesError,
  XERO_CONTACT_TWO_HOMES_CODE,
} from "@/lib/xero-contact-home";
import {
  buildMemberFullName,
  findOrCreateXeroContact,
  getMissingFieldsForXeroContactCreate,
  XeroContactCreatePartialSuccessError,
  XeroContactProviderAnswerUnavailableError,
} from "@/lib/xero-contacts";
import { assertXeroProviderWriteAllowed } from "@/lib/xero-environment-write-gate";
import {
  CONTACT_SYNC_CURSOR_RESOURCE,
  DEFAULT_XERO_SYNC_SCOPE,
} from "@/lib/xero-inbound/constants";
import { getXeroGroupingMode } from "@/lib/xero-member-grouping";

/**
 * Xero's per-minute API budget, which is what really bounds a chunk. Stated
 * here rather than imported because it is used as an ARITHMETIC BASIS for the
 * chunk sizes below, not as the limiter — `callXeroApi` owns the enforcement.
 */
const XERO_CALLS_PER_MINUTE = 60;

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
const CALLS_PER_MEMBER_WITHOUT_GROUPING = 2;
const CALLS_PER_MEMBER_WITH_GROUPING = 4;

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
const CHUNK_WALL_CLOCK_BUDGET_MS = 45_000;

/** Beyond this the cached contact list is old enough to mislead (#2939). */
export const CONTACT_CACHE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The chunk size for this installation, derived from what a member really
 * costs. Exported so the panel's button label and the route's default are the
 * same number as the loop's — it is the only place the operator learns the
 * batch size.
 */
export async function getSeedingChunkSize(): Promise<number> {
  const mode = await getXeroGroupingMode();
  return mode === "NONE"
    ? DEFAULT_SEEDING_CHUNK
    : DEFAULT_SEEDING_CHUNK_WITH_GROUPING;
}

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

type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  role: string;
  xeroContactId: string | null;
};

function displayName(member: MemberRow): string {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

/**
 * The member's name as the funnel would build it, normalised the way the
 * provider-side name comparison normalises. `buildMemberFullName` rather than a
 * second spelling: it is the exact value `findExistingXeroContactByExactName`
 * is handed on the recovery path this index exists to pre-empt (`INV-SSOT`).
 */
function normalisedMemberName(member: MemberRow): string {
  return normalizeXeroContactMatchValue(buildMemberFullName(member));
}

function toRef(member: MemberRow): MissingContactMemberRef {
  return {
    memberId: member.id,
    memberName: displayName(member),
    memberEmail: member.email,
  };
}

/**
 * The reviewed plan, as a value two runs can compare. Ordered by member id so
 * two dry-runs of the same state agree whatever order Postgres returned rows
 * in, and carrying the expected action so a member who moved from "link this
 * contact" to "create one" reads as a changed plan rather than an unchanged one.
 *
 * `stableDigest` rather than a fourth hand-rolled sha256-of-`JSON.stringify`:
 * raw stringify is insertion-ordered, which is the defect that module exists to
 * prevent, and `INV-SSOT` has one home for exactly this. The sibling feature
 * this tool is modelled on name-for-name is the next caller due to move.
 */
function computePlannedDigest(rows: PushableMemberRow[]): string {
  return stableDigest(
    rows
      .map((row) => [row.memberId, row.evidence, row.cachedXeroContactId])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

function emptySnapshot(
  lastRefreshedAt: string | null,
  chunkSize: number,
): MissingContactSnapshot {
  return {
    cacheReady: false,
    contactCacheLastRefreshedAt: lastRefreshedAt,
    contactCacheAgeHours: null,
    contactCacheStale: false,
    plannedDigest: computePlannedDigest([]),
    chunkSize,
    estimatedXeroCallsPerChunk: 0,
    eligible: 0,
    alreadyLinked: 0,
    unlinked: 0,
    pushable: 0,
    excluded: 0,
    ambiguous: 0,
    pushableRows: [],
    excludedRows: [],
    ambiguousRows: [],
  };
}

/**
 * Member ids this club invented as a school's booking contact.
 *
 * BOTH GENERATIONS of the school tie, because the `organisationId` columns are
 * written only from #3367 onwards: a school that booked before it carries
 * neither, and a booking-only read would call every one of those invented
 * records an ordinary person. `takeXeroContactFromSchoolsOwnMember`
 * (`xero-contact-home.ts`) reads the same two generations and states WHY they
 * both have to be read; that reasoning is not repeated here.
 *
 * IT IS NOT THE SAME READ, and the differences are deliberate rather than
 * accidental. The transfer asks "does this member's history resolve to THIS
 * organisation, and to no other", so it is organisation-scoped, excludes
 * login-capable members, and resolves free text through the shared
 * `isSameOrganisationName` matcher. This asks the much cruder question "was
 * this record invented as some school's contact at all", so it is
 * organisation-agnostic, and any non-null `schoolName` is a tie. Every
 * divergence errs towards EXCLUDING MORE, which is the safe direction for a
 * tool that mints provider contacts: a false exclusion costs an operator one
 * manual push from the member's own screen, a false inclusion mints a person
 * contact for a school.
 *
 * Deliberately NOT narrowed by `canLogin` for the same reason: a login-capable
 * member owning a school booking is an anomaly, and an anomaly belongs in front
 * of an operator rather than hidden.
 *
 * The request TYPE is read as well as the two link columns (#2939 review). A
 * `SCHOOL` request whose `schoolName` is genuinely null and whose
 * `organisationId` has not been written yet escaped both columns, so the one
 * discriminator the model actually has answered the question nothing else
 * could.
 */
async function findSchoolBookingContactIds(): Promise<Set<string>> {
  const [bookings, requests] = await Promise.all([
    prisma.booking.findMany({
      where: { organisationId: { not: null } },
      select: { memberId: true },
      distinct: ["memberId"],
    }),
    prisma.bookingRequest.findMany({
      where: {
        convertedMemberId: { not: null },
        OR: [
          { type: "SCHOOL" },
          { organisationId: { not: null } },
          { schoolName: { not: null } },
        ],
      },
      select: { convertedMemberId: true },
      distinct: ["convertedMemberId"],
    }),
  ]);

  const ids = new Set<string>();
  for (const booking of bookings) ids.add(booking.memberId);
  for (const request of requests) {
    if (request.convertedMemberId) ids.add(request.convertedMemberId);
  }
  return ids;
}

type CachedContact = {
  contactId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
};

/**
 * Every ACTIVE cached Xero contact, indexed on BOTH axes the funnel can match
 * on: the lower-cased email address, and the normalised contact name.
 *
 * ONE query rather than a per-member lookup: Prisma cannot express a
 * case-insensitive `in`, and a round trip per member is the shape this tool
 * exists to avoid. Bounded by the club's Xero contact count, which the same
 * cache already holds in full for the inbound sync.
 *
 * THE NAME INDEX IS THE SECOND AXIS, added because leaving it out was the gap
 * this tool exists to avoid (#2939 review). The email index answers "does Xero
 * already hold a customer at this address"; the name index answers "will Xero
 * REFUSE a create for this member because it already holds a customer with this
 * name", which is a different question with a different answer and the only one
 * of the two the provider enforces. It is normalised with
 * `normalizeXeroContactMatchValue` — the same normaliser
 * `findExistingXeroContactByExactName` compares with — so a name this index
 * finds is exactly a name the funnel's recovery would have adopted on.
 *
 * Contacts with no email address are now kept: they are invisible on the email
 * axis and perfectly visible on the name one.
 */
async function loadCachedContacts(): Promise<{
  byEmail: Map<string, CachedContact[]>;
  byNormalisedName: Map<string, CachedContact[]>;
}> {
  const rows = await prisma.xeroContactCache.findMany({
    where: { contactStatus: "ACTIVE" },
    select: {
      contactId: true,
      name: true,
      firstName: true,
      lastName: true,
      emailAddress: true,
    },
  });

  const byEmail = new Map<string, CachedContact[]>();
  const byNormalisedName = new Map<string, CachedContact[]>();
  for (const row of rows) {
    const email = row.emailAddress?.trim().toLowerCase();
    if (email) {
      const list = byEmail.get(email) ?? [];
      list.push(row);
      byEmail.set(email, list);
    }
    // The name Xero itself shows, built the one way this application builds it,
    // then normalised the one way it compares them.
    const name = normalizeXeroContactMatchValue(
      row.name ?? `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
    );
    if (name) {
      const list = byNormalisedName.get(name) ?? [];
      list.push(row);
      byNormalisedName.set(name, list);
    }
  }
  return { byEmail, byNormalisedName };
}

/**
 * The read-only census. No provider call, no write, no enqueue, no audit row.
 */
export async function getXeroMissingContactSnapshot(options?: {
  limit?: number;
}): Promise<MissingContactSnapshot> {
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: { lastSuccessfulSyncAt: true },
  });
  const lastRefreshedAt = cursor?.lastSuccessfulSyncAt?.toISOString() ?? null;
  const chunkSize = await getSeedingChunkSize();
  if (!lastRefreshedAt) return emptySnapshot(null, chunkSize);
  const cacheAgeMs = Date.now() - new Date(lastRefreshedAt).getTime();
  const contactCacheAgeHours = Math.max(0, Math.floor(cacheAgeMs / 3_600_000));
  const contactCacheStale = cacheAgeMs > CONTACT_CACHE_STALE_AFTER_MS;

  const [members, schoolContactIds, cached] = await Promise.all([
    prisma.member.findMany({
      where: { active: true, archivedAt: null },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        passwordHash: true,
        role: true,
        xeroContactId: true,
      },
    }),
    findSchoolBookingContactIds(),
    loadCachedContacts(),
  ]);
  const { byEmail: cachedByEmail, byNormalisedName: cachedByName } = cached;

  const excludedRows: ExcludedMemberRow[] = [];
  const eligible: MemberRow[] = [];

  for (const member of members) {
    const row: MemberRow = member;
    const reason = classifyExclusion(row, schoolContactIds);
    if (reason) {
      excludedRows.push({ ...toRef(row), reason });
      continue;
    }
    eligible.push(row);
  }

  const unlinked = eligible.filter((member) => !member.xeroContactId);
  const alreadyLinked = eligible.length - unlinked.length;

  // Which local record holds each candidate contact. Both tables, because a
  // Xero contact id has two possible homes since #3366 and a member may claim
  // neither of them (INV-INT-018).
  const candidateIds = [
    ...new Set(
      unlinked.flatMap((member) =>
        (cachedByEmail.get(member.email.trim().toLowerCase()) ?? []).map(
          (contact) => contact.contactId,
        ),
      ),
    ),
  ];
  const [heldByMembers, heldByOrganisations] = await Promise.all([
    candidateIds.length
      ? prisma.member.findMany({
          where: { xeroContactId: { in: candidateIds } },
          select: { xeroContactId: true },
        })
      : Promise.resolve([]),
    candidateIds.length
      ? prisma.organisation.findMany({
          where: { xeroContactId: { in: candidateIds } },
          select: { xeroContactId: true },
        })
      : Promise.resolve([]),
  ]);
  const memberHeld = new Set(
    heldByMembers.map((row) => row.xeroContactId).filter(Boolean) as string[],
  );
  const organisationHeld = new Set(
    heldByOrganisations
      .map((row) => row.xeroContactId)
      .filter(Boolean) as string[],
  );

  // Two unlinked members on one address cannot both be given the contact that
  // address resolves to, and nothing here may pick between them.
  const sharedEmails = new Set<string>();
  const seenEmails = new Set<string>();
  for (const member of unlinked) {
    const email = member.email.trim().toLowerCase();
    if (seenEmails.has(email)) sharedEmails.add(email);
    seenEmails.add(email);
  }

  const pushableRows: PushableMemberRow[] = [];
  const ambiguousRows: AmbiguousMemberRow[] = [];

  for (const member of unlinked) {
    const email = member.email.trim().toLowerCase();
    if (sharedEmails.has(email)) {
      ambiguousRows.push({
        ...toRef(member),
        reason: "MEMBERS_SHARE_THE_EMAIL_ADDRESS",
        xeroContactIds: [],
      });
      continue;
    }

    const candidates = cachedByEmail.get(email) ?? [];

    /*
      THE NAME AXIS, asked before any email-axis answer is acted on.

      Xero enforces contact-name uniqueness, so whatever the email axis says, a
      create for this member is refused if an active contact already carries
      this name — and the funnel's recovery then adopts that contact on the
      normalised name ALONE. Any such contact that is not already the email
      candidate is therefore a decision, not a match, and belongs in front of an
      operator. Contacts the email axis already found are excluded: those are
      the same record arriving on the other axis, which is agreement rather than
      collision.
    */
    const sameName = (cachedByName.get(normalisedMemberName(member)) ?? []).filter(
      (contact) =>
        !candidates.some((candidate) => candidate.contactId === contact.contactId),
    );
    if (sameName.length > 0) {
      ambiguousRows.push({
        ...toRef(member),
        reason: "XERO_CONTACT_ALREADY_HAS_THIS_NAME",
        xeroContactIds: sameName.map((contact) => contact.contactId),
      });
      continue;
    }

    if (candidates.length === 0) {
      pushableRows.push({
        ...toRef(member),
        evidence: "NO_CACHED_MATCH",
        cachedXeroContactId: null,
      });
      continue;
    }

    const schoolOwned = candidates.filter((contact) =>
      organisationHeld.has(contact.contactId),
    );
    if (schoolOwned.length > 0) {
      ambiguousRows.push({
        ...toRef(member),
        reason: "XERO_CONTACT_BELONGS_TO_A_SCHOOL",
        xeroContactIds: schoolOwned.map((contact) => contact.contactId),
      });
      continue;
    }

    const takenByMember = candidates.filter((contact) =>
      memberHeld.has(contact.contactId),
    );
    if (takenByMember.length > 0) {
      ambiguousRows.push({
        ...toRef(member),
        reason: "ANOTHER_MEMBER_HOLDS_THE_CONTACT",
        xeroContactIds: takenByMember.map((contact) => contact.contactId),
      });
      continue;
    }

    if (candidates.length > 1) {
      ambiguousRows.push({
        ...toRef(member),
        reason: "SEVERAL_XERO_CONTACTS_SHARE_THE_EMAIL",
        xeroContactIds: candidates.map((contact) => contact.contactId),
      });
      continue;
    }

    // Destructured rather than indexed: the length test above already proved
    // there is exactly one, and a first-with-no-rest read says so to the
    // compiler instead of asserting it away (#2800).
    const [candidate] = candidates;
    if (!candidate) continue;
    // The ONE name-comparison rule this application has, shared with the
    // link-mismatch report and the inbound sync (INV-SSOT). A second spelling
    // of "is this the same person" is how one surface starts accepting what
    // another refuses.
    const namesMatch = namesAppearToMatchMemberAndContact(
      {
        firstName: member.firstName,
        lastName: member.lastName,
        xeroContactId: candidate.contactId,
      },
      candidate,
    );
    if (!namesMatch) {
      ambiguousRows.push({
        ...toRef(member),
        reason: "XERO_CONTACT_NAME_DIFFERS",
        xeroContactIds: [candidate.contactId],
      });
      continue;
    }

    pushableRows.push({
      ...toRef(member),
      evidence: "CACHED_CONTACT_MATCH",
      cachedXeroContactId: candidate.contactId,
    });
  }

  const limit = options?.limit;
  const slice = <T>(rows: T[]): T[] =>
    typeof limit === "number" ? rows.slice(0, Math.max(1, limit)) : rows;

  return {
    cacheReady: true,
    contactCacheLastRefreshedAt: lastRefreshedAt,
    contactCacheAgeHours,
    contactCacheStale,
    plannedDigest: computePlannedDigest(pushableRows),
    chunkSize,
    estimatedXeroCallsPerChunk:
      Math.min(chunkSize, pushableRows.length) *
      (chunkSize === DEFAULT_SEEDING_CHUNK
        ? CALLS_PER_MEMBER_WITHOUT_GROUPING
        : CALLS_PER_MEMBER_WITH_GROUPING),
    eligible: eligible.length,
    alreadyLinked,
    unlinked: unlinked.length,
    pushable: pushableRows.length,
    excluded: excludedRows.length,
    ambiguous: ambiguousRows.length,
    pushableRows: slice(pushableRows),
    excludedRows: slice(excludedRows),
    ambiguousRows: slice(ambiguousRows),
  };
}

function classifyExclusion(
  member: MemberRow,
  schoolContactIds: Set<string>,
): MissingContactExclusion | null {
  if (member.role === "SCHOOL") return "SCHOOL_MEMBER_RECORD";
  if (schoolContactIds.has(member.id)) return "SCHOOL_BOOKING_CONTACT";
  if (isDeletedAccountMarker(member)) return "ANONYMISED_ACCOUNT";
  /*
    The SPECIFIC placeholder before the general one, which is the rule
    `placeholder-contact-email.ts` states at `isInheritanceLostEmail`: the
    general predicate accepts every address this one does, so testing it first
    swallows this reason entirely. It matters because "lost the address they
    used to inherit" is somebody's arrangement having broken, and only that
    reason tells an admin so; "never had one" is a walk-in working as intended.
  */
  if (isInheritanceLostEmail(member.email)) return "INHERITED_ADDRESS_LOST";
  /*
    A club-internal `.invalid` address is not an address. A contact minted on
    one would carry a blank email in Xero, which CAN still be invoiced — that is
    the whole point of the walk-in path — but Xero cannot EMAIL it, and a later
    contact sync cannot MATCH it back by address. Matching would then be left to
    the name alone, which is the exact collision surface the sixth ambiguity
    class above exists to keep an operator's hands on. A walk-in still gets a
    contact through the funnel the first time somebody invoices them, so this
    population is small and self-resolving rather than parked.
  */
  if (isPlaceholderContactEmail(member.email)) return "NO_REAL_EMAIL_ADDRESS";
  // The SAME create gate the funnel applies, from its one home, so a row this
  // reports as pushable cannot be refused by the payload builder a moment later.
  if (getMissingFieldsForXeroContactCreate(member).length > 0) {
    return "INCOMPLETE_DETAILS";
  }
  return null;
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

/** The one contact-home refusal, recognised without depending on a message. */
function isTwoHomesRefusal(error: unknown): boolean {
  return (
    error instanceof XeroContactTwoHomesError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === XERO_CONTACT_TWO_HOMES_CODE)
  );
}

/**
 * How the funnel resolved this contact, read from the fact it persisted rather
 * than inferred: `findOrCreateXeroContact` writes `linkedVia: "created"` on the
 * canonical CONTACT link when it minted one and an `email_match` / `name_match`
 * value when it adopted one. An unlabelled row is reported as unlabelled, never
 * guessed — the count exists to tell an operator how many NEW customers a run
 * added to the club's books.
 */
async function readResolutionLabel(
  memberId: string,
  xeroContactId: string,
): Promise<"created" | "linked" | "unknown"> {
  const link = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Member",
      localId: memberId,
      xeroObjectType: "CONTACT",
      xeroObjectId: xeroContactId,
      role: "CONTACT",
    },
    // At most one row: the five columns above are exactly the model's unique key.
    select: { metadata: true },
  });
  const metadata = link?.metadata;
  const linkedVia =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).linkedVia
      : undefined;
  if (linkedVia === "created") return "created";
  if (typeof linkedVia === "string" && linkedVia.length > 0) return "linked";
  return "unknown";
}

/**
 * Run one bounded chunk. `reviewedMemberIds` is what the operator confirmed;
 * the pushable set is recomputed here from the same classifier the dry run
 * used, and only the intersection is touched. The reviewed half excludes a
 * member who became eligible after the review; the recomputed half excludes a
 * reviewed member who has since stopped being pushable. See `INV-INT-022`.
 *
 * ## Three guards, and each one closes a different door
 *
 * `reviewedPlannedDigest` is what the operator reviewed, as a value. It is
 * COMPARED, not merely recorded: the membership test above is blind to a member
 * whose plan CHANGED while staying pushable — the operator approves "link Jane
 * to the contact Xero already has", the contact sync archives it underneath
 * them, and the member is still pushable, now as a CREATE. The sibling
 * grouping-resync refuses with `plan_changed` in exactly this situation; this
 * refuses with {@link SeedingPlanChangedError}.
 *
 * `requireAuthoritativeMatch` is passed to every funnel call, so a member whose
 * Xero search fails, or whose name collides with a contact Xero already holds,
 * is RECORDED AS A FAILURE and left where they were rather than being given a
 * speculative new contact or somebody else's old one. The next run picks them
 * up unchanged. A plan digest cannot catch that class, because the divergence
 * happens inside the funnel after the plan has already matched.
 *
 * The returned contact id is compared against the one the plan promised. When
 * the plan said "link to contact X" and the funnel linked to something else,
 * that is a `PLAN_DIVERGED` failure rather than a success — the count an
 * operator reads must never say "linked to a contact Xero already had" about a
 * link nobody reviewed.
 */
export async function runXeroMissingContactSeedingChunk(options: {
  reviewedMemberIds: string[];
  /** The `plannedDigest` of the dry run the operator reviewed. */
  reviewedPlannedDigest?: string;
  limit?: number;
  createdByMemberId?: string;
  /** Test seam for the wall-clock budget, in milliseconds since the loop began. */
  elapsedMs?: () => number;
}): Promise<SeedingRunResult> {
  const result: SeedingRunResult = {
    processed: 0,
    linkedExisting: 0,
    created: 0,
    resolvedUnlabelled: 0,
    failed: 0,
    failures: [],
    outcomes: [],
    skipped: [],
    remaining: 0,
    outstandingPushable: 0,
    done: true,
    haltedByDailyLimit: false,
    haltedByTimeBudget: false,
  };

  // The environment gate, asked ONCE and before anything else (#2986). The
  // funnel asks it again per member and `callXeroApi` refuses every mutation
  // underneath that, so this is a courtesy to the operator rather than the
  // control: it turns N identical refusals into one, and it cannot be the thing
  // that lets a run through, because it only ever throws.
  await assertXeroProviderWriteAllowed("createContacts");

  const snapshot = await getXeroMissingContactSnapshot();

  /*
    The plan check, BEFORE anything is touched, so a refusal here can leave
    nothing partial behind: no provider call has happened yet.
  */
  if (
    options.reviewedPlannedDigest !== undefined &&
    options.reviewedPlannedDigest !== snapshot.plannedDigest
  ) {
    throw new SeedingPlanChangedError();
  }

  const pushableById = new Map(
    snapshot.pushableRows.map((row) => [row.memberId, row]),
  );
  const reviewed = [...new Set(options.reviewedMemberIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  /*
    Which reviewed members already hold a contact. This is what separates "an
    earlier chunk of this same review already did them" from "this member
    stopped being pushable" — two states the run used to report as one number,
    and only the second is something an operator has to look at.
  */
  const alreadyLinkedIds = new Set(
    (
      await prisma.member.findMany({
        where: { id: { in: reviewed }, xeroContactId: { not: null } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  const targets: string[] = [];
  for (const memberId of reviewed) {
    if (pushableById.has(memberId)) targets.push(memberId);
    else {
      result.skipped.push({
        memberId,
        reason: alreadyLinkedIds.has(memberId)
          ? "ALREADY_DONE"
          : "NO_LONGER_PUSHABLE",
      });
    }
  }

  const chunkSize = Math.max(1, options.limit ?? snapshot.chunkSize);
  const chunk = targets.slice(0, chunkSize);

  // A REAL stopwatch. `Date.now()` is frozen for every unit test in this
  // repository, so a deadline built from it can never expire (docs/TESTING.md).
  const startedAt = process.hrtime.bigint();
  const elapsedMs =
    options.elapsedMs ??
    (() => Number(process.hrtime.bigint() - startedAt) / 1_000_000);

  let attempted = 0;
  for (const memberId of chunk) {
    /*
      The wall-clock budget. A route killed by its host's timeout loses the
      WHOLE result — the summary audit row is written after this returns — while
      every contact it created stays in Xero. Stopping and returning a partial
      result is strictly better than losing the record of one. Checked after at
      least one member so a chunk always makes progress.
    */
    if (attempted > 0 && elapsedMs() > CHUNK_WALL_CLOCK_BUDGET_MS) {
      result.haltedByTimeBudget = true;
      break;
    }
    attempted += 1;
    const planned = pushableById.get(memberId);
    const ref: MissingContactMemberRef = planned
      ? {
          memberId,
          memberName: planned.memberName,
          memberEmail: planned.memberEmail,
        }
      : { memberId, memberName: memberId, memberEmail: "" };
    try {
      const xeroContactId = await findOrCreateXeroContact(memberId, {
        createdByMemberId: options.createdByMemberId,
        // #2939: if the provider cannot be asked authoritatively, do nothing
        // for this member. See the docblock above.
        requireAuthoritativeMatch: true,
      });

      /*
        THE PLAN COMPARISON. A reviewed row that named a contact was reviewed AS
        that contact; the funnel resolving a different one is a divergence the
        operator never saw, not a success. The local link is already written by
        the time this reads it — the funnel owns that write and second-guessing
        it here would be a different bug — so this is reported loudly rather
        than reversed, with BOTH ids, which is what makes it actionable.
      */
      if (
        planned?.cachedXeroContactId &&
        planned.cachedXeroContactId !== xeroContactId
      ) {
        result.failed += 1;
        const message =
          "The dry run said this member would be linked to Xero contact " +
          `${planned.cachedXeroContactId}, and the run linked them to ` +
          `${xeroContactId} instead. Check both contacts in Xero before ` +
          "raising anything for this member.";
        result.failures.push({
          memberId,
          kind: "PLAN_DIVERGED",
          error: message,
        });
        result.outcomes.push({
          ...ref,
          outcome: "failed",
          xeroContactId,
          plannedEvidence: planned.evidence,
          kind: "PLAN_DIVERGED",
          error: message,
        });
        logger.error(
          { memberId, planned: planned.cachedXeroContactId, xeroContactId },
          "Xero missing-contact seeding: the funnel resolved a contact the reviewed plan did not name",
        );
        continue;
      }

      result.processed += 1;
      const label = await readResolutionLabel(memberId, xeroContactId);
      if (label === "created") result.created += 1;
      else if (label === "linked") result.linkedExisting += 1;
      else result.resolvedUnlabelled += 1;
      result.outcomes.push({
        ...ref,
        outcome:
          label === "created"
            ? "created"
            : label === "linked"
              ? "linked"
              : "unlabelled",
        xeroContactId,
        plannedEvidence: planned?.evidence ?? "NO_CACHED_MATCH",
        kind: null,
        error: null,
      });
    } catch (error) {
      // A daily limit stops the whole run rather than failing every remaining
      // member against a budget that is already spent. What is left stays
      // pushable, so the next dry run finds it unchanged.
      if (error instanceof XeroDailyLimitError) {
        result.haltedByDailyLimit = true;
        finishRun(result, targets.length, snapshot.pushable);
        result.done = false;
        logger.warn(
          { memberId },
          "Xero missing-contact seeding halted by the daily API limit",
        );
        return result;
      }
      result.failed += 1;
      const kind = classifyFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ memberId, kind, error: message });
      result.outcomes.push({
        ...ref,
        outcome: "failed",
        xeroContactId: null,
        plannedEvidence: planned?.evidence ?? "NO_CACHED_MATCH",
        kind,
        error: message,
      });
      // One bad member does not stall the chunk: the funnel has already
      // recorded the operation FAILED and replayable (INV-INT-019), so the
      // next run picks this member up again with nothing duplicated.
      logger.error(
        { err: error, memberId },
        "Xero missing-contact seeding: member failed (continuing)",
      );
    }
  }

  finishRun(result, targets.length, snapshot.pushable);
  return result;
}

/**
 * ONE arithmetic for what is left, applied on EVERY exit.
 *
 * It used to be computed one way on the daily-limit halt and another way on the
 * normal path, so a failed member counted as outstanding in one branch and as
 * done in the other. A member is outstanding here exactly when the run did not
 * RESOLVE a contact for them, which is true on every branch, because every
 * non-resolution — not reached, failed, refused, timed out — leaves the member
 * exactly where they were and therefore pushable again next time.
 *
 * `outstandingPushable` is the same question asked of the whole population
 * rather than the reviewed slice. Past the row limit those are different
 * numbers, and reporting only the second is how the button said "next 25 of
 * 900" while the result said "475 still to do" on the same screen.
 */
function finishRun(
  result: SeedingRunResult,
  targetCount: number,
  populationPushable: number,
): void {
  result.remaining = targetCount - result.processed;
  result.done =
    result.remaining === 0 &&
    !result.haltedByTimeBudget &&
    !result.haltedByDailyLimit;
  result.outstandingPushable = Math.max(
    populationPushable - result.processed,
    result.remaining,
  );
}

/**
 * The failure kind, from the error's own TYPE rather than its message. The
 * two-homes refusal is recognised structurally (by class or by code) because it
 * crosses a module boundary; the rest are plain `instanceof`.
 */
function classifyFailure(error: unknown): SeedingFailureKind {
  if (isTwoHomesRefusal(error)) return "TWO_HOMES_REFUSAL";
  if (error instanceof XeroContactCreatePartialSuccessError) {
    return "PARTIAL_SUCCESS";
  }
  if (error instanceof XeroContactProviderAnswerUnavailableError) {
    return error.phase === "DUPLICATE_NAME_RECOVERY"
      ? "NAME_ALREADY_IN_XERO"
      : "PROVIDER_ANSWER_UNAVAILABLE";
  }
  return "OTHER";
}
