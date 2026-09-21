/**
 * The club-format self-heal step DEFINITION (stage 1 of programme #3205,
 * #3563; INV-CONFIG-006).
 *
 * WHY IT IS ITS OWN MODULE rather than a sixth definition in
 * `config-self-heal-steps.ts`, which is where the other five live. The same
 * reason that file exists at all: the file-size ratchet in
 * `scripts/lib/file-size-base.ts` would not let it grow further, and it has a
 * natural seam. Here the seam is the one `config-self-heal.ts` already names —
 * a step whose value comes from the ENVIRONMENT rather than from
 * `config/club.json`, and which therefore declares
 * `requiresPrimaryClubConfig: false`. `clubTimeZoneSelfHealStepDefinition` is
 * the other one and stays where it is, because moving a definition breaks
 * every doc reference and every disk-scanning census that names its path for
 * no gain the ratchet asked for.
 *
 * READ `config-self-heal.ts`'s module doc FIRST. It states the guarantees this
 * definition has to satisfy — create-if-absent only, idempotent,
 * blue/green-safe, best-effort — and the three presence/write GRAIN shapes.
 * This step is shape 1: a new table with a fixed-id singleton row, checked and
 * written at ROW level.
 *
 * Like `config-self-heal-steps.ts`, this module stays free of `server-only`: it
 * is not an `INV-OPS-013` root, it reads no environment of its own, and a
 * marker here would protect nothing that its marked callee
 * `club-format-env.ts` does not already protect.
 */

import {
  CLUB_FORMAT_SETTINGS_ID,
  type ClubFormat,
} from "@/lib/club-format";
import {
  decideClubFormatBackfill,
  type ClubFormatFieldBackfill,
} from "@/lib/club-format-env";
import type { ConfigSelfHealStep } from "@/lib/config-self-heal";
import logger from "@/lib/logger";

/**
 * Club-format step (stage 1 of programme #3205, #3563; INV-CONFIG-006).
 * Persists the currency and locale this deployment is ALREADY effectively
 * using, once, so that an upgrade re-denominates nobody.
 *
 * ## Why this cannot be a migration or a seed
 * A production upgrade runs `prisma migrate deploy` and nothing else: the seed
 * does not run, and SQL cannot read `process.env.CURRENCY`. Before this change
 * the club's currency and locale WERE `CURRENCY` / `LOCALE` (via `APP_CURRENCY`
 * and `APP_LOCALE` in `src/config/operational.ts`), so the only place that can
 * copy an existing deployment's current effective values into the new
 * `ClubFormatSettings` row is a boot-time backfill. That is why the
 * 20261005010000 migration deliberately creates the table with NO row and
 * neither column with a `@default`: the row's existence is the "this club has
 * configured its format" signal, and inventing `'NZD'` in SQL would silently
 * re-denominate a club that has been running on, say, `CHF`.
 *
 * ## Grain: shape 1 (new table / fixed-id singleton -> ROW-LEVEL)
 * `isPresent` asks whether the ROW exists; `write` is a single create-if-absent
 * upsert (`update: {}`). One row, one write, nothing can be half-written, and
 * an existing row — whether written by the Full-Admin surface or by an earlier
 * boot — is NEVER touched. That is what makes `CURRENCY` seed-only: once the
 * row exists, editing the container's environment cannot move the club's money
 * (owner decision D3 on #3205).
 *
 * ## Why it opts OUT of the primary-config fallback guard
 * `requiresPrimaryClubConfig: false`, on the same two counts
 * `clubTimeZoneSelfHealStepDefinition` above records. The guard exists to stop
 * a placeholder from `club.example.json` or `SAFE_DEFAULT_CONFIG` freezing into
 * a DB-first row, and this step reads neither file — its source is the
 * ENVIRONMENT, whose value is equally true (or equally absent) whatever state
 * `config/club.json` is in. And gating it would break the very installs it
 * exists for: since #1987 an absent `config/club.json` is NORMAL, so provenance
 * is routinely not `"primary"` on a perfectly healthy install, and those
 * installs would never be backfilled at all.
 *
 * This is the SECOND step to take that exemption, and the exemption test in
 * `config-self-heal.test.ts` is pinned NEGATIVELY — it names every exempt step
 * — precisely so a third one cannot arrive by copy-paste without somebody
 * justifying it. Widening that list is the conscious act it is designed to
 * force, not a formality.
 *
 * ## The value, and why a per-FIELD decision
 * {@link decideClubFormatBackfill} judges the currency and the locale
 * separately, because a deployment can easily have a good `CURRENCY` and an
 * unset `LOCALE` (or the reverse), and a row-level decision would hand such an
 * install the default for the half it had configured. The environment is read
 * at heal time, never captured at import, so the value cannot go stale on a
 * long-running image. `updatedByMemberId` is null because a boot has no actor.
 *
 * ## When the environment names nothing usable, this step records the default AND WARNS
 * `CURRENCY=dollars` or `LOCALE=English` is a real misconfiguration. Recording
 * nothing and leaving the row absent would leave the club resolving from the
 * same unusable environment forever; recording the default silently would hand
 * a club a currency it does not charge in with nothing to lead anyone to the
 * cause. So it records the default and logs a warning naming both the raw
 * environment value and what was written in its place — the treatment the
 * owner settled on for the timezone's identical case on 23 Aug 2026 (#2989).
 *
 * The warning is emitted from `currentValue`, which the runner calls ONLY on
 * the boot that actually writes the row (`heal` = `write(db, currentValue())`).
 * So a club that has already chosen its currency never sees it — `isPresent`
 * answers true from the row before the environment is even classified, which is
 * what makes a warning here mean "this value was just invented", never "your
 * configuration is wrong".
 */
export const clubFormatSelfHealStepDefinition: ConfigSelfHealStep<ClubFormat> = {
  name: "club-format",
  requiresPrimaryClubConfig: false,
  async isPresent(db) {
    const row = await db.clubFormatSettings.findUnique({
      where: { id: CLUB_FORMAT_SETTINGS_ID },
      select: { id: true },
    });
    // The club's own choice, whatever the environment says. Nothing else is
    // consulted, so a configured club is never warned at.
    return row !== null;
  },
  currentValue() {
    const decision = decideClubFormatBackfill();
    reportClubFormatBackfillField(
      "currency",
      decision.currency,
      "CURRENCY / NEXT_PUBLIC_CURRENCY",
      "a three-letter ISO 4217 code such as NZD or CHF",
    );
    reportClubFormatBackfillField(
      "locale",
      decision.locale,
      "LOCALE / NEXT_PUBLIC_LOCALE",
      "a language tag such as en-NZ or de-CH",
    );
    return {
      currencyCode: decision.currency.value,
      locale: decision.locale.value,
    };
  },
  async write(db, value) {
    // Defensive, and cheap: both columns are NOT NULL, so a future refactor
    // that let an empty value reach here would fail at the database rather
    // than at the one line that can still refuse it.
    if (!value.currencyCode || !value.locale) return;
    // Create-if-absent only (`update: {}`): an existing row is the club's own
    // choice and must survive every future boot untouched.
    await db.clubFormatSettings.upsert({
      where: { id: CLUB_FORMAT_SETTINGS_ID },
      create: {
        id: CLUB_FORMAT_SETTINGS_ID,
        currencyCode: value.currencyCode,
        locale: value.locale,
        updatedByMemberId: null,
      },
      update: {},
      select: { id: true },
    });
  },
};

/**
 * Say which of the three ways one backfilled field got its value, in the two
 * cases where silence would mislead. Shared by both fields so the currency and
 * the locale cannot come to be reported differently.
 *
 * - `defaulted` is a WARNING: the environment said something unusable, so the
 *   club has just been handed a value it may not want, and an operator has to
 *   be told which value could not be read.
 * - a `preserved` field whose canonical spelling differs from the raw one
 *   (`nzd` -> `NZD`) is INFO: nothing is wrong, but an operator grepping a
 *   deploy log for what they set should find what was stored.
 * - `absent`, and `preserved` where the two agree, say nothing. Nobody is being
 *   moved and there is nothing to report.
 */
function reportClubFormatBackfillField(
  field: "currency" | "locale",
  decision: ClubFormatFieldBackfill,
  variables: string,
  expected: string,
): void {
  if (decision.kind === "defaulted") {
    logger.warn(
      {
        scope: "config-self-heal",
        step: "club-format",
        field,
        environmentValue: decision.raw,
        recorded: decision.value,
      },
      `Config self-heal recorded the club ${field} as ${decision.value} BY ` +
        `DEFAULT: ${variables} is "${decision.raw}", which is not ${expected}. ` +
        `If this club does not use ${decision.value} an administrator must set ` +
        `it at /admin/club-format — and note that correcting the environment ` +
        `variable will NOT change it, because the recorded value is the ` +
        `authority from now on.`,
    );
    return;
  }
  if (decision.raw !== null && decision.raw !== decision.value) {
    logger.info(
      {
        scope: "config-self-heal",
        step: "club-format",
        field,
        environmentValue: decision.raw,
        recorded: decision.value,
      },
      `Config self-heal is recording the club ${field} as ${decision.value}, ` +
        `read from ${variables} as "${decision.raw}" — the same value, spelled ` +
        `the way this runtime canonicalises it.`,
    );
  }
}
