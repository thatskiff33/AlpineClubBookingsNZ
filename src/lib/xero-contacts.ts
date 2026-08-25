/**
 * Xero contact create/update/search and stale-link repair.
 *
 * Provides `findOrCreateXeroContact`, `createXeroContactForMember`,
 * `updateXeroContact`, the contact-name normalisation helpers used for
 * matching, and the `retryXeroWriteWithContactRepair` helper that
 * invoice write paths call when Xero reports a stale contact link.
 * Duplicate-detection and potential-match helpers live in
 * xero-duplicate-contacts.ts.
 */

import {
  Address,
  Contact,
  Phone,
  type XeroClient,
} from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import type { Prisma } from "@prisma/client";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  getXeroErrorSearchText,
  isRetryableXeroContactReferenceError,
  XeroDailyLimitError,
} from "./xero-api-client";
import { syncManagedXeroContactGroupForMember } from "./xero-contact-groups";
import { buildXeroContactUpdatePayload } from "./xero-contact-sync";
import { buildXeroContactCompanyNumberPatch } from "@/lib/xero-contact-date-of-birth";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import {
  applyXeroContactEmailPolicy,
  resolveXeroContactEmailPolicy,
  type XeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";
import { ensureXeroContactContained } from "@/lib/xero-contact-containment-proof";
import {
  ambiguousMemberContactCreateReservationWhere,
  assertMemberAvailableForXeroContactChange,
  closeProviderCreatedContactRecoveryForLinkedContact,
  lockMemberForXeroContactLink,
  recordProviderCreatedContactPendingLocalLink,
  XeroContactAlreadyLinkedError,
  XeroContactCreateInProgressError,
  XeroContactLinkChangedError,
} from "@/lib/xero-contact-create-recovery";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class XeroContactValidationError extends Error {
  missingFields: string[];

  constructor(missingFields: string[]) {
    super(
      `Member is missing required fields for Xero contact creation: ${missingFields.join(", ")}`
    );
    this.name = "XeroContactValidationError";
    this.missingFields = missingFields;
  }
}

export interface FindOrCreateXeroContactOptions {
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  /**
   * An already-authenticated Xero client, for the containment verification on
   * the steady-state path (#3036 review P1-12).
   *
   * PURELY AN OPTIMISATION, and it is safe to omit: containment builds its own
   * client when it needs one. What it saves is a DUPLICATE build. The
   * steady-state path returns before `getAuthenticatedXeroClient()` — which is
   * right, since a proof that matches costs no provider call at all — but when
   * the proof is stale or absent, containment then authenticates a second time
   * even though every document writer built a client two lines before calling
   * this function. On a restored copy's first pass that is one extra token read
   * plus one extra `xero.initialize()` (an OIDC discovery round trip, not
   * cached) PER CONTACT.
   *
   * Both must be supplied together or neither is used.
   */
  xero?: XeroClient;
  tenantId?: string;
}

type ContactCreateOperationInput = Omit<
  Parameters<typeof startXeroSyncOperation>[0],
  "store"
>;

type ContactUpdateOperationInput = ContactCreateOperationInput;

const MEMBER_CONTACT_UPDATE_RESERVATION_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  passwordHash: true,
  xeroContactId: true,
  dateOfBirth: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
} as const;

export type LockedMemberContactUpdateSnapshot = Prisma.MemberGetPayload<{
  select: typeof MEMBER_CONTACT_UPDATE_RESERVATION_SELECT;
}>;

export type LockedMemberContactCreateSnapshot =
  LockedMemberContactUpdateSnapshot;

export type MemberContactCreateReservationPlan<T> = {
  input: ContactCreateOperationInput;
  value: T;
};

export type MemberContactUpdateReservationPlan<T> = {
  input: ContactUpdateOperationInput;
  value: T;
};

/**
 * Commit the exact member-scoped CREATE reservation before any provider create.
 * Member merge takes the conflicting Member FOR UPDATE set and rechecks these
 * rows under that lock, so either the reservation is visible to merge or the
 * member disappears before this transaction can reserve it.
 *
 * `repairExistingLink` is the caller's EXPLICIT declaration that the member's
 * current link is unusable — Xero rejected the contact reference, or an admin
 * asked for a forced re-resolution. Without it an already-linked member is
 * refused, because minting a second contact for a member who has a good one is
 * a duplicate in the club's books. With it the reservation is allowed, since
 * refusing was a dead end: the repair path reaches this reservation whenever
 * Xero produced no match, deterministically so for a walk-in placeholder-email
 * owner whose email search is skipped by design, and `XERO_CONTACT_ALREADY_LINKED`
 * then 409'd every attempt with nothing able to clear it (#2623 T2).
 */
export async function reserveMemberContactCreateOperation<T>(
  memberId: string,
  buildPlan: (
    member: LockedMemberContactCreateSnapshot,
  ) => MemberContactCreateReservationPlan<T>,
  db: typeof prisma = prisma,
  options?: { repairExistingLink?: boolean },
): Promise<{
  operation: Awaited<ReturnType<typeof startXeroSyncOperation>>;
  value: T;
}> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT 1
      FROM "Member"
      WHERE "id" = ${memberId}
      FOR KEY SHARE
    `;
    const locked = await tx.member.findUnique({
      where: { id: memberId },
      select: MEMBER_CONTACT_UPDATE_RESERVATION_SELECT,
    });
    if (!locked) {
      throw new Error(`Member not found: ${memberId}`);
    }
    assertMemberAvailableForXeroContactChange(locked);
    if (locked.xeroContactId && !options?.repairExistingLink) {
      throw new XeroContactAlreadyLinkedError();
    }
    const ambiguousReservation = await tx.xeroSyncOperation.findFirst({
      where: ambiguousMemberContactCreateReservationWhere(memberId),
      select: { id: true },
    });
    if (ambiguousReservation) {
      throw new XeroContactCreateInProgressError();
    }
    const plan = buildPlan(locked);
    const operation = await startXeroSyncOperation({
      ...plan.input,
      store: tx,
    });
    return { operation, value: plan.value };
  });
}

/**
 * Commit a Member-scoped UPDATE reservation before provider work. Merge and
 * deletion take the conflicting Member FOR UPDATE row and re-check this exact
 * RUNNING operation, while completion takes the same row and closes the
 * operation plus canonical link atomically.
 */
export async function reserveMemberContactUpdateOperation<T>(
  memberId: string,
  xeroContactId: string,
  buildPlan: (
    member: LockedMemberContactUpdateSnapshot,
  ) => MemberContactUpdateReservationPlan<T> | null,
  db: typeof prisma = prisma,
): Promise<{
  operation: Awaited<ReturnType<typeof startXeroSyncOperation>>;
  value: T;
} | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT 1
      FROM "Member"
      WHERE "id" = ${memberId}
      FOR KEY SHARE
    `;
    const locked = await tx.member.findUnique({
      where: { id: memberId },
      select: MEMBER_CONTACT_UPDATE_RESERVATION_SELECT,
    });
    if (!locked) {
      throw new Error(`Member not found: ${memberId}`);
    }
    assertMemberAvailableForXeroContactChange(locked);
    if (locked.xeroContactId !== xeroContactId) {
      throw new XeroContactLinkChangedError();
    }
    const plan = buildPlan(locked);
    if (!plan) return null;
    const operation = await startXeroSyncOperation({
      ...plan.input,
      store: tx,
    });
    return { operation, value: plan.value };
  });
}

export async function completeMemberContactUpdateOperation(
  memberId: string,
  expectedXeroContactId: string,
  operationId: string,
  completion: Parameters<typeof completeXeroSyncOperation>[1],
  db: typeof prisma = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const locked = await lockMemberForXeroContactLink(tx, memberId);
    if (locked.xeroContactId !== expectedXeroContactId) {
      throw new XeroContactLinkChangedError();
    }
    await completeXeroSyncOperation(operationId, completion, { store: tx });
  });
}

export interface XeroContactUpdateData {
  firstName?: string;
  lastName?: string;
  email: string;
  dateOfBirth?: Date | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation / matching helpers
// ---------------------------------------------------------------------------

export function normalizeXeroContactMatchValue(
  value: string | null | undefined
): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

export function buildMemberFullName(member: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return [member.firstName, member.lastName]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildXeroContactDisplayName(
  contact: Pick<Contact, "name" | "firstName" | "lastName">
) {
  if (contact.name?.trim()) {
    return contact.name.trim();
  }

  return [contact.firstName, contact.lastName]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeXeroContactMatchValue(
  value: string | null | undefined
): string[] {
  return normalizeXeroContactMatchValue(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function namesLookSimilarForPotentialMatch(
  memberName: string,
  contactName: string
): boolean {
  const memberTokens = [...new Set(tokenizeXeroContactMatchValue(memberName))];
  const contactTokens = new Set(tokenizeXeroContactMatchValue(contactName));

  if (memberTokens.length === 0 || contactTokens.size === 0) {
    return false;
  }

  let matchedTokens = 0;
  for (const token of memberTokens) {
    if (contactTokens.has(token)) {
      matchedTokens += 1;
    }
  }

  const requiredMatches = Math.min(memberTokens.length, 2);
  return matchedTokens >= requiredMatches;
}

function isDuplicateActiveXeroContactNameError(error: unknown): boolean {
  const text = getXeroErrorSearchText(error);
  return (
    text.includes("already assigned to another contact") ||
    (text.includes("contact name") && text.includes("must be unique"))
  );
}

// ---------------------------------------------------------------------------
// Address builders / validation
// ---------------------------------------------------------------------------

function buildXeroAddresses(member: {
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
}): Address[] {
  const addresses: Address[] = [];
  if (member.streetAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.STREET,
      addressLine1: member.streetAddressLine1,
      addressLine2: member.streetAddressLine2 || "",
      city: member.streetCity || "",
      region: member.streetRegion || "",
      postalCode: member.streetPostalCode || "",
      country: member.streetCountry || "",
    });
  }
  if (member.postalAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.POBOX,
      addressLine1: member.postalAddressLine1,
      addressLine2: member.postalAddressLine2 || "",
      city: member.postalCity || "",
      region: member.postalRegion || "",
      postalCode: member.postalPostalCode || "",
      country: member.postalCountry || "",
    });
  }
  return addresses;
}

// Server-side create gate (#2089). Xero's contact-create API requires only a
// unique contact name; this app additionally keeps email required because Xero
// uses it for invoice delivery and contact matching. Phone, date of birth,
// joined date, and both addresses are OPTIONAL — the payload builder omits
// blank addresses/phone and omits `companyNumber` for a member with no date of
// birth (#2859), and joined date is never sent to Xero at all. This helper is
// the single source of truth for the create gate; the client mirror
// (`getMissingFieldsForXeroCreate`, members/_utils.ts) must stay in lockstep
// with the required set here.
export function getMissingFieldsForXeroContactCreate(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): string[] {
  const missingFields: string[] = [];

  if (!member.firstName?.trim()) missingFields.push("First Name");
  if (!member.lastName?.trim()) missingFields.push("Last Name");
  if (!member.email?.trim()) missingFields.push("Email");

  return missingFields;
}

/**
 * The contact request as it is PERSISTED, which is deliberately not the contact
 * request as it is SENT (INV-PRIV-011, #2683).
 *
 * Xero's accounting API requires `Name` on a contact, so these writers have to
 * send `"${firstName} ${lastName}"` — there is no version of the request that
 * omits it. But the same object was handed to `startXeroSyncOperation` as the
 * operation's `requestPayload`, so every contact create and every contact update
 * wrote a member's full name into `XeroSyncOperation.requestPayload` and kept it
 * there. `firstName`, `lastName`, `emailAddress` and the address lines are all
 * stripped by the redactor on the way in; `name` is not, and cannot be, because
 * `name` is also the key for lodges, rooms, templates and Xero contact groups
 * that the admin panel reads back out of these very payloads.
 *
 * So it is removed here, at the persistence boundary, the same way the other
 * call sites that composed a person's name were fixed at source. The idempotency
 * key is unaffected: `buildXeroPayloadHash` runs on the outbound request, not on
 * the stored copy, precisely so that redaction cannot change an operation's
 * identity.
 *
 * Shape-tolerant on purpose — `retryXeroWriteWithContactRepair` is shared with
 * the invoice and credit-note writers, and this must be a no-op for their
 * payloads.
 */
function stripPersonNameFromStoredContactPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.contacts)) {
    return payload;
  }
  return {
    ...record,
    contacts: record.contacts.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const contact = entry as Record<string, unknown>;
      if (!("name" in contact)) {
        return entry;
      }
      const stored: Record<string, unknown> = { ...contact };
      delete stored.name;
      return stored;
    }),
  };
}

/*
  INV-CONFIG-005 (#3036): the `policy` argument is the compile-time half of Xero
  contact containment. It cannot be constructed outside
  `xero-contact-containment.ts`, so a new contact-payload builder cannot be
  written without first asking what installation this is; and on the club's live
  site `applyXeroContactEmailPolicy` is the identity function, so the payload
  below — and therefore its stored request payload and its idempotency key — is
  byte-identical to what it was before that issue.
*/
function buildMemberXeroContactCreatePayload(
  member: LockedMemberContactCreateSnapshot,
  policy: XeroContactEmailPolicy,
): Contact {
  const missingFields = getMissingFieldsForXeroContactCreate(member);
  if (missingFields.length > 0) {
    throw new XeroContactValidationError(missingFields);
  }

  const hasAnyPhonePart = Boolean(
    member.phoneCountryCode?.trim() ||
      member.phoneAreaCode?.trim() ||
      member.phoneNumber?.trim(),
  );
  return {
    name: `${member.firstName} ${member.lastName}`,
    firstName: member.firstName,
    lastName: member.lastName,
    emailAddress: applyXeroContactEmailPolicy(
      policy,
      isPlaceholderContactEmail(member.email) ? "" : member.email,
    ),
    // #2859: the member's date of birth, in the `dd/mm/yyyy` shape the import
    // side has always read back out of this field. `null` — an EXPLICIT "the
    // field is known to be empty" — because this payload creates the contact,
    // so there is nothing in Xero to clobber. Omitting the argument would mean
    // "nothing is known", which the guard refuses to write into. A member with
    // no date of birth contributes no key at all.
    ...buildXeroContactCompanyNumberPatch(member.dateOfBirth, null),
    phones: hasAnyPhonePart
      ? [
          {
            phoneType: Phone.PhoneTypeEnum.MOBILE,
            phoneCountryCode: member.phoneCountryCode || "",
            phoneAreaCode: member.phoneAreaCode || "",
            phoneNumber: member.phoneNumber || "",
          },
        ]
      : [],
    addresses: buildXeroAddresses(member),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function linkMatchedXeroContact(
  tx: Prisma.TransactionClient,
  input: {
    memberId: string;
    contactId: string;
    previousXeroContactId?: string | null;
    repairExistingLink?: boolean;
    linkedVia:
      | "email_match"
      | "email_match_repair"
      | "name_match"
      | "name_match_repair";
    contactName?: string | null;
  }
) {
  const existingLink = await tx.member.findFirst({
    where: {
      xeroContactId: input.contactId,
      id: { not: input.memberId },
    },
    select: {
      firstName: true,
      lastName: true,
    },
  });

  if (existingLink) {
    throw new Error(
      `Matched Xero contact is already linked to ${existingLink.firstName} ${existingLink.lastName}.`
    );
  }

  await tx.member.update({
    where: { id: input.memberId },
    data: { xeroContactId: input.contactId },
  });
  await upsertXeroObjectLink(
    {
      localModel: "Member",
      localId: input.memberId,
      xeroObjectType: "CONTACT",
      xeroObjectId: input.contactId,
      xeroObjectUrl: buildXeroContactUrl(input.contactId),
      role: "CONTACT",
      metadata: {
        linkedVia: input.linkedVia,
        contactName: input.contactName?.trim()
          ? input.contactName.trim()
          : undefined,
        repairedFromXeroContactId:
          input.repairExistingLink &&
          input.previousXeroContactId &&
          input.previousXeroContactId !== input.contactId
            ? input.previousXeroContactId
            : undefined,
      },
    },
    { store: tx },
  );
}

async function findExistingXeroContactByExactName(input: {
  xero: XeroClient;
  tenantId: string;
  fullName: string;
  contextPrefix: string;
}): Promise<Contact | null> {
  const normalizedName = normalizeXeroContactMatchValue(input.fullName);
  if (!normalizedName) {
    return null;
  }

  const contactsResponse = await callXeroApi(
    () =>
      input.xero.accountingApi.getContacts(
        input.tenantId,
        undefined, // ifModifiedSince
        undefined, // where
        undefined, // order
        undefined, // iDs
        1, // page
        false, // includeArchived
        true, // summaryOnly
        input.fullName.replace(/"/g, ""),
        20 // pageSize
      ),
    {
      operation: "getContacts",
      resourceType: "CONTACT",
      workflow: "findOrCreateXeroContact",
      context: `${input.contextPrefix} searchByName(${input.fullName})`,
    }
  );

  return (
    contactsResponse.body.contacts?.find(
      (contact) =>
        normalizeXeroContactMatchValue(buildXeroContactDisplayName(contact)) ===
        normalizedName
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Find / create
// ---------------------------------------------------------------------------

export async function findOrCreateXeroContact(
  memberId: string,
  options?: FindOrCreateXeroContactOptions
): Promise<string> {
  // F7 (#1355): Xero API calls (OAuth refresh, searches, createContacts and
  // its up-to-120s retry sleeps) must NEVER run inside the advisory-locked
  // transaction — Prisma's 5s interactive-transaction default aborted the tx
  // AFTER the external side effect whenever Xero was slow, rolling back the
  // local link while the Xero contact persisted, on every new-member/repair
  // invoice path. The restructure:
  //   Phase 0 — lock-free steady-state fast path (trust the persisted link).
  //   Phase 1 — ALL Xero work outside any transaction. Concurrent duplicate
  //             creation is prevented by the member-scoped Xero idempotency
  //             key (identical concurrent creates converge on one contact),
  //             not by holding a DB lock across provider calls.
  //   Phase 2 — a SHORT advisory-locked transaction re-checks then writes
  //             the local link (first-writer-wins against a concurrent
  //             resolver).
  //   Op-log completion runs POST-COMMIT so an operation is never recorded
  //   SUCCEEDED for work whose surrounding transaction rolled back.
  //   INV-CONFIG-005 (#3036) — FIRST, before any provider work: what
  //             installation is this? On the club's live site this is a no-op
  //             and everything below is unchanged. On a confirmed copy every
  //             contact address is contained. When NOTHING has declared which
  //             this is, `resolveXeroContactEmailPolicy` throws here, so an
  //             undeclared installation raises no invoice against a contact it
  //             cannot vouch for.
  /*
    THE POLICY IS RESOLVED ONCE AND PHASE 1 IS LONG, so an administrator switching
    the safer override on during it leaves this contact written under the previous
    answer — a real TOCTOU window, documented rather than closed (#3071 review).
    Re-resolving later could not un-send it: by Phase 2 the contact already exists
    in Xero. It SELF-HEALS but not instantly — the next document writer to resolve
    this member takes the steady-state path above, which resolves afresh and
    contains the address — and until then an invoice raised in the same workflow is
    raised against a real address, which Xero's own reminders would email. Remedy:
    Admin -> Environment lists uncontained contacts, and `guides/environment-role.md`
    -> "Putting a replaced address back" covers the repair. Not closed here because
    a lock spanning the provider calls is the F7 (#1355) failure this function was
    restructured to remove, and a mid-Phase re-resolve would narrow the window
    while inviting a reader to think it gone.
  */
  const { policy: emailPolicy } = await resolveXeroContactEmailPolicy();
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member) throw new Error(`Member not found: ${memberId}`);
  assertMemberAvailableForXeroContactChange(member);

  // Trust the persisted contact link on steady-state write paths and avoid
  // a read-before-write. Retry/repair paths can opt in to relinking.
  if (member.xeroContactId && !options?.repairExistingLink) {
    const xeroContactId = await prisma.$transaction(async (tx) => {
      const fresh = await lockMemberForXeroContactLink(tx, memberId);
      if (!fresh.xeroContactId) {
        throw new XeroContactAlreadyLinkedError();
      }
      await upsertXeroObjectLink(
        {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "CONTACT",
          xeroObjectId: fresh.xeroContactId,
          xeroObjectUrl: buildXeroContactUrl(fresh.xeroContactId),
          role: "CONTACT",
        },
        { store: tx },
      );
      return fresh.xeroContactId;
    });
    /*
      THE RESTORED-DATABASE PATH, and the reason this issue exists. Every member
      in a copy restored from the club's live database is already linked, so this
      branch is the one all twelve document writers take — with no provider write
      and no look at what the contact holds. Xero then emails its own reminders
      for outstanding AUTHORISED invoices, from its own servers, to that stored
      address. So containment happens HERE, after the short link transaction has
      committed (a provider call must never run inside it) and before the id
      reaches anything that can raise an invoice.
    */
    await ensureXeroContactContained({
      policy: emailPolicy,
      xeroContactId,
      sourceEmail: member.email,
      workflow: "findOrCreateXeroContact",
      // The caller's client when it has one — see the option's docblock. Only
      // reached when the proof is stale or absent; a matching proof returns
      // above without a provider call at all.
      xero: options?.xero,
      tenantId: options?.tenantId,
    });
    await syncContactGroupsBestEffort(memberId, xeroContactId, options);
    return xeroContactId;
  }

  // ── Phase 1: Xero resolution, OUTSIDE any transaction ──────────────
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const previousXeroContactId = member.xeroContactId;

  type ResolvedContact =
    | {
        kind: "matched";
        contactId: string;
        linkedVia: "email_match" | "email_match_repair" | "name_match" | "name_match_repair";
        contactName: string | null;
        operationId: string | null;
        completionInput: Parameters<typeof completeXeroSyncOperation>[1] | null;
      }
    | {
        kind: "created";
        contactId: string;
        operationId: string;
        completionInput: Parameters<typeof completeXeroSyncOperation>[1];
      };
  let resolved: ResolvedContact | null = null;

    // Search by email first.
    // Email quotes are stripped to keep the OData filter syntactically valid;
    // z.string().email() at the API boundary ensures only RFC-valid emails
    // reach this point, so no further escaping is needed.
  // Walk-in placeholder owners (#1935) have no real address: skip the Xero
  // email search entirely (a placeholder must never match a real contact) and
  // fall through to creating a contact with an empty email below.
  if (!isPlaceholderContactEmail(member.email)) try {
    const contactsResponse = await callXeroApi(
      () =>
        xero.accountingApi.getContacts(
          tenantId,
          undefined, // ifModifiedSince
          `EmailAddress="${member.email.replace(/"/g, "")}"` // where clause
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "findOrCreateXeroContact",
        context: `findOrCreateXeroContact searchByEmail(${member.email})`,
      }
    );
    const contacts = contactsResponse.body.contacts;
    if (contacts && contacts.length > 0) {
      resolved = {
        kind: "matched",
        contactId: contacts[0].contactID!,
        linkedVia: options?.repairExistingLink ? "email_match_repair" : "email_match",
        contactName: buildXeroContactDisplayName(contacts[0]),
        operationId: null,
        completionInput: null,
      };
    }
  } catch (searchErr) {
    // Rate-limit errors must propagate — swallowing them would cause a new
    // contact to be created and waste the daily quota further.
    if (searchErr instanceof XeroDailyLimitError) throw searchErr;
    // Any other error (network timeout, transient 5xx) is logged and we
    // fall through to contact creation. This is intentional: a failed
    // search is recoverable, whereas failing to create the invoice is not.
    logger.warn(
      { err: searchErr, memberId, email: member.email },
      "Xero email search failed; falling through to contact creation"
    );
  }

  // #2623 T2: a repair of an EXISTING link that found no email match is one
  // step from minting a second Xero contact for a member who may already have a
  // perfectly good one — and for a walk-in placeholder owner the email search
  // never runs at all, so that is the only step left. Ask Xero by exact name
  // first. `getContacts` here excludes archived contacts, which is precisely the
  // discrimination wanted: a live same-named contact is the link to repair TO,
  // while an archived/absent one leaves creation as the honest outcome.
  if (!resolved && options?.repairExistingLink && previousXeroContactId) {
    try {
      const matchedByName = await findExistingXeroContactByExactName({
        xero,
        tenantId,
        fullName: buildMemberFullName(member),
        contextPrefix: "findOrCreateXeroContact repair name re-resolution",
      });
      if (matchedByName?.contactID) {
        resolved = {
          kind: "matched",
          contactId: matchedByName.contactID,
          linkedVia: "name_match_repair",
          contactName: buildXeroContactDisplayName(matchedByName),
          operationId: null,
          completionInput: null,
        };
      }
    } catch (nameSearchErr) {
      if (nameSearchErr instanceof XeroDailyLimitError) throw nameSearchErr;
      logger.warn(
        { err: nameSearchErr, memberId, previousXeroContactId },
        "Xero name search failed during link repair; falling through to contact creation",
      );
    }
  }

  if (!resolved) {
    // Create new contact (still outside any transaction). The member-scoped
    // Xero idempotency key makes concurrent duplicate creates converge on
    // one contact, which is what previously justified holding the advisory
    // lock across this call.
    const idempotencyKey = buildXeroIdempotencyKey(
      "member",
      memberId,
      "contact",
      "find-or-create",
      "v1"
    );
    const {
      operation,
      value: { contact, lockedMember },
    } = await reserveMemberContactCreateOperation(
      memberId,
      (locked) => {
        const contact = buildMemberXeroContactCreatePayload(locked, emailPolicy);
        return {
          input: {
            direction: "OUTBOUND",
            entityType: "CONTACT",
            operationType: "CREATE",
            localModel: "Member",
            localId: memberId,
            idempotencyKey,
            correlationKey: idempotencyKey,
            // INV-PRIV-011 (#2683): sent with Xero's required Name, stored without it.
            requestPayload: stripPersonNameFromStoredContactPayload({
              contacts: [contact],
            }),
            createdByMemberId: options?.createdByMemberId ?? null,
          },
          value: { contact, lockedMember: locked },
        };
      },
      prisma,
      // Only an explicit repair may reserve for an already-linked member.
      { repairExistingLink: options?.repairExistingLink },
    );

    try {
      const response = await callXeroApi(
        () =>
          xero.accountingApi.createContacts(
            tenantId,
            { contacts: [contact] },
            undefined,
            idempotencyKey
          ),
        {
          operation: "createContacts",
          resourceType: "CONTACT",
          workflow: "findOrCreateXeroContact",
          context: `createContacts(findOrCreate ${memberId})`,
        }
      );
      const createdContact = response.body.contacts?.[0];
      if (!createdContact?.contactID) {
        throw new Error("Failed to create Xero contact");
      }

      await persistProviderCreatedContactProofOrThrow(
        operation.id,
        createdContact.contactID,
      );

      resolved = {
        kind: "created",
        contactId: createdContact.contactID,
        operationId: operation.id,
        completionInput: {
          responsePayload: response.body,
          xeroObjectType: "CONTACT",
          xeroObjectId: createdContact.contactID,
          xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
          extraLinks: [
            {
              localModel: "Member",
              localId: memberId,
              xeroObjectType: "CONTACT",
              xeroObjectId: createdContact.contactID,
              xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
              role: "CONTACT",
            },
          ],
        },
      };
    } catch (error) {
      if (error instanceof XeroContactCreatePartialSuccessError) throw error;
      if (isDuplicateActiveXeroContactNameError(error)) {
        try {
          const matchedContact = await findExistingXeroContactByExactName({
            xero,
            tenantId,
            fullName: buildMemberFullName(lockedMember),
            contextPrefix: "findOrCreateXeroContact duplicate-name recovery",
          });

          if (matchedContact?.contactID) {
            resolved = {
              kind: "matched",
              contactId: matchedContact.contactID,
              linkedVia: options?.repairExistingLink
                ? "name_match_repair"
                : "name_match",
              contactName: buildXeroContactDisplayName(matchedContact),
              operationId: operation.id,
              completionInput: {
                responsePayload: {
                  resolution: "linked_existing_contact_by_name",
                  matchedBy: "name",
                  duplicateCreateError: sanitizeForJson(error),
                },
                xeroObjectType: "CONTACT",
                xeroObjectId: matchedContact.contactID,
                xeroObjectUrl: buildXeroContactUrl(matchedContact.contactID),
                extraLinks: [
                  {
                    localModel: "Member",
                    localId: memberId,
                    xeroObjectType: "CONTACT",
                    xeroObjectId: matchedContact.contactID,
                    xeroObjectUrl: buildXeroContactUrl(matchedContact.contactID),
                    role: "CONTACT",
                  },
                ],
              },
            };
          }
        } catch (recoveryError) {
          await failXeroSyncOperation(operation.id, recoveryError, {
            duplicateCreateError: sanitizeForJson(error),
            recoveryError: sanitizeForJson(recoveryError),
          });
          throw recoveryError;
        }
      }

      if (!resolved) {
        await failXeroSyncOperation(operation.id, error);
        throw error;
      }
    }
  }

  // ── Phase 2: SHORT advisory-locked transaction, re-check-then-write ──
  // Only local writes happen under the lock; the 5s interactive-transaction
  // budget is ample. First-writer-wins: a concurrent resolver that linked
  // while our Xero work ran keeps its link (identical concurrent creates
  // converge on the same contact via the shared idempotency key anyway).
  const finalResolved = resolved;
  if (!finalResolved) {
    throw new Error(`Failed to resolve a Xero contact for member ${memberId}`);
  }

  let linkOutcome: { contactId: string; wonWrite: boolean };
  try {
    linkOutcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;
      const fresh = await lockMemberForXeroContactLink(tx, memberId);

      if (
        fresh.xeroContactId &&
        !options?.repairExistingLink &&
        fresh.xeroContactId !== finalResolved.contactId
      ) {
        return { contactId: fresh.xeroContactId, wonWrite: false };
      }

      if (finalResolved.kind === "matched") {
        await linkMatchedXeroContact(tx, {
          memberId,
          contactId: finalResolved.contactId,
          previousXeroContactId,
          repairExistingLink: options?.repairExistingLink,
          linkedVia: finalResolved.linkedVia,
          contactName: finalResolved.contactName,
        });
      } else {
        await tx.member.update({
          where: { id: memberId },
          data: { xeroContactId: finalResolved.contactId },
        });
        // #2859: record that THIS APP CREATED this contact, as a positive fact.
        // `buildXeroContactCompanyNumberPatch` may write the member's date of
        // birth into a contact the app made without first observing its NZBN
        // field, because a contact that did not exist a moment ago can hold
        // nothing in that field but this app's own writes. It may NOT assume
        // that of a contact it merely linked.
        //
        // It has to be a positive marker rather than the ABSENCE of the
        // `linkedVia: "email_match" | "name_match"` that `linkMatchedXeroContact`
        // writes: `xero-member-import.ts` links members onto pre-existing Xero
        // contacts by setting `xeroContactId` directly, with no link metadata at
        // all, and that is how essentially the whole live membership got its
        // contacts. Reading "no match metadata" as "we created it" would hand
        // exactly those contacts' business numbers to the birthday writer.
        await upsertXeroObjectLink(
          {
            localModel: "Member",
            localId: memberId,
            xeroObjectType: "CONTACT",
            xeroObjectId: finalResolved.contactId,
            xeroObjectUrl: buildXeroContactUrl(finalResolved.contactId),
            role: "CONTACT",
            metadata: { linkedVia: "created" },
          },
          { store: tx },
        );
      }
      // #2623 T7: if an EARLIER create already made this very contact in Xero
      // and only failed to link it, this write is the local half it was waiting
      // for. Close it under the same Member fence rather than leaving a stale
      // blocker on member merge and account deletion.
      await closeProviderCreatedContactRecoveryForLinkedContact(
        tx,
        memberId,
        finalResolved.contactId,
      );
      return { contactId: finalResolved.contactId, wonWrite: true };
    });
  } catch (linkError) {
    if (finalResolved.operationId) {
      try {
        await failXeroSyncOperation(finalResolved.operationId, linkError, {
          phase: "local_link_after_xero_resolution",
          resolvedContactId: finalResolved.contactId,
          providerContactCreated: finalResolved.kind === "created",
        });
      } catch (failErr) {
        logger.error(
          { err: failErr, memberId },
          "Failed to record local-link failure on the contact operation"
        );
      }
    }
    throw linkError;
  }

  // Post-commit op-log close (F7 task 3): success is recorded only for work
  // that actually committed; a phase-2 failure marks the operation FAILED via
  // the catch below instead of leaving a SUCCEEDED record for rolled-back
  // state. (linkMatchedXeroContact throws inside the tx when the contact is
  // already linked to another member — that failure path is covered too.)
  if (finalResolved.operationId && finalResolved.completionInput) {
    if (linkOutcome.wonWrite) {
      await completeXeroSyncOperation(
        finalResolved.operationId,
        finalResolved.completionInput
      );
    } else {
      logger.warn(
        {
          memberId,
          resolvedContactId: finalResolved.contactId,
          existingContactId: linkOutcome.contactId,
        },
        "Concurrent resolver linked a different Xero contact first; recording the unlinked resolution"
      );
      await completeXeroSyncOperation(finalResolved.operationId, {
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
  }

  const xeroContactId = linkOutcome.contactId;
  /*
    Also on this path, and for three cases the create payload does not cover: a
    contact MATCHED by email or exact name (somebody else's real address may be
    on it), a contact this resolution lost the write race for (the id returned is
    a concurrent resolver's, not ours), and a contact we did create — which is
    contained by construction and is still VERIFIED rather than assumed, because
    a record asserting something we did not look at is the defect shape this epic
    kept finding. `xero` and `tenantId` are already authenticated here, so the
    verification costs one provider read and no second token refresh.
  */
  await ensureXeroContactContained({
    policy: emailPolicy,
    xeroContactId,
    sourceEmail: member.email,
    workflow: "findOrCreateXeroContact",
    xero,
    tenantId,
  });
  await syncContactGroupsBestEffort(memberId, xeroContactId, options);
  return xeroContactId;
}

async function syncContactGroupsBestEffort(
  memberId: string,
  xeroContactId: string,
  options?: { createdByMemberId?: string }
) {
  try {
    await syncManagedXeroContactGroupForMember(memberId, {
      createdByMemberId: options?.createdByMemberId,
    });
  } catch (error) {
    logger.error(
      { err: error, memberId, xeroContactId },
      "Failed to sync managed Xero contact groups after linking contact"
    );
  }
}

/**
 * Create a brand-new Xero contact for a member and link it locally.
 * Unlike findOrCreateXeroContact, this does not try to match existing
 * contacts by email.
 */
export type XeroContactCreatePartialSuccessPhase =
  | "PROVIDER_CONTACT_CREATED"
  | "LOCAL_MEMBER_LINK_COMMITTED";

/**
 * A fixed, typed boundary for irreversible Xero contact-create progress.
 * `originalError` is server-only diagnostic context; routes must expose only
 * the phase and contact id through the privacy-safe recovery contract.
 */
export class XeroContactCreatePartialSuccessError extends Error {
  readonly phase: XeroContactCreatePartialSuccessPhase;
  readonly xeroContactId: string;
  readonly originalError: unknown;

  constructor(
    phase: XeroContactCreatePartialSuccessPhase,
    xeroContactId: string,
    originalError: unknown,
  ) {
    super("Xero contact creation completed only in part");
    this.name = "XeroContactCreatePartialSuccessError";
    this.phase = phase;
    this.xeroContactId = xeroContactId;
    this.originalError = originalError;
  }
}

async function persistProviderCreatedContactProofOrThrow(
  operationId: string,
  resolvedContactId: string,
): Promise<void> {
  try {
    await recordProviderCreatedContactPendingLocalLink({
      operationId,
      resolvedContactId,
    });
  } catch (proofError) {
    try {
      await failXeroSyncOperation(operationId, proofError, {
        phase: "local_link_after_xero_resolution",
        resolvedContactId,
        providerContactCreated: true,
      });
    } catch (failError) {
      logger.error(
        { err: failError, operationId },
        "Failed to preserve provider-created Xero contact recovery proof",
      );
    }
    throw new XeroContactCreatePartialSuccessError(
      "PROVIDER_CONTACT_CREATED",
      resolvedContactId,
      proofError,
    );
  }
}

export async function createXeroContactForMember(
  memberId: string,
  options?: { createdByMemberId?: string }
): Promise<string> {
  // F7 (#1355): same restructure as findOrCreateXeroContact — the Xero
  // create (OAuth refresh + up-to-120s retry sleeps) runs OUTSIDE any
  // transaction; only the local link write takes the short advisory-locked
  // transaction. This function's contract is create-and-overwrite (an admin
  // explicitly minting a fresh contact), so no first-writer re-check applies;
  // the member-scoped idempotency key bounds concurrent duplicates.
  // INV-CONFIG-005 (#3036): same first question as the funnel, and for the same
  // reason — this function creates a contact carrying an email address, so an
  // undeclared installation must not reach the provider at all.
  const { policy: emailPolicy } = await resolveXeroContactEmailPolicy();
  const idempotencyKey = buildXeroIdempotencyKey(
      "member",
      memberId,
      "contact",
      "create",
      "v1"
    );
  const { operation, value: contact } =
    await reserveMemberContactCreateOperation(memberId, (locked) => {
      const contact = buildMemberXeroContactCreatePayload(locked, emailPolicy);
      return {
        input: {
          direction: "OUTBOUND",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: memberId,
          idempotencyKey,
          correlationKey: idempotencyKey,
          // INV-PRIV-011 (#2683): sent with Xero's required Name, stored without it.
          requestPayload: stripPersonNameFromStoredContactPayload({
            contacts: [contact],
          }),
          createdByMemberId: options?.createdByMemberId ?? null,
        },
        value: contact,
      };
    });

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  let createdContactId: string;
  let completionInput: Parameters<typeof completeXeroSyncOperation>[1];
  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createContacts(
          tenantId,
          { contacts: [contact] },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createContacts",
        resourceType: "CONTACT",
        workflow: "createXeroContactForMember",
        context: `createContacts(member ${memberId})`,
      }
    );
    const createdContact = response.body.contacts?.[0];
    if (!createdContact?.contactID) {
      throw new Error("Failed to create Xero contact");
    }
    createdContactId = createdContact.contactID;
    await persistProviderCreatedContactProofOrThrow(
      operation.id,
      createdContactId,
    );
    completionInput = {
      responsePayload: response.body,
      xeroObjectType: "CONTACT",
      xeroObjectId: createdContactId,
      xeroObjectUrl: buildXeroContactUrl(createdContactId),
      extraLinks: [
        {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "CONTACT",
          xeroObjectId: createdContactId,
          xeroObjectUrl: buildXeroContactUrl(createdContactId),
          role: "CONTACT",
        },
      ],
    };
  } catch (error) {
    if (error instanceof XeroContactCreatePartialSuccessError) throw error;
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }

  // Short advisory-locked transaction: only the local link write.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;
      await lockMemberForXeroContactLink(tx, memberId);
      await tx.member.update({
        where: { id: memberId },
        data: { xeroContactId: createdContactId },
      });
    });
  } catch (linkError) {
    try {
      await failXeroSyncOperation(operation.id, linkError, {
        phase: "local_link_after_xero_resolution",
        resolvedContactId: createdContactId,
        providerContactCreated: true,
      });
    } catch (failErr) {
      logger.error(
        { err: failErr, memberId },
        "Failed to record local-link failure on the contact operation"
      );
    }
    throw new XeroContactCreatePartialSuccessError(
      "PROVIDER_CONTACT_CREATED",
      createdContactId,
      linkError,
    );
  }

  // Post-commit op-log close (F7 task 3).
  try {
    await completeXeroSyncOperation(operation.id, completionInput);
  } catch (completionError) {
    throw new XeroContactCreatePartialSuccessError(
      "LOCAL_MEMBER_LINK_COMMITTED",
      createdContactId,
      completionError,
    );
  }

  const xeroContactId = createdContactId;
  /*
    Verified rather than assumed, exactly as on the funnel's create branch: the
    payload above already carried the contained address, and the row that proves
    it is still written only after reading back what Xero stored.

    WRAPPED IN THE PARTIAL-SUCCESS PHASE THIS FUNCTION ALREADY OWNS, because a
    bare throw here would lose the one fact the admin needs. The contact EXISTS
    and is LINKED by the time this runs; only the proof is missing. A plain error
    reaches `/api/admin/members/[id]/xero-push` with no created-contact id, so
    the operator is told nothing was recorded, and pressing Create again is a
    dead end — the reservation refuses an already-linked member without an
    explicit repair. `LOCAL_MEMBER_LINK_COMMITTED` is the phase for exactly this
    shape and the route already renders it as "created and linked, post-processing
    pending", which is true. It still FAILS: the caller gets an error, and the
    proof is re-attempted by the next document writer that resolves this member
    (the funnel's steady-state path contains it), so it self-heals without an
    operator retry.
  */
  try {
    await ensureXeroContactContained({
      policy: emailPolicy,
      xeroContactId,
      // Already the CONTAINED form (the payload builder above applied the
      // policy), and `ensureXeroContactContained` fingerprints it through an
      // idempotent transform — so this is the same fingerprint the funnel derives
      // from the member's stored address for the same member.
      sourceEmail: contact.emailAddress ?? "",
      workflow: "createXeroContactForMember",
      xero,
      tenantId,
    });
  } catch (containmentError) {
    throw new XeroContactCreatePartialSuccessError(
      "LOCAL_MEMBER_LINK_COMMITTED",
      xeroContactId,
      containmentError,
    );
  }
  await syncContactGroupsBestEffort(memberId, xeroContactId, options);
  return xeroContactId;
}

// ---------------------------------------------------------------------------
// First-invoice date helper (used by bulk sync joined-date backfill)
// ---------------------------------------------------------------------------

export async function getContactFirstInvoiceDate(
  xero: XeroClient,
  tenantId: string,
  contactID: string
): Promise<Date | null> {
  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getInvoices(
          tenantId,
          undefined, // ifModifiedSince
          undefined, // where
          "Date ASC", // order - earliest first
          undefined, // iDs
          undefined, // invoiceNumbers
          [contactID], // contactIDs
          undefined, // statuses
          1, // page
          false, // includeArchived
          false, // createdByMyApp
          undefined, // unitdp
          false // summaryOnly
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "getContactFirstInvoiceDate",
        context: `getContactFirstInvoiceDate(${contactID})`,
      }
    );
    const invoices = response.body.invoices ?? [];
    if (invoices.length > 0 && invoices[0].date) {
      return new Date(invoices[0].date);
    }
    return null;
  } catch (err) {
    // Let daily limit errors propagate so callers can abort
    if (err instanceof XeroDailyLimitError) throw err;
    logger.warn(
      { err, contactID },
      "Failed to fetch first invoice date from Xero"
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// retryXeroWriteWithContactRepair
// ---------------------------------------------------------------------------

interface XeroContactRepairOperationKeys {
  idempotencyKey?: string | null;
  correlationKey?: string | null;
}

interface RetryXeroWriteWithContactRepairOptions<T> {
  memberId: string;
  currentContactId: string;
  workflow: string;
  operationId?: string;
  repairExistingLink?: boolean;
  createdByMemberId?: string;
  buildRequestPayload: (contactId: string) => unknown;
  buildOperationKeys?: (contactId: string) => XeroContactRepairOperationKeys;
  run: (input: {
    contactId: string;
    idempotencyKey?: string | null;
  }) => Promise<T>;
  repairContactLink?: (
    memberId: string,
    options?: FindOrCreateXeroContactOptions
  ) => Promise<string>;
  persistUpdatedOperation?: (input: {
    operationId: string;
    requestPayload: unknown;
    keys?: XeroContactRepairOperationKeys;
  }) => Promise<void>;
}

async function persistUpdatedXeroOperationRequest(input: {
  operationId: string;
  requestPayload: unknown;
  keys?: XeroContactRepairOperationKeys;
}) {
  await prisma.xeroSyncOperation.update({
    where: { id: input.operationId },
    data: {
      requestPayload: sanitizeForJson(
        stripPersonNameFromStoredContactPayload(input.requestPayload),
      ),
      idempotencyKey: input.keys?.idempotencyKey,
      correlationKey: input.keys?.correlationKey,
    },
  });
}

export async function retryXeroWriteWithContactRepair<T>(
  options: RetryXeroWriteWithContactRepairOptions<T>
): Promise<T> {
  const initialKeys = options.buildOperationKeys?.(options.currentContactId);

  try {
    return await options.run({
      contactId: options.currentContactId,
      idempotencyKey: initialKeys?.idempotencyKey ?? null,
    });
  } catch (error) {
    if (
      options.repairExistingLink ||
      !isRetryableXeroContactReferenceError(error)
    ) {
      throw error;
    }

    const repairContactLink =
      options.repairContactLink ?? findOrCreateXeroContact;
    const repairedContactId = await repairContactLink(options.memberId, {
      createdByMemberId: options.createdByMemberId,
      repairExistingLink: true,
    });
    const repairedPayload = options.buildRequestPayload(repairedContactId);
    const repairedKeys = options.buildOperationKeys?.(repairedContactId);

    if (options.operationId) {
      const persistUpdatedOperation =
        options.persistUpdatedOperation ?? persistUpdatedXeroOperationRequest;
      await persistUpdatedOperation({
        operationId: options.operationId,
        requestPayload: repairedPayload,
        keys: repairedKeys,
      });
    }

    logger.warn(
      {
        workflow: options.workflow,
        memberId: options.memberId,
        previousContactId: options.currentContactId,
        repairedContactId,
      },
      "Retrying Xero write after repairing a stale contact link"
    );

    return options.run({
      contactId: repairedContactId,
      idempotencyKey: repairedKeys?.idempotencyKey ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Update existing Xero contact
// ---------------------------------------------------------------------------

export async function updateXeroContact(
  xeroContactId: string,
  data: XeroContactUpdateData | undefined,
  options?: {
    localModel?: string;
    localId?: string;
    createdByMemberId?: string;
    preserveXeroName?: boolean;
  }
): Promise<void> {
  // INV-CONFIG-005 (#3036): this function writes an email address onto a Xero
  // contact, so it asks the same first question as the create paths. On the
  // club's live site `applyXeroContactEmailPolicy` below is the identity
  // function and every payload, stored request payload and idempotency key is
  // unchanged; on a confirmed copy the address is contained; on an undeclared
  // installation this throws before anything reaches Xero.
  //
  // It ALSO proves containment, below, before its own write — see the call site.
  const { policy: emailPolicy } = await resolveXeroContactEmailPolicy();
  // #2859: what Xero is known to hold in the NZBN field right now, so the date
  // of birth below never overwrites a real New Zealand Business Number. Read
  // from the local contact cache — no provider call, and nothing here may run
  // inside the short Member transactions. `undefined` (no cache row) means
  // "nothing known", and on THIS path — an update to a contact that already
  // exists in Xero — nothing known means the date of birth is not sent at all.
  // A member's contact is not necessarily one this app created:
  // `findOrCreateXeroContact` links a pre-existing contact by email or exact
  // name match without ever writing a cache row, and that contact may carry a
  // genuine NZBN. See `buildXeroContactCompanyNumberPatch`'s docblock, rule 3.
  const [cachedContact, contactLink] = await Promise.all([
    prisma.xeroContactCache.findUnique({
      where: { contactId: xeroContactId },
      select: { companyNumber: true },
    }),
    // #2859: did THIS APP create this contact? A positive `linkedVia: "created"`
    // marker, written by `findOrCreateXeroContact`'s create branch, is the only
    // thing that answers yes — see the note there for why absence cannot.
    prisma.xeroObjectLink.findFirst({
      where: {
        localModel: "Member",
        xeroObjectType: "CONTACT",
        xeroObjectId: xeroContactId,
        role: "CONTACT",
      },
      select: { metadata: true },
    }),
  ]);
  const appCreatedThisContact =
    contactLink?.metadata !== null &&
    typeof contactLink?.metadata === "object" &&
    !Array.isArray(contactLink.metadata) &&
    (contactLink.metadata as Record<string, unknown>).linkedVia === "created";

  // `undefined` ONLY when there is no cache row. A row that exists and holds
  // `null` is a positive fact — Xero's NZBN field is empty — and must stay
  // distinguishable from "never cached", because the two have opposite
  // outcomes. `?? undefined` here would collapse them and silently restore the
  // defect this guard exists to close.
  //
  // A contact this app created is the one case where "never cached" is still
  // safe: it held nothing when it was made, and nothing but this app's own
  // writes has reached that field since. Without this, a default install never
  // sends a date-of-birth EDIT at all — `syncManagedXeroContactGroupForMember`
  // is the only create-time cache writer and it short-circuits before any Xero
  // call when the grouping mode is `NONE`, which is the schema default.
  const currentCompanyNumber = cachedContact
    ? cachedContact.companyNumber
    : appCreatedThisContact
      ? null
      : undefined;

  /**
   * The NZBN patch for whichever contact this payload is actually addressed to.
   *
   * `retryXeroWriteWithContactRepair` rebuilds this payload against a DIFFERENT
   * contact when it repairs a stale link, and the cache above was read for the
   * ORIGINAL one — so applying that reading to the repaired contact would judge
   * one contact's NZBN field by another's contents. When the id has moved, the
   * date of birth is simply not sent: omission is the direction that cannot
   * destroy anything, and the repaired contact picks the value up on its next
   * update (or already carries it, if this app created it).
   */
  const companyNumberPatchFor = (
    contactId: string,
    contactData: XeroContactUpdateData,
  ) =>
    contactId === xeroContactId
      ? buildXeroContactCompanyNumberPatch(
          contactData.dateOfBirth,
          currentCompanyNumber,
        )
      : {};

  const buildContact = (
    contactId: string,
    contactData: XeroContactUpdateData,
  ): Contact => {
    const contact: Contact = {
      contactID: contactId,
      emailAddress: applyXeroContactEmailPolicy(emailPolicy, contactData.email),
      ...companyNumberPatchFor(contactId, contactData),
      phones: contactData.phoneNumber
        ? [
            {
              phoneType: Phone.PhoneTypeEnum.MOBILE,
              phoneCountryCode: contactData.phoneCountryCode || "",
              phoneAreaCode: contactData.phoneAreaCode || "",
              phoneNumber: contactData.phoneNumber,
            },
          ]
        : [],
      addresses: buildXeroAddresses(contactData),
    };

    if (!options?.preserveXeroName) {
      if (!contactData.firstName || !contactData.lastName) {
        throw new Error(
          "firstName and lastName are required when updating Xero contact names"
        );
      }

      contact.name = `${contactData.firstName} ${contactData.lastName}`;
      contact.firstName = contactData.firstName;
      contact.lastName = contactData.lastName;
    }

    return contact;
  };
  const buildRequestPayload = (
    contactId: string,
    contactData: XeroContactUpdateData,
  ) => ({
    contacts: [buildContact(contactId, contactData)],
  });
  const buildOperationKeys = (
    contactId: string,
    contactData: XeroContactUpdateData,
  ) => {
    const payloadHash = buildXeroPayloadHash(
      buildRequestPayload(contactId, contactData),
    );
    const idempotencyKey = buildXeroIdempotencyKey(
      "contact",
      contactId,
      "update",
      payloadHash,
      "v2"
    );

    return {
      idempotencyKey,
      correlationKey: idempotencyKey,
    };
  };
  const memberId =
    options?.localModel === "Member" && options.localId
      ? options.localId
      : null;
  const buildOperationInput = (
    contactData: XeroContactUpdateData,
  ): ContactUpdateOperationInput => {
    const keys = buildOperationKeys(xeroContactId, contactData);
    return {
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: options?.localModel,
      localId: options?.localId,
      idempotencyKey: keys.idempotencyKey,
      correlationKey: keys.correlationKey,
      // INV-PRIV-011 (#2683): sent with Xero's required Name, stored without it.
      requestPayload: stripPersonNameFromStoredContactPayload(
        buildRequestPayload(xeroContactId, contactData),
      ),
      createdByMemberId: options?.createdByMemberId ?? null,
    };
  };

  // A Member-scoped caller's argument is only an intent to synchronise. The
  // payload that is reserved and sent is rebuilt from the authoritative Member
  // row after the lifecycle-conflicting KEY SHARE lock has been obtained. If a
  // merge won first, a surviving master therefore contributes its post-merge
  // phone/address/email rather than the caller's pre-merge snapshot; a deleted
  // loser/account never obtains a reservation.
  let authoritativeData: XeroContactUpdateData;
  let operation: Awaited<ReturnType<typeof startXeroSyncOperation>>;
  if (memberId) {
    const reservation = await reserveMemberContactUpdateOperation(
      memberId,
      xeroContactId,
      (locked) => {
        const currentData = buildXeroContactUpdatePayload(locked);
        return {
          input: buildOperationInput(currentData),
          value: currentData,
        };
      },
    );
    if (!reservation) {
      throw new Error("Member Xero contact update reservation was not created");
    }
    operation = reservation.operation;
    authoritativeData = reservation.value;
  } else {
    if (!data) {
      throw new Error("Xero contact update data is required outside Member scope");
    }
    authoritativeData = data;
    operation = await startXeroSyncOperation(buildOperationInput(data));
  }

  const authoritativeRequestPayload = (contactId: string) =>
    buildRequestPayload(contactId, authoritativeData);
  const authoritativeOperationKeys = (contactId: string) =>
    buildOperationKeys(contactId, authoritativeData);

  try {
    // Authentication and every provider call remain outside both short Member
    // transactions. The committed RUNNING reservation is their authority, and
    // authentication failure closes it through the same failure path.
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    /*
      INV-CONFIG-005 (#3036): CONTAIN BEFORE WRITING, not after.

      This function is reachable with no invoice anywhere near it — an
      administrator editing a member, a member saving their profile, an
      email-change confirmation — and on a copy it overwrites whatever Xero holds
      with the contained form. Recording nothing meant the operator surface could
      say "no Xero contact has been touched yet" while this installation had
      already rewritten real accounting records, which is precisely the
      reassuring-false-record shape this epic keeps finding.

      Recording it AFTERWARDS would have been the wrong repair: every row in that
      table is written after reading Xero's stored value back, and by then the
      value read back is the contained address this function just sent, so the
      row would say "nothing was overwritten" about a real overwrite. Containing
      FIRST puts the read where it can still see the truth: containment reads the
      contact, replaces a deliverable address if one is there, and records what
      it actually saw. The write below then sends the contained form of the
      member's current address.

      COST, stated honestly. On the live site this is a no-op — no read, no
      provider call, no row. On a copy whose proof is fresh it is one indexed
      read. On a copy meeting a contact for the first time it is one provider
      read plus, if a real address is there, one provider write — so a contact
      holding a real address takes two provider writes on this path rather than
      one. Contact updates are rare (a profile save), the duplicate only happens
      once per contact per freshness window, and paying it is how the count is a
      measurement rather than a guess.

      The repair leg is covered elsewhere: `retryXeroWriteWithContactRepair` can
      retry against a DIFFERENT contact, and it reaches that id through
      `findOrCreateXeroContact`, which contains it.
    */
    await ensureXeroContactContained({
      policy: emailPolicy,
      xeroContactId,
      sourceEmail: authoritativeData.email,
      workflow: "updateXeroContact",
      xero,
      tenantId,
    });
    const response = await retryXeroWriteWithContactRepair({
      memberId:
        options?.localModel === "Member" && options.localId
          ? options.localId
          : "",
      currentContactId: xeroContactId,
      workflow: "updateXeroContact",
      operationId: operation.id,
      repairExistingLink:
        options?.localModel !== "Member" || !options.localId,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: authoritativeRequestPayload,
      buildOperationKeys: authoritativeOperationKeys,
      run: ({ contactId, idempotencyKey }) =>
        callXeroApi(
          () =>
            xero.accountingApi.updateContact(
              tenantId,
              contactId,
              authoritativeRequestPayload(contactId),
              idempotencyKey ?? undefined
            ),
          {
            operation: "updateContact",
            resourceType: "CONTACT",
            workflow: "updateXeroContact",
            context: `updateContact(${contactId})`,
          }
        ),
    });
    const completedContactId =
      response.body.contacts?.[0]?.contactID ?? xeroContactId;

    const completion: Parameters<typeof completeXeroSyncOperation>[1] = {
      responsePayload: response.body,
      xeroObjectType: "CONTACT",
      xeroObjectId: completedContactId,
      xeroObjectUrl: buildXeroContactUrl(completedContactId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "CONTACT",
                xeroObjectId: completedContactId,
                xeroObjectUrl: buildXeroContactUrl(completedContactId),
                role: "CONTACT",
              },
            ]
          : [],
    };
    if (memberId) {
      await completeMemberContactUpdateOperation(
        memberId,
        xeroContactId,
        operation.id,
        completion,
      );
    } else {
      await completeXeroSyncOperation(operation.id, completion);
    }
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}
