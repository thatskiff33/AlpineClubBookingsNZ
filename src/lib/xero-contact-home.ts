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
 * ## This is bounded, and it is meant to be
 *
 * Stage 4 (#3369) removes the invented school member, which is the other home.
 * The overlap opens when stage 2 first links an organisation and closes there.
 * Nothing here is designed to be permanent; what it must be is REAL while it
 * lasts, because the alternative is a rule enforced by the care of whoever
 * writes the next caller.
 */

import type { Prisma } from "@prisma/client";

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
