/**
 * THE canonical answer to "is this installation production?" (ENV-SAFETY 1,
 * #3034; epic #2986). INV-CONFIG-003.
 *
 * Three effective states and no fourth:
 *
 * - `PRODUCTION`     — the deployment declared production and no safer override
 *                      is on. Ordinary production behaviour.
 * - `NON_PRODUCTION` — the deployment declared non-production, or an
 *                      administrator has forced this instance safer.
 * - `UNKNOWN`        — nothing has said. **Not production, and not the same
 *                      thing as confirmed non-production either.** #3035 and
 *                      #3036 fail closed here: an external side effect whose
 *                      safety depends on which installation this is does not
 *                      happen until the configuration is resolved.
 *
 * NOTHING IS EVER INFERRED. Not from `NODE_ENV` (a build mode — a staging
 * container runs a production build), not from `APP_RUNTIME_ROLE` (a deployment
 * naming convention for which SLOT a container is: web-blue, cron-leader,
 * staging), not from a hostname, a branch, a URL, a `DATABASE_URL`, or a
 * provider organisation. Every one of those is a convention that holds until
 * somebody stands up a copy that breaks it, and that is the day it matters.
 *
 * TWO GUARDS HOLD THAT, and they are named here exactly, because a docblock that
 * cites a test file which does not exist is worse than one that cites nothing —
 * the next reader trusts it and stops looking (#3034 review).
 * `environment-role-resolver.test.ts` asserts the answer does not move when all
 * of those variables are set to production-looking and then
 * non-production-looking values. `environment-role-inference-census.test.ts`
 * asserts at source level that neither this module nor
 * `environment-role-declaration.ts` READS any of them — not that they avoid
 * MENTIONING them, which they plainly do not: both explain at length why these
 * variables cannot answer the question, and the census's own comment says the
 * word may appear while a read may not.
 *
 * THE DATABASE CAN ONLY MAKE THE ANSWER SAFER. `EnvironmentSafetySettings` holds
 * one boolean, `forceNonProduction`, and the schema deliberately has no column
 * in which "I am production" could be expressed — so a restored production dump
 * cannot carry a production claim into a staging copy, because there is nothing
 * for it to travel in. Production is declared by the DEPLOYMENT and by nothing
 * else. Turning the override OFF is therefore not an elevation: with it off the
 * declaration decides, and an installation that declares nothing goes back to
 * UNKNOWN rather than to production.
 *
 * FAIL CLOSED WHEN THE OVERRIDE CANNOT BE READ, including when the declaration
 * says `production`. An unreadable override means we cannot rule out that an
 * operator has already forced this instance safer — which is the case where
 * getting it wrong emails the club's real members from a copy. This trades no
 * availability the application actually has: every page of this app needs the
 * database, so a database that cannot answer this one-row primary-key read is
 * not an installation that is otherwise serving. The one exception is the leg
 * that is already at the safest answer: with the declaration `non-production`,
 * an unreadable override changes nothing, because the override could only have
 * pushed it where it already is.
 *
 * NO CACHE, DELIBERATELY. This is one primary-key read of a one-row table. A
 * cache would put a staleness window between an administrator switching the
 * safer override on — the button somebody presses when they have just realised a
 * copy is about to email real members — and it taking effect. If a future
 * optimiser wants one, that window is the thing to argue about first.
 *
 * NOT `server-only`, on purpose: `setup-readiness-db.ts` imports this and is
 * itself imported by the `tsx` entrypoint `npm run setup`, which a `server-only`
 * import would abort. It is kept off the client bundle graph by being named a
 * forbidden leaf in both halves of `INV-OPS-013` — see
 * `environment-role-declaration.ts`'s docblock for the two lists and why being
 * in neither means being protected by neither.
 */

import {
  readEnvironmentRoleDeclaration,
  type EnvironmentRoleDeclaration,
} from "@/lib/environment-role-declaration";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** The settings singleton's id, spelled once. */
export const ENVIRONMENT_SAFETY_SETTINGS_ID = "default";

/**
 * The projection EVERY read and write of this row uses — the override read
 * below, the admin route's `findUnique` and its `upsert`.
 *
 * One spelling, exported from the canonical reader, because a second
 * byte-identical copy elsewhere is a silent-drift hazard rather than a style
 * question: nothing fails when the two come to differ by a column — the route
 * simply returns a payload missing a field the panel reads, or audits a `before`
 * value it never selected. That happened on #2989 and is why this is here.
 */
export const ENVIRONMENT_SAFETY_SETTINGS_SELECT = {
  forceNonProduction: true,
  updatedByMemberId: true,
  updatedAt: true,
} as const;

export type EnvironmentRole = "PRODUCTION" | "NON_PRODUCTION" | "UNKNOWN";

export interface PersistedEnvironmentSafetySettings {
  forceNonProduction: boolean;
  updatedByMemberId: string | null;
  updatedAt: Date;
}

/**
 * What the database says about the safer override.
 *
 * `none` covers BOTH "no row" and "a row with the override off", because they
 * are the same answer and a read path must not create a row to tell them apart.
 * `unreadable` is a third state rather than folded into `none` for the reason the
 * club-timezone snapshot keeps them apart: "we could not ask" and "the answer is
 * no" have opposite safety consequences here, and collapsing them would turn a
 * database blip into a confident PRODUCTION.
 */
export type EnvironmentRoleDatabaseOverride =
  | {
      kind: "force-non-production";
      updatedAt: Date;
      updatedByMemberId: string | null;
    }
  | { kind: "none" }
  | { kind: "unreadable" };

/**
 * Which source decided the role.
 *
 * `unresolved` is not an error condition — it is the honest answer when nothing
 * has declared this installation, and it is what a caller keys "fail closed" on
 * together with `role: "UNKNOWN"`.
 */
export type EnvironmentRoleDecidedBy =
  | "deployment-declaration"
  | "database-safer-override"
  | "unresolved";

export interface EnvironmentRoleResolution {
  role: EnvironmentRole;
  decidedBy: EnvironmentRoleDecidedBy;
  declaration: EnvironmentRoleDeclaration;
  databaseOverride: EnvironmentRoleDatabaseOverride;
  /**
   * Operator-facing, secret-free explanation lines: what each source said, and
   * what to do when they disagree or one is missing. These travel to the setup
   * checklist and the admin panel, so they name variables and screens and never
   * credentials, connection strings or provider identifiers.
   */
  notes: string[];
}

/** The minimal delegate shape, so a structural fake can stand in for tests. */
type EnvironmentSafetySettingsDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: typeof ENVIRONMENT_SAFETY_SETTINGS_SELECT;
  }) => Promise<PersistedEnvironmentSafetySettings | null>;
};

function environmentSafetySettingsDelegate():
  | EnvironmentSafetySettingsDelegate
  | undefined {
  return (
    prisma as unknown as {
      environmentSafetySettings?: EnvironmentSafetySettingsDelegate;
    }
  ).environmentSafetySettings;
}

/**
 * The persisted row, or `null` when it is absent, or the `unreadable` sentinel.
 *
 * A MISSING DELEGATE IS `unreadable`, not `none`. An un-migrated database or a
 * Prisma client generated before this model existed cannot answer the question,
 * and answering "no override" on its behalf is the one direction this module is
 * not allowed to guess in.
 */
export const ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE: unique symbol = Symbol(
  "environment-safety-settings-unreadable",
);

/**
 * How often a failed override read may say so, per process.
 *
 * The single most confusing symptom this change can produce is "our live site
 * went UNKNOWN and stopped emailing members", and a bare `catch {}` throws away
 * the only evidence of WHY — the operator note can only offer a guess between
 * two very different faults ("apply the migration" versus "the database is
 * unreachable"), while the Prisma error says which. So it is logged at error
 * level.
 *
 * THROTTLED, because this resolver runs once per email send and once per Xero
 * contact from #3035 and #3036 onward. A database outage is exactly when this
 * fires, so logging unconditionally would turn one fault into a log storm at the
 * moment the logs matter most. Same shape as
 * `alertAdminsOfFailClosedWithhold` in `src/lib/email/core.ts`, which solved
 * this identical hazard: the first occurrence logs immediately, then at most one
 * per window.
 *
 * The window is wall-clock `Date.now()` and not a stopwatch, so the frozen test
 * clock is not a problem: a test advances it with `vi.setSystemTime` rather than
 * waiting. AGENTS.md's "`Date.now()` is no longer a stopwatch" rule is about
 * measuring ELAPSED time, which this is not.
 */
const UNREADABLE_LOG_WINDOW_MS = 15 * 60 * 1000;

/** 0 means "never logged in this process". */
let unreadableLoggedAt = 0;

/** Test seam: the throttle is module state and must not leak between tests. */
export function __resetEnvironmentRoleUnreadableLogThrottle() {
  unreadableLoggedAt = 0;
}

function logUnreadableOverride(error: unknown) {
  const now = Date.now();
  if (unreadableLoggedAt !== 0 && now - unreadableLoggedAt < UNREADABLE_LOG_WINDOW_MS) {
    return;
  }
  unreadableLoggedAt = now;
  /*
    The error's MESSAGE and nothing else. A Prisma error can carry the client's
    configuration on adjacent fields, and `DATABASE_URL` holds the database
    password — so the whole error object is deliberately not attached, and
    `err: { message }` is the shape that says "the fault, not the credentials".
    The logger redacts known secret keys anyway; that is a backstop, not the
    reason this is narrow.
  */
  logger.error(
    {
      scope: "environment-role",
      err: { message: error instanceof Error ? error.message : String(error) },
    },
    "Could not read the environment-safety override, so this installation's role cannot be confirmed and resolves UNKNOWN. Anything whose safety depends on knowing whether this is the club's live site will fail closed until it can be read. Apply pending migrations (prisma migrate deploy) or restore database access.",
  );
}

export async function loadPersistedEnvironmentSafetySettings(): Promise<
  | PersistedEnvironmentSafetySettings
  | null
  | typeof ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE
> {
  const delegate = environmentSafetySettingsDelegate();
  /*
    A MISSING DELEGATE IS DELIBERATELY SILENT, unlike a thrown read. In
    production the delegate is generated from the same schema as this code, so
    its absence is not a fault an operator can act on — while in the unit suite it
    is the DEFAULT state, because almost every test mocks `@/lib/prisma` with a
    partial object naming only the delegates it uses. Logging here would put an
    error line in several hundred unrelated suites and say nothing the readiness
    surface does not already say. `resolveEnvironmentRole` still fails closed for
    it, which is the part that matters.
  */
  if (!delegate) return ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE;
  try {
    return await delegate.findUnique({
      where: { id: ENVIRONMENT_SAFETY_SETTINGS_ID },
      select: ENVIRONMENT_SAFETY_SETTINGS_SELECT,
    });
  } catch (error) {
    logUnreadableOverride(error);
    return ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE;
  }
}

/** {@link loadPersistedEnvironmentSafetySettings}, classified. */
export async function readEnvironmentRoleDatabaseOverride(): Promise<EnvironmentRoleDatabaseOverride> {
  const row = await loadPersistedEnvironmentSafetySettings();
  if (row === ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE) {
    return { kind: "unreadable" };
  }
  if (!row || !row.forceNonProduction) return { kind: "none" };
  return {
    kind: "force-non-production",
    updatedAt: row.updatedAt,
    updatedByMemberId: row.updatedByMemberId,
  };
}

const DECLARE_IT_NOTE =
  "Set APP_ENVIRONMENT_ROLE to production or non-production in this " +
  "deployment's environment. It is not APP_RUNTIME_ROLE, which names which " +
  "container slot this is (web-blue, cron-leader, staging) and is never read " +
  "for this.";

const UNREADABLE_OVERRIDE_NOTE =
  "The environment-safety override could not be read from the database, so " +
  "this installation cannot be confirmed as production: an administrator may " +
  "already have forced it to behave as non-production and there is no way to " +
  "tell from here. Apply the pending migrations (prisma migrate deploy) or " +
  "restore database access, then check again.";

/**
 * The precedence rule, as a pure function of the two sources, so the twelve
 * combinations can be asserted without a database
 * (`environment-role-precedence.test.ts`).
 *
 * THE BRANCH ORDER, AND EXACTLY WHICH PART OF IT IS LOAD-BEARING. Stated
 * precisely because the previous wording said the whole order was the invariant,
 * which overstates it — and a docblock a future editor checks and finds wrong is
 * a docblock they then reorder past (#3034 review).
 *
 * 1. A declared `non-production` is final, and BRANCH 1 MUST COME FIRST. It is
 *    already the safest answer, so no database state and no database FAILURE can
 *    move it — and in particular the override cannot elevate it, because the
 *    override has no elevating direction to move it in. Put branch 2 or 3 above
 *    it and a database blip turns a declared copy into UNKNOWN.
 * 2. Otherwise an unreadable override is UNKNOWN, even under a declared
 *    `production`. See the module docblock: we cannot rule out an operator
 *    having forced this instance safer.
 * 3. Otherwise the override, if on, forces NON_PRODUCTION.
 *
 *    BRANCHES 2 AND 3 ARE INTERCHANGEABLE, and saying so is the honest version:
 *    they test disjoint values of the same `kind`, so swapping them changes no
 *    answer. What matters is only that both sit above branch 4.
 * 4. Otherwise the declaration decides: `production` gives PRODUCTION (4a);
 *    `absent` and `invalid` give UNKNOWN (4b). BRANCH 3 MUST COME BEFORE 4a —
 *    that pair is the whole "the database can force safer" rule, and swapping
 *    them makes a declared production ignore an override an administrator has
 *    deliberately switched on. `absent` and `invalid` never become PRODUCTION,
 *    and they stay distinguishable so the operator surface can tell "you have
 *    not set it" from "you set it to something I refuse to interpret".
 */
export function decideEnvironmentRole(
  declaration: EnvironmentRoleDeclaration,
  databaseOverride: EnvironmentRoleDatabaseOverride,
): EnvironmentRoleResolution {
  const base = { declaration, databaseOverride };

  // 1. Declared non-production — already the safest answer.
  if (declaration.kind === "non-production") {
    return {
      ...base,
      role: "NON_PRODUCTION",
      decidedBy: "deployment-declaration",
      notes: [
        "This deployment declares APP_ENVIRONMENT_ROLE=non-production, so it is treated as non-production.",
        ...(databaseOverride.kind === "unreadable"
          ? [
              "The database safer override could not be read, which changes nothing here: it can only force this installation towards non-production, which is where the declaration has already put it.",
            ]
          : []),
        ...(databaseOverride.kind === "force-non-production"
          ? [
              "An administrator has also switched the safer override on. That is redundant while the declaration says non-production, and harmless.",
            ]
          : []),
      ],
    };
  }

  // 2. The override could not be read — fail closed.
  if (databaseOverride.kind === "unreadable") {
    return {
      ...base,
      role: "UNKNOWN",
      decidedBy: "unresolved",
      notes: [
        declaration.kind === "production"
          ? "This deployment declares APP_ENVIRONMENT_ROLE=production."
          : declaration.kind === "invalid"
            ? `APP_ENVIRONMENT_ROLE is set to "${declaration.raw}", which is not one of the two accepted values.`
            : "APP_ENVIRONMENT_ROLE is not set in this deployment's environment.",
        UNREADABLE_OVERRIDE_NOTE,
      ],
    };
  }

  // 3. The safer override is on.
  if (databaseOverride.kind === "force-non-production") {
    return {
      ...base,
      role: "NON_PRODUCTION",
      decidedBy: "database-safer-override",
      notes: [
        declaration.kind === "production"
          ? "This deployment declares APP_ENVIRONMENT_ROLE=production, but an administrator has switched the safer override on, so it is treated as non-production. Switching the override off restores production behaviour."
          : declaration.kind === "invalid"
            ? `APP_ENVIRONMENT_ROLE is set to "${declaration.raw}", which is not one of the two accepted values — but an administrator has switched the safer override on, so this installation is treated as non-production.`
            : "APP_ENVIRONMENT_ROLE is not set, but an administrator has switched the safer override on, so this installation is treated as non-production.",
        "The override can only force the safer state. Switching it off does not make an installation production — it hands the decision back to the deployment declaration.",
      ],
    };
  }

  // 4a. Declared production, no override.
  if (declaration.kind === "production") {
    return {
      ...base,
      role: "PRODUCTION",
      decidedBy: "deployment-declaration",
      notes: [
        "This deployment declares APP_ENVIRONMENT_ROLE=production and no safer override is switched on, so it behaves as the club's live installation.",
      ],
    };
  }

  // 4b. Nothing usable said anything.
  return {
    ...base,
    role: "UNKNOWN",
    decidedBy: "unresolved",
    notes: [
      declaration.kind === "invalid"
        ? `APP_ENVIRONMENT_ROLE is set to "${declaration.raw}", which is not one of the two accepted values (production, non-production). It is refused rather than guessed at, because guessing is how a typo becomes "production".`
        : "APP_ENVIRONMENT_ROLE is not set in this deployment's environment, and no safer override is switched on.",
      "Nothing has said which installation this is, so it is treated as neither production nor confirmed non-production. Anything whose safety depends on knowing — sending email to members, writing to the club's real accounting — does not run until it is declared.",
      DECLARE_IT_NOTE,
    ],
  };
}

/**
 * The effective role plus the sanitized state of both sources.
 *
 * The database is read on EVERY path, including the declared-`non-production`
 * one where it cannot change the answer, so an operator surface can always
 * report whether the override is on. See {@link decideEnvironmentRole} for why a
 * failed read on that one path changes nothing.
 */
export async function resolveEnvironmentRole(): Promise<EnvironmentRoleResolution> {
  const declaration = readEnvironmentRoleDeclaration();
  const databaseOverride = await readEnvironmentRoleDatabaseOverride();
  return decideEnvironmentRole(declaration, databaseOverride);
}

/**
 * The effective role alone, for the callers that only need to branch on it
 * (#3035's delivery boundary, #3036's Xero containment).
 *
 * There is deliberately no `isProduction()` / `isStaging()` convenience helper.
 * A boolean cannot express UNKNOWN, so every such helper forces a caller to
 * collapse it into one of the other two — and whichever it picks is a silent
 * policy decision made at the call site instead of here.
 */
export async function getEnvironmentRole(): Promise<EnvironmentRole> {
  return (await resolveEnvironmentRole()).role;
}
