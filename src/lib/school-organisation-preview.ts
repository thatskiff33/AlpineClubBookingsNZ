/**
 * WHICH SCHOOL WOULD THIS REQUEST RESOLVE TO? — the read-only answer an officer
 * needs before correcting a school booking request (#2936, MAD epic #2725).
 *
 * ## Why this exists at all, and why it did not before
 *
 * Until stage 2 of programme #2912 (#3367) a school request's `schoolName` was
 * free text that became a Xero contact's name and nothing else. Correcting it
 * was a spelling fix. It is not any more: approval now resolves that text to an
 * `Organisation` record inside the approval transaction, the booking and the
 * invoice attach to that record, and the record owns a durable Xero customer.
 *
 * So correcting a school's name is no longer a spelling fix — **it is a choice
 * about which school the club is about to invoice.** Two corrections that look
 * identical on the screen do completely different things:
 *
 *   - a misspelling put right, where the club already holds a record under the
 *     corrected spelling, reunites this request with the record and the Xero
 *     customer that school has always had;
 *   - a name shortened or lengthened into one the club does NOT hold mints a
 *     SECOND record at approval, and a second Xero customer behind it, because
 *     `school-organisations.ts` forbids near-miss merging on purpose.
 *
 * The officer cannot tell those apart from the name alone. This module is what
 * tells them, BEFORE the correction is written, and
 * {@link assertSchoolRecordOutcomeAcknowledged} is what refuses a correction
 * whose consequence the officer did not actually see.
 *
 * ## Read-only, and deliberately NOT the resolve
 *
 * `resolveOrCreateSchoolOrganisation` may only be called inside the locked
 * approval transaction — its unique-name claim IS that lock, and a
 * disk-scanning census in `organisation-reader-contract.test.ts` fails if any
 * file other than the approval names it. Nothing here calls it. This asks the
 * SAME question of Postgres through the SAME filter
 * (`schoolOrganisationNameClaim`, the one home for the claim) and only reads,
 * so the claim and the preview cannot drift apart while the preview stays
 * outside the lock, where it belongs.
 *
 * A preview is therefore ADVISORY about timing and EXACT about rule: another
 * approval could create the record between the preview and the correction. That
 * is a race the correction closes by re-asking at write time rather than
 * trusting what the screen said — see {@link assertSchoolRecordOutcomeAcknowledged}.
 *
 * ## Why the vocabulary changes at this module's edge
 *
 * Stage 2's census keeps the set of files that read the organisation link small
 * and argued-for. This module is one of them and is declared there. Everything
 * downstream — the correction service, its route, the officer's panel — takes
 * {@link SchoolRecordPreview}, which is plain strings and booleans: those files
 * consume an ANSWER, they do not read the link. Naming the fields
 * `schoolRecordId` rather than `organisationId` is what keeps that true in fact
 * as well as in intention, so the census stays a contract instead of growing a
 * UI-shaped exemption.
 */

import { OrganisationContactRole, type Prisma } from "@prisma/client";

import {
  MAX_XERO_ORGANISATION_CONTACT_PERSONS,
  organisationContactPersonIdentity,
} from "@/lib/organisation-xero-contact-persons";
import { xeroContactPersonFromMember } from "@/lib/xero-contact-shape";
import type { prisma } from "@/lib/prisma";
import {
  MAX_ORGANISATION_NAME_LENGTH,
  normaliseOrganisationName,
  schoolOrganisationNameClaim,
} from "@/lib/school-organisations";

/**
 * How many current contact people a preview will name before it stops, and why
 * it is the PROVIDER's cap rather than a number of this module's own.
 *
 * The preview answers "who would approving displace?", and the only place an
 * officer ever sees those people is the school's accounting contact — which
 * `readOrganisationForXeroContact` derives NEWEST first, de-duplicated, and
 * capped at this many. A preview with its own larger cap and its own opposite
 * ordering showed precisely the names that cap has already dropped: the oldest
 * associations, which are the ones the provider never names. So the preview
 * borrows the cap, the ordering, the person shaping and the de-duplication
 * identity rather than inventing four of its own (`INV-SSOT`).
 *
 * ONE thing is deliberately NOT borrowed, and it is stated here rather than left
 * to be discovered as a bug: the ROLE scope. The provider names a school's
 * `TEACHER` and `CONTACT` rows together; this preview reads `TEACHER` rows only,
 * because it answers a narrower question — "who would approving DISPLACE?" — and
 * `reconcileOrganisationTeachers` replaces the teacher set and deliberately
 * never touches a `CONTACT` row somebody attached by hand. So a school that has
 * one is shown fewer names here than its accounting contact carries, and that is
 * the correct answer to this question. If this list is ever reused to say what
 * the provider SHOWS rather than what approval replaces, the role filter is the
 * line that has to go.
 */
const CONTACT_PREVIEW_LIMIT = MAX_XERO_ORGANISATION_CONTACT_PERSONS;

/** Either client answers this module's questions; both only ever read. */
type SchoolRecordReader = Prisma.TransactionClient | typeof prisma;

/**
 * What approving this request would do with the school name, as far as the club
 * can see right now.
 *
 * `known` is the whole decision: a name the club already holds a record for
 * attaches to it, a name it does not mints a new one. Everything else on the
 * object exists so an officer can tell a good match from a coincidence.
 */
export type SchoolRecordPreview = {
  /** The name as it would be stored — trimmed, whitespace-collapsed, capped. */
  normalisedName: string;
  /** True when the club already holds a school record answering to that name. */
  known: boolean;
  /** The record's id when `known`; null when the correction would mint one. */
  schoolRecordId: string | null;
  /** The record's OWN spelling, which is kept: a match never renames it. */
  schoolRecordName: string | null;
  /**
   * The record is archived. It still matches — archiving means "stop offering
   * it", not "a different school" — so the officer is told rather than surprised.
   */
  schoolRecordArchived: boolean;
  /**
   * The record already owns a Xero customer. This is the fact that makes a
   * wrong match expensive: invoices for this stay would join that customer's
   * history.
   */
  schoolRecordHasXeroCustomer: boolean;
  /**
   * Who the club currently shows as that school's contact people, by name.
   *
   * NOT decoration. Approving REPLACES this set with the request's teachers
   * (`reconcileOrganisationTeachers`, #3367), so these are precisely the people
   * a correction to the teacher list is about to remove.
   */
  currentContactNames: string[];
  /** True when more contacts exist than `currentContactNames` lists. */
  currentContactNamesTruncated: boolean;
};

/** The name is unusable as a school name — empty once normalised. */
export class EmptySchoolNameError extends Error {
  status = 422;

  constructor() {
    super("A school name is required.");
    this.name = "EmptySchoolNameError";
  }
}

/** A correction whose school-record consequence was not the acknowledged one. */
export class SchoolRecordAcknowledgementError extends Error {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = "SchoolRecordAcknowledgementError";
  }
}

/**
 * Normalise a school name exactly as the resolve would store it.
 *
 * Exported because the correction service stores the SAME string it previewed;
 * normalising in two places with two slightly different rules is how a preview
 * comes to describe a record the write then misses.
 */
export function normaliseSchoolNameForStorage(name: string): string {
  const normalised = normaliseOrganisationName(name).slice(
    0,
    MAX_ORGANISATION_NAME_LENGTH,
  );
  if (!normalised) throw new EmptySchoolNameError();
  return normalised;
}

/**
 * Ask Postgres which school record this free-text name claims.
 *
 * Takes a client so the correction can re-ask inside its own transaction using
 * the same code the screen used.
 */
export async function previewSchoolRecordForName(
  db: SchoolRecordReader,
  name: string,
): Promise<SchoolRecordPreview> {
  const normalisedName = normaliseSchoolNameForStorage(name);

  const existing = await db.organisation.findFirst({
    where: schoolOrganisationNameClaim(normalisedName),
    // The SAME ordering the resolve uses. A preview that picked a different row
    // out of a set of two would be describing a record the approval will not use.
    orderBy: [
      { archivedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ],
    select: {
      id: true,
      name: true,
      archivedAt: true,
      xeroContactId: true,
      contacts: {
        where: { role: OrganisationContactRole.TEACHER },
        // NEWEST first, the provider's own ordering and for the provider's own
        // reason: a returning teacher is minted as a fresh Member on every
        // approval, so oldest-first would freeze the list on people who have
        // long gone. Unbounded rather than `take`: the cap has to apply AFTER
        // de-duplication or one human recorded three times eats three places.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          member: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      },
    },
  });

  if (!existing) {
    return {
      normalisedName,
      known: false,
      schoolRecordId: null,
      schoolRecordName: null,
      schoolRecordArchived: false,
      schoolRecordHasXeroCustomer: false,
      currentContactNames: [],
      currentContactNamesTruncated: false,
    };
  }

  // Shaped and de-duplicated by the provider's own functions, so a teacher the
  // club has recorded once per visit is one name here as they are one contact
  // person there — and so a row the provider would not name at all (no name on
  // it) is not counted here either. Shaping through
  // `xeroContactPersonFromMember` rather than reading the row directly is what
  // makes "the same de-duplication identity" true rather than nearly true: the
  // identity is only as shared as its input is.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { member } of existing.contacts) {
    const person = xeroContactPersonFromMember(member);
    if (!person) continue;
    const identity = organisationContactPersonIdentity(person);
    if (seen.has(identity)) continue;
    seen.add(identity);
    names.push(`${person.firstName} ${person.lastName}`.trim());
  }
  return {
    normalisedName,
    known: true,
    schoolRecordId: existing.id,
    schoolRecordName: existing.name,
    schoolRecordArchived: existing.archivedAt !== null,
    schoolRecordHasXeroCustomer: Boolean(existing.xeroContactId),
    currentContactNames: names.slice(0, CONTACT_PREVIEW_LIMIT),
    currentContactNamesTruncated: names.length > CONTACT_PREVIEW_LIMIT,
  };
}

/**
 * What the officer said they were doing, sent back with the correction.
 *
 * `"existing"` must name the record; `"new"` must not. The pair is what makes
 * the acknowledgement a statement about a specific school rather than a tick.
 */
export type SchoolRecordAcknowledgement = {
  outcome: "existing" | "new";
  schoolRecordId?: string | null;
};

/**
 * REFUSE a correction whose school-record consequence is not the one the
 * officer was shown.
 *
 * This is the whole point of the preview, and it is checked at WRITE time
 * against a freshly-read preview rather than against the one the screen
 * rendered. Two things can have moved underneath it, and both matter:
 *
 *   - another approval created the record while the form was open, so what the
 *     officer accepted as "a new school" would now silently JOIN an existing
 *     one — and its Xero customer;
 *   - the officer edited the name field after reading the preview, so the
 *     acknowledgement describes a name nobody is storing.
 *
 * Both come back as a refusal that names the school, never as a best guess. A
 * second record for one school is an officer's merge; an invoice that quietly
 * joined the wrong school's history is not something anyone finds later.
 */
export function assertSchoolRecordOutcomeAcknowledged(
  preview: SchoolRecordPreview,
  acknowledgement: SchoolRecordAcknowledgement,
): void {
  const acknowledgedId = acknowledgement.schoolRecordId ?? null;

  if (preview.known) {
    if (
      acknowledgement.outcome !== "existing" ||
      acknowledgedId !== preview.schoolRecordId
    ) {
      throw new SchoolRecordAcknowledgementError(
        `"${preview.normalisedName}" is a school the club already has on record` +
          (preview.schoolRecordHasXeroCustomer
            ? ", with its own Xero customer"
            : "") +
          ". Re-open the correction, check it is the same school, and confirm " +
          "it before saving.",
      );
    }
    return;
  }

  if (acknowledgement.outcome !== "new" || acknowledgedId !== null) {
    throw new SchoolRecordAcknowledgementError(
      `The club has no school on record called "${preview.normalisedName}". ` +
        "Saving this would create a new school, and a new Xero customer with " +
        "it. Re-open the correction and confirm that is what you mean.",
    );
  }
}
