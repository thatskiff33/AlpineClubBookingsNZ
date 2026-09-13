/**
 * The WRITE VOCABULARY of the encrypted integration-credential store (#2723).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT INSIDE THE STORE. Every mutation of
 * `IntegrationCredential` must say who made it and what it expected to find,
 * and both answers are *closed sets* rather than free text. That is the same
 * shape `audit-categories.ts` has beside `audit.ts`, for the same reason: the
 * vocabulary is what every writer imports, the store is what every writer
 * calls, and keeping them apart means a new writer names the vocabulary module
 * and gets a compile error rather than a string it invented.
 *
 * WHAT WAS WRONG BEFORE. The store took `updatedByUserId?: string | null`. Three
 * separate things were spelled the same way by that column:
 *
 *   1. a Full Admin wrote this credential, and here is their member id;
 *   2. a background writer wrote it — the Xero token-key generator, the Google
 *      verify callback, the Stripe webhook marker — and there is no member;
 *   3. somebody wrote it and simply did not pass the argument.
 *
 * (2) and (3) both stored `null`, so no reader could tell a deliberate system
 * write from an omission, and (3) was the default: the argument was optional,
 * so omitting it compiled, ran, and looked exactly like a legitimate background
 * write. Five of the store's nine production call sites omitted it.
 *
 * THE REMEDY IS STRUCTURAL, NOT POLICED. `CredentialActor` is a required
 * argument on every mutator, so (3) does not compile; `kind` discriminates (1)
 * from (2); and a system write must NAME itself from `CREDENTIAL_SYSTEM_ACTORS`,
 * so "system" is an identified writer rather than the absence of a person.
 * `assertCredentialActor` is the runtime half, for the holes a TypeScript type
 * always has — an `as never` cast in a test double, a value arriving from
 * untyped JavaScript or JSON, a value read back out of storage and forwarded.
 * `credential-actor-census.test.ts` is the third line, and it counts call sites
 * from the tree rather than from a list anybody maintains.
 */

import { createHash } from "crypto";

import { createAuditLog, type AuditLogClient } from "@/lib/audit";
import type { AuthSecretSource } from "@/lib/integration-crypto";

// ---------------------------------------------------------------------------
// Who wrote it
// ---------------------------------------------------------------------------

/**
 * Every non-human writer of the credential store, named.
 *
 * THE LIST IS CLOSED, and that is the point — the same decision, for the same
 * reason, as `AUDIT_CATEGORIES`. A free-text actor would let a new background
 * writer call itself `"system"`, `"cron"` or `"backend"` and leave an operator
 * reading the audit trail unable to tell which of them touched a secret. Adding
 * a member here is a reviewed change, and adding one is exactly the moment to
 * ask whether the write should have had a human behind it instead.
 *
 * A name says WHICH writer, not which module — `google-verify-callback` and
 * `google-verify-reset` live in the same file and are different events, because
 * an operator investigating a stranded credential needs to know which of the
 * two rewrote it.
 */
export const CREDENTIAL_SYSTEM_ACTORS = [
  /** Google's OAuth round-trip succeeded; the non-secret verified marker is stamped. */
  "google-verify-callback",
  /** Verify-reset: a Google credential changed, so the verified marker is dropped. */
  "google-verify-reset",
  /** A signature-verified Stripe TEST-MODE webhook event stamped the marker. */
  "stripe-webhook-verify",
  /** Verify-reset: a Stripe credential changed, so the webhook marker is dropped. */
  "stripe-verify-reset",
  /** The shared-post sync registered this install for pushes and stored the issued secret. */
  "servernz-push-registration",
  /** First use of Xero token encryption auto-generated (or replaced) the wrapped token key. */
  "xero-token-key-generation",
  /** The E2E staging stack seeding Stripe test-mode keys. Never a real deployment. */
  "e2e-stripe-seed",
] as const;

export type CredentialSystemActor = (typeof CREDENTIAL_SYSTEM_ACTORS)[number];

const CREDENTIAL_SYSTEM_ACTOR_SET: ReadonlySet<string> = new Set<string>(
  CREDENTIAL_SYSTEM_ACTORS,
);

/** The runtime half of the closed set, for a value that arrives as text. */
export function isCredentialSystemActor(
  value: unknown,
): value is CredentialSystemActor {
  return typeof value === "string" && CREDENTIAL_SYSTEM_ACTOR_SET.has(value);
}

/**
 * Who is mutating a stored credential. A human Full Admin, or a NAMED
 * background writer — never "unknown", which is the state this type exists to
 * abolish.
 */
export type CredentialActor =
  | { readonly kind: "admin"; readonly memberId: string }
  | { readonly kind: "system"; readonly actor: CredentialSystemActor };

/**
 * Thrown when a value reaching a credential mutator is not an actor.
 *
 * Named rather than a bare `Error` so the message can say which operation was
 * refused, and so the census's own fixtures can assert on the type rather than
 * on wording. It never echoes the credential VALUE — only the actor it was
 * handed, which by construction holds no secret.
 */
export class CredentialActorError extends Error {
  readonly operation: string;
  readonly received: unknown;

  constructor(operation: string, received: unknown) {
    super(
      `Credential mutation "${operation}" supplied no usable actor (received ` +
        `${JSON.stringify(received) ?? String(received)}). ` +
        "Every write to the encrypted credential store must name a Full Admin " +
        "({ kind: \"admin\", memberId }) or one of CREDENTIAL_SYSTEM_ACTORS " +
        "({ kind: \"system\", actor }) from @/lib/integration-credential-actor.",
    );
    this.name = "CredentialActorError";
    this.operation = operation;
    this.received = received;
  }
}

/**
 * The RUNTIME half of the required-actor contract.
 *
 * The type is the first line and catches every ordinary writer; this is the
 * second, and it exists because a TypeScript type has three documented holes a
 * security-relevant field should not rely on being closed: an `as never` /
 * `as CredentialActor` cast (this repository uses `as never` freely in test
 * doubles), a value crossing from untyped JavaScript or JSON, and a value read
 * back out of a stored row and forwarded.
 *
 * An `admin` actor must carry a NON-EMPTY member id. An empty string would
 * otherwise store as an admin write attributable to nobody, which is the
 * original defect wearing a different column value.
 */
export function assertCredentialActor(
  operation: string,
  actor: unknown,
): asserts actor is CredentialActor {
  if (typeof actor !== "object" || actor === null) {
    throw new CredentialActorError(operation, actor);
  }
  const kind = (actor as { kind?: unknown }).kind;
  if (kind === "admin") {
    const memberId = (actor as { memberId?: unknown }).memberId;
    if (typeof memberId !== "string" || memberId.trim() === "") {
      throw new CredentialActorError(operation, actor);
    }
    return;
  }
  if (kind === "system") {
    if (!isCredentialSystemActor((actor as { actor?: unknown }).actor)) {
      throw new CredentialActorError(operation, actor);
    }
    return;
  }
  throw new CredentialActorError(operation, actor);
}

/**
 * The actor as audit evidence: three fields, all non-secret, and the pair
 * (`actorKind`, `systemActor`) is what makes a human write and a background
 * write distinguishable on the row.
 *
 * This shape is deliberately narrow. It is the ONLY thing the store puts in an
 * audit row about the writer, and it has no field capable of holding a
 * credential value — so the "no plaintext in the audit row" rule holds by the
 * shape of the type rather than by the care of whoever edits the store next.
 */
export interface CredentialActorEvidence {
  readonly actorKind: "admin" | "system";
  readonly systemActor: CredentialSystemActor | null;
  readonly adminMemberId: string | null;
}

/** Project an actor onto its audit evidence. */
export function credentialActorEvidence(
  actor: CredentialActor,
): CredentialActorEvidence {
  return actor.kind === "admin"
    ? { actorKind: "admin", systemActor: null, adminMemberId: actor.memberId }
    : { actorKind: "system", systemActor: actor.actor, adminMemberId: null };
}

/**
 * The member id stored on `IntegrationCredential.updatedByUserId` — a misnomer
 * the column keeps, and `INV-LIFE-078` already records that it holds a member
 * id. A system write stores `null` there, which is now unambiguous: the audit
 * row for the same mutation names which system actor it was, and no write can
 * reach the column without having named one or the other.
 */
export function credentialActorMemberId(actor: CredentialActor): string | null {
  return actor.kind === "admin" ? actor.memberId : null;
}

// ---------------------------------------------------------------------------
// What it expected to find
// ---------------------------------------------------------------------------

/**
 * An opaque optimistic-concurrency token for one stored credential row.
 *
 * WHAT IT IS DERIVED FROM, and why not a `version Int` column. This repository's
 * canonical counter is `version Int @default(1)` bumped by a database trigger
 * (`BookingRequest`, `MinimumStayPolicy`, `AdultMemberHostingPolicy`), and
 * `MinimumStayPolicy` carries the note saying why it is a counter and not a
 * timestamp: millisecond collisions are possible, so `updatedAt` is not a
 * version. A stored credential needs no new column to get the same property.
 * Every write re-encrypts under a FRESH 16-byte random IV
 * (`integration-crypto.ts`), so the stored `(iv, authTag, ciphertext)` tuple is
 * a distinct value on every write even when the plaintext is identical — a
 * stronger discriminator than a counter, with no migration and no trigger.
 *
 * IT IS A HASH, NOT THE TUPLE ITSELF. The store's exposure contract (#2079)
 * says ciphertext, iv and authTag never leave the server, and a version token
 * is exactly the kind of value a future route hands to a browser as an
 * `If-Match`. SHA-256 over the tuple changes whenever any part of it changes,
 * reveals none of it, and keeps that contract intact whatever a caller does
 * with the token.
 */
export type CredentialVersion = string;

/** Derive the version token of a stored row. */
export function credentialVersionOf(row: {
  ciphertext: string;
  iv: string;
  authTag: string;
}): CredentialVersion {
  return createHash("sha256")
    .update(`${row.iv}:${row.authTag}:${row.ciphertext}`, "utf8")
    .digest("hex");
}

/**
 * What a writer believes is stored right now. REQUIRED on every mutator, so
 * concurrency intent is declared at the call site instead of inferred from the
 * absence of an argument.
 *
 *   absent   — create-only. A row already there means somebody else got in
 *              first, and this write loses.
 *   version  — compare-and-set against a token from an earlier read. The row
 *              having moved since means this write is stale, and it loses.
 *   any      — a deliberate unconditional overwrite, for a writer that is the
 *              sole authority for that (provider, key) and has nothing to be
 *              stale against. It is spelled out rather than defaulted, because
 *              "I did not think about it" and "I thought about it and there is
 *              nothing to lose to" must not look the same in the code.
 */
export type CredentialWriteExpectation =
  | { readonly expect: "absent" }
  | { readonly expect: "version"; readonly version: CredentialVersion }
  | { readonly expect: "any" };

/**
 * What a DELETE may expect to find. Narrower than the write expectation on
 * purpose: `{ expect: "absent" }` would mean "remove a row I believe is not
 * there", which is not a thing anybody means. Making it unrepresentable beats
 * refusing it at runtime.
 */
export type CredentialDeleteExpectation =
  | { readonly expect: "version"; readonly version: CredentialVersion }
  | { readonly expect: "any" };

/**
 * Thrown when a write's expectation did not hold: the row moved, or appeared,
 * under a concurrent writer. The stale write made NO change and wrote NO audit
 * row — it lost, and it is told so rather than silently winning.
 *
 * `observedVersion` is the token now stored WHEN THE LOSER COULD READ IT, and
 * `null` when it could not — either the row is gone, or the write lost to a
 * unique violation, which aborts the PostgreSQL transaction and leaves nothing
 * readable from inside it. Either way the caller re-reads: the store drops its
 * cache for the provider before the error leaves, so that re-read is fresh.
 */
export class StaleCredentialWriteError extends Error {
  readonly provider: string;
  readonly key: string;
  readonly expectation: CredentialWriteExpectation;
  readonly observedVersion: CredentialVersion | null;

  constructor(params: {
    provider: string;
    key: string;
    expectation: CredentialWriteExpectation;
    observedVersion: CredentialVersion | null;
  }) {
    super(
      `A concurrent writer changed the stored "${params.provider}" credential ` +
        `"${params.key}" first, so this write was refused rather than applied. ` +
        "Re-read the credential and decide again.",
    );
    this.name = "StaleCredentialWriteError";
    this.provider = params.provider;
    this.key = params.key;
    this.expectation = params.expectation;
    this.observedVersion = params.observedVersion;
  }
}

/**
 * The runtime half of the required-expectation contract, for the same three
 * holes `assertCredentialActor` covers.
 */
export function assertCredentialWriteExpectation(
  operation: string,
  expectation: unknown,
): asserts expectation is CredentialWriteExpectation {
  if (typeof expectation !== "object" || expectation === null) {
    throw new CredentialExpectationError(operation, expectation);
  }
  const expect = (expectation as { expect?: unknown }).expect;
  if (expect === "absent" || expect === "any") return;
  if (expect === "version") {
    const version = (expectation as { version?: unknown }).version;
    if (typeof version !== "string" || version.trim() === "") {
      throw new CredentialExpectationError(operation, expectation);
    }
    return;
  }
  throw new CredentialExpectationError(operation, expectation);
}

/**
 * The runtime half for a DELETE, which accepts one expectation fewer. Written
 * as its own assertion rather than left to the caller to re-check, so the
 * narrower type and the narrower runtime rule cannot drift apart.
 */
export function assertCredentialDeleteExpectation(
  operation: string,
  expectation: unknown,
): asserts expectation is CredentialDeleteExpectation {
  assertCredentialWriteExpectation(operation, expectation);
  if (expectation.expect === "absent") {
    throw new CredentialExpectationError(operation, expectation);
  }
}

/** Thrown when a value reaching a credential mutator is not an expectation. */
export class CredentialExpectationError extends Error {
  readonly operation: string;
  readonly received: unknown;

  constructor(operation: string, received: unknown) {
    super(
      `Credential mutation "${operation}" supplied no usable write expectation ` +
        `(received ${JSON.stringify(received) ?? String(received)}). ` +
        "Pass { expect: \"absent\" }, { expect: \"version\", version } or " +
        "{ expect: \"any\" } from @/lib/integration-credential-actor.",
    );
    this.name = "CredentialExpectationError";
    this.operation = operation;
    this.received = received;
  }
}

/** Describe an expectation for an audit row. Never carries a secret. */
export function describeCredentialExpectation(
  expectation: CredentialWriteExpectation,
): string {
  return expectation.expect;
}

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

/** The audit `action` each mutation records. One spelling, one home. */
export const CREDENTIAL_AUDIT_ACTIONS = {
  set: "integration.credential.set",
  deleted: "integration.credential.deleted",
  generated: "integration.credential.generated",
} as const;

/**
 * Request evidence a caller may attach to the audit row (request id, IP, user
 * agent). Optional, because a background writer has no request; never a place a
 * secret can travel, because every field is a header the client already sent.
 */
export interface CredentialRequestContext {
  id?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The audit payload for one credential mutation.
 *
 * IT IS TYPED, AND THAT IS THE POINT. Rule 4 above holds because this function
 * cannot be handed a plaintext: its parameter list names the provider, the key,
 * the actor evidence and the crypto METADATA, and there is no parameter a value
 * fits into. `credential-plaintext-exposure.test.ts` drives the real store with
 * a sentinel secret and proves the audit rows, the logger and the thrown errors
 * never contain it, which is the behavioural half of the same claim.
 */
function buildCredentialAuditEvidence(params: {
  provider: string;
  key: string;
  actor: CredentialActor;
  expectation: string | null;
  secretSource?: AuthSecretSource;
  labelVersion?: string;
}): Record<string, string | null> {
  const evidence = credentialActorEvidence(params.actor);
  return {
    provider: params.provider,
    key: params.key,
    actorKind: evidence.actorKind,
    systemActor: evidence.systemActor,
    expectation: params.expectation,
    secretSource: params.secretSource ?? null,
    labelVersion: params.labelVersion ?? null,
  };
}

/** Write the audit row for a mutation, on the SAME client that made the change. */
export async function recordCredentialMutation(
  db: AuditLogClient,
  params: {
    action: string;
    summary: string;
    actor: CredentialActor;
    provider: string;
    key: string;
    expectation: string | null;
    secretSource?: AuthSecretSource;
    labelVersion?: string;
    request?: CredentialRequestContext;
  },
): Promise<void> {
  const memberId = credentialActorMemberId(params.actor);
  await createAuditLog(
    {
      action: params.action,
      // `security` and `important` are what the admin write route already
      // recorded for `integration.credential.set`, kept deliberately: changing
      // the category of an action already in the table would reclassify the
      // rows written before this change (`INV-OPS-012`).
      category: "security",
      severity: "important",
      outcome: "success",
      memberId,
      actorMemberId: memberId,
      entityType: "IntegrationCredential",
      entityId: `${params.provider}:${params.key}`,
      summary: params.summary,
      metadata: buildCredentialAuditEvidence({
        provider: params.provider,
        key: params.key,
        actor: params.actor,
        expectation: params.expectation,
        secretSource: params.secretSource,
        labelVersion: params.labelVersion,
      }),
      requestId: params.request?.id ?? null,
      ipAddress: params.request?.ipAddress ?? null,
      userAgent: params.request?.userAgent ?? null,
    },
    db,
  );
}
