/**
 * The read-only CENSUS of members with no Xero contact (#2939, a child of MAD
 * programme #2725). The rule is `INV-INT-022`; the rule the run this feeds must
 * not break is `INV-INT-018`; the operator guide is `docs/guides/xero.md` ->
 * "Create the missing Xero contacts in bulk" and the longer design rationale is
 * `docs/xero/ARCHITECTURE.md`.
 *
 * The bounded run that acts on this census is
 * `xero-missing-contact-seeding-run.ts`; the shape both return is
 * `xero-missing-contact-seeding-shape.ts`, which imports nothing and says why.
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
 */

import { prisma } from "@/lib/prisma";
import { stableDigest } from "@/lib/stable-digest";
import { isDeletedAccountMarker } from "@/lib/xero-contact-create-recovery";
import {
  isInheritanceLostEmail,
  isPlaceholderContactEmail,
} from "@/lib/placeholder-contact-email";
import { namesAppearToMatchMemberAndContact } from "@/lib/xero-contact-link-mismatches";
import { normalizeXeroContactMatchValue } from "@/lib/xero-contact-name-match";
import {
  buildMemberFullName,
  getMissingFieldsForXeroContactCreate,
} from "@/lib/xero-contacts";
import {
  CONTACT_SYNC_CURSOR_RESOURCE,
  DEFAULT_XERO_SYNC_SCOPE,
} from "@/lib/xero-inbound/constants";
import { getXeroGroupingMode } from "@/lib/xero-member-grouping";
import {
  CALLS_PER_MEMBER_WITH_GROUPING,
  CALLS_PER_MEMBER_WITHOUT_GROUPING,
  CONTACT_CACHE_STALE_AFTER_MS,
  DEFAULT_SEEDING_CHUNK,
  DEFAULT_SEEDING_CHUNK_WITH_GROUPING,
  type AmbiguousMemberRow,
  type ExcludedMemberRow,
  type MissingContactExclusion,
  type MissingContactMemberRef,
  type MissingContactSnapshot,
  type PushableMemberRow,
} from "@/lib/xero-missing-contact-seeding-shape";

/**
 * The chunk size for this installation, derived from what a member really
 * costs. It lives here rather than beside the constants it returns because it
 * READS THE DATABASE, and the shape module deliberately imports nothing.
 * Exported so the panel's button label and the route's default are the same
 * number as the loop's — the label is the only place the operator learns the
 * batch size.
 */
export async function getSeedingChunkSize(): Promise<number> {
  const mode = await getXeroGroupingMode();
  return mode === "NONE"
    ? DEFAULT_SEEDING_CHUNK
    : DEFAULT_SEEDING_CHUNK_WITH_GROUPING;
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
