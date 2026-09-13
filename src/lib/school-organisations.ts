/**
 * Resolving a school's `Organisation` record from the name on a booking request
 * (#3367, stage 2 of programme #2912). `INV-SSOT`, `INV-CONFIG-001`,
 * `INV-LOCK-001`.
 *
 * ## One home for "which school is this?"
 *
 * Approval is the first caller; request editing (#2936) and stage 4's
 * classification backfill (#3369) are the next two, and all three have to agree
 * on when two spellings are the same school or the club ends up with two records
 * for one name and two Xero customers behind them. So the matching rule lives
 * here and nowhere else.
 *
 * ## The rule, and what it deliberately is NOT
 *
 * A school name is free text — what counts as one varies by country and by club,
 * so nothing here encodes a format (`INV-CONFIG-001`). Two names are the same
 * school when they match once punctuation, accents, case and runs of whitespace
 * are folded away. That is it: **no fuzzy matching, no near-miss merging, no
 * stemming.** The binding classification rule on #2912 forbids a fuzzy merge
 * outright, and this is the runtime half of the same rule — "Tokoroa Primary"
 * and "Tokoroa Primary School" are two schools here, and an officer who knows
 * better merges them deliberately rather than having it guessed.
 *
 * ## TWO QUESTIONS, AND THEY ARE NOT THE SAME QUESTION
 *
 * {@link resolveOrCreateSchoolOrganisation} asks **which record does this name
 * claim?** — and it asks Postgres, with a case-insensitive equality on the
 * whitespace-normalised name, because that is the claim two concurrent
 * approvals race for. {@link isSameOrganisationName} asks **does this free text
 * name the same school as that record?**, in TypeScript, over a small fetched
 * set, and it is the one used to PROVE that a Xero contact matched by name
 * belongs where the provider said it did.
 *
 * The proof is deliberately COARSER than the claim, and never the other way
 * round. Xero's own name search folds punctuation and accents, so it hands back
 * one contact for `St. Peter's College` and `St Peter's College`; a proof that
 * called those two different schools would refuse the very row the search
 * accepted, and school names are full of apostrophes and full stops. Coarser is
 * safe — every name that claims a record also satisfies the proof — whereas
 * stricter re-opens exactly the defect `INV-INT-018` exists to close. The
 * folding itself lives in `xero-contact-name-match.ts`, in ONE place, so the
 * search and the proof cannot drift apart (`INV-SSOT`).
 *
 * The cost of the coarser proof is bounded and it is the right way round: a
 * punctuation variant typed at approval still MINTS a second record (the claim
 * is unchanged), and the proof then lets that record take the Xero contact its
 * own earlier booking created. Two records for one school is an officer's merge;
 * a school that can never be invoiced is not.
 *
 * ## The unique-name claim (`INV-LOCK-001`)
 *
 * `Organisation.name` carries no database uniqueness, on purpose: two clubs, two
 * kinds, and eventually two campuses of one trust are all legitimate reasons for
 * a repeated name, and a unique index would be a migration this stage does not
 * need. What stops two concurrent approvals minting two schools for one name is
 * that {@link resolveOrCreateSchoolOrganisation} is only ever called INSIDE the
 * approval transaction, which already holds the canonical global
 * `pg_advisory_xact_lock(1)` for its whole life — so school approvals are
 * serialised against each other and the read-then-create below cannot interleave.
 * Calling this outside that lock would reintroduce the race it is relying on.
 *
 * NOTHING IN THIS FILE ENFORCES THAT, and saying so is the point. A transaction
 * client cannot be asked which advisory locks it holds, so there is no runtime
 * assertion to write here. What enforces it is a disk-scanning census in
 * `src/lib/__tests__/organisation-reader-contract.test.ts` — "the school
 * resolve is called ONLY inside the locked approval transaction" — which reads
 * every file under `src/` and fails if any caller other than
 * `school-booking-request.ts` names this function. Adding a caller therefore
 * means proving the new one holds the lock and amending that census, not
 * trusting this paragraph.
 */

import { OrganisationKind, type Prisma } from "@prisma/client";

import { normalizeXeroContactMatchValue } from "@/lib/xero-contact-name-match";

/** Trim, collapse internal whitespace. The only normalisation there is. */
export function normaliseOrganisationName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * Are these two names the same school?
 *
 * THE ONE TypeScript answer, and it is deliberately the same folding Xero's
 * contact-name search uses — see "Two questions" above. The contact transfer in
 * `xero-contact-home.ts` is the caller that makes that mandatory: it has to
 * decide whether a school's own history names the school whose contact the
 * provider just handed back, and the provider handed it back under exactly this
 * rule. A comparison of its own here would refuse a school recorded once as
 * `St. Peter's College` and typed on its return as `St Peter's College`, and that
 * school's invoice would then fail on every replay, for ever.
 *
 * It is a FOLDING, not a fuzzy match: `Tokoroa Primary` and `Tokoroa Primary
 * School` are still two schools, because #2912 forbids a near-miss merge.
 *
 * Two empty names are never "the same school" — an absent name is not evidence
 * of anything. A name that folds to nothing at all (punctuation only) is empty
 * by the same test and is likewise never a match.
 */
export function isSameOrganisationName(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalizeXeroContactMatchValue(left);
  const b = normalizeXeroContactMatchValue(right);
  if (!a || !b) return false;
  return a === b;
}

/** The column is `VarChar(200)`; a longer name is truncated rather than refused. */
export const MAX_ORGANISATION_NAME_LENGTH = 200;

/**
 * The NAME a school's Xero contact carries, from either local record.
 *
 * ONE home for it, because two records can produce it (`INV-SSOT`). Before this
 * stage a school's contact was created from the invented school member, whose
 * `firstName` column is `VarChar(100)` — so every school contact already in
 * Xero was named with the school truncated at 100 characters. The organisation
 * record holds up to 200.
 *
 * If the organisation sent its longer name, a returning school with a name over
 * 100 characters would not collide with the contact it already has: Xero would
 * accept the create, and the club would end up with two customers for one
 * school — exactly the duplicate this stage exists to avoid. The cap is
 * therefore not a display choice, it is what makes the duplicate-name recovery
 * in `organisation-xero-contacts.ts` find the existing contact.
 */
export const MAX_SCHOOL_XERO_CONTACT_NAME_LENGTH = 100;

export function schoolXeroContactName(name: string): string {
  return normaliseOrganisationName(name)
    .slice(0, MAX_SCHOOL_XERO_CONTACT_NAME_LENGTH)
    .trim();
}

export type ResolvedSchoolOrganisation = {
  id: string;
  name: string;
  created: boolean;
};

/**
 * The CLAIM a school name makes on a record: which row
 * {@link resolveOrCreateSchoolOrganisation} would find for it, expressed as a
 * Prisma filter so the resolve and every reader that asks "does this free text
 * name a school we already have?" ask Postgres the same question (`INV-SSOT`).
 *
 * Case-insensitive equality on the whitespace-normalised, truncated name — the
 * claim, not the proof. See "Two questions" in the module docblock.
 */
export function schoolOrganisationNameClaim(
  name: string,
): Prisma.OrganisationWhereInput {
  return {
    kind: OrganisationKind.SCHOOL,
    name: {
      equals: normaliseOrganisationName(name).slice(
        0,
        MAX_ORGANISATION_NAME_LENGTH,
      ),
      mode: "insensitive",
    },
  };
}

/**
 * Which of these free-text school names POSITIVELY name a school record that is
 * not this one?
 *
 * Read-only, and used as EVIDENCE rather than as a resolve: the contact transfer
 * in `xero-contact-home.ts` asks it before refusing to hand a school its own
 * Xero contact, because free-text inequality on its own is weak evidence that
 * another school is involved. A name nothing answers to is ambiguous — a typo, a
 * school that never booked again, a request the club never converted — and an
 * ambiguous name must not out-vote history that positively resolves.
 *
 * Names are de-duplicated and empty ones dropped, so a request naming one school
 * twice costs one clause. Callers pass the names of ONE member's converted
 * requests, which is a small bounded set.
 */
export async function findOtherSchoolOrganisationsNamed(
  tx: Prisma.TransactionClient,
  input: {
    names: readonly (string | null | undefined)[];
    excludeOrganisationId: string;
  },
): Promise<{ id: string; name: string }[]> {
  const claims = [
    ...new Set(
      input.names
        .map((name) => normaliseOrganisationName(name ?? ""))
        .filter(Boolean),
    ),
  ].map((name) => schoolOrganisationNameClaim(name));
  if (claims.length === 0) return [];

  return tx.organisation.findMany({
    where: { OR: claims, NOT: { id: input.excludeOrganisationId } },
    select: { id: true, name: true },
  });
}

/**
 * The `Organisation` for this school name, creating it on first sight.
 *
 * MUST be called inside a transaction already holding the global booking lock —
 * see the module docblock. An existing record is never renamed and its recorded
 * email and phone are never overwritten: the club's own record of a school
 * outranks whatever one booking request happened to type, and silently
 * rewriting it would change who the next invoice reaches.
 *
 * An ARCHIVED school still matches. Archiving means "stop offering it", not
 * "this is a different school", and its Xero customer is still the right one —
 * so the booking attaches to it, and un-archiving stays an officer's decision.
 * A live record is preferred where both exist.
 */
export async function resolveOrCreateSchoolOrganisation(
  tx: Prisma.TransactionClient,
  input: { name: string; email?: string | null; phone?: string | null },
): Promise<ResolvedSchoolOrganisation> {
  const name = normaliseOrganisationName(input.name).slice(
    0,
    MAX_ORGANISATION_NAME_LENGTH,
  );
  if (!name) {
    throw new Error(
      "A school organisation cannot be resolved from an empty name (#3367).",
    );
  }

  const existing = await tx.organisation.findFirst({
    where: schoolOrganisationNameClaim(name),
    // A live record first, then the oldest, so the answer does not depend on
    // insertion order when a club has archived one and re-created it.
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });
  if (existing) {
    return { id: existing.id, name: existing.name, created: false };
  }

  const created = await tx.organisation.create({
    data: {
      kind: OrganisationKind.SCHOOL,
      name,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
    },
    select: { id: true, name: true },
  });
  return { id: created.id, name: created.name, created: true };
}
