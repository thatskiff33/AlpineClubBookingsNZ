/**
 * THE PROOF that a Xero contact a copy is about to invoice can no longer reach a
 * member (ENV-SAFETY 3, #3036; epic #2986). INV-CONFIG-005.
 *
 * `xero-contact-containment.ts` next door answers the DECISION — which
 * installation is this, and therefore what address may go into a contact
 * payload. This module answers the harder half: an existing contact's address
 * was written before this installation existed, so it has to be looked at, and
 * looking at it costs a provider call nobody wants to spend per invoice. Hence a
 * durable record, a freshness bound on it, and a refusal when neither can be
 * established.
 *
 * The two are separate files because they fail differently and are read at
 * different times: the decision is pure and synchronous once the role is read,
 * while everything here touches Xero and the database and can refuse a caller.
 */

import type { XeroClient } from "xero-node";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  getAuthenticatedXeroClient,
  callXeroApi,
} from "@/lib/xero-api-client";
import {
  assertXeroContactEmailPolicyWitness,
  resolveXeroContactEmailPolicy,
  type XeroContactEmailPolicy,
} from "@/lib/xero-contact-containment";
import {
  isXeroContactEmailUnreachable,
  toXeroSandboxContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/** Thrown when a copy could not prove that a contact can no longer reach a member. */
export class XeroContactContainmentError extends Error {
  readonly xeroContactId: string;

  constructor(xeroContactId: string, message: string) {
    super(message);
    this.name = "XeroContactContainmentError";
    this.xeroContactId = xeroContactId;
  }
}

/** The minimal shape of the Xero client the containment read and write need. */
type XeroContactContainmentClient = {
  accountingApi: {
    getContact: (
      tenantId: string,
      contactId: string,
    ) => Promise<{ body: { contacts?: Array<{ emailAddress?: string }> } }>;
    updateContact: (
      tenantId: string,
      contactId: string,
      contacts: { contacts: Array<{ contactID: string; emailAddress: string }> },
      idempotencyKey?: string,
    ) => Promise<{ body: unknown }>;
  };
};

/** The containment record's delegate, structurally, so a fake can stand in. */
type ContainmentDelegate = {
  findUnique: (args: {
    where: { xeroContactId: string };
    select: { containedEmail: true; updatedAt: true };
  }) => Promise<{ containedEmail: string; updatedAt: Date } | null>;
  upsert: (args: {
    where: { xeroContactId: string };
    create: {
      xeroContactId: string;
      containedEmail: string;
      rewroteAddress: boolean;
      rewrittenAt: Date | null;
    };
    /*
      `rewroteAddress` and `rewrittenAt` are OPTIONAL on the update half, and
      that is the monotonicity: a re-verification that finds the contained
      address already in place omits them rather than writing `false` over a
      rewrite this installation really did perform. See
      {@link recordXeroContactContainment}.
    */
    update: {
      containedEmail: string;
      rewroteAddress?: boolean;
      rewrittenAt?: Date;
    };
  }) => Promise<unknown>;
};

/**
 * How long a containment proof may be trusted without looking at Xero again.
 *
 * WHY A PROOF HAS TO EXPIRE AT ALL, which is the half the first version of this
 * module did not say. The fast path invalidates a proof when the MEMBER's stored
 * address moves, because that is the input the fingerprint is derived from.
 * Nothing invalidates it when the PROVIDER side moves - and the provider side is
 * the side the proof is a claim about. Two ways that happens, neither of them
 * exotic:
 *
 * - somebody edits the contact's email address inside Xero, which is ordinary
 *   while testing against a sandbox organisation;
 * - a copy is connected to the club's REAL Xero organisation, the damage is
 *   repaired from the live site (where addresses are written verbatim), and the
 *   contact holds the member's real address again while this copy's row still
 *   says it is contained. That is the chain that ends with Xero emailing a real
 *   member an invoice reminder, and it was reachable by following this product's
 *   own operator guide.
 *
 * So the proof is bounded, and past the bound the contact is re-read from Xero
 * exactly as if there were no proof at all. THE RESIDUAL IS THE WINDOW ITSELF,
 * and it is stated rather than hidden: a provider-side change made inside the
 * window is not noticed until the window expires.
 *
 * TWENTY-FOUR HOURS, chosen against Xero's daily call ceiling rather than by
 * feel. Re-verification costs one provider read per contact per window, so a copy
 * exercising three hundred members spends three hundred reads a day against a
 * five-thousand-call daily limit. Six hours would spend four times that for a
 * tighter bound nothing measured says is needed; a week would leave a copy
 * trusting a week-old claim about somebody else's data.
 */
export const XERO_CONTAINMENT_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function containmentDelegate(): ContainmentDelegate | undefined {
  return (
    prisma as unknown as {
      xeroSandboxContactContainment?: ContainmentDelegate;
    }
  ).xeroSandboxContactContainment;
}

/**
 * Prove that a Xero contact can no longer reach a member, before its id is
 * handed to anything that raises an invoice.
 *
 * A NO-OP ON PRODUCTION, checked from the token rather than from a second role
 * read, so the live site's contact resolution is unchanged: no evidence read, no
 * provider call, no row.
 *
 * ## The three paths, in cost order
 *
 * 1. **Durable proof already matches AND IS STILL FRESH — zero provider
 *    calls.** One indexed primary-key-shaped read of
 *    `XeroSandboxContactContainment` by `xeroContactId`, compared against the
 *    contained address this member's CURRENT stored address maps to, and against
 *    {@link XERO_CONTAINMENT_PROOF_MAX_AGE_MS}. This is the steady state: a batch
 *    subscription run over three hundred members costs three hundred indexed
 *    reads and no Xero traffic at all, which is what keeps this out of N+1
 *    territory. The row is one per contact, upserted, so the table cannot grow
 *    per invoice. THE FRESHNESS HALF IS NOT DECORATION — see that constant: a
 *    local address change is the only thing the fingerprint alone can notice,
 *    and the proof is a claim about the PROVIDER side.
 * 2. **No proof, and Xero is already holding nothing deliverable.** One provider
 *    read, no write. A contact with no address, or one carrying a club-internal
 *    walk-in/deleted placeholder, can reach nobody — rewriting it would spend a
 *    provider call to change nothing.
 * 3. **No proof, and Xero is holding a real address.** One provider read and one
 *    provider write, then the row. The idempotency key is derived from the
 *    contact id and the address being written, so a retry of the same
 *    containment is the same key and cannot produce a second write; a DIFFERENT
 *    target address (the member's address moved) is a different key, which is
 *    what makes a genuine re-containment possible at all.
 *
 * ## Why it VERIFIES rather than believes, even for a contact we just created
 *
 * The create payload already carries the contained address, so a freshly created
 * contact is contained by construction and this function could record the row
 * with no provider read. It does the read anyway, and the reason is this epic's
 * own history: every serious finding in it was a record asserting something had
 * happened when it had not. A row written from "we believe we sent that" is that
 * shape. A row written after seeing Xero's stored value means *we have looked*,
 * and the cost is one extra read per newly created contact — a rare event,
 * because contacts are created once per member.
 *
 * ## Where it may run
 *
 * OUTSIDE every transaction, like every other provider call in the contact
 * layer. `findOrCreateXeroContact` and `createXeroContactForMember` call it after
 * their short advisory-locked link transactions have committed, so a slow Xero
 * cannot hold a Member row locked.
 *
 * AND NO CALLER OF THE FUNNEL IS INSIDE A TRANSACTION — verified at all twelve
 * DIRECT call sites on this branch plus the one indirect one
 * (`retryXeroWriteWithContactRepair`'s default `repairContactLink`), not
 * assumed. The stronger-sounding claim ("they
 * cannot be") would be false and is not made: a caller inside an interactive
 * transaction would simply take a SECOND pooled connection, because the funnel
 * opens its own `$transaction` on both paths. That was already a pool hazard
 * before this change — it is what F7 (#1355) restructured this function around —
 * so containment adds a provider call where provider calls already legitimately
 * happen rather than introducing a new exposure. #3035 recorded the sharpest
 * instance: the group-settlement path holds `pg_advisory_xact_lock(1)` while it
 * emails, and a second Prisma connection taken in there is a pool-timeout risk
 * because that lock is exclusive and every other invoice run queues behind it
 * holding one of its own. That path resolves its contact BEFORE the fence opens
 * (its `initialFence` transaction has committed by then), so nothing here runs
 * inside it.
 *
 * ## Failure is a refusal, never a shrug
 *
 * If containment cannot be established — the provider read fails, the write
 * fails, the row cannot be written, the delegate is missing because the migration
 * has not been applied — this throws {@link XeroContactContainmentError} and the
 * invoice does not happen. A copy that could not contain a contact and invoiced
 * anyway is precisely the outcome this issue exists to prevent.
 *
 * FIVE PROVIDER ERRORS PASS THROUGH WITH THEIR OWN IDENTITY rather than being
 * re-labelled — see {@link XERO_PROVIDER_ERROR_NAMES_TO_RETHROW}. The refusal is
 * identical either way (nothing is raised against an unproved contact); what
 * would have been lost is the outbox's ability to tell a never-attempted
 * cool-down refusal from a real failure, which is what keeps an un-attempted
 * operation re-drivable instead of terminally FAILED.
 */
export async function ensureXeroContactContained(params: {
  policy: XeroContactEmailPolicy;
  xeroContactId: string;
  /** The member's stored address. Never written anywhere; only fingerprinted. */
  sourceEmail: string | null | undefined;
  workflow: string;
  /** Reuse an already-authenticated client where the caller has one. */
  xero?: XeroContactContainmentClient | XeroClient;
  tenantId?: string;
}): Promise<void> {
  if (assertXeroContactEmailPolicyWitness(params.policy) === "verbatim") return;

  const { xeroContactId } = params;
  const target = xeroSandboxContainmentTarget(params.sourceEmail);

  const delegate = containmentDelegate();
  if (!delegate) {
    throw new XeroContactContainmentError(
      xeroContactId,
      `This installation is a copy, so Xero contact ${xeroContactId} must not be ` +
        "left holding an address that can reach a member — and the containment " +
        "record cannot be read on this database, so containment cannot be " +
        "proved. Apply the pending migrations (prisma migrate deploy) and try " +
        "again. Nothing was written to Xero (INV-CONFIG-005).",
    );
  }

  let existing: { containedEmail: string; updatedAt: Date } | null;
  try {
    existing = await delegate.findUnique({
      where: { xeroContactId },
      select: { containedEmail: true, updatedAt: true },
    });
  } catch (error) {
    throw new XeroContactContainmentError(
      xeroContactId,
      `Could not read the containment record for Xero contact ${xeroContactId}, ` +
        "so this copy cannot prove the contact is unable to reach a member. " +
        `Nothing was written to Xero. ${errorText(error)} (INV-CONFIG-005)`,
    );
  }
  /*
    TWO conditions, not one. The recorded fingerprint has to match what this
    application would write for this member today (the member's address has not
    moved), AND the proof has to be young enough to still describe the provider
    side - see XERO_CONTAINMENT_PROOF_MAX_AGE_MS for why a proof about what Xero
    holds cannot be invalidated by a local change alone.
  */
  const proofAgeMs = existing
    ? Date.now() - existing.updatedAt.getTime()
    : null;
  if (
    existing?.containedEmail === target &&
    proofAgeMs !== null &&
    /*
      A NEGATIVE AGE IS STALE, not fresh. `updatedAt` is written by whichever
      process wrote the row, so a clock that has since moved backwards — a
      container with a skewed clock, a restore that carried rows from a machine
      ahead of this one — leaves a future-dated proof whose age is negative and
      therefore always "inside" the window. It would be trusted for ever, which
      is the one direction this bound exists to prevent. Fail closed: re-read the
      contact.
    */
    proofAgeMs >= 0 &&
    proofAgeMs < XERO_CONTAINMENT_PROOF_MAX_AGE_MS
  ) {
    return;
  }

  const { xero, tenantId } = await resolveContainmentClient(params);

  let stored: string | undefined;
  try {
    const response = await callXeroApi(
      () => xero.accountingApi.getContact(tenantId, xeroContactId),
      {
        operation: "getContact",
        resourceType: "CONTACT",
        workflow: params.workflow,
        context: `containXeroContactEmail(${xeroContactId})`,
      },
    );
    stored = response.body.contacts?.[0]?.emailAddress ?? undefined;
  } catch (error) {
    rethrowProviderErrorUnchanged(error);
    throw new XeroContactContainmentError(
      xeroContactId,
      `Could not read Xero contact ${xeroContactId}, so this copy cannot prove ` +
        "the contact is unable to reach a member and will not raise anything " +
        `against it. Nothing was written to Xero. ${errorText(error)} ` +
        "(INV-CONFIG-005)",
    );
  }

  const rewroteAddress = !isXeroContactEmailUnreachable(stored);
  if (rewroteAddress) {
    /*
      The address we WRITE is derived from what Xero is holding, not from the
      member's stored address, and that distinction matters. The contact may be
      one this application merely linked — matched by email or by exact name, or
      linked wholesale by `xero-member-import.ts` — so the address on it can
      belong to somebody other than the member now pointing at it. Containing
      what is actually there is the only version that cannot leave a real address
      behind.
    */
    const contained = toXeroSandboxContactEmail(stored);
    const idempotencyKey = buildXeroIdempotencyKey(
      "contact",
      xeroContactId,
      "contain-email",
      contained,
      "v1",
    );
    try {
      await callXeroApi(
        () =>
          xero.accountingApi.updateContact(
            tenantId,
            xeroContactId,
            {
              contacts: [
                { contactID: xeroContactId, emailAddress: contained },
              ],
            },
            idempotencyKey,
          ),
        {
          operation: "updateContact",
          resourceType: "CONTACT",
          workflow: params.workflow,
          context: `containXeroContactEmail(${xeroContactId})`,
        },
      );
    } catch (error) {
      rethrowProviderErrorUnchanged(error);
      throw new XeroContactContainmentError(
        xeroContactId,
        `Could not replace the email address on Xero contact ${xeroContactId} ` +
          "with a non-deliverable one, so this copy will not raise anything " +
          "against it — the contact is still able to reach a member and Xero " +
          "would email invoice reminders to that address. " +
          `${errorText(error)} (INV-CONFIG-005)`,
      );
    }
    logger.info(
      { scope: "xero-contact-containment", xeroContactId, workflow: params.workflow },
      "This installation is a copy, so the email address on this Xero contact was replaced with a non-deliverable one. Xero can no longer email invoice reminders to a real member from here.",
    );
  }

  /*
    The address is only carried onto the ROW as the fingerprint derived from the
    member's current stored address (`target`), never as whatever was actually
    written above. They agree in the ordinary case; they differ when the contact
    was holding somebody else's address, and it is the member's address the fast
    path has to compare against next time.
  */
  await recordXeroContactContainment(delegate, {
    xeroContactId,
    containedEmail: target,
    rewroteAddress,
    workflow: params.workflow,
  });
}

/**
 * Prove the contact behind a member's Xero documents is contained, for an
 * invoice operation that does NOT go through `findOrCreateXeroContact`.
 *
 * ## Which operations need this, and why the line is drawn there
 *
 * The rule is not "every Xero write": it is **every operation that raises a new
 * document against a contact, or that can leave an invoice OUTSTANDING against
 * one**. Xero's own reminders go to the address on the contact of an outstanding
 * `AUTHORISED` invoice, with no API call from this application, so those are the
 * operations that can end with a real member being chased for money on a copy.
 * Three writers qualify and none of them touches the funnel:
 *
 * - the membership-cancellation credit note, which resolves its contact from the
 *   invoice it is crediting — NOT from the member's own link, which is why the
 *   caller names the contact rather than this function guessing it;
 * - a booking-invoice line-item update, which can RAISE the amount due;
 * - applied-credit deallocation, which removes credit from an invoice and
 *   therefore also raises the amount due.
 *
 * Deliberately NOT here: recording a payment, allocating a credit note, and
 * voiding an invoice all reduce or remove what is outstanding, so none of them
 * can create exposure that was not already there; and archiving a contact or
 * changing its contact-group membership carries no document and no address. All
 * of those are still refused on an UNDECLARED installation, by the gate inside
 * `callXeroApi` — that is a different question from containment, and it is
 * answered in one place for every writer.
 *
 * ## THE CALLER NAMES THE CONTACT, and the first version of this helper got
 * that wrong
 *
 * It resolved the contact from `Member.xeroContactId` — which is a DIFFERENT
 * contact from the one two of these three operations use, and the code says so
 * out loud: the cancellation credit note takes
 * `invoice.contact?.contactID ?? subscription.member.xeroContactId`, and that
 * `??` exists precisely because the two can differ. Containing the member's
 * contact and raising the document against the invoice's meant proving
 * containment of a contact the operation never touched — a check that reads as
 * coverage and gives none. Both drifts are ordinary rather than exotic: a member
 * merge nulls the loser's link while the loser's invoices keep the loser's
 * contact, and the admin re-link route writes a new link while existing invoices
 * keep the old one.
 *
 * So the contact is a REQUIRED input, supplied by the caller as a resolver
 * function. A function rather than a value because one caller
 * (`deallocateExcessAppliedCreditForBooking`) has to ASK Xero which contact its
 * invoice belongs to: passing a value would spend that read on the club's live
 * site, where this whole function is a no-op. The resolver runs only after the
 * policy says "contain", so PRODUCTION still reads nothing and calls nothing.
 *
 * `memberId` remains, for the FINGERPRINT only. The row records the contained
 * address this application would derive from that member's stored address, which
 * is what the fast path compares against next time; the address actually written
 * to Xero is derived from what Xero was HOLDING. Those two already diverge
 * whenever a contact carries somebody else's address (see
 * {@link ensureXeroContactContained}), and a foreign contact is simply that case
 * again — consistent, because the same member is named every time this operation
 * runs.
 *
 * ## A CONTACT THAT CANNOT BE NAMED IS A REFUSAL
 *
 * If the resolver comes back empty, the contact behind this document cannot be
 * identified from here, so containment cannot be proved and the operation is
 * refused rather than proceeding on the assumption that somebody else contained
 * it. On PRODUCTION this function returns before reading anything at all, so
 * that refusal cannot reach the live site.
 */
export async function requireContainedXeroContactForInvoiceOperation(params: {
  /**
   * The contact the document will actually be raised against, or whose invoice
   * this operation will leave outstanding. Resolved lazily — see the docblock.
   */
  resolveXeroContactId: () => Promise<string | null | undefined>;
  /** Fingerprint source ONLY. Never used to choose the contact. */
  memberId: string;
  workflow: string;
  xero?: XeroContactContainmentClient | XeroClient;
  tenantId?: string;
}): Promise<void> {
  const { policy } = await resolveXeroContactEmailPolicy();
  if (assertXeroContactEmailPolicyWitness(policy) === "verbatim") return;

  const [xeroContactId, member] = await Promise.all([
    params.resolveXeroContactId(),
    prisma.member.findUnique({
      where: { id: params.memberId },
      select: { email: true },
    }),
  ]);
  if (!xeroContactId) {
    throw new XeroContactContainmentError(
      "",
      "This installation is a copy, and the Xero contact this operation would " +
        "act on cannot be identified from here, so it cannot be proved that " +
        "Xero is unable to email a real member about it. Nothing was written to " +
        `Xero. Resolve the Xero contact for member ${params.memberId} first — ` +
        "raising or re-opening an invoice does that (INV-CONFIG-005).",
    );
  }
  await ensureXeroContactContained({
    policy,
    xeroContactId,
    sourceEmail: member?.email,
    workflow: params.workflow,
    xero: params.xero,
    tenantId: params.tenantId,
  });
}

/** Short, secret-free description of a caught error, for an operator message. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The provider errors this module must NOT re-label, by `name`.
 *
 * WHY RE-LABELLING THEM IS A DEFECT AND NOT A COSMETIC LOSS. Two of these are
 * raised by gates that run BEFORE any request reaches Xero — the daily-limit
 * gate and the transient-outage breaker, both of which `withXeroRetry` and
 * `getAuthenticatedXeroClient` consult on the way in. The outbox decides whether
 * a failed operation may be returned to PENDING and re-driven by asking exactly
 * this question (`isXeroCooldownRefusal` in `xero-operation-outbox.ts`, keyed on
 * `error.name` plus `preHttp`), and its whole safety argument is that a refusal
 * which sent nothing cannot have duplicated anything. Wrapping such a refusal in
 * a `XeroContactContainmentError` makes it unrecognisable, so the outbox
 * TERMINALLY FAILS an operation that was never attempted — #2423's F2 defect
 * ("a pile of FAILED-unattempted invoices that nothing auto-recovers") arriving
 * on a new path. The same wrapping defeats every downstream
 * `err instanceof XeroDailyLimitError`, and `XeroReconnectRequiredError` is here
 * for the same reason: `getXeroApiErrorInfo` maps it by name to the "reconnect
 * Xero" message an administrator can act on, and a wrapped one becomes a generic
 * 500.
 *
 * NOTHING IS WEAKENED BY LETTING THEM THROUGH. The caller still fails, so no
 * document is raised against an unproved contact — which is the whole guarantee.
 * All that changes is that the error keeps the identity its own recovery
 * machinery needs, and gains a better operator message than this module could
 * write for it.
 *
 * Keyed on `name` rather than `instanceof` on purpose: these classes travel
 * through module boundaries the unit suite mocks, and a mocked module's class is
 * not the same class object.
 */
const XERO_PROVIDER_ERROR_NAMES_TO_RETHROW = new Set([
  "XeroDailyLimitError",
  "XeroTransientOutageError",
  "XeroReconnectRequiredError",
  /*
    Reached through `loadXeroTokens` inside `getAuthenticatedXeroClient`, and
    name-keyed in FOUR places that all treat it exactly like
    `XeroReconnectRequiredError` — `xero-api-errors.ts`,
    `xero-connection-probe.ts`, `xero-organisation.ts` and
    `membership-cancellation-invoice-blockers.ts`. Relabelling it turned the
    admin's "reconnect Xero" message into an opaque 500, and it bites hardest on
    exactly this module's population: a copy restored with a different
    `AUTH_SECRET` cannot decrypt the tokens it inherited.
  */
  "XeroTokenDecryptError",
  /*
    OUR OWN refusal, raised by the gate inside `callXeroApi` when the role is
    UNKNOWN — which containment's own provider calls pass through. It is reachable
    here on one leg: an installation that declares nothing while the safer
    override is ON resolves NON_PRODUCTION, so containment runs, and a failed
    override read a moment later resolves UNKNOWN inside the gate. Wrapping it
    would destroy the marker the outbox keys its never-attempted re-drive on,
    which is the whole point of giving that class a `preHttp` marker at all.
  */
  "XeroContactEnvironmentUnknownError",
]);

/** Rethrow untouched if this is one of {@link XERO_PROVIDER_ERROR_NAMES_TO_RETHROW}. */
function rethrowProviderErrorUnchanged(error: unknown): void {
  if (
    error instanceof Error &&
    XERO_PROVIDER_ERROR_NAMES_TO_RETHROW.has(error.name)
  ) {
    throw error;
  }
}

async function resolveContainmentClient(params: {
  xero?: XeroContactContainmentClient | XeroClient;
  tenantId?: string;
  xeroContactId: string;
}): Promise<{ xero: XeroContactContainmentClient; tenantId: string }> {
  if (params.xero && params.tenantId) {
    return {
      xero: params.xero as unknown as XeroContactContainmentClient,
      tenantId: params.tenantId,
    };
  }
  try {
    const authenticated = await getAuthenticatedXeroClient();
    return {
      xero: authenticated.xero as unknown as XeroContactContainmentClient,
      tenantId: authenticated.tenantId,
    };
  } catch (error) {
    rethrowProviderErrorUnchanged(error);
    throw new XeroContactContainmentError(
      params.xeroContactId,
      "Could not reach Xero to prove that contact " +
        `${params.xeroContactId} is unable to email a member, so this copy will ` +
        `not raise anything against it. ${errorText(error)} (INV-CONFIG-005)`,
    );
  }
}

/**
 * Write the proof.
 *
 * An upsert on the contact id, so a re-containment after a member's address
 * moves replaces the row rather than appending one. A failure here is a REFUSAL
 * and not a best-effort miss: without the row the next invoice would re-read the
 * contact from Xero, which is merely slow — but a row that cannot be written at
 * all means the database is not accepting the proof, and proceeding would leave
 * a copy invoicing on an unrecorded claim.
 *
 * AND WHEN THE PROVIDER WRITE ALREADY HAPPENED, THE COUNT UNDER-REPORTS. The
 * caller refuses, correctly — but a deliverable address was replaced on a real
 * Xero contact and no row records it, so `/admin/environment` will report one
 * fewer overwrite than actually occurred. That is the one direction this
 * feature's numbers can be wrong in, so it is logged at error level with the
 * contact id rather than left to be inferred from a refusal, and the refusal
 * message says it too. There is no repair available here: the address is already
 * replaced and the database is refusing writes, so inventing a retry would only
 * add a second provider call to a failing situation.
 */
async function recordXeroContactContainment(
  delegate: ContainmentDelegate,
  row: {
    xeroContactId: string;
    containedEmail: string;
    rewroteAddress: boolean;
    workflow: string;
  },
): Promise<void> {
  const now = new Date();
  try {
    await delegate.upsert({
      where: { xeroContactId: row.xeroContactId },
      create: {
        xeroContactId: row.xeroContactId,
        containedEmail: row.containedEmail,
        rewroteAddress: row.rewroteAddress,
        rewrittenAt: row.rewroteAddress ? now : null,
      },
      /*
        MONOTONE. `rewroteAddress` answers "did this installation overwrite a
        deliverable address on this contact", which is a fact about the past that
        a later re-verification cannot undo. Re-verifying a contact this copy
        already contained necessarily finds the CONTAINED address in place and
        recomputes `rewroteAddress` as false - so writing it unconditionally
        RETRACTED the record, and the operator surface then positively asserted
        that nothing had been overwritten. Deterministic, no concurrency needed:
        contain a contact, change that member's address locally (a copy is where
        an email-change flow gets tested), and the next document write erased it.
        So the false case omits both columns instead of writing them.
      */
      update: {
        containedEmail: row.containedEmail,
        ...(row.rewroteAddress
          ? { rewroteAddress: true, rewrittenAt: now }
          : {}),
      },
    });
  } catch (error) {
    if (row.rewroteAddress) {
      logger.error(
        {
          scope: "xero-contact-containment",
          xeroContactId: row.xeroContactId,
          workflow: row.workflow,
          err: { message: errorText(error) },
        },
        "This installation replaced a deliverable email address on a Xero contact and then could not record it. The contact is contained, but the operator count of overwritten addresses on Admin -> Environment is now one short of what really happened. Note the contact id from this line.",
      );
    }
    throw new XeroContactContainmentError(
      row.xeroContactId,
      `Xero contact ${row.xeroContactId} was contained, but the proof could not ` +
        "be recorded, so this copy cannot show that it is safe to invoice. " +
        (row.rewroteAddress
          ? "A real email address WAS replaced on that contact before this " +
            "failure, and the count on Admin -> Environment will not include " +
            "it. "
          : "") +
        `${errorText(error)} (INV-CONFIG-005)`,
    );
  }
}
