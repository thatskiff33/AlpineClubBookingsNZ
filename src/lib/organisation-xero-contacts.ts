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
 * ### The contact person: who is named, and what reaches the provider
 *
 * Both answers live next door, in `organisation-xero-contact-persons.ts`,
 * because that is the module that derives the contact persons and pushes
 * them. The short version: the next contact resolution refreshes them, which
 * in practice means the school's next approval, and a teacher's name and
 * address reach Xero as part of the school's record.
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
 * duplicate because the NAME is already taken, and even then `INV-INT-018` must
 * pass first.
 *
 * ## The returning school takes its own contact with it
 *
 * A school that has booked before already has a Xero contact under its own
 * name, held by the invented school member of that earlier booking. Xero
 * refuses the duplicate name, the recovery above finds that very contact, and
 * the organisation TAKES it — the member's link is released in the same
 * transaction, and the hand-over is audited. Owner decision, 13 September 2026.
 * Nothing changes at Xero: the contact keeps its id, its history and every
 * invoice already raised against it. `xero-contact-home.ts` holds the rule, the
 * four legs that establish the member is this school's own, and the refusal
 * that still fires for anybody else.
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
  buildOrganisationXeroContactPayload,
  contactPersonsFingerprint,
  ORGANISATION_LOCAL_MODEL,
  organisationContactEmail,
  OrganisationXeroContactError,
  readOrganisationForXeroContact,
  refreshOrganisationContactPersons,
  upsertOrganisationContactLink,
} from "@/lib/organisation-xero-contact-persons";
import {
  assertXeroContactHasNoOtherHome,
  lockXeroContactHome,
  takeXeroContactFromSchoolsOwnMember,
  type XeroContactTransferFromMember,
} from "@/lib/xero-contact-home";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
/** The advisory-lock keyspace for one organisation's contact link. */
export function organisationXeroContactLockKey(organisationId: string): string {
  return `xero-organisation-contact:${organisationId}`;
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
    // NO FALLBACK TO THE MEMBER, on purpose (owner, 13 September 2026). A
    // returning school's existing contact is TAKEN by the organisation rather
    // than invoiced through the member that holds it, so there is nothing left
    // for a fallback to catch that is not a genuine failure — and a provider
    // operation that cannot resolve while this programme is mid-build must fail
    // loudly and stay replayable rather than succeed quietly against the wrong
    // customer.
    return findOrCreateXeroContactForOrganisation(
      booking.organisationId,
      options,
    );
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
  let linkOutcome: {
    contactId: string;
    wonWrite: boolean;
    // Set when the organisation took the contact off its own invented member.
    // Returned OUT of the transaction rather than assigned to an outer variable,
    // so what the op-log records below is what actually committed.
    transferredFrom: XeroContactTransferFromMember | null;
  };
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
        return {
          contactId: fresh.xeroContactId,
          wonWrite: false,
          transferredFrom: null,
        };
      }

      /*
        INV-INT-018, in the order that makes the refusal safe.

        FIRST the one transfer: where the contact is held by this school's OWN
        invented member — the record an earlier booking of this same school
        resolves to — the organisation takes it, and the member's link is
        released in this same transaction. That is the returning school, which
        is the common case rather than an exotic one, and the owner settled on
        13 September 2026 that it is taken now rather than refused.

        THEN the refusal, unweakened and unchanged. It runs on every path,
        including this one: once a legitimate holder has been released no member
        holds the id, so it passes; for any OTHER member it throws exactly as it
        did before. Composed this way a transfer that fails to fire can only
        produce a refusal, never a wrong adoption.
      */
      const transferredFrom = await takeXeroContactFromSchoolsOwnMember(tx, {
        organisationId,
        organisationName: organisation.name,
        xeroContactId: finalResolved.contactId,
        actorMemberId: options?.createdByMemberId ?? null,
      });
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
      return { contactId: finalResolved.contactId, wonWrite: true, transferredFrom };
    });
  } catch (linkError) {
    // FAILED and replayable, including for the two-homes refusal. There is no
    // quiet close here: a contact this organisation cannot be given is a real
    // unresolved provider operation, it keeps its idempotency key so a retry
    // converges on the same contact rather than minting a second, and the
    // caller's invoice fails rather than being raised against a customer
    // nobody chose.
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
    const { transferredFrom } = linkOutcome;
    if (transferredFrom) {
      logger.warn(
        {
          organisationId,
          xeroContactId: transferredFrom.xeroContactId,
          fromMemberId: transferredFrom.fromMemberId,
        },
        "This school's Xero customer moved from its own invented member record " +
          "to the school (#3367, INV-INT-018). Nothing changed in Xero.",
      );
    }
    await completeXeroSyncOperation(operation.id, {
      responsePayload: transferredFrom
        ? { ...(completionPayload as object), transferredFrom }
        : completionPayload,
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
