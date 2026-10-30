/**
 * The WRITE VOCABULARY for a member's two-factor secret (#3454).
 *
 * `Member.totpSecret` is encrypted at rest, and until #3454 it was written at
 * enrolment, and cleared by the account-erasure executor, with no audit row at
 * all — so "who turned on this member's second factor, and when?" had no
 * answer, beside a credential store (#2723) where the same question always does.
 *
 * This lifts #2723's PATTERN rather than its type. `CredentialActor` names a
 * Full Admin or a named background job, and a self-enrolment is neither: the
 * member themself is the actor. And the secret is not a provider credential, so
 * it does not belong in that store. What carries over is the contract:
 *
 *   1. a REQUIRED actor, so an unattributed mutation does not compile, with a
 *      runtime assertion for the holes a type always has;
 *   2. the change and its audit row on ONE transaction client, so neither can
 *      land without the other;
 *   3. an evidence payload built from a type with no field a secret fits into;
 *   4. a no-op records nothing.
 *
 * WHAT A MEMBER SEES. The rows are `security`, a member-visible category, so an
 * enrolment appears on the member's own timeline as what happened, when and who
 * did it — the generic event, which is how a member would notice an enrolment
 * they did not make. They declare NO member-facing free text: the audit-log
 * guide keeps that list deliberately short (credit reasons and booking-decision
 * notes), and nothing here needs a sentence beyond the summary.
 */

import type { Prisma } from "@prisma/client";
import {
  createAuditLog,
  type AuditLogClient,
  type StructuredAuditEvent,
} from "@/lib/audit";
import { FORMER_MEMBER_ANONYMISATION_JOB_NAME } from "@/lib/privacy-retention-shared";

/**
 * Request evidence for the row: the audit module's own shape, which
 * `getAuditRequestContext` returns, rather than the credential store's.
 */
export type TwoFactorRequestContext = StructuredAuditEvent["request"];

/**
 * The background jobs that may CLEAR a second factor with no person behind the
 * write, each named (INV-PRIV-020 bullet 2's closed list, for this vocabulary).
 * Adding one is a reviewed change; no system actor ever enrols a factor.
 */
export const TWO_FACTOR_SYSTEM_ACTORS = [
  /** The retention job anonymising a former member after their period (#4457). */
  FORMER_MEMBER_ANONYMISATION_JOB_NAME,
] as const;

export type TwoFactorSystemActor = (typeof TWO_FACTOR_SYSTEM_ACTORS)[number];

const TWO_FACTOR_SYSTEM_ACTOR_SET: ReadonlySet<string> = new Set<string>(
  TWO_FACTOR_SYSTEM_ACTORS,
);

/** Who changed a member's second factor. */
export type TwoFactorActor =
  /** The member enrolling their own second factor. */
  | { readonly kind: "member"; readonly memberId: string }
  /** An administrator, e.g. approving the member's account erasure. */
  | { readonly kind: "admin"; readonly memberId: string }
  /** A named background job clearing it, e.g. retention anonymisation. */
  | { readonly kind: "system"; readonly actor: TwoFactorSystemActor };

/**
 * A person: the only actor that may enrol a factor or replace recovery codes.
 * Every non-clear entry point takes this, so a job there does not compile.
 */
export type TwoFactorPersonActor = Exclude<TwoFactorActor, { readonly kind: "system" }>;

/** The audit `action` each mutation records. One spelling, one home. */
export const TWO_FACTOR_AUDIT_ACTIONS = {
  enrolled: "security.two_factor.enrolled",
  cleared: "security.two_factor.cleared",
  /** A member replaced their recovery codes, invalidating every unused one. */
  recoveryCodesReplaced: "security.two_factor.recovery_codes_replaced",
} as const;

export type TwoFactorAuditAction =
  (typeof TWO_FACTOR_AUDIT_ACTIONS)[keyof typeof TWO_FACTOR_AUDIT_ACTIONS];

/** Why an actor was refused. */
type TwoFactorActorRefusal =
  | { readonly kind: "unusable" }
  | { readonly kind: "not-own-factor"; readonly subjectMemberId: string }
  | { readonly kind: "job-may-only-clear" };

function refusalMessage(operation: string, received: unknown, refusal: TwoFactorActorRefusal): string {
  switch (refusal.kind) {
    case "unusable":
      return `Two-factor mutation "${operation}" supplied no usable actor (received ` +
        `${JSON.stringify(received) ?? String(received)}). Name the member ` +
        "({ kind: \"member\", memberId }) or the administrator " +
        "({ kind: \"admin\", memberId }), or a job from TWO_FACTOR_SYSTEM_ACTORS " +
        "({ kind: \"system\", actor }), from @/lib/two-factor-audit.";
    case "not-own-factor":
      return `Two-factor mutation "${operation}" was refused: a member actor ` +
        `(${JSON.stringify(received)}) may change only their own second ` +
        `factor, and this one belongs to member "${refusal.subjectMemberId}". ` +
        "An administrator acting on another member names { kind: \"admin\" }.";
    case "job-may-only-clear":
      return `Two-factor mutation "${operation}" was refused: a job ` +
        `(${JSON.stringify(received)}) may only clear a second factor. ` +
        "Enrolling one or replacing recovery codes needs a member or an administrator.";
  }
}

/** Thrown when a value reaching a two-factor mutation is not an actor allowed to make it. Echoes no secret. */
export class TwoFactorActorError extends Error {
  readonly operation: string;

  constructor(
    operation: string,
    received: unknown,
    refusal: TwoFactorActorRefusal = { kind: "unusable" },
  ) {
    super(refusalMessage(operation, received, refusal));
    this.name = "TwoFactorActorError";
    this.operation = operation;
  }
}

/** The runtime half of the required-actor contract. */
export function assertTwoFactorActor(
  operation: string,
  actor: unknown,
): asserts actor is TwoFactorActor {
  if (typeof actor !== "object" || actor === null) {
    throw new TwoFactorActorError(operation, actor);
  }
  const { kind, memberId, actor: job } = actor as {
    kind?: unknown;
    memberId?: unknown;
    actor?: unknown;
  };
  if (kind === "system") {
    if (typeof job !== "string" || !TWO_FACTOR_SYSTEM_ACTOR_SET.has(job)) {
      throw new TwoFactorActorError(operation, actor);
    }
    return;
  }
  if (
    (kind !== "member" && kind !== "admin") ||
    typeof memberId !== "string" ||
    memberId.trim() === ""
  ) {
    throw new TwoFactorActorError(operation, actor);
  }
}

/**
 * Whether this actor may make this mutation of this member's second factor. A
 * member may change only their OWN; an administrator acts on someone else's; a
 * named job may only CLEAR one. Every entry point calls it before anything is
 * written: a row naming member A as "the member themself" for member B's
 * enrolment, or a job as the author of an enrolment, is a false record. The
 * types already refuse a job outside a clear; this is the runtime half, for
 * casts and untyped values.
 */
export function assertTwoFactorActorMayAct(
  operation: TwoFactorAuditAction,
  actor: unknown,
  subjectMemberId: string,
): asserts actor is TwoFactorActor {
  assertTwoFactorActor(operation, actor);
  if (actor.kind === "system" && operation !== TWO_FACTOR_AUDIT_ACTIONS.cleared) {
    throw new TwoFactorActorError(operation, actor, { kind: "job-may-only-clear" });
  }
  if (actor.kind === "member" && actor.memberId !== subjectMemberId) {
    throw new TwoFactorActorError(operation, actor, { kind: "not-own-factor", subjectMemberId });
  }
}

/** What every audit row for a two-factor mutation carries beside its action and actor. */
type TwoFactorMutationDetails = {
  subjectMemberId: string;
  /** The method enrolled or being cleared (null when none was set or it does not apply). */
  method: "TOTP" | "EMAIL" | null;
  /**
   * Whether an authenticator-app secret is being stored or destroyed. Not
   * called `totpSecret`: the metadata redactor strips any key containing
   * "secret", and this is a boolean, never the value.
   */
  authenticatorApp: boolean;
  /** How many recovery codes were issued, when the event issued any. Never the codes. */
  recoveryCodesIssued?: number;
  request?: TwoFactorRequestContext;
};

/** A job appears only beside a clear; enrolment and code replacement name a person. */
export type TwoFactorMutation = TwoFactorMutationDetails & (
  | { action: typeof TWO_FACTOR_AUDIT_ACTIONS.cleared; actor: TwoFactorActor }
  | {
      action: Exclude<TwoFactorAuditAction, typeof TWO_FACTOR_AUDIT_ACTIONS.cleared>;
      actor: TwoFactorPersonActor;
    }
);

/**
 * Write the audit row for a two-factor mutation, on the SAME client that made
 * the change. The parameter list names the subject, the method and booleans —
 * there is no parameter a secret fits into.
 */
export async function recordTwoFactorMutation(
  db: AuditLogClient,
  params: TwoFactorMutation,
): Promise<void> {
  // Defence in depth: the entry points already asserted, before their writes.
  assertTwoFactorActorMayAct(params.action, params.actor, params.subjectMemberId);
  const actorMemberId = params.actor.kind === "system" ? null : params.actor.memberId;
  const summary =
    params.action === TWO_FACTOR_AUDIT_ACTIONS.enrolled
      ? `Two-factor authentication turned on (${
          params.method === "EMAIL" ? "email code" : "authenticator app"
        })`
      : params.action === TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced
        ? "Two-factor recovery codes replaced"
        : "Two-factor authentication cleared";
  await createAuditLog(
    {
      action: params.action,
      // `security`: a second factor is a credential, and that is the category
      // the audit-log guide files credentials under.
      category: "security",
      severity: "important",
      outcome: "success",
      memberId: actorMemberId,
      actorMemberId,
      subjectMemberId: params.subjectMemberId,
      targetId: params.subjectMemberId,
      entityType: "Member",
      entityId: params.subjectMemberId,
      summary,
      metadata: {
        actorKind: params.actor.kind,
        ...(params.actor.kind === "system" ? { systemActor: params.actor.actor } : {}),
        method: params.method,
        authenticatorApp: params.authenticatorApp,
        ...(params.recoveryCodesIssued === undefined
          ? {}
          : { recoveryCodesIssued: params.recoveryCodesIssued }),
      },
      // Declared, not defaulted: the member reads the generic event only.
      memberDisclosure: { visibility: "internal" },
      requestId: params.request?.id ?? null,
      ipAddress: params.request?.ipAddress ?? null,
      userAgent: params.request?.userAgent ?? null,
    },
    db,
  );
}

/**
 * The member's second factor as a clear needs to describe it. Only booleans
 * and the method leave the read — the encrypted secret is tested for presence
 * and never handed on.
 */
export type TwoFactorClearEvidence = {
  readonly twoFactorEnabled: boolean;
  readonly twoFactorMethod: "TOTP" | "EMAIL" | null;
  readonly authenticatorApp: boolean;
};

/** Read {@link TwoFactorClearEvidence} on the caller's transaction, after its row lock. */
export async function readTwoFactorClearEvidence(
  tx: Pick<Prisma.TransactionClient, "member">,
  memberId: string,
): Promise<TwoFactorClearEvidence | null> {
  const before = await tx.member.findUnique({
    where: { id: memberId },
    select: { twoFactorEnabled: true, twoFactorMethod: true, totpSecret: true },
  });
  if (!before) return null;
  return {
    twoFactorEnabled: before.twoFactorEnabled,
    twoFactorMethod: before.twoFactorMethod,
    authenticatorApp: Boolean(before.totpSecret),
  };
}

/**
 * Record the clear of a second factor read beforehand as `before`, on the
 * transaction that clears it. A member with no second factor has nothing
 * cleared and gets no row.
 */
export async function recordTwoFactorClear(
  tx: AuditLogClient,
  params: {
    before: TwoFactorClearEvidence | null;
    actor: Exclude<TwoFactorActor, { kind: "member" }>;
    subjectMemberId: string;
    request?: TwoFactorRequestContext;
  },
): Promise<void> {
  const { before } = params;
  if (!before || (!before.twoFactorEnabled && !before.authenticatorApp)) return;
  await recordTwoFactorMutation(tx, {
    action: TWO_FACTOR_AUDIT_ACTIONS.cleared,
    actor: params.actor,
    subjectMemberId: params.subjectMemberId,
    method: before.twoFactorMethod,
    authenticatorApp: before.authenticatorApp,
    request: params.request,
  });
}

/**
 * The account-erasure executor's half: read the member's second factor INSIDE
 * the erasure transaction (after its row lock) and, when there is one to clear,
 * record the clear on that same transaction.
 */
export async function recordErasureTwoFactorClear(
  tx: Pick<Prisma.TransactionClient, "member" | "auditLog">,
  params: {
    memberId: string;
    adminMemberId: string;
    request?: TwoFactorRequestContext;
  },
): Promise<void> {
  await recordTwoFactorClear(tx, {
    before: await readTwoFactorClearEvidence(tx, params.memberId),
    actor: { kind: "admin", memberId: params.adminMemberId },
    subjectMemberId: params.memberId,
    request: params.request,
  });
}
