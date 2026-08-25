import "server-only";

/**
 * What the environment-safety maintenance surface is TOLD (ENV-SAFETY 1, #3034;
 * epic #2986) — the payload `/api/admin/environment-safety` returns on both
 * verbs, and the readers that build it.
 *
 * It is a module rather than part of the route because `src/app` validates and
 * authorises at the boundary and delegates the rest to `src/lib`
 * (`docs/ARCHITECTURE.md` -> "Where code lives"), and because the route's own
 * 250-line budget is spent on the authorisation, confirmation, audit and
 * isolation reasoning that is genuinely about the WRITE. This half has one
 * question of its own: what may travel to a browser.
 *
 * `server-only` HERE and not on `environment-role.ts`, which is the split worth
 * understanding rather than copying blindly. The resolver has to stay importable
 * from the `tsx` `npm run setup` entrypoint (through `setup-readiness-db.ts`), so
 * it cannot carry `server-only`. This module has no such caller — it exists to
 * build a browser payload — so it takes the compiler-enforced guarantee, and the
 * panel that consumes the payload declares the same types itself rather than
 * importing them from here.
 *
 * WHAT IS DELIBERATELY NOT ON THE PAYLOAD: the changer's email (see
 * `MEMBER_NAME_SELECT`), the raw environment beyond the one refused value the
 * operator has to see to fix their own typo, and anything about the database
 * connection. This screen answers "which installation is this?" and nothing on
 * it needs a credential to do so.
 */

import {
  ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE,
  loadPersistedEnvironmentSafetySettings,
  type EnvironmentRole,
  type EnvironmentRoleDecidedBy,
  type EnvironmentRoleResolution,
  type PersistedEnvironmentSafetySettings,
} from "@/lib/environment-role";
import {
  readWithheldApplicationEmail,
  type WithheldApplicationEmail,
} from "@/lib/environment-safety-withheld";
import { prisma } from "@/lib/prisma";
import {
  readXeroContactContainment,
  type XeroContactContainment,
} from "@/lib/xero-contact-containment-status";

/**
 * Name fields ONLY. The panel says WHO last changed the override, so it needs a
 * display name and nothing else — selecting the email, or the whole row, would
 * put a contact address into a configuration payload with no use for one.
 */
const MEMBER_NAME_SELECT = {
  firstName: true,
  lastName: true,
} as const;

/**
 * The flattened declaration. `raw` is non-null for exactly one state —
 * `invalid` — and it has already been stripped of control characters and capped
 * by `sanitizeEnvironmentRoleRawValue`, which is what makes it safe to render.
 * The panel has to NAME the refused value, because "that is not an accepted
 * value" is unactionable without saying what was read.
 */
export type EnvironmentSafetyDeclarationState = {
  kind: "production" | "non-production" | "absent" | "invalid";
  raw: string | null;
};

export type EnvironmentSafetyOverrideState = {
  /** Whether the safer override is forcing non-production right now. */
  on: boolean;
  /**
   * False when the row could not be read at all. Distinct from `on: false` on
   * purpose: "the override is off" and "we could not ask" have opposite safety
   * consequences, and the panel has to give different instructions for each.
   */
  readable: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

export type EnvironmentSafetyState = {
  role: EnvironmentRole;
  decidedBy: EnvironmentRoleDecidedBy;
  declaration: EnvironmentSafetyDeclarationState;
  override: EnvironmentSafetyOverrideState;
  /**
   * How much application email this installation has held back for
   * environment-safety reasons, and when the most recent was — the one signal
   * that separates "a live club wrongly declared a copy" from "a copy nobody is
   * using", because no property of the DATA can (see
   * `environment-safety-withheld.ts`). It is on the payload for every role, and
   * the panel gives it prominence only where it means something: on a
   * NON_PRODUCTION installation.
   *
   * `{ available: false }` today for every installation. #3035 creates the rows.
   */
  withheldEmail: WithheldApplicationEmail;
  /**
   * How much of the club's Xero accounting this installation has contained
   * (ENV-SAFETY 3, #3036; INV-CONFIG-005).
   *
   * On the payload for every role, and the panel gives it prominence only where
   * it means something. Two numbers rather than one: how many contacts are
   * proved unable to reach a member, and how many of those had a DELIVERABLE
   * address that this installation overwrote — the second is the one that says a
   * copy has been editing the club's real books. No address of any kind travels;
   * see `xero-contact-containment-status.ts`.
   */
  xeroContactContainment: XeroContactContainment;
  /** The resolver's own operator-facing lines, rendered verbatim. */
  notes: string[];
};

/**
 * The display name of the member who last saved, or `null`. Defensive because
 * the column carries no foreign key (the house shape for a settings singleton),
 * so the member may since have been merged or deleted: a missing member, a blank
 * name and an unreachable database all mean "we cannot name them", never a
 * failed read of the setting.
 */
async function readChangedByName(
  memberId: string | null,
): Promise<string | null> {
  if (!memberId) return null;
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: MEMBER_NAME_SELECT,
    });
    if (!member) return null;
    return `${member.firstName} ${member.lastName}`.trim() || null;
  } catch {
    return null;
  }
}

function declarationState(
  resolution: EnvironmentRoleResolution,
): EnvironmentSafetyDeclarationState {
  const { declaration } = resolution;
  return {
    kind: declaration.kind,
    raw: declaration.kind === "invalid" ? declaration.raw : null,
  };
}

/**
 * The override half of the payload.
 *
 * `on` AND `readable` COME FROM THE RESOLUTION, NEVER FROM `row`, and that is the
 * fix for a real defect rather than a tidy-up (#3034 review). This module reads
 * the settings row a SECOND time (see {@link stateFromResolution}) and the first
 * version built `on` / `readable` from that second read while `role` and
 * `decidedBy` came from the first. An administrator flipping the override between
 * the two reads produced a payload the panel rendered as "Production — the club's
 * live site" beside "Safer override: ON". The unreadable case was shaped worse: a
 * transient failure on read one and a success on read two gave `role: UNKNOWN`
 * with `override.readable: true`, so the panel dropped its "the setting cannot be
 * read, so it cannot be changed" hint while the notes still said it could not be
 * read — and the Save button came back for a write the resolver had already
 * refused to trust.
 *
 * `resolution.databaseOverride.kind` carries `force-non-production` / `none` /
 * `unreadable` authoritatively, and it is the SAME read every safety decision in
 * the platform is made from, so deriving from it is what makes this payload one
 * coherent answer — which is what the issue asks for: "the effective state plus
 * sanitized source state from ONE canonical resolver".
 * `src/lib/setup-readiness.ts` already does it this way.
 *
 * The second read is used for the DISPLAY fields only — `updatedAt` and
 * `updatedByName`, which the resolver deliberately omits when the override is
 * off. Those cannot contradict anything: they answer "who last touched this",
 * not "what is it now". When the resolution says the row is unreadable they are
 * suppressed, because naming who last changed a setting we have just said we
 * cannot read would be the same contradiction one field further along.
 */
async function overrideStateFrom(
  resolution: EnvironmentRoleResolution,
  row:
    | PersistedEnvironmentSafetySettings
    | null
    | typeof ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE,
): Promise<EnvironmentSafetyOverrideState> {
  if (resolution.databaseOverride.kind === "unreadable") {
    return { on: false, readable: false, updatedAt: null, updatedByName: null };
  }

  const stored = row === ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE ? null : row;
  return {
    on: resolution.databaseOverride.kind === "force-non-production",
    readable: true,
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
    updatedByName: stored ? await readChangedByName(stored.updatedByMemberId) : null,
  };
}

/**
 * The three payload sections that read the database, in parallel.
 *
 * They share no state and neither ordering nor a transaction: the override
 * projection, the withheld-email count and the Xero-containment summary answer
 * three independent questions, and awaiting them one after another made an
 * administrator's page load wait for the sum of three round trips rather than the
 * longest of them. Both builders below compose the same three, so the shape is
 * spelled once — a second copy is how one of them comes to be missing a section
 * the panel reads (#2989 is the precedent this repository already has for that).
 */
async function independentPayloadReads(
  resolution: EnvironmentRoleResolution,
  row:
    | PersistedEnvironmentSafetySettings
    | null
    | typeof ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE,
) {
  const [override, withheldEmail, xeroContactContainment] = await Promise.all([
    overrideStateFrom(resolution, row),
    readWithheldApplicationEmail(),
    readXeroContactContainment(),
  ]);
  return { override, withheldEmail, xeroContactContainment };
}

/**
 * The state a READ produces.
 *
 * IT READS THE ROW A SECOND TIME, on purpose, AND FOR ONE NARROW PURPOSE.
 * `resolveEnvironmentRole()` exposes `updatedAt` / `updatedByMemberId` only for an
 * override that is ON, because that is all the RESOLUTION needs — and widening its
 * type so a settings screen could show "switched off on 15 June by Ada" would put
 * a display concern into the module every safety decision in the platform goes
 * through. One extra primary-key read of a one-row table, on an administrator's
 * page load, is the cheaper side of that trade.
 *
 * WHAT THE SECOND READ MAY DECIDE IS THEREFORE LIMITED TO THOSE TWO DISPLAY
 * FIELDS. `on` and `readable` come from the resolution — see
 * {@link overrideStateFrom} for the payload this contradicted itself in when they
 * did not.
 */
export async function stateFromResolution(
  resolution: EnvironmentRoleResolution,
): Promise<EnvironmentSafetyState> {
  const row = await loadPersistedEnvironmentSafetySettings();
  return {
    role: resolution.role,
    decidedBy: resolution.decidedBy,
    declaration: declarationState(resolution),
    ...(await independentPayloadReads(resolution, row)),
    notes: resolution.notes,
  };
}

/**
 * The state a WRITE produces: the resolution recomputed from the row this
 * request just wrote, rather than re-read from the database.
 *
 * `row` may be `null`, and that is not a write that failed. It is the dirty
 * gate refusing a no-op: saving "override off" against an installation that has
 * no row is already the stored answer, so nothing is written and there is no row
 * to describe. The payload then says exactly what a read would — override off,
 * readable, never changed.
 *
 * Recomputing rather than re-reading is what makes the response describe the
 * write that just happened. A fresh `resolveEnvironmentRole()` here could pick
 * up a concurrent administrator's change and report it as this request's result.
 */
export async function stateFromWrittenRow(
  resolution: EnvironmentRoleResolution,
  row: PersistedEnvironmentSafetySettings | null,
): Promise<EnvironmentSafetyState> {
  return {
    role: resolution.role,
    decidedBy: resolution.decidedBy,
    declaration: declarationState(resolution),
    ...(await independentPayloadReads(resolution, row)),
    notes: resolution.notes,
  };
}
