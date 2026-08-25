import "server-only";

/**
 * The WRITE half of the environment-safety override (ENV-SAFETY 1, #3034; epic
 * #2986). INV-CONFIG-003.
 *
 * `src/app` validates and authorises at the boundary and delegates the rest to
 * `src/lib` (`docs/ARCHITECTURE.md` → "Where code lives"), and this is the rest:
 * the Serializable transaction, its dirty gate, its audit row, and the classifier
 * for the contention errors it can lose to. `/api/admin/environment-safety`
 * keeps the guard, the body schema, the confirmation and the HTTP status codes,
 * which is exactly what a route is for — and it keeps its 250-line route-handler
 * budget while the reasoning below sits next to the code it is about.
 *
 * THE TRANSACTION TOUCHES EXACTLY TWO TABLES — `EnvironmentSafetySettings` and
 * `AuditLog` — and that is a contract, not an implementation detail. Switching
 * the override changes how this installation BEHAVES from now on; it rewrites no
 * booking, no payment and no member. A write here reaching any of those would be
 * that promise broken, so the route's test enumerates the delegates the
 * transaction touched and fails if any other one is called.
 *
 * SERIALIZABLE, AND NO ADVISORY LOCK. A single-row configuration upsert composes
 * no capacity claim, no settlement money and no lifecycle transition, which is
 * what `docs/CONCURRENCY_AND_LOCKING.md` reserves the lock tiers for — but it
 * does need its recorded BEFORE value to be true. At Prisma's default READ
 * COMMITTED a `findUnique` takes no row lock, so two administrators saving at
 * once could each read "off", both write, and leave a trail claiming two changes
 * FROM off. Serializable aborts the loser instead, which writes nothing at all
 * and is answered a retryable 503.
 */

import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  ENVIRONMENT_SAFETY_SETTINGS_ID,
  ENVIRONMENT_SAFETY_SETTINGS_SELECT,
  decideEnvironmentRole,
  type EnvironmentRoleResolution,
  type PersistedEnvironmentSafetySettings,
} from "@/lib/environment-role";
import { readEnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
import { prisma } from "@/lib/prisma";

/**
 * Retryable failures of the transaction below, answered 503 rather than 500.
 *
 * P2028 (transaction API error, including an exhausted `maxWait`/`timeout`) and
 * P2034 (write conflict, deadlock, or the serialisation failure Serializable
 * deliberately provokes) are the shared shape `/api/admin/club-time-zone` and
 * `/api/admin/site-style` use. P2002 joins them because on a one-row singleton
 * whose id is a constant, a primary-key collision can only be this upsert's
 * create arm losing a race with another administrator recording the setting for
 * the first time — and the only other table this transaction writes is
 * `AuditLog`, whose primary key is a per-row `cuid` with no other unique
 * constraint, so no P2002 can originate there today. Add a unique index to
 * `AuditLog` and this set must be revisited, because a duplicate-audit bug would
 * start being answered "try again shortly" — a retryable status for something
 * retrying cannot fix.
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2002", "P2028", "P2034"]);

export function isTransactionContentionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSACTION_CONTENTION_CODES.has(code);
}

export interface EnvironmentSafetyOverrideWriteOutcome {
  changed: boolean;
  /** `null` when the dirty gate refused a no-op and no row exists. */
  row: PersistedEnvironmentSafetySettings | null;
  /** The role AFTER the write — see {@link resolutionAfterWrite}. */
  resolution: EnvironmentRoleResolution;
}

/**
 * The role after a write, computed from the row this request wrote and the
 * declaration read live — never from a fresh database round trip, which could
 * pick up a concurrent administrator's change and report it as this request's
 * result.
 *
 * It is also what lets the response tell the operator the honest consequence of
 * switching the override OFF on an undeclared installation: UNKNOWN, not
 * production. Nothing an administrator can do here makes an installation claim
 * to be production.
 */
function resolutionAfterWrite(
  row: PersistedEnvironmentSafetySettings | null,
): EnvironmentRoleResolution {
  return decideEnvironmentRole(
    readEnvironmentRoleDeclaration(),
    row?.forceNonProduction
      ? {
          kind: "force-non-production",
          updatedAt: row.updatedAt,
          updatedByMemberId: row.updatedByMemberId,
        }
      : { kind: "none" },
  );
}

/**
 * Set the safer override, audited, in one Serializable transaction.
 *
 * `forceNonProduction` is the only thing a caller may set, and there is
 * deliberately no parameter that could assert production: the direction of this
 * lever is fixed by the schema, which has no column for the other one.
 */
export async function writeEnvironmentSafetyOverride(params: {
  forceNonProduction: boolean;
  actingMemberId: string;
  request: Request;
}): Promise<EnvironmentSafetyOverrideWriteOutcome> {
  const { forceNonProduction, actingMemberId, request } = params;

  const outcome = await prisma.$transaction(
    async (tx) => {
      const before = await tx.environmentSafetySettings.findUnique({
        where: { id: ENVIRONMENT_SAFETY_SETTINGS_ID },
        select: ENVIRONMENT_SAFETY_SETTINGS_SELECT,
      });

      /*
        DIRTY GATING (docs/ARCHITECTURE.md -> "Admin/member layer"). Re-saving
        the value already stored writes nothing at all: no row, no `updatedAt`
        bump and no audit row. A trail recording changes that never happened is
        worse than no trail, because the next reader cannot tell the difference.
        The isolation level — not the fact that this read sits inside the
        transaction — is what keeps `before` true at commit time.

        ABSENT COUNTS AS `false`, and that is the fix for a real hole (#3034
        review). The first version gated on `before &&`, so saving
        `forceNonProduction: false` with NO row created one and wrote an audit row
        summarised "switched off" — for an override that had never been on. The
        effective role does not change either way, so that row claimed a change
        that did not happen, which is exactly what the paragraph above argues
        against.

        Treating absent as `false` is the right resolution rather than merely the
        cheaper one, for two reasons. An absent row and `false` ARE the same
        answer — that is what the schema's `@default(false)` and the migration's
        decision not to seed a row both rest on, and what lets every read path
        avoid ever creating one. And the panel never offers this: with the
        override off the button reads "Switch the override on", so a `false`
        against an absent row can only arrive from a direct API call. The
        "provenance of a deliberate confirmation" it would preserve is provenance
        nobody asked for — and it would go on to make the panel say "last changed
        <date> by <name>" for a change that never occurred, which is the same
        untruth one layer up.
      */
      const beforeValue = before?.forceNonProduction ?? false;
      if (beforeValue === forceNonProduction) {
        return { changed: false as const, row: before };
      }

      const row = await tx.environmentSafetySettings.upsert({
        where: { id: ENVIRONMENT_SAFETY_SETTINGS_ID },
        update: { forceNonProduction, updatedByMemberId: actingMemberId },
        create: {
          id: ENVIRONMENT_SAFETY_SETTINGS_ID,
          forceNonProduction,
          updatedByMemberId: actingMemberId,
        },
        select: ENVIRONMENT_SAFETY_SETTINGS_SELECT,
      });

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "ENVIRONMENT_SAFETY_OVERRIDE_UPDATED",
          actor: { memberId: actingMemberId },
          entity: {
            type: "EnvironmentSafetySettings",
            id: ENVIRONMENT_SAFETY_SETTINGS_ID,
          },
          /*
            Installation configuration, like CLUB_TIME_ZONE_UPDATED and
            CLUB_IDENTITY_SETTINGS_UPDATED. NOT `security`: this changes what the
            installation DOES, not who may sign in or what they may reach. The
            read gate happens to be identical either way — both are readable with
            `support:view` alone — so the choice is about which shelf the row
            belongs on rather than about who can see it. It does widen the
            support-readable population by one site, which the changelog says.
          */
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: forceNonProduction
            ? "Environment safety override switched on (forced non-production)"
            : "Environment safety override switched off",
          /*
            THE BEFORE AND AFTER FLAG, AND NOTHING ELSE. `before: null` means
            nothing was stored yet. No request echo, no environment values, and
            nothing about the actor beyond the id the row already carries — in
            particular NOT the deployment declaration, which is configuration
            this row has no business copying and which the resolver reads live
            anyway.
          */
          metadata: {
            before: before?.forceNonProduction ?? null,
            after: forceNonProduction,
          },
          request: getAuditRequestContext(request),
        }),
      );

      return { changed: true as const, row };
    },
    { isolationLevel: "Serializable" },
  );

  return { ...outcome, resolution: resolutionAfterWrite(outcome.row) };
}
