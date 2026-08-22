import type { AgeTier } from "@prisma/client";
import {
  CLUB_TIME_SETTINGS_ID,
  normaliseClubTimeZone,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import { EMAIL_MESSAGE_SETTINGS_ID } from "@/lib/email-message-settings";
import { prisma } from "@/lib/prisma";

/**
 * DB write path for the setup wizard (`scripts/setup.ts runWizard`, C8 #1987).
 *
 * Under the DB-first configuration model (epic #1943) the club's configuration
 * lives in the database, not in `config/club.json`. The interactive wizard used
 * to write that file; it now writes the same settings rows the admin editors
 * write, reusing their field mappings and create-only/tier-keyed upsert shapes:
 *
 *  - identity name / short name       -> ClubIdentitySettings (id="default")
 *    (mirrors src/app/api/admin/club-identity/route.ts + prisma/seed.ts)
 *  - club/booking name, from-name,    -> EmailMessageSetting (id="default")
 *    support/contact email, publicUrl    (mirrors src/app/api/admin/email-settings/route.ts)
 *  - total bunk/bed capacity          -> LodgeSettings (id="default").capacity
 *    (mirrors the admin capacity editor's LodgeSettings write)
 *  - club timezone (IANA identifier)  -> ClubTimeSettings (id="default")
 *    (CT-1 #2989; mirrors the Full-Admin maintenance surface's write, validated
 *    through the same `normaliseClubTimeZone`, so the wizard can never persist a
 *    value that surface would reject)
 *  - age tiers (label/ages/subscription) -> AgeTierSetting, keyed by the unique
 *    `tier` enum (mirrors src/app/api/admin/age-tier-settings/route.ts and the
 *    seed's create-if-missing loop). Per-tier nightly RATES are NOT stored here
 *    — they live in the seasons/rates tables and are configured at /admin/seasons.
 *
 * The wizard runs as a CLI with no admin session, so `updatedByMemberId` is set
 * to null on the writes it owns (every such column is nullable). Writes are
 * idempotent upserts, so a re-run is safe. This module deliberately does NOT
 * import "server-only" (unlike club-identity-settings.ts) so the tsx CLI can
 * import it, and it takes the Prisma client as a parameter so the write logic is
 * unit-testable with a mocked client (no interactive readline involved).
 */

const CLUB_IDENTITY_SETTINGS_ID = "default";
const LODGE_SETTINGS_ID = "default";

/**
 * Upper bound on lodge capacity, mirroring the admin lodge-settings editor
 * (`z.number().int().positive().max(100000)` in
 * src/app/api/admin/lodge-settings/route.ts). The wizard must never persist a
 * capacity the admin editor would reject, so this bound is enforced on the write
 * path (and surfaced earlier at the capacity prompt in scripts/setup.ts).
 */
export const MAX_LODGE_CAPACITY = 100000;

export interface WizardAgeTier {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
}

export interface WizardConfigValues {
  name: string;
  shortName: string | null;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
  emailFromName: string;
  capacity: number;
  /**
   * The club's civil timezone as a named IANA identifier (CT-1, #2989) — the
   * SOLE authority for what day and time it is for booking purposes, and a
   * different thing entirely from the server's or container's `TZ`. Rejected on
   * the write path unless `normaliseClubTimeZone` accepts it, so setup cannot
   * finish with an empty or invalid zone.
   */
  timeZone: string;
  ageTiers: WizardAgeTier[];
}

/** Minimal upsert/read delegate shape for one Prisma model. */
interface WizardDelegate {
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    // Optional projection narrowing the implicit RETURNING (#2130 runtime-prep).
    select?: Record<string, boolean>;
  }): Promise<unknown>;
  findUnique(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
  findMany(args?: {
    orderBy?: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown>[]>;
}

/**
 * The subset of the Prisma client the wizard write path uses. The real client
 * satisfies this structurally; tests pass a mock exposing just these delegates.
 * `$transaction` is the batch (array) form used to write all age tiers
 * atomically — mirroring the admin age-tier route (route.ts) and the #1983
 * atomic-heal precedent.
 */
export interface WizardDbClient {
  clubIdentitySettings: WizardDelegate;
  emailMessageSetting: WizardDelegate;
  lodgeSettings: WizardDelegate;
  ageTierSetting: WizardDelegate;
  clubTimeSettings: WizardDelegate;
  $transaction(operations: Promise<unknown>[]): Promise<unknown[]>;
}

/** Default to the shared Prisma singleton for the real CLI run. */
function defaultDb(): WizardDbClient {
  return prisma as unknown as WizardDbClient;
}

/**
 * The current DB values behind each wizard prompt, used to pre-fill prompt
 * defaults on the overwrite path so an operator who accepts the defaults
 * PRESERVES prior admin edits instead of reverting them to config-file values.
 * Every field is nullable: a cold install (empty DB) leaves them null and the
 * wizard falls back to config/SAFE_DEFAULT defaults.
 */
export interface WizardCurrentAgeTier {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
}

export interface WizardCurrentValues {
  name: string | null;
  shortName: string | null;
  supportEmail: string | null;
  contactEmail: string | null;
  publicUrl: string | null;
  emailFromName: string | null;
  capacity: number | null;
  /**
   * The exception to the all-nullable rule above (CT-1, #2989): there is ALWAYS
   * an effective club timezone, so this is never null. When `ClubTimeSettings`
   * holds a valid zone that is it; otherwise it is what the deployment is
   * effectively using right now — the validated `TZ` / `NEXT_PUBLIC_TZ` seed, or
   * `Pacific/Auckland` when the environment says nothing. Prompting from a null
   * would risk the wizard offering an empty default for a NON-NULL column.
   */
  timeZone: string;
  ageTiers: WizardCurrentAgeTier[];
}

export interface WizardConfigState {
  hasClubIdentity: boolean;
  hasEmailSettings: boolean;
  hasLodgeCapacity: boolean;
  ageTierCount: number;
  existingClubName: string | null;
  /** Current DB values, for sourcing prompt defaults on the overwrite path. */
  current: WizardCurrentValues;
}

function trimOptional(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function toAgeTier(value: unknown): AgeTier | null {
  return typeof value === "string" ? (value as AgeTier) : null;
}

/**
 * Read the current DB configuration state used to gate the wizard's
 * overwrite confirmation AND to source prompt defaults on the overwrite path.
 * Deliberately does NOT swallow errors: the CLI treats a thrown error
 * (unreachable DB / un-migrated schema) as "cannot reach the database" and
 * prints post-deploy /admin/setup guidance instead of writing.
 */
export async function readWizardConfigState(
  db: WizardDbClient = defaultDb(),
): Promise<WizardConfigState> {
  const [identity, email, lodge, ageTierRows, clubTime] = await Promise.all([
    db.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { name: true, shortName: true },
    }),
    db.emailMessageSetting.findUnique({
      where: { id: EMAIL_MESSAGE_SETTINGS_ID },
      select: {
        clubName: true,
        supportEmail: true,
        contactEmail: true,
        publicUrl: true,
        emailFromName: true,
      },
    }),
    db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
      select: { capacity: true },
    }),
    db.ageTierSetting.findMany({
      orderBy: { sortOrder: "asc" },
      select: {
        tier: true,
        minAge: true,
        maxAge: true,
        label: true,
        subscriptionRequiredForBooking: true,
      },
    }),
    // CT-1 (#2989). Read like every sibling — NOT swallowed: an unreachable DB
    // or an un-migrated schema must reach the CLI as "cannot reach the database"
    // (see this function's docblock), not be quietly reported as "no timezone
    // configured", which would make the wizard offer the environment's zone as
    // the default while the club's real answer sat unread in a table it could
    // not open.
    db.clubTimeSettings.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: { timeZone: true },
    }),
  ]);

  const currentAgeTiers: WizardCurrentAgeTier[] = ageTierRows.flatMap((row) => {
    const tier = toAgeTier(row.tier);
    if (!tier) return [];
    return [
      {
        tier,
        minAge: typeof row.minAge === "number" ? row.minAge : 0,
        maxAge: typeof row.maxAge === "number" ? row.maxAge : null,
        label: typeof row.label === "string" ? row.label : "",
        subscriptionRequiredForBooking: Boolean(row.subscriptionRequiredForBooking),
      },
    ];
  });

  const capacity =
    typeof lodge?.capacity === "number" ? lodge.capacity : null;

  // The current EFFECTIVE club timezone, offered as the prompt's default: the
  // persisted row wins, and only when it is absent (or somehow unusable) does the
  // environment answer, with the documented New Zealand default as the last
  // resort.
  //
  // That is `resolveClubTimeZone` — the canonical rule — and it is CALLED rather
  // than restated here (#2989 fix round). This used to hand-roll the same three
  // steps, which was behaviourally identical the day it was written and is
  // exactly how two descriptions of one rule come to disagree; the file already
  // pays that lesson's price twice over in the comments above.
  //
  // What the shared rule buys, spelled out because it is easy to lose: its
  // environment leg goes through the PRESERVATION normaliser, so a deployment
  // running on `TZ=GB` has kept Europe/London time for years and Europe/London is
  // what the operator is offered. Offering Pacific/Auckland — which is what
  // running the operator-input validator over `GB` produces — would move the club
  // the moment they pressed Enter on a default they had every reason to trust.
  // Where the environment names no place at all (`TZ=UTC`) there is nothing to
  // preserve, so the documented default is offered and the operator is the one
  // who confirms it. That is not the silent substitution the backfill had to
  // avoid: here the value is on screen and a person is answering for it.
  //
  // Note the ROW's existence is deliberately NOT folded into the
  // "already configured" flags below: the boot-time backfill
  // (`clubTimeZoneSelfHealStep`) creates that row unprompted on the very first
  // boot of an empty install, so treating it as configuration would make a
  // genuinely fresh database announce "the database already holds club
  // configuration" and demand an overwrite confirmation.
  const timeZone = resolveClubTimeZone(
    typeof clubTime?.timeZone === "string" ? clubTime.timeZone : null,
    readEnvironmentClubTimeZoneSeed(),
  );

  return {
    hasClubIdentity: Boolean(trimOptional(identity?.name)),
    hasEmailSettings: Boolean(
      email && (trimOptional(email.clubName) || trimOptional(email.supportEmail)),
    ),
    hasLodgeCapacity: capacity !== null,
    ageTierCount: ageTierRows.length,
    existingClubName:
      trimOptional(identity?.name) ?? trimOptional(email?.clubName),
    current: {
      name: trimOptional(identity?.name) ?? trimOptional(email?.clubName),
      shortName: trimOptional(identity?.shortName),
      supportEmail: trimOptional(email?.supportEmail),
      contactEmail: trimOptional(email?.contactEmail),
      publicUrl: trimOptional(email?.publicUrl),
      emailFromName: trimOptional(email?.emailFromName),
      capacity,
      timeZone,
      ageTiers: currentAgeTiers,
    },
  };
}

/**
 * Write the wizard-collected values to the DB settings rows. Idempotent
 * upserts, applied in the same field mapping the admin editors use. Existing
 * ClubIdentitySettings fields the wizard does not collect (hutLeaderLabel,
 * facebookUrl) are intentionally left untouched.
 */
export async function applyWizardConfigToDatabase(
  values: WizardConfigValues,
  db: WizardDbClient = defaultDb(),
): Promise<void> {
  // Never persist a capacity the admin lodge-settings editor would reject
  // (positive, <= MAX_LODGE_CAPACITY). This is the last-resort write-path guard;
  // the capacity prompt rejects out-of-range input earlier.
  if (
    !Number.isInteger(values.capacity) ||
    values.capacity <= 0 ||
    values.capacity > MAX_LODGE_CAPACITY
  ) {
    throw new Error(
      `capacity must be a positive integer no greater than ${MAX_LODGE_CAPACITY}`,
    );
  }

  // Never persist a club timezone the Full-Admin maintenance surface would
  // reject, and never persist an empty one — `ClubTimeSettings.timeZone` is NOT
  // NULL and the whole point of asking is that the answer is explicit. Checked
  // BEFORE any write, like the capacity guard above, so a bad answer leaves the
  // database exactly as it was rather than half-applied. The prompt in
  // scripts/setup.ts rejects a bad answer earlier; this is the last resort.
  const timeZone = normaliseClubTimeZone(values.timeZone);
  if (!timeZone) {
    throw new Error(
      `timeZone must be a named IANA timezone such as Pacific/Auckland or ` +
        `Australia/Sydney. Abbreviations (NZT, NZST, EST) and fixed offsets ` +
        `(+12:00, UTC+12, Etc/GMT-12) are not accepted: they name no place, so ` +
        `they carry no daylight-saving rules for the club's future bookings.`,
    );
  }

  await db.clubIdentitySettings.upsert({
    where: { id: CLUB_IDENTITY_SETTINGS_ID },
    update: {
      name: values.name,
      shortName: values.shortName,
      updatedByMemberId: null,
    },
    create: {
      id: CLUB_IDENTITY_SETTINGS_ID,
      name: values.name,
      shortName: values.shortName,
      updatedByMemberId: null,
    },
  });

  // The wizard collects every field below EXCEPT bookingsName, which it derives
  // from the club name. Setting a derived value on UPDATE would clobber an
  // admin-customized bookingsName the wizard never collected, so it is written
  // on CREATE only and omitted from the update clause (W2a).
  const emailUpdate = {
    clubName: values.name,
    emailFromName: values.emailFromName,
    supportEmail: values.supportEmail,
    contactEmail: values.contactEmail,
    publicUrl: values.publicUrl,
    updatedByMemberId: null,
  };
  await db.emailMessageSetting.upsert({
    where: { id: EMAIL_MESSAGE_SETTINGS_ID },
    update: emailUpdate,
    create: {
      id: EMAIL_MESSAGE_SETTINGS_ID,
      ...emailUpdate,
      bookingsName: `${values.name} - Bookings`,
    },
  });

  await db.lodgeSettings.upsert({
    where: { id: LODGE_SETTINGS_ID },
    update: { capacity: values.capacity, updatedByMemberId: null },
    create: {
      id: LODGE_SETTINGS_ID,
      capacity: values.capacity,
      updatedByMemberId: null,
    },
  });

  // Club timezone (CT-1, #2989). This upsert DOES update an existing row, unlike
  // the create-only age-tier and bookingsName writes above and unlike the
  // boot-time backfill: the operator was just asked this question outright and
  // gave an answer, so their answer wins over whatever an earlier boot copied out
  // of the environment. The value written is the NORMALISED identifier, so the
  // canonical spelling is stored however the operator typed it. Rewriting it
  // changes no historical timestamp and no date-only value — it changes only how
  // civil time is computed from here on.
  await db.clubTimeSettings.upsert({
    where: { id: CLUB_TIME_SETTINGS_ID },
    update: { timeZone, updatedByMemberId: null },
    create: {
      id: CLUB_TIME_SETTINGS_ID,
      timeZone,
      updatedByMemberId: null,
    },
    select: { id: true },
  });

  // Write all age tiers atomically. A mid-loop failure in the old sequential
  // loop left 1-3 arbitrary rows, which normalizeAgeTierSettings returns AS-IS
  // (only an empty set or the legacy-3 shape fall back to defaults) -> wrong
  // age classification and subscription gating until re-run. The batch
  // $transaction rolls all four back on any failure, mirroring the admin
  // age-tier route (W1).
  await db.$transaction(
    values.ageTiers.map((tier) =>
      db.ageTierSetting.upsert({
        where: { tier: tier.tier },
        update: {
          minAge: tier.minAge,
          maxAge: tier.maxAge,
          label: tier.label,
          subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
          // familyGroupRequestCreateMemberAllowed is never collected by the
          // wizard and is not carried in the DB-sourced defaults, so it is
          // create-only — an admin customization survives an overwrite (same
          // never-overwrite treatment as bookingsName).
          sortOrder: tier.sortOrder,
        },
        create: {
          tier: tier.tier,
          minAge: tier.minAge,
          maxAge: tier.maxAge,
          label: tier.label,
          subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
          familyGroupRequestCreateMemberAllowed:
            tier.familyGroupRequestCreateMemberAllowed,
          sortOrder: tier.sortOrder,
        },
        // Blue/green runtime-prep (#2130): narrow the implicit RETURNING. This
        // stopped the wizard write naming the legacy xeroContactGroupId/Name
        // columns before the STEP 2 contract migration dropped them; keep it
        // narrow regardless. The $transaction result is discarded.
        select: { tier: true },
      }),
    ),
  );
}
