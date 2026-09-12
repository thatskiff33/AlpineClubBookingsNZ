/**
 * An organisation's OWN Xero customer: resolve it, create it, and keep the
 * named contact person on it honest (#3367, stage 2 of programme #2912).
 * `INV-INT`, `INV-INT-018`, `INV-CONFIG-005`, `INV-LOCK-001`/`INV-LOCK-002`.
 *
 * NOTE ON THE NAME. `xero-organisation.ts`, `xero-organisation-cache-bus.ts`
 * and the `xero-organisation-*` tests are about XERO'S OWN TENANT — the
 * accounting organisation this application is connected to. They have nothing
 * to do with this module, whose `Organisation` is the club's record of a school.
 * This file leads with the local model for exactly that reason.
 *
 * ## What a school's Xero contact looks like, and why
 *
 * Organisation-shaped: `name` alone carries the school, and the person-name
 * fields are OMITTED rather than filled with an empty surname — the surnameless
 * human in the club's Xero contact list is the defect programme #2912 exists to
 * fix. The real teacher is attached through `contactPersons`, which is Xero's
 * own place for "who to talk to at this organisation".
 *
 * That second half is an owner decision of 13 September 2026 on #3367, taken
 * over the smaller name-only alternative: the treasurer should be able to see
 * who to talk to without leaving Xero. Two things follow from it and are
 * answered here rather than left to be rediscovered.
 *
 * ### WHAT HAPPENS WHEN A SCHOOL'S CONTACT PERSON CHANGES
 *
 * **The next contact resolution refreshes it, and that is a real refresh rather
 * than a hope.** A record naming a teacher who left is worse than one naming
 * nobody, because it invites the treasurer to contact them. So:
 *
 * - The intended contact persons are derived from the organisation's
 *   `OrganisationContact` rows every time this module resolves a contact —
 *   never from a snapshot taken when the contact was first created.
 * - A fingerprint of what was last SENT is kept in the local `XeroObjectLink`
 *   row's metadata. When the derived list no longer matches it, one
 *   `updateContact` is sent and the fingerprint is rewritten; when it matches,
 *   no provider call happens at all. So a steady-state school costs nothing
 *   extra, and a school whose teacher changed is corrected on its next invoice.
 * - Approving a new school booking records the new teacher and then queues that
 *   booking's invoice, which resolves the contact — so "the next approval
 *   refreshes it" is literally true.
 *
 * Only `contactPersons` is refreshed. The contact's NAME is never rewritten:
 * Xero enforces unique contact names, renaming is the operation the settled rule
 * on #2912 forbids for a person's contact, and a school that changes its name is
 * an officer decision rather than a sync. The same answer is written for a human
 * reader in `docs/guides/school-bookings.md` and
 * `docs/XERO_MEMBER_GROUPING_RUNBOOK.md`.
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
 *
 * ### THE TEACHER STILL CARRIES THE SCHOOL'S ROLE LOCALLY, AND THAT IS FINE
 *
 * A reader who meets this will wonder, so: teachers are still created with
 * `Role.SCHOOL`, exactly as before stage 2. The owner declined changing that
 * here (13 September 2026, choice B) because a teacher's hut-leader assignment
 * is tied to that area and the schema warns that reclassifying a member can
 * silently remove a live assignment — so stage 4 (#3369) retires the role
 * vocabulary in one deliberate step, together with the invented school member it
 * already removes. The two facts do not conflict: a Xero contact person is a
 * name and an address, not a role.
 *
 * ## The shape of the resolve, and why it is the shape it is
 *
 * Three phases, copied in structure from `findOrCreateXeroContact` because that
 * structure is the fix for F7 (#1355) and must not be re-broken here:
 *
 * - **Phase 0** — trust the persisted link. No provider call.
 * - **Phase 1** — ALL Xero work OUTSIDE any transaction. Concurrent duplicate
 *   creates converge through an organisation-scoped idempotency key rather than
 *   by holding a database lock across a provider call.
 * - **Phase 2** — a SHORT advisory-locked transaction re-checks and writes.
 *
 * **NO SEARCH BY EMAIL.** This is the one place the organisation path
 * deliberately DIVERGES from the member path, and it is a safety property rather
 * than an omission. A school's recorded email is routinely a teacher's own
 * address, so asking Xero `EmailAddress="…"` would find and adopt that person's
 * personal contact — which is exactly what #2912 settled must never happen. The
 * only contact this module will ever adopt is one Xero itself refused to let us
 * duplicate because the NAME is already taken, and even then the two-homes
 * refusal (`INV-INT-018`) must pass first.
 */

import type { XeroClient } from "xero-node";
import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
} from "@/lib/xero-api-client";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  resolveXeroContactEmailPolicy,
  type XeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";
import { ensureXeroContactContained } from "@/lib/xero-contact-containment-proof";
import {
  buildXeroContactDisplayName,
  findExistingXeroContactByExactName,
  findOrCreateXeroContact,
  isDuplicateActiveXeroContactNameError,
  stripPersonNameFromStoredContactPayload,
} from "@/lib/xero-contacts";
import {
  buildXeroContactShape,
  type XeroContactPersonInput,
} from "@/lib/xero-contact-shape";
import {
  assertXeroContactHasNoOtherHome,
  lockXeroContactHome,
  XeroContactTwoHomesError,
} from "@/lib/xero-contact-home";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

/** The local model name this module writes into the Xero operation ledger. */
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

/** The advisory-lock keyspace for one organisation's contact link. */
export function organisationXeroContactLockKey(organisationId: string): string {
  return `xero-organisation-contact:${organisationId}`;
}

export class OrganisationXeroContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganisationXeroContactError";
  }
}

/**
 * THE RETURNING SCHOOL. This is the one outcome stage 2 cannot fix on its own,
 * and it is common rather than exotic, so it is a named error rather than a
 * generic failure.
 *
 * A school that has booked before already has a Xero contact — a person-shaped
 * one, carrying the school's name in the first-name position, held by the
 * invented school member of that earlier booking. Xero enforces unique contact
 * names, so creating the organisation's own contact under the same name is
 * refused by the provider; the duplicate-name recovery then finds that very
 * contact, and the two-homes refusal (`INV-INT-018`) stops the organisation
 * adopting a contact a member still holds.
 *
 * THAT REFUSAL IS CORRECT AND MUST NOT BE SOFTENED. Moving the link from the
 * member to the organisation would strand the earlier booking — its credit
 * notes and supplementary invoices still resolve a Xero contact through that
 * member — and deciding which local record owns a historical contact is
 * precisely the classification stage 4 (#3369) runs a census for, with a
 * requirement of zero ambiguous rows. Guessing it here is the thing #2912
 * forbids.
 *
 * So the invoice is raised against the contact the school already has, exactly
 * as it was before this stage, and this error carries what an officer needs to
 * act: which school, and which contact. A school with NO prior Xero contact —
 * the case #2939 and #2936 are waiting on — is unaffected and gets its own
 * organisation contact.
 */
export class OrganisationXeroContactHeldByMemberError extends Error {
  readonly organisationId: string;
  readonly organisationName: string;
  readonly xeroContactId: string;

  constructor(input: {
    organisationId: string;
    organisationName: string;
    xeroContactId: string;
    cause: unknown;
  }) {
    super(
      `Xero already holds a contact named "${input.organisationName}" and a ` +
        "member record still owns it, so this school cannot be given its own " +
        "organisation contact yet. This is the expected outcome for a school " +
        "that has booked before: its Xero customer was created against the " +
        "invented school member of an earlier booking, and deciding which " +
        "record should own it is the classification #3369 runs. The invoice " +
        "is raised against the contact the school already has (INV-INT-018).",
      { cause: input.cause },
    );
    this.name = "OrganisationXeroContactHeldByMemberError";
    this.organisationId = input.organisationId;
    this.organisationName = input.organisationName;
    this.xeroContactId = input.xeroContactId;
  }
}

type OrganisationContactSnapshot = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  xeroContactId: string | null;
  contactPersons: XeroContactPersonInput[];
};

/**
 * The organisation and the people to name on its Xero contact.
 *
 * Order is deterministic and is part of the fingerprint: teachers before other
 * contacts, then oldest association first. Deterministic order is what stops the
 * refresh below firing on every resolve because two rows came back swapped.
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
        orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
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
  for (const row of organisation.contacts) {
    if (contactPersons.length >= MAX_XERO_ORGANISATION_CONTACT_PERSONS) break;
    const firstName = row.member.firstName?.trim() ?? "";
    const lastName = row.member.lastName?.trim() ?? "";
    if (!firstName && !lastName) continue;
    contactPersons.push({
      firstName,
      lastName,
      // A walk-in placeholder address is not an address (#1935): it is a
      // reserved-domain marker meaning "this person cannot be reached", and
      // putting one on a school's contact would tell the treasurer to write to
      // a mailbox that does not exist.
      email: isPlaceholderContactEmail(row.member.email)
        ? ""
        : row.member.email,
    });
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
function organisationContactEmail(
  organisation: OrganisationContactSnapshot,
): string {
  return (
    organisation.email?.trim() ||
    organisation.contactPersons.find((person) => person.email.trim())?.email ||
    ""
  );
}

function buildOrganisationXeroContactPayload(
  organisation: OrganisationContactSnapshot,
  policy: XeroContactEmailPolicy,
) {
  return buildXeroContactShape(policy, {
    name: organisation.name,
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
function contactPersonsFingerprint(contact: {
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

async function upsertOrganisationContactLink(
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
async function refreshOrganisationContactPersons(input: {
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
    contactPersons: desired.contactPersons ?? [],
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

/**
 * WHO A BOOKING IS INVOICED AS (#3367).
 *
 * Where a booking is linked to an Organisation, the Organisation is the
 * invoiced party and its own Xero customer is used; where it is not, this is
 * today's behaviour to the letter — the booking's member, resolved by
 * `findOrCreateXeroContact`, with the same options and the same client.
 *
 * WORTH KNOWING: an invoice payload sends only a contact REFERENCE and no name
 * at all, so "the organisation is the invoiced party" is a change to contact
 * resolution and to nothing in the eleven invoice builders. That is why this is
 * one function rather than a sweep.
 */
export async function findOrCreateXeroContactForInvoicedParty(
  booking: { memberId: string; organisationId: string | null },
  options?: FindOrCreateOrganisationXeroContactOptions & {
    repairExistingLink?: boolean;
  },
): Promise<string> {
  if (booking.organisationId) {
    try {
      return await findOrCreateXeroContactForOrganisation(
        booking.organisationId,
        options,
      );
    } catch (error) {
      // THE ONE FALLBACK, and it is narrow on purpose: exactly the returning
      // school, and nothing else. Every other failure propagates, because an
      // invoice raised against the wrong customer is worse than an invoice that
      // did not get raised. See OrganisationXeroContactHeldByMemberError for
      // why this outcome is expected rather than broken.
      if (!(error instanceof OrganisationXeroContactHeldByMemberError)) throw error;
      logger.warn(
        {
          organisationId: booking.organisationId,
          memberId: booking.memberId,
          xeroContactId: error.xeroContactId,
        },
        "This school already has a Xero customer under a member record, so the " +
          "invoice is raised against it rather than a new organisation contact " +
          "(#3367; classification is #3369)",
      );
    }
  }
  return findOrCreateXeroContact(booking.memberId, options);
}

export interface FindOrCreateOrganisationXeroContactOptions {
  createdByMemberId?: string;
  /** An already-authenticated client, purely to avoid a second `initialize()`. */
  xero?: XeroClient;
  tenantId?: string;
}

/**
 * The organisation's durable Xero customer id, creating it on first use.
 *
 * Idempotent under replay: the organisation-scoped idempotency key means two
 * concurrent or retried creates converge on ONE Xero contact rather than
 * minting a second, which is the property `Organisation.xeroContactId`'s
 * uniqueness cannot provide on its own because the provider write happens
 * before the local write.
 */
export async function findOrCreateXeroContactForOrganisation(
  organisationId: string,
  options?: FindOrCreateOrganisationXeroContactOptions,
): Promise<string> {
  // INV-CONFIG-005 (#3036) FIRST, before any provider work: which installation
  // is this? On the club's live site the policy is the identity function; on a
  // copy every address written below is contained; on an undeclared
  // installation this throws before anything reaches Xero.
  const { policy: emailPolicy } = await resolveXeroContactEmailPolicy();
  const organisation = await readOrganisationForXeroContact(organisationId);
  // The caller's already-authenticated client when it handed over BOTH halves;
  // otherwise build one, and only when something actually needs it.
  const callerClient =
    options?.xero && options.tenantId
      ? { xero: options.xero, tenantId: options.tenantId }
      : null;
  const resolveClient = async () =>
    callerClient ?? (await getAuthenticatedXeroClient());

  // ── Phase 0: trust the persisted link ──────────────────────────────
  if (organisation.xeroContactId) {
    const xeroContactId = organisation.xeroContactId;
    await upsertOrganisationContactLink({ organisationId, xeroContactId });
    await ensureXeroContactContained({
      policy: emailPolicy,
      xeroContactId,
      sourceEmail: organisationContactEmail(organisation),
      workflow: "findOrCreateXeroContactForOrganisation",
      xero: options?.xero,
      tenantId: options?.tenantId,
    });
    await refreshOrganisationContactPersons({
      organisation,
      xeroContactId,
      policy: emailPolicy,
      resolveClient,
      createdByMemberId: options?.createdByMemberId,
    });
    return xeroContactId;
  }

  // ── Phase 1: every Xero call, OUTSIDE any transaction ──────────────
  const { xero, tenantId } = await resolveClient();

  const contact = buildOrganisationXeroContactPayload(organisation, emailPolicy);
  const fingerprint = contactPersonsFingerprint(contact);
  const idempotencyKey = buildXeroIdempotencyKey(
    "organisation",
    organisationId,
    "contact",
    "find-or-create",
    "v1",
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "CREATE",
    localModel: ORGANISATION_LOCAL_MODEL,
    localId: organisationId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    // INV-PRIV-011 (#2683): sent with Xero's required Name, stored without it.
    requestPayload: stripPersonNameFromStoredContactPayload({
      contacts: [contact],
    }),
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  let resolved: { contactId: string; linkedVia: "created" | "name_match" } | null =
    null;
  let completionPayload: unknown = null;
  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createContacts(
          tenantId,
          { contacts: [contact] },
          undefined, // summarizeErrors
          idempotencyKey,
        ),
      {
        operation: "createContacts",
        resourceType: "CONTACT",
        workflow: "findOrCreateXeroContactForOrganisation",
        context: `createContacts(organisation ${organisationId})`,
      },
    );
    const created = response.body.contacts?.[0];
    if (!created?.contactID) {
      throw new OrganisationXeroContactError(
        "Xero accepted the organisation contact create but returned no contact id",
      );
    }
    resolved = { contactId: created.contactID, linkedVia: "created" };
    completionPayload = response.body;
  } catch (error) {
    // The ONE adoption path. Xero enforces unique contact names, so this error
    // means a contact with this school's exact name already exists — the
    // treasurer made one by hand, or an earlier attempt created it and failed
    // before linking. Adopting it is right; it is still subject to the
    // two-homes refusal in phase 2, which is what stops us adopting a contact a
    // member holds. Note there is deliberately NO email search anywhere on this
    // path — see the module docblock.
    if (error instanceof XeroDailyLimitError) {
      await failXeroSyncOperation(operation.id, error);
      throw error;
    }
    if (!isDuplicateActiveXeroContactNameError(error)) {
      await failXeroSyncOperation(operation.id, error);
      throw error;
    }
    try {
      const matched = await findExistingXeroContactByExactName({
        xero,
        tenantId,
        fullName: organisation.name,
        contextPrefix:
          "findOrCreateXeroContactForOrganisation duplicate-name recovery",
      });
      if (!matched?.contactID) {
        await failXeroSyncOperation(operation.id, error);
        throw error;
      }
      resolved = { contactId: matched.contactID, linkedVia: "name_match" };
      completionPayload = {
        resolution: "linked_existing_contact_by_name",
        matchedBy: "name",
        matchedContactName: buildXeroContactDisplayName(matched),
        duplicateCreateError: sanitizeForJson(error),
      };
    } catch (recoveryError) {
      await failXeroSyncOperation(operation.id, recoveryError, {
        duplicateCreateError: sanitizeForJson(error),
        recoveryError: sanitizeForJson(recoveryError),
      });
      throw recoveryError;
    }
  }

  const finalResolved = resolved;
  if (!finalResolved) {
    const failure = new OrganisationXeroContactError(
      `Failed to resolve a Xero contact for organisation ${organisationId}`,
    );
    await failXeroSyncOperation(operation.id, failure);
    throw failure;
  }

  // ── Phase 2: SHORT advisory-locked transaction, re-check then write ─
  // Locks in the fixed order of INV-LOCK-002: this organisation's own key, then
  // the contact-home key. No provider call runs inside it.
  let linkOutcome: { contactId: string; wonWrite: boolean };
  try {
    linkOutcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organisationXeroContactLockKey(organisationId)}))`;
      await lockXeroContactHome(tx, finalResolved.contactId);

      const fresh = await tx.organisation.findUnique({
        where: { id: organisationId },
        select: { xeroContactId: true },
      });
      if (!fresh) {
        throw new OrganisationXeroContactError(
          `Organisation disappeared while linking its Xero contact: ${organisationId}`,
        );
      }
      if (fresh.xeroContactId && fresh.xeroContactId !== finalResolved.contactId) {
        // First writer wins, exactly as the member path does.
        return { contactId: fresh.xeroContactId, wonWrite: false };
      }

      // INV-INT-018 — the two-homes refusal. Establish that no MEMBER still
      // holds this contact id, and refuse rather than guess which record should
      // own it. See xero-contact-home.ts for why this is reachable rather than
      // hypothetical.
      await assertXeroContactHasNoOtherHome(tx, {
        xeroContactId: finalResolved.contactId,
        home: { kind: "ORGANISATION", id: organisationId },
      });

      await tx.organisation.update({
        where: { id: organisationId },
        data: { xeroContactId: finalResolved.contactId },
      });
      await upsertOrganisationContactLink(
        {
          organisationId,
          xeroContactId: finalResolved.contactId,
          linkedVia: finalResolved.linkedVia,
          // Only a contact we CREATED is known to hold exactly what we sent. An
          // adopted one may carry contact persons we have never seen, so its
          // fingerprint is left unset and the first refresh corrects it.
          ...(finalResolved.linkedVia === "created"
            ? { contactPersonsFingerprint: fingerprint }
            : {}),
        },
        tx,
      );
      return { contactId: finalResolved.contactId, wonWrite: true };
    });
  } catch (linkError) {
    if (linkError instanceof XeroContactTwoHomesError) {
      /*
        The returning school. Nothing was created in Xero on this path — the
        provider refused the duplicate name before creating anything — so there
        is no orphan contact to clean up, and abandoning here leaves the club's
        accounting exactly as it was.

        CANCELLED with a populated reason, not FAILED: this is the loud-skip
        shape (#1765) the booking-invoice path already uses for "no work is
        expected here". A FAILED row would join the active-failure overview and
        the repeated-failure alerting once per invoice for as long as the school
        keeps booking, which would train an operator to ignore it.
      */
      await completeXeroSyncOperation(operation.id, {
        status: "CANCELLED",
        responsePayload: {
          skipped: true,
          reason:
            `Xero already holds a contact named "${organisation.name}" and a ` +
            "member record still owns it, so this school keeps the Xero " +
            "customer it already has. Classifying that contact as the " +
            "school's is #3369's census (INV-INT-018).",
          resolvedContactId: finalResolved.contactId,
        },
      });
      throw new OrganisationXeroContactHeldByMemberError({
        organisationId,
        organisationName: organisation.name,
        xeroContactId: finalResolved.contactId,
        cause: linkError,
      });
    }
    await failXeroSyncOperation(operation.id, linkError, {
      phase: "local_link_after_xero_resolution",
      resolvedContactId: finalResolved.contactId,
      providerContactCreated: finalResolved.linkedVia === "created",
    });
    throw linkError;
  }

  // Post-commit op-log close: SUCCEEDED is recorded only for work that
  // committed (F7 task 3).
  if (linkOutcome.wonWrite) {
    await completeXeroSyncOperation(operation.id, {
      responsePayload: completionPayload,
      xeroObjectType: "CONTACT",
      xeroObjectId: finalResolved.contactId,
      xeroObjectUrl: buildXeroContactUrl(finalResolved.contactId),
      extraLinks: [
        {
          localModel: ORGANISATION_LOCAL_MODEL,
          localId: organisationId,
          xeroObjectType: "CONTACT",
          xeroObjectId: finalResolved.contactId,
          xeroObjectUrl: buildXeroContactUrl(finalResolved.contactId),
          role: "CONTACT",
        },
      ],
    });
  } else {
    logger.warn(
      {
        organisationId,
        resolvedContactId: finalResolved.contactId,
        existingContactId: linkOutcome.contactId,
      },
      "Concurrent resolver linked a different Xero contact to this organisation first",
    );
    await completeXeroSyncOperation(operation.id, {
      responsePayload: {
        resolution: "superseded_by_concurrent_link",
        resolvedContactId: finalResolved.contactId,
        linkedContactId: linkOutcome.contactId,
      },
      xeroObjectType: "CONTACT",
      xeroObjectId: finalResolved.contactId,
      xeroObjectUrl: buildXeroContactUrl(finalResolved.contactId),
    });
  }

  const xeroContactId = linkOutcome.contactId;
  await ensureXeroContactContained({
    policy: emailPolicy,
    xeroContactId,
    sourceEmail: organisationContactEmail(organisation),
    workflow: "findOrCreateXeroContactForOrganisation",
    xero,
    tenantId,
  });
  await refreshOrganisationContactPersons({
    organisation,
    xeroContactId,
    policy: emailPolicy,
    resolveClient: async () => ({ xero, tenantId }),
    createdByMemberId: options?.createdByMemberId,
  });
  return xeroContactId;
}
