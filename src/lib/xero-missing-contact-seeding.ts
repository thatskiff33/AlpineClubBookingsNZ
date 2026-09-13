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
 * confidently towards duplicates.
 *
 * ## What the run may touch
 *
 * The intersection of the ids the operator reviewed with a freshly recomputed
 * pushable set, and nothing else. Both halves are load-bearing; `INV-INT-022`
 * is where that is written down, and
 * {@link runXeroMissingContactSeedingChunk} says what each half excludes.
 */

import { createHash } from "node:crypto";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isDeletedAccountMarker } from "@/lib/xero-contact-create-recovery";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { namesAppearToMatchMemberAndContact } from "@/lib/xero-contact-link-mismatches";
import {
  XeroContactTwoHomesError,
  XERO_CONTACT_TWO_HOMES_CODE,
} from "@/lib/xero-contact-home";
import {
  findOrCreateXeroContact,
  getMissingFieldsForXeroContactCreate,
  XeroContactCreatePartialSuccessError,
} from "@/lib/xero-contacts";
import { assertXeroProviderWriteAllowed } from "@/lib/xero-environment-write-gate";

/**
 * The contact-sync watermark this snapshot's freshness is judged against. The
 * inbound sync owns the constant's meaning; it is repeated as a literal here
 * for the same reason `xero-member-import.ts` repeats it — importing it would
 * drag the whole provider-calling sync module into a read-only census.
 */
const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";
const DEFAULT_XERO_SYNC_SCOPE = "default";

/**
 * Members per chunk. Each one costs at most two Xero calls (an email search and
 * a create), so 25 stays far inside the per-minute budget and gives the
 * operator a checkpoint often enough to stop a run that is going wrong.
 */
export const DEFAULT_SEEDING_CHUNK = 25;

/**
 * Why a member is not in the seeding population at all. The first two are the
 * school rule (`Role.SCHOOL`, and a record invented as a school's booking
 * contact whatever role it carries — both belong to an `Organisation` since
 * #3367); then an approved deletion's anonymised marker; a club-internal
 * `.invalid` address, which is not an address; and the funnel's own create gate
 * answering no. The operator-facing wording for each lives in the panel.
 */
export type MissingContactExclusion =
  | "SCHOOL_MEMBER_RECORD"
  | "SCHOOL_BOOKING_CONTACT"
  | "ANONYMISED_ACCOUNT"
  | "NO_REAL_EMAIL_ADDRESS"
  | "INCOMPLETE_DETAILS";

/**
 * Why a member the tool would otherwise push is handed back for an operator to
 * resolve instead. Each is a question with more than one defensible answer, so
 * none of them is guessed: a school already owns the only contact on this
 * address; another member already holds it; two unlinked members share the
 * address; several Xero contacts carry it; or the one that does carries a
 * different name.
 */
export type MissingContactAmbiguity =
  | "XERO_CONTACT_BELONGS_TO_A_SCHOOL"
  | "ANOTHER_MEMBER_HOLDS_THE_CONTACT"
  | "MEMBERS_SHARE_THE_EMAIL_ADDRESS"
  | "SEVERAL_XERO_CONTACTS_SHARE_THE_EMAIL"
  | "XERO_CONTACT_NAME_DIFFERS";

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
  /** Digest of the full pushable plan, before any row limit is applied. */
  plannedDigest: string;
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

function toRef(member: MemberRow): MissingContactMemberRef {
  return {
    memberId: member.id,
    memberName: displayName(member),
    memberEmail: member.email,
  };
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The reviewed plan, as a value two runs can compare. Ordered by member id so
 * two dry-runs of the same state agree whatever order Postgres returned rows
 * in, and carrying the expected action so a member who moved from "link this
 * contact" to "create one" reads as a changed plan rather than an unchanged one.
 */
function computePlannedDigest(rows: PushableMemberRow[]): string {
  return digestOf(
    rows
      .map((row) => [row.memberId, row.evidence, row.cachedXeroContactId])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

function emptySnapshot(lastRefreshedAt: string | null): MissingContactSnapshot {
  return {
    cacheReady: false,
    contactCacheLastRefreshedAt: lastRefreshedAt,
    plannedDigest: computePlannedDigest([]),
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
 * BOTH GENERATIONS, exactly as `takeXeroContactFromSchoolsOwnMember` reads them
 * and for the same reason: the `organisationId` columns are written only from
 * #3367 onwards, so a school that booked before it carries neither and a
 * booking-only read would call every one of those invented records an ordinary
 * person. The free-text `schoolName` on a converted request reaches back past
 * the release. Deliberately NOT narrowed by `canLogin`: a login-capable member
 * owning a school booking is an anomaly, and a tool whose job is minting
 * provider contacts should hand an anomaly to an operator — it is reported,
 * not hidden, and can still be pushed from the member's own screen.
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
        OR: [{ organisationId: { not: null } }, { schoolName: { not: null } }],
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
 * Every ACTIVE cached Xero contact carrying an email address, keyed by the
 * lower-cased address. ONE query rather than a per-member lookup: Prisma cannot
 * express a case-insensitive `in`, and a round trip per member is the shape
 * this tool exists to avoid. Bounded by the club's Xero contact count, which
 * the same cache already holds in full for the inbound sync.
 */
async function loadCachedContactsByEmail(): Promise<Map<string, CachedContact[]>> {
  const rows = await prisma.xeroContactCache.findMany({
    where: { contactStatus: "ACTIVE", emailAddress: { not: null } },
    select: {
      contactId: true,
      name: true,
      firstName: true,
      lastName: true,
      emailAddress: true,
    },
  });

  const byEmail = new Map<string, CachedContact[]>();
  for (const row of rows) {
    const email = row.emailAddress?.trim().toLowerCase();
    if (!email) continue;
    const list = byEmail.get(email) ?? [];
    list.push(row);
    byEmail.set(email, list);
  }
  return byEmail;
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
  if (!lastRefreshedAt) return emptySnapshot(null);

  const [members, schoolContactIds, cachedByEmail] = await Promise.all([
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
    loadCachedContactsByEmail(),
  ]);

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
    plannedDigest: computePlannedDigest(pushableRows),
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
  // A club-internal `.invalid` address is not an address: a contact minted with
  // a blank email cannot be matched on a later sync and cannot be sent an
  // invoice. A walk-in still gets one through the funnel when first invoiced.
  if (isPlaceholderContactEmail(member.email)) return "NO_REAL_EMAIL_ADDRESS";
  // The SAME create gate the funnel applies, from its one home, so a row this
  // reports as pushable cannot be refused by the payload builder a moment later.
  if (getMissingFieldsForXeroContactCreate(member).length > 0) {
    return "INCOMPLETE_DETAILS";
  }
  return null;
}

/** Why one member's push did not happen, in the operator's terms. */
export type SeedingFailureKind = "TWO_HOMES_REFUSAL" | "PARTIAL_SUCCESS" | "OTHER";

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
  /** Reviewed ids that were no longer pushable when the run recomputed. */
  skippedNoLongerPushable: string[];
  /** Reviewed, still pushable, and beyond this chunk's size. */
  remaining: number;
  done: boolean;
  haltedByDailyLimit: boolean;
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
 */
export async function runXeroMissingContactSeedingChunk(options: {
  reviewedMemberIds: string[];
  limit?: number;
  createdByMemberId?: string;
}): Promise<SeedingRunResult> {
  const result: SeedingRunResult = {
    processed: 0,
    linkedExisting: 0,
    created: 0,
    resolvedUnlabelled: 0,
    failed: 0,
    failures: [],
    skippedNoLongerPushable: [],
    remaining: 0,
    done: true,
    haltedByDailyLimit: false,
  };

  // The environment gate, asked ONCE and before anything else (#2986). The
  // funnel asks it again per member and `callXeroApi` refuses every mutation
  // underneath that, so this is a courtesy to the operator rather than the
  // control: it turns N identical refusals into one, and it cannot be the thing
  // that lets a run through, because it only ever throws.
  await assertXeroProviderWriteAllowed("createContacts");

  const snapshot = await getXeroMissingContactSnapshot();
  const pushableById = new Map(
    snapshot.pushableRows.map((row) => [row.memberId, row]),
  );
  const reviewed = [...new Set(options.reviewedMemberIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const targets: string[] = [];
  for (const memberId of reviewed) {
    if (pushableById.has(memberId)) targets.push(memberId);
    else result.skippedNoLongerPushable.push(memberId);
  }

  const chunkSize = Math.max(1, options.limit ?? DEFAULT_SEEDING_CHUNK);
  const chunk = targets.slice(0, chunkSize);
  result.remaining = targets.length - chunk.length;
  result.done = result.remaining === 0;

  for (const memberId of chunk) {
    try {
      const xeroContactId = await findOrCreateXeroContact(memberId, {
        createdByMemberId: options.createdByMemberId,
      });
      result.processed += 1;
      const label = await readResolutionLabel(memberId, xeroContactId);
      if (label === "created") result.created += 1;
      else if (label === "linked") result.linkedExisting += 1;
      else result.resolvedUnlabelled += 1;
    } catch (error) {
      // A daily limit stops the whole run rather than failing every remaining
      // member against a budget that is already spent. What is left stays
      // pushable, so the next dry run finds it unchanged.
      if (error instanceof XeroDailyLimitError) {
        result.haltedByDailyLimit = true;
        result.done = false;
        result.remaining = targets.length - result.processed - result.failed;
        logger.warn(
          { memberId },
          "Xero missing-contact seeding halted by the daily API limit",
        );
        return result;
      }
      result.failed += 1;
      result.failures.push({
        memberId,
        kind: isTwoHomesRefusal(error)
          ? "TWO_HOMES_REFUSAL"
          : error instanceof XeroContactCreatePartialSuccessError
            ? "PARTIAL_SUCCESS"
            : "OTHER",
        error: error instanceof Error ? error.message : String(error),
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

  return result;
}
