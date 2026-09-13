/**
 * A Xero contact id has AT MOST ONE local home (#3367, stage 2 of programme
 * #2912). `INV-INT-018`.
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
 * from the per-lodge capacity key, so it joins neither. It is always taken
 * LAST: a writer takes its own entity key (the member key, or the organisation
 * key) and then this one, so every participant acquires in the same order and
 * no two can deadlock. Nothing else is ever taken while it is held, and no
 * provider call may run inside the transaction that holds it.
 *
 * ## The ONE exception: a school taking its own contact (owner, 13 Sep 2026)
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
 * Call it AFTER the writer's own entity lock and before the refusal below, and
 * never around a provider call.
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
 * 1. **This school's bookings resolve to it.** A `Booking` links this
 *    organisation to this member. That is what "the school's own member" means
 *    operationally — approval creates the invented member and the booking
 *    together, and a returning school's request is mapped onto the same record.
 *    (A `BookingRequest` carries no member of its own; it resolves to one only
 *    through its converted booking, which is the row read here.)
 * 2. **No OTHER school's bookings do.** A shared booking contact used by two
 *    organisations belongs to neither, and handing it to whichever invoices
 *    first is precisely the guess this module exists to refuse.
 * 3. **It cannot sign in.** An invented record, never a person with an account.
 * 4. **It is not one of this school's named people.** Teachers are recorded as
 *    `OrganisationContact` rows and are pushed to Xero as contact persons on the
 *    school's own record; a teacher's personal Xero contact is exactly what
 *    #2912 settled must never be repurposed as the school.
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

  // Leg 1 — this school's bookings resolve to this member.
  const ownBooking = await tx.booking.findFirst({
    where: { organisationId: input.organisationId, memberId: holder.id },
    select: { id: true },
  });
  if (!ownBooking) return null;

  // Leg 2 — and no other school's do.
  const otherSchoolBooking = await tx.booking.findFirst({
    where: {
      memberId: holder.id,
      AND: [
        { organisationId: { not: null } },
        { NOT: { organisationId: input.organisationId } },
      ],
    },
    select: { id: true },
  });
  if (otherSchoolBooking) return null;

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
  // The member's canonical CONTACT ledger row goes with the column, the way
  // member merge retires a loser's identity links. Scoped to this contact id
  // and this role, so an unrelated link on the same record survives.
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
        "its history and every invoice raised against it (INV-INT-018).",
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
