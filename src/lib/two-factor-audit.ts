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

/**
 * Request evidence for the row: the audit module's own shape, which
 * `getAuditRequestContext` returns, rather than the credential store's.
 */
export type TwoFactorRequestContext = StructuredAuditEvent["request"];

/** Who changed a member's second factor. */
export type TwoFactorActor =
  /** The member enrolling their own second factor. */
  | { readonly kind: "member"; readonly memberId: string }
  /** An administrator, e.g. approving the member's account erasure. */
  | { readonly kind: "admin"; readonly memberId: string };

/** The audit `action` each mutation records. One spelling, one home. */
export const TWO_FACTOR_AUDIT_ACTIONS = {
  enrolled: "security.two_factor.enrolled",
  cleared: "security.two_factor.cleared",
  /** A member replaced their recovery codes, invalidating every unused one. */
  recoveryCodesReplaced: "security.two_factor.recovery_codes_replaced",
} as const;

export type TwoFactorAuditAction =
  (typeof TWO_FACTOR_AUDIT_ACTIONS)[keyof typeof TWO_FACTOR_AUDIT_ACTIONS];

/** Thrown when a value reaching a two-factor mutation is not an actor. Echoes no secret. */
export class TwoFactorActorError extends Error {
  readonly operation: string;

  constructor(operation: string, received: unknown, subjectMemberId?: string) {
    super(
      subjectMemberId === undefined
        ? `Two-factor mutation "${operation}" supplied no usable actor (received ` +
            `${JSON.stringify(received) ?? String(received)}). Name the member ` +
            "({ kind: \"member\", memberId }) or the administrator " +
            "({ kind: \"admin\", memberId }) from @/lib/two-factor-audit."
        : `Two-factor mutation "${operation}" was refused: a member actor ` +
            `(${JSON.stringify(received)}) may change only their own second ` +
            `factor, and this one belongs to member "${subjectMemberId}". ` +
            "An administrator acting on another member names { kind: \"admin\" }.",
    );
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
  const { kind, memberId } = actor as { kind?: unknown; memberId?: unknown };
  if (
    (kind !== "member" && kind !== "admin") ||
    typeof memberId !== "string" ||
    memberId.trim() === ""
  ) {
    throw new TwoFactorActorError(operation, actor);
  }
}

/**
 * A member may only change their OWN second factor; an administrator acts on
 * someone else's. Refused before anything is written, because a row naming
 * member A as "the member themself" for member B's enrolment is a false record.
 */
export function assertTwoFactorActorMayAct(
  operation: string,
  actor: unknown,
  subjectMemberId: string,
): asserts actor is TwoFactorActor {
  assertTwoFactorActor(operation, actor);
  if (actor.kind === "member" && actor.memberId !== subjectMemberId) {
    throw new TwoFactorActorError(operation, actor, subjectMemberId);
  }
}

/**
 * Write the audit row for a two-factor mutation, on the SAME client that made
 * the change. The parameter list names the subject, the method and booleans —
 * there is no parameter a secret fits into.
 */
export async function recordTwoFactorMutation(
  db: AuditLogClient,
  params: {
    action: TwoFactorAuditAction;
    actor: TwoFactorActor;
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
  },
): Promise<void> {
  assertTwoFactorActorMayAct(params.action, params.actor, params.subjectMemberId);
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
      memberId: params.actor.memberId,
      actorMemberId: params.actor.memberId,
      subjectMemberId: params.subjectMemberId,
      targetId: params.subjectMemberId,
      entityType: "Member",
      entityId: params.subjectMemberId,
      summary,
      metadata: {
        actorKind: params.actor.kind,
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
 * The account-erasure executor's half: read the member's second factor INSIDE
 * the erasure transaction (after its row lock) and, when there is one to clear,
 * record the clear on that same transaction. Only booleans leave the read — the
 * encrypted secret is tested for presence and never handed on. A member with no
 * second factor has nothing cleared and gets no row.
 */
export async function recordErasureTwoFactorClear(
  tx: Pick<Prisma.TransactionClient, "member" | "auditLog">,
  params: {
    memberId: string;
    adminMemberId: string;
    request?: TwoFactorRequestContext;
  },
): Promise<void> {
  const before = await tx.member.findUnique({
    where: { id: params.memberId },
    select: { twoFactorEnabled: true, twoFactorMethod: true, totpSecret: true },
  });
  const authenticatorApp = Boolean(before?.totpSecret);
  if (!before || (!before.twoFactorEnabled && !authenticatorApp)) return;
  await recordTwoFactorMutation(tx, {
    action: TWO_FACTOR_AUDIT_ACTIONS.cleared,
    actor: { kind: "admin", memberId: params.adminMemberId },
    subjectMemberId: params.memberId,
    method: before.twoFactorMethod,
    authenticatorApp,
    request: params.request,
  });
}
