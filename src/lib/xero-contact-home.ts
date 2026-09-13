/**
 * A Xero contact id has AT MOST ONE local home (#3367, stage 2 of programme
 * #2912). `INV-INT-018`, and `INV-INT-020` for the ONE transfer.
 *
 * ## The problem this module exists for, in one paragraph
 *
 * Stage 1 (#3366) gave an organisation its own durable Xero customer link. From
 * that moment a Xero contact id has **two** columns that can hold it —
 * `Member.xeroContactId` and `Organisation.xeroContactId` — each unique within
 * its own table, with nothing able to express "at most one of the two", because
 * no database constraint spans two tables that way. Stage 2 is the release where
 * the second one starts being written, so stage 2's writers are the only thing
 * standing between two local records claiming one Xero customer. If both hold
 * it, the club's books say a school and a person are the same customer, and
 * whichever path runs next decides which one wins.
 *
 * ## It is NOT only a race. It is reachable on purpose.
 *
 * The obvious reading of the watchpoint on #3367 is that this is a hairline
 * concurrency window. It is not. A school's organisation contact carries the
 * school's contact email — the same address the invented school member carries,
 * because both come from the booking request's contact field. And
 * `findOrCreateXeroContact` resolves a member by asking Xero
 * `EmailAddress="…"` FIRST. So the very next path that resolves a Xero contact
 * for a school booking's member — a credit note, a modification credit note, a
 * supplementary invoice, none of which stage 2 moves onto the organisation —
 * would find the ORGANISATION's contact by email and link it to the member.
 * That is deterministic, not a race, and it is why the refusal below is
 * symmetric rather than sitting only on the organisation writer.
 *
 * ## What guarantees it
 *
 * Two things, and both are needed:
 *
 * 1. **{@link assertXeroContactHasNoOtherHome}** — the refusal. It reads the
 *    OTHER table and throws {@link XeroContactTwoHomesError} rather than
 *    guessing which record should win. Refusing is the whole point: the settled
 *    rule on #2912 is that a person's Xero contact is never renamed, reused or
 *    repurposed as the school, and silently letting a member adopt a school's
 *    contact is that rule broken from the database side instead of the provider
 *    side.
 * 2. **{@link lockXeroContactHome}** — a contact-scoped advisory lock, taken by
 *    every writer that links a contact id, so two writers cannot both read "no
 *    other home" and both then write. Without it the check is a read of
 *    uncommitted-invisible state and closes only the deterministic path above,
 *    not the concurrent one.
 *
 * ## Lock tier and order (`INV-LOCK-001`, `INV-LOCK-002`)
 *
 * This is a DOMAIN-KEYED advisory lock — `hashtext` of a namespaced string —
 * which is a deliberately distinct keyspace from the global lock(1) cohort and
 * from the per-lodge capacity key, so it joins neither.
 *
 * **The rule is that the contact-home key is the OUTER lock relative to any
 * `Member` ROW lock.** A writer takes its own entity ADVISORY key first (the
 * member key, or the organisation key), then this one, and only then may it
 * touch a `Member` row — whether by `SELECT … FOR UPDATE` or by an `update`.
 *
 * An earlier revision of this file said instead that the contact-home key is
 * taken LAST and that nothing else is acquired while it is held. That was
 * FALSE, and it described a deadlock: {@link takeXeroContactFromSchoolsOwnMember}
 * takes a `Member` row lock — `tx.member.update` on the holder — while holding
 * this key, and the member-side linkers took the row lock first and then waited
 * for this key. The wait graph closes on the pair the section below calls
 * reachable on purpose (a credit note on a school's earlier booking against the
 * new booking's invoice), and Postgres resolves it by aborting one with
 * `40P01`. Stating the order the code really needs, and moving the two member
 * linkers to match it, is what makes the rule hold rather than merely read well.
 *
 * No provider call may run inside the transaction that holds this key.
 *
 * ## The ONE exception: a school taking its own contact (`INV-INT-020`; owner, 13 Sep 2026)
 *
 * A school that has booked before already has a Xero contact, held by the
 * invented school member of that earlier booking. Refusing there would leave
 * every returning school without an organisation contact, which is not what
 * #3367 asks for. So there is one deliberate, narrow, audited TRANSFER —
 * {@link takeXeroContactFromSchoolsOwnMember} — and nothing else changes: the
 * refusal above still runs, unweakened, immediately after it. The transfer
 * removes a legitimate holder; anybody else is refused exactly as before.
 *
 * The owner overruled the alternative (refuse, and invoice against the member's
 * contact) on two grounds. Every stage of programme #2912 lands on
 * `epic/2725-mad` and the epic reaches `main` as ONE merge, so stage 3's
 * ownership accessor is present the moment any of this touches a deployment —
 * the interval the fallback protected exists only inside the branch. And Xero
 * has no merge-contacts API, but the treasurer can merge two contacts by hand in
 * Xero's own interface, so a duplicate has an ordinary operational remedy.
 *
 * ## This is bounded, and it is meant to be
 *
 * Stage 4 (#3369) removes the invented school member, which is the other home.
 * The overlap opens when stage 2 first links an organisation and closes there.
 * Nothing here is designed to be permanent; what it must be is REAL while it
 * lasts, because the alternative is a rule enforced by the care of whoever
 * writes the next caller.
 */

import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import {
  findOtherSchoolOrganisationsNamed,
  isSameOrganisationName,
} from "@/lib/school-organisations";

/** The advisory-lock keyspace. Namespaced, so it collides with nothing else. */
export const XERO_CONTACT_HOME_LOCK_NAMESPACE = "xero-contact-home";

/** Which local table is claiming, or already holds, a Xero contact id. */
export type XeroContactHome =
  | { kind: "MEMBER"; id: string }
  | { kind: "ORGANISATION"; id: string };

export const XERO_CONTACT_TWO_HOMES_CODE = "XERO_CONTACT_TWO_HOMES";

/**
 * Refusal, not a fallback. The caller is told which record already holds the
 * contact so an officer can unlink the wrong one deliberately; nothing here
 * picks a winner.
 */
export class XeroContactTwoHomesError extends Error {
  readonly code = XERO_CONTACT_TWO_HOMES_CODE;
  readonly xeroContactId: string;
  readonly claimedBy: XeroContactHome;
  readonly heldBy: XeroContactHome;

  constructor(input: {
    xeroContactId: string;
    claimedBy: XeroContactHome;
    heldBy: XeroContactHome;
    heldByLabel: string;
  }) {
    super(
      `Xero contact ${input.xeroContactId} is already the Xero customer for ` +
        `${input.heldBy.kind === "ORGANISATION" ? "organisation" : "member"} ` +
        `${input.heldByLabel}, so it cannot also become the ` +
        `${input.claimedBy.kind === "ORGANISATION" ? "organisation" : "member"} ` +
        "record's Xero customer. One Xero customer belongs to one local record. " +
        "Unlink the existing one first, or create a separate contact " +
        "(INV-INT-018).",
    );
    this.name = "XeroContactTwoHomesError";
    this.xeroContactId = input.xeroContactId;
    this.claimedBy = input.claimedBy;
    this.heldBy = input.heldBy;
  }
}

export function xeroContactHomeLockKey(xeroContactId: string): string {
  return `${XERO_CONTACT_HOME_LOCK_NAMESPACE}:${xeroContactId}`;
}

/**
 * Take the contact-scoped advisory lock for the rest of the transaction.
 *
 * Call it AFTER the writer's own entity ADVISORY key, BEFORE any `Member` row
 * lock, and before the refusal below. Never around a provider call. See "Lock
 * tier and order" above for why the row-lock half of that sentence is the part
 * that matters.
 */
export async function lockXeroContactHome(
  tx: Prisma.TransactionClient,
  xeroContactId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${xeroContactHomeLockKey(xeroContactId)}))`;
}

/**
 * Throw unless the OTHER table's claim on this contact id is empty.
 *
 * Only the other table is consulted: a same-table conflict is already a unique
 * constraint (`Member.xeroContactId` and `Organisation.xeroContactId` are each
 * `@unique`), and `linkMatchedXeroContact` additionally names the member it
 * clashed with. This function covers exactly the gap those cannot: the one that
 * spans two tables.
 */
export async function assertXeroContactHasNoOtherHome(
  tx: Prisma.TransactionClient,
  input: { xeroContactId: string; home: XeroContactHome },
): Promise<void> {
  if (input.home.kind === "MEMBER") {
    const organisation = await tx.organisation.findFirst({
      where: { xeroContactId: input.xeroContactId },
      select: { id: true, name: true },
    });
    if (!organisation) return;
    throw new XeroContactTwoHomesError({
      xeroContactId: input.xeroContactId,
      claimedBy: input.home,
      heldBy: { kind: "ORGANISATION", id: organisation.id },
      heldByLabel: organisation.name,
    });
  }

  const member = await tx.member.findFirst({
    where: { xeroContactId: input.xeroContactId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!member) return;
  throw new XeroContactTwoHomesError({
    xeroContactId: input.xeroContactId,
    claimedBy: input.home,
    heldBy: { kind: "MEMBER", id: member.id },
    heldByLabel: `${member.firstName} ${member.lastName}`.trim(),
  });
}

/**
 * The MEMBER a Xero contact id is currently held by, if any.
 *
 * Read on `Member.xeroContactId`, which is `@unique`, so there is at most one
 * row and `findFirst` cannot silently pick between candidates.
 */
async function findMemberHoldingXeroContact(
  tx: Prisma.TransactionClient,
  xeroContactId: string,
): Promise<{ id: string; canLogin: boolean } | null> {
  return tx.member.findFirst({
    where: { xeroContactId },
    select: { id: true, canLogin: true },
  });
}

/** What a completed transfer moved, for the caller's op-log and the PR's evidence. */
export type XeroContactTransferFromMember = {
  /** The member record that held the contact and no longer does. */
  fromMemberId: string;
  xeroContactId: string;
  /** `Member`-side CONTACT ledger rows retired with the link. */
  deactivatedLinkRows: number;
};

/**
 * THE ONE TRANSFER: an organisation takes the Xero contact its OWN invented
 * school member is holding. Owner decision, 13 September 2026 (#3367).
 *
 * Returns `null` — having written nothing — whenever the holder is anybody
 * else, which leaves {@link assertXeroContactHasNoOtherHome} to refuse exactly
 * as it did before. **Call it immediately before that refusal, never instead of
 * it**: the transfer's job is to remove a legitimate holder, and the refusal is
 * still what decides every other case. Composed that way, a transfer that fails
 * to fire can only ever produce a refusal, never a wrong adoption.
 *
 * ## Establishing that the member is the school's OWN
 *
 * Not taken from the caller — a caller-supplied member id would make the
 * transfer fire on whatever a mistaken call site passed. All four legs are read
 * from the database inside the locked transaction:
 *
 * 1. **This school's history resolves to it** (see the next section).
 * 2. **No OTHER school's history does.** A booking contact shared by two
 *    schools belongs to neither, and handing it to whichever invoices first is
 *    precisely the guess this module exists to refuse.
 * 3. **It cannot sign in.** An invented record, never a person with an account.
 * 4. **It is not one of this school's named people.** Teachers are recorded as
 *    `OrganisationContact` rows and are pushed to Xero as contact persons on the
 *    school's own record; a teacher's personal Xero contact is exactly what
 *    #2912 settled must never be repurposed as the school.
 *
 * ## WHY THE FIRST TWO LEGS DO NOT READ `Booking.organisationId` ALONE
 *
 * Because the returning school — the entire case this transfer exists for —
 * does not have one. `Booking.organisationId` is written in exactly one place,
 * at approval, from THIS release, and nothing backfills it. So a school that
 * booked before this release has an earlier booking whose `organisationId` is
 * `NULL`, and reading only that column would make leg 1 answer "no" for every
 * such school: the transfer would never fire, the refusal immediately after it
 * would throw, and the school's invoice would fail on every retry for ever,
 * because nothing else ever writes `Organisation.xeroContactId`. That is an END
 * STATE, not a window — no later stage of this programme repairs it.
 *
 * The durable tie already exists, on columns that predate this release.
 * `BookingRequest` carries `convertedMemberId` — the invented school member the
 * request converted into, written once at conversion and never rewritten — and
 * `schoolName`, the free text the requester typed, present on EVERY school
 * request including every historical one. Together they answer "whose school
 * was this member invented for?" for a pre-release booking exactly as
 * `Booking.organisationId` answers it for a new one.
 *
 * So each leg reads BOTH generations:
 *
 * - **Leg 1 accepts** a `Booking` carrying this organisation, OR a
 *   `BookingRequest` this member converted that carries this organisation, OR a
 *   `BookingRequest` this member converted whose `schoolName` normalises equal
 *   to this organisation's name.
 * - **Leg 2 refuses** on a `Booking` carrying a DIFFERENT organisation, on a
 *   converted `BookingRequest` carrying a different organisation, or on one
 *   whose free-text `schoolName` POSITIVELY resolves to a different existing
 *   `Organisation`. The name half is what lets leg 2 see pre-release history at
 *   all: without it a member who served two schools before this release passes
 *   every leg, and one school walks off with the other's Xero customer.
 *
 * **Why leg 2 asks the database rather than stopping at "the text differs".**
 * Free-text inequality is weak evidence for a refusal that has no remedy. A
 * converted request naming a school the club never created a record for — a
 * typo, a school that booked once and never returned, a request that was
 * declined — would otherwise out-vote history that positively resolves, and the
 * school in front of us could never be invoiced at all. A name that answers to
 * an actual other `Organisation` is evidence; a name that answers to nothing is
 * ambiguity, and ambiguity does not refuse. The lookup goes through
 * {@link findOtherSchoolOrganisationsNamed} so "which record does this name
 * claim?" is asked exactly as the approval resolve asks it (`INV-SSOT`).
 *
 * **And the name comparison is the CONTACT-MATCH rule, never a stricter one.**
 * {@link isSameOrganisationName} folds punctuation, accents, case and
 * whitespace, which is what Xero's own exact-name search folds — so the school
 * this contact was matched FOR is the school these legs recognise. An earlier
 * revision compared whitespace and case only. That was stricter than the search
 * that produced the candidate, so a school recorded once as `St. Peter's
 * College` and typed on its return as `St Peter's College` was handed to this
 * transfer by Xero and then judged a different school by leg 1: no evidence,
 * the refusal below threw, and the invoice failed on every replay for ever. A
 * proof may never be stricter than the match that produced its candidate.
 *
 * The comparison runs in TypeScript, over the small bounded set of requests this
 * member converted, because no Prisma `where` expresses that folding.
 *
 * ## Why neither record can end up holding the id twice, or neither
 *
 * Both writes are ordinary statements in the caller's transaction, so they
 * commit or roll back together: a failure anywhere later leaves the member
 * holding the contact, which is the state it was already in. The contact-home
 * advisory lock is held for the whole of it, so no concurrent linker can claim
 * the id in the gap between the clear and the set. And the audit row is written
 * on the same client, so a recorded hand-over that did not happen is impossible
 * in either direction.
 *
 * A contact may therefore change hands EXACTLY ONCE, and only towards an
 * organisation: nothing here ever moves a contact back, or between two members.
 *
 * ## The window this opens inside the epic branch, and why that is acceptable
 *
 * Between this stage and stage 3 (#3368) the member-keyed paths — a credit note
 * or a supplementary invoice on that earlier booking — still resolve a contact
 * through the member whose link this transfer released. They search Xero by
 * email, find the organisation's contact, and are REFUSED by the rule above:
 * loudly, replayably, and never with an invoice raised against a customer
 * nobody chose. That window exists only inside `epic/2725-mad`, which reaches
 * `main` as ONE merge; #3368 is where those paths defer to the Organisation,
 * and it is present the moment any of this touches a deployment.
 */
export async function takeXeroContactFromSchoolsOwnMember(
  tx: Prisma.TransactionClient,
  input: {
    organisationId: string;
    organisationName: string;
    xeroContactId: string;
    /** The officer whose action caused this, when there is one. */
    actorMemberId?: string | null;
  },
): Promise<XeroContactTransferFromMember | null> {
  const holder = await findMemberHoldingXeroContact(tx, input.xeroContactId);
  if (!holder) return null;

  // The BOTH-GENERATIONS read. One query per generation, both keyed on the
  // holder, both bounded: a `Booking` set narrowed to the rows that carry any
  // organisation at all, and the requests this member was converted from.
  // Fetched rather than counted because leg 1 and leg 2 are answered from the
  // SAME rows, and because the name comparison happens here, not in SQL.
  const [organisationBookings, convertedRequests] = await Promise.all([
    tx.booking.findMany({
      where: { memberId: holder.id, organisationId: { not: null } },
      select: { organisationId: true },
      distinct: ["organisationId"],
    }),
    tx.bookingRequest.findMany({
      where: { convertedMemberId: holder.id },
      select: { organisationId: true, schoolName: true },
    }),
  ]);

  // Leg 1 — this school's history resolves to this member, in either generation.
  const isThisSchool = (row: {
    organisationId: string | null;
    schoolName?: string | null;
  }) =>
    row.organisationId === input.organisationId ||
    // Only where the row names no organisation: a request already resolved to a
    // DIFFERENT school is that school's, whatever text it was typed from.
    (row.organisationId === null &&
      isSameOrganisationName(row.schoolName, input.organisationName));
  const ownHistory =
    organisationBookings.some(isThisSchool) ||
    convertedRequests.some(isThisSchool);
  if (!ownHistory) return null;

  // Leg 2 — and no OTHER school's does. A row belongs to another school when it
  // RESOLVES to one: it names another organisation, or its free text answers to
  // an actual other `Organisation` record. A row whose name is absent, or names
  // a school this club has no record of, is ambiguity rather than evidence and
  // does not refuse on its own — leg 1 is what has to be positively
  // established, and it already has been.
  const namesAnotherOrganisation = (row: { organisationId: string | null }) =>
    row.organisationId !== null && row.organisationId !== input.organisationId;
  if (
    organisationBookings.some(namesAnotherOrganisation) ||
    convertedRequests.some(namesAnotherOrganisation)
  ) {
    return null;
  }

  // The pre-release half: free text on requests that resolved to no school at
  // all. Only names that are not THIS school's are asked about, so a punctuation
  // variant of this school's own name is never carried into the question.
  const otherSchoolNames = convertedRequests
    .filter(
      (row) =>
        row.organisationId === null &&
        Boolean(row.schoolName?.trim()) &&
        !isSameOrganisationName(row.schoolName, input.organisationName),
    )
    .map((row) => row.schoolName);
  if (otherSchoolNames.length > 0) {
    const otherSchools = await findOtherSchoolOrganisationsNamed(tx, {
      names: otherSchoolNames,
      excludeOrganisationId: input.organisationId,
    });
    if (otherSchools.length > 0) return null;
  }

  // Leg 3 — an invented record, not a person who signs in.
  if (holder.canLogin) return null;

  // Leg 4 — not one of this school's named contact people.
  const namedPerson = await tx.organisationContact.findUnique({
    where: {
      organisationId_memberId: {
        organisationId: input.organisationId,
        memberId: holder.id,
      },
    },
    select: { id: true },
  });
  if (namedPerson) return null;

  await tx.member.update({
    where: { id: holder.id },
    data: { xeroContactId: null },
  });
  /*
    The member's canonical CONTACT ledger rows go with the column, the way
    member merge retires a loser's identity links.

    SCOPED TO THIS MEMBER, THIS OBJECT TYPE AND THIS CONTACT ID — and
    deliberately NOT to `role`, which this `where` does not name. So every
    active `Member` link to THIS contact id is deactivated, whatever role it
    carries, not only the canonical `CONTACT` one.

    Deactivating more is the safe direction and it is what makes the inbound
    analysis hold. `xero-inbound/contact.ts` resolves a contact webhook's local
    target by reading ACTIVE `Member` links with `role: "CONTACT"`, so that role
    must go or an inbound patch would still be applied to a member that no
    longer owns the contact. Naming the role here would close exactly that one
    and leave any other role on the same id asserting a link that is no longer
    true; not naming it closes them all. A link on the same record to a
    DIFFERENT contact id is untouched, which is the separation that matters.
  */
  const deactivated = await tx.xeroObjectLink.updateMany({
    where: {
      localModel: "Member",
      localId: holder.id,
      xeroObjectType: "CONTACT",
      xeroObjectId: input.xeroContactId,
      active: true,
    },
    data: { active: false },
  });

  /*
    AUDITED, and in the same transaction as the move it describes.

    Category `xero` — the subsystem test in `INV-PRIV-013`: every other writer
    of a member's Xero contact link already records under `xero`
    (`xero.contact.synced_to_member`), so `xero` is the category that keeps the
    subsystem uniform and any other choice would SPLIT it, which is the defect
    that rule exists to prevent. `xero` correlates behind Support + Finance
    (`docs/guides/audit-log.md`), which is who reads a contact-identity change.

    `critical` severity, so `classifyAuditRetention` keeps it for the critical
    term: which local record owns a Xero customer is the club's own record of
    its accounting identity, and the move is not reversible by this code.

    No names and no addresses in the metadata (`INV-PRIV`): ids only, plus the
    school's own name, which is not a person's.
  */
  await createAuditLog(
    {
      action: "xero.contact.moved_to_organisation",
      memberId: input.actorMemberId ?? null,
      targetId: input.organisationId,
      subjectMemberId: holder.id,
      entityType: "Organisation",
      entityId: input.organisationId,
      category: "xero",
      severity: "critical",
      outcome: "success",
      summary: "Xero contact moved from a school's member record to the school",
      details:
        `The Xero customer for "${input.organisationName}" now belongs to the ` +
        "school's own record rather than to the booking contact that was " +
        "invented for it. Nothing changed in Xero: the contact keeps its id, " +
        "its history and every invoice raised against it (INV-INT-020).",
      metadata: {
        xeroContactId: input.xeroContactId,
        fromMemberId: holder.id,
        toOrganisationId: input.organisationId,
        organisationName: input.organisationName,
        deactivatedMemberContactLinks: deactivated.count,
      },
    },
    tx,
  );

  return {
    fromMemberId: holder.id,
    xeroContactId: input.xeroContactId,
    deactivatedLinkRows: deactivated.count,
  };
}
