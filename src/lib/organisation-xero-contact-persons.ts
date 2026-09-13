/**
 * The people named on a school's Xero contact, and keeping them honest (#3367,
 * stage 2 of programme #2912). `INV-INT-018`, `INV-CONFIG-005`, `INV-PRIV`.
 *
 * Split out of `organisation-xero-contacts.ts`, which resolves and creates the
 * contact itself. This half owns one question — WHO is named on it, and what
 * reaches the provider with them — and it is the half a reader comes looking
 * for, so the two answers below are written here rather than in a pull request.
 *
 * ### WHAT HAPPENS WHEN A SCHOOL'S CONTACT PERSON CHANGES
 *
 * **The next contact resolution refreshes it, and that is a real refresh rather
 * than a hope.** A record naming a teacher who left is worse than one naming
 * nobody, because it invites the treasurer to contact them. So:
 *
 * - Approval RECONCILES rather than appends. A fresh teacher `Member` is minted
 *   on every approval — even for the same returning human — so an approval that
 *   only ever added rows would accumulate one association per approval and
 *   never remove one. {@link reconcileOrganisationTeachers} makes the approved
 *   booking's teacher set BE the organisation's `TEACHER` set: rows for people
 *   no longer in it are deleted. The model's own docblock licenses that — "this
 *   row is pure association… it carries no history of its own" — and the
 *   booking-side `HutLeaderAssignment`, which DOES carry history, is a separate
 *   record and is never touched.
 * - The intended contact persons are derived from the organisation's
 *   `OrganisationContact` rows every time this module resolves a contact —
 *   never from a snapshot taken when the contact was first created — NEWEST
 *   first, and with duplicates of one human collapsed, so the cap below can
 *   never hide the current teacher behind five departed ones.
 * - A fingerprint of what was last SENT is kept in the local `XeroObjectLink`
 *   row's metadata. When the derived list no longer matches it, one
 *   `updateContact` is sent and the fingerprint is rewritten; when it matches,
 *   no provider call happens at all. So a steady-state school costs nothing
 *   extra, and a school whose teacher changed is corrected on its next invoice.
 * - Approving a new school booking records the new teacher and then queues that
 *   booking's invoice, which resolves the contact — so "the next approval
 *   refreshes it" is literally true.
 *
 * TWO CONSEQUENCES OF RECONCILING THAT A READER SHOULD MEET HERE RATHER THAN
 * DISCOVER. First, a school with two approved bookings in flight ends up naming
 * the teachers of whichever was approved LAST, not of whichever travels next:
 * the association is "who the school's current contact is", and this data has
 * no better answer to that than the most recent approval. Second, a request
 * that records NO teacher reconciles nothing — an absence of information is not
 * an assertion that the school has no contacts, and treating it as one would
 * let an incomplete request erase a known-good teacher.
 *
 * Only `contactPersons` is refreshed. The contact's NAME is never rewritten:
 * Xero enforces unique contact names, renaming is the operation the settled rule
 * on #2912 forbids for a person's contact, and a school that changes its name is
 * an officer decision rather than a sync. The same answer is written for a human
 * reader in `docs/guides/booking-requests.md` -> "What happens in Xero when you
 * approve a school request" and in `docs/XERO_MEMBER_GROUPING_RUNBOOK.md`.
 *
 * ### A PERSON'S NAME NOW REACHES THE PROVIDER AS PART OF A SCHOOL'S RECORD
 *
 * That is a deliberate widening of what leaves this system, not an incidental
 * one. A teacher's first name, last name and email address are written onto the
 * school's Xero contact. The address goes through the containment policy like
 * every other address this application sends, so a copy sends a contained form
 * (`INV-CONFIG-005`); the NAMES are sent verbatim on every installation,
 * because a contact person with no name is not a contact person. Nothing is
 * stored locally beyond the fingerprint, and the stored operation payload is
 * redacted on the way in, so the names live in Xero and in this application's
 * own `Member` rows and nowhere else.
 */

import type { XeroClient } from "xero-node";
import { OrganisationContactRole, type Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { callXeroApi } from "@/lib/xero-api-client";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import type { XeroContactEmailPolicy } from "@/lib/xero-contact-containment";
import { stripPersonNameFromStoredContactPayload } from "@/lib/xero-contacts";
import {
  buildXeroContactShape,
  type XeroContactPersonInput,
} from "@/lib/xero-contact-shape";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import { schoolXeroContactName } from "@/lib/school-organisations";

/** The local model name the organisation paths write into the Xero ledger. */
export const ORGANISATION_LOCAL_MODEL = "Organisation";

/**
 * How many contact persons a school's Xero contact carries.
 *
 * A bound rather than a rule about schools: a party can arrive with a dozen
 * teachers, and a contact carrying a dozen names is neither readable in Xero nor
 * a payload worth sending. The first few in the deterministic order below are
 * the ones an officer recorded first, which is the closest thing to "the one to
 * talk to" this data has.
 */
export const MAX_XERO_ORGANISATION_CONTACT_PERSONS = 5;
export class OrganisationXeroContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganisationXeroContactError";
  }
}
export type OrganisationContactSnapshot = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  xeroContactId: string | null;
  contactPersons: XeroContactPersonInput[];
};

/**
 * Make this booking's teacher set BE the organisation's `TEACHER` set.
 *
 * MUST run inside the approval transaction, on its client, so the associations
 * and the booking they describe commit together.
 *
 * Called with an EMPTY set it does nothing at all, deliberately: see the second
 * consequence in this module's docblock. Only `TEACHER` rows are reconciled —
 * a `CONTACT`-role association is somebody an officer attached by hand for a
 * reason this code does not know, and a booking approval is not evidence that
 * it has stopped being true.
 *
 * Returns how many associations it removed, so the caller can log or audit a
 * departure rather than have it happen silently.
 */
export async function reconcileOrganisationTeachers(
  tx: Prisma.TransactionClient,
  input: { organisationId: string; teacherMemberIds: readonly string[] },
): Promise<{ removedCount: number }> {
  const keep = [...new Set(input.teacherMemberIds)];
  if (keep.length === 0) return { removedCount: 0 };

  const removed = await tx.organisationContact.deleteMany({
    where: {
      organisationId: input.organisationId,
      role: OrganisationContactRole.TEACHER,
      memberId: { notIn: keep },
    },
  });
  return { removedCount: removed.count };
}

/**
 * The organisation and the people to name on its Xero contact.
 *
 * Order is deterministic and is part of the fingerprint: teachers before other
 * contacts, then the NEWEST association first. Deterministic order is what
 * stops the refresh below firing on every resolve because two rows came back
 * swapped.
 *
 * NEWEST first, not oldest, and the direction is load-bearing rather than
 * cosmetic. The cap below stops at five. Ordered oldest-first, a school that
 * ever accumulated five associations would have its derived list frozen on the
 * oldest five for ever: the fingerprint would stop changing, no update would
 * ever be sent again, and the contact would keep naming people who have gone.
 * Newest-first means the cap can only ever hide the LEAST current names, which
 * is what a cap is for.
 *
 * Duplicates of one human are collapsed before the cap applies. A returning
 * teacher is minted as a fresh `Member` on every approval, and an ADOPTED
 * contact may already carry contact persons this application has never seen, so
 * "the same person twice" is an ordinary state rather than a corruption. The
 * identity used is the trimmed, case-folded name and address together, which is
 * all this data has; it is deliberately not a fuzzy match.
 */
export async function readOrganisationForXeroContact(
  organisationId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<OrganisationContactSnapshot> {
  const organisation = await db.organisation.findUnique({
    where: { id: organisationId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      xeroContactId: true,
      contacts: {
        // TEACHER sorts before CONTACT alphabetically, which is also the
        // priority wanted, so the enum's own ordering carries it.
        orderBy: [{ role: "asc" }, { createdAt: "desc" }, { id: "desc" }],
        select: {
          member: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      },
    },
  });
  if (!organisation) {
    throw new OrganisationXeroContactError(
      `Organisation not found: ${organisationId}`,
    );
  }

  const contactPersons: XeroContactPersonInput[] = [];
  const seen = new Set<string>();
  for (const row of organisation.contacts) {
    if (contactPersons.length >= MAX_XERO_ORGANISATION_CONTACT_PERSONS) break;
    const firstName = row.member.firstName?.trim() ?? "";
    const lastName = row.member.lastName?.trim() ?? "";
    if (!firstName && !lastName) continue;
    const person = {
      firstName,
      lastName,
      // A walk-in placeholder address is not an address (#1935): it is a
      // reserved-domain marker meaning "this person cannot be reached", and
      // putting one on a school's contact would tell the treasurer to write to
      // a mailbox that does not exist.
      email: isPlaceholderContactEmail(row.member.email)
        ? ""
        : row.member.email,
    };
    const identity =
      `${person.firstName} ${person.lastName} ${person.email}`.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    contactPersons.push(person);
  }

  return {
    id: organisation.id,
    name: organisation.name,
    email: organisation.email,
    phone: organisation.phone,
    xeroContactId: organisation.xeroContactId,
    contactPersons,
  };
}

/**
 * The address that goes on the school's own contact.
 *
 * The organisation's recorded address first; a school reachable only through a
 * named teacher falls back to that teacher's, which is what the invented school
 * member already carried before this stage, so no school loses its invoice
 * delivery address in the move. Empty string is the honest third answer — Xero
 * accepts a contact with no address, and inventing one is the class of thing
 * this programme exists to stop.
 */
export function organisationContactEmail(
  organisation: OrganisationContactSnapshot,
): string {
  return (
    organisation.email?.trim() ||
    organisation.contactPersons.find((person) => person.email.trim())?.email ||
    ""
  );
}

export function buildOrganisationXeroContactPayload(
  organisation: OrganisationContactSnapshot,
  policy: XeroContactEmailPolicy,
) {
  return buildXeroContactShape(policy, {
    // Through the SHARED helper, not `organisation.name` raw. The invented
    // school member's contact was named with the school truncated at 100
    // characters — its `firstName` column's limit — and the organisation record
    // holds 200. A returning school with a long name would otherwise not
    // collide with the contact it already has, Xero would accept the create,
    // and the club would hold two customers for one school.
    name: schoolXeroContactName(organisation.name),
    // No `person`: this is what makes the contact an ORGANISATION rather than a
    // surnameless human. `isCustomer` cannot be set on write and is never read
    // as the discriminator — see xero-contact-shape.ts.
    person: null,
    email: organisationContactEmail(organisation),
    phone: { number: organisation.phone },
    contactPersons: organisation.contactPersons,
  });
}

/**
 * What was last SENT as this contact's contact persons, hashed.
 *
 * Computed from the POLICY-APPLIED payload, not from the local rows, so a copy's
 * fingerprint describes the contained addresses it really sent. That also means
 * a contact adopted with somebody else's real contact persons on it fails the
 * comparison on first resolve and is corrected, rather than being trusted
 * because nothing local changed.
 */
export function contactPersonsFingerprint(contact: {
  contactPersons?: unknown;
}): string {
  return buildXeroPayloadHash({ contactPersons: contact.contactPersons ?? [] });
}

function readStoredFingerprint(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).contactPersonsFingerprint;
  return typeof value === "string" ? value : null;
}

export async function upsertOrganisationContactLink(
  input: {
    organisationId: string;
    xeroContactId: string;
    linkedVia?: string;
    contactPersonsFingerprint?: string;
  },
  store?: Prisma.TransactionClient,
): Promise<void> {
  await upsertXeroObjectLink(
    {
      localModel: ORGANISATION_LOCAL_MODEL,
      localId: input.organisationId,
      xeroObjectType: "CONTACT",
      xeroObjectId: input.xeroContactId,
      xeroObjectUrl: buildXeroContactUrl(input.xeroContactId),
      role: "CONTACT",
      // MERGED, never replaced. The two facts this row's metadata carries are
      // written by two different calls at two different times: `linkedVia` —
      // whether the contact was `created` or adopted by `name_match` — is
      // written once when the link is first made, and the contact-persons
      // fingerprint is rewritten on every refresh that sends an update. A plain
      // rebuild would mean the FIRST refresh silently dropped the provenance,
      // and provenance is exactly what tells a reader whether the contact is
      // one this application made or one it adopted.
      mergeMetadata: true,
      ...(input.linkedVia || input.contactPersonsFingerprint
        ? {
            metadata: {
              ...(input.linkedVia ? { linkedVia: input.linkedVia } : {}),
              ...(input.contactPersonsFingerprint
                ? {
                    contactPersonsFingerprint: input.contactPersonsFingerprint,
                  }
                : {}),
            },
          }
        : {}),
    },
    store ? { store } : undefined,
  );
}
/**
 * Push the school's current contact persons to Xero when, and only when, they
 * differ from what was last sent. See "WHAT HAPPENS WHEN A SCHOOL'S CONTACT
 * PERSON CHANGES" at the top of this file.
 *
 * Best-effort by design: a school's invoice must not fail to be raised because
 * the name of the teacher on the contact could not be corrected. The failure is
 * logged and recorded on the operation ledger, and the next resolve tries again
 * because the fingerprint was never advanced.
 */
export async function refreshOrganisationContactPersons(input: {
  organisation: OrganisationContactSnapshot;
  xeroContactId: string;
  policy: XeroContactEmailPolicy;
  /**
   * LAZY on purpose. A school whose contact persons have not changed must cost
   * no provider work at all, and `getAuthenticatedXeroClient()` is provider work
   * — a token read plus an OIDC discovery round trip that is not cached. The
   * steady-state path therefore hands in a resolver rather than a client, and
   * this function only calls it once it knows it has something to send.
   */
  resolveClient: () => Promise<{ xero: XeroClient; tenantId: string }>;
  createdByMemberId?: string;
}): Promise<void> {
  const { organisation, xeroContactId } = input;
  const desired = buildOrganisationXeroContactPayload(
    organisation,
    input.policy,
  );
  const desiredPersons = desired.contactPersons ?? [];

  /*
    NOTHING TO SAY IS NOT THE SAME AS "THERE IS NOBODY", so no update is sent.

    An `updateContact` carrying `contactPersons: []` does not mean "we have no
    teacher on file" to Xero — it means "replace the list with nothing". On the
    ADOPTION path that is actively destructive: the contact this organisation
    took is one Xero refused to let us duplicate, so it may well be a record a
    treasurer built by hand, with contact persons they entered and this
    application has never seen. Clearing those because a request happened to
    record no teacher would delete somebody's work to assert an absence this
    code does not actually know.

    The honest cost, stated rather than hidden: a school whose only teacher
    leaves and is replaced by NOBODY keeps naming them in Xero until either a
    replacement is recorded or the treasurer edits the contact. A departure WITH
    a replacement — the ordinary case, and the one the owner's decision was
    taken on — is corrected on the next invoice as promised.
  */
  if (desiredPersons.length === 0) return;

  const fingerprint = contactPersonsFingerprint(desired);

  const link = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: ORGANISATION_LOCAL_MODEL,
      localId: organisation.id,
      xeroObjectType: "CONTACT",
      xeroObjectId: xeroContactId,
      role: "CONTACT",
    },
    select: { metadata: true },
  });
  if (readStoredFingerprint(link?.metadata) === fingerprint) return;

  // Only the contact persons. The name is never rewritten (see the docblock),
  // and the address is left to the create path and to containment, so this
  // payload cannot silently re-point a school's invoice delivery.
  const contact = {
    contactID: xeroContactId,
    contactPersons: desiredPersons,
  };
  const idempotencyKey = buildXeroIdempotencyKey(
    "organisation",
    organisation.id,
    "contact",
    "contact-persons",
    fingerprint,
    "v1",
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "UPDATE",
    localModel: ORGANISATION_LOCAL_MODEL,
    localId: organisation.id,
    idempotencyKey,
    correlationKey: idempotencyKey,
    // INV-PRIV-011 (#2683): a contact person's name and address are redacted by
    // the stored-payload redactor on the way in; the strip below is what removes
    // Xero's required top-level `name`, which the redactor cannot.
    requestPayload: stripPersonNameFromStoredContactPayload({
      contacts: [contact],
    }),
    createdByMemberId: input.createdByMemberId ?? null,
  });

  try {
    const { xero, tenantId } = await input.resolveClient();
    const response = await callXeroApi(
      () =>
        xero.accountingApi.updateContact(
          tenantId,
          xeroContactId,
          { contacts: [contact] },
          idempotencyKey,
        ),
      {
        operation: "updateContact",
        resourceType: "CONTACT",
        workflow: "refreshOrganisationContactPersons",
        context: `updateContact(organisation ${organisation.id})`,
      },
    );
    await upsertOrganisationContactLink({
      organisationId: organisation.id,
      xeroContactId,
      contactPersonsFingerprint: fingerprint,
    });
    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "CONTACT",
      xeroObjectId: xeroContactId,
      xeroObjectUrl: buildXeroContactUrl(xeroContactId),
    });
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    logger.error(
      { err: error, organisationId: organisation.id, xeroContactId },
      "Failed to refresh the contact persons on an organisation's Xero contact",
    );
  }
}
