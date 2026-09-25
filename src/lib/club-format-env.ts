/**
 * The environment's club currency and locale, as a SEED ONLY (stage 1 of
 * programme #3205, #3563). INV-CONFIG-006.
 *
 * `CURRENCY` / `NEXT_PUBLIC_CURRENCY` and `LOCALE` / `NEXT_PUBLIC_LOCALE` were
 * the club's currency and locale before this change, so they are what an
 * existing deployment's "current effective" values mean, and they are the only
 * thing a first boot after the upgrade can copy from. That is the whole of their
 * remaining role: `resolveClubFormat` consults the seed only when nothing is
 * persisted, and the boot backfill persists it once so that stops being true.
 * The `APP_CURRENCY`, `APP_STRIPE_CURRENCY` and `APP_LOCALE` constants in
 * `src/config/operational.ts` still derive from the same variables; since #3566
 * nothing outside that file reads the first and last, and #3567 retires them
 * (and decides where the charge currency, `APP_STRIPE_CURRENCY`, comes from).
 *
 * WHY THIS IS ITS OWN MODULE rather than sitting beside the validators, and it
 * is the reason `club-time-zone-env.ts` records for `TZ`, transferred without a
 * word of change. `club-format.ts` is deliberately free of `server-only`
 * because the admin panel needs its currency list and its length limits — which
 * puts everything in it on the CLIENT bundle graph. A `process.env` read there
 * is a latent second authority of exactly the kind this invariant forbids: Next
 * inlines only `NEXT_PUBLIC_*`, so in a browser the same function would return
 * the BUILD-TIME `NEXT_PUBLIC_CURRENCY`, which can differ from the running
 * server's — and in the published image it is not set at all, which is the
 * defect programme #3205 exists to fix rather than one to re-create here.
 *
 * This module IS marked `server-only`, so the production build refuses it in a
 * browser bundle at any depth, and it is named in BOTH leaf lists as well —
 * `FORBIDDEN_MODULES` in `src/lib/__tests__/client-server-boundary-census.test.ts`
 * and the `$MOD` alternation in `.semgrep/rules/acb-client-server-boundary.yml`.
 * That is deliberate rather than belt-and-braces: the build proof needs a build,
 * while both of those run without one, in the required `verify` check and in
 * review. The reasoning lives in one place and is not restated here:
 * `docs/invariants/operations.md` -> `INV-OPS-013`. The census is opt-in and
 * says so, so nothing would have failed had this module been left out of it —
 * which is precisely why it is named here.
 *
 * It is reached by the `npm run config:self-heal` tsx entrypoint, which since
 * #2850 runs with `--conditions=react-server`, under which `server-only`
 * resolves to an empty module; `cli-server-only-reach-census.test.ts` fails any
 * published invocation that reaches a marked module without the condition.
 */
import "server-only";

import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
  normaliseClubCurrencyCode,
  normaliseClubLocale,
  resolveClubFormat,
  type ClubFormat,
  type ClubFormatCandidate,
} from "@/lib/club-format";

/**
 * The raw currency seed, or `null` when neither variable is set.
 *
 * Read LIVE from `process.env` rather than from a module-level constant, which
 * is not a detail: a constant frozen at import makes a "the database wins over
 * the environment" test unable to tell a real precedence rule from an
 * environment read that never happened.
 */
export function readEnvironmentClubCurrencySeed(): string | null {
  return (
    process.env.CURRENCY?.trim() ||
    process.env.NEXT_PUBLIC_CURRENCY?.trim() ||
    null
  );
}

/** The raw locale seed, or `null`. See {@link readEnvironmentClubCurrencySeed}. */
export function readEnvironmentClubLocaleSeed(): string | null {
  return (
    process.env.LOCALE?.trim() || process.env.NEXT_PUBLIC_LOCALE?.trim() || null
  );
}

/**
 * What one environment seed is worth to a writer that must PRESERVE it.
 *
 * Three outcomes, and the middle one is the reason this exists rather than a
 * bare string — the same argument `EnvironmentClubTimeZoneSeed` makes. A writer
 * that cannot tell "nothing is set" from "something is set that I refuse to
 * record" will substitute the shipped default for both, which is correct for the
 * first and silently re-denominates a club for the second.
 *
 * - `absent`    — the variable is unset. The documented default applies; nobody
 *                 is being moved and there is nothing to say.
 * - `preserved` — the seed is usable. `value` is its canonical spelling, which
 *                 is exactly what the deployment has been running on. `raw` is
 *                 what the environment literally said, worth logging when the
 *                 two differ (`nzd` -> `NZD`).
 * - `unusable`  — the seed is set and cannot be used (`CURRENCY=dollars`,
 *                 `LOCALE=English`). There is nothing to preserve, so this seed
 *                 cannot answer "what is this deployment already using?" at all,
 *                 and a caller must SAY so rather than quietly defaulting.
 */
export type EnvironmentClubFormatField =
  | { kind: "absent" }
  | { kind: "preserved"; value: string; raw: string }
  | { kind: "unusable"; raw: string };

function classify(
  raw: string | null,
  normalise: (value: string | null) => string | null,
): EnvironmentClubFormatField {
  if (!raw) return { kind: "absent" };
  const value = normalise(raw);
  return value ? { kind: "preserved", value, raw } : { kind: "unusable", raw };
}

export function classifyEnvironmentClubCurrencySeed(): EnvironmentClubFormatField {
  return classify(readEnvironmentClubCurrencySeed(), normaliseClubCurrencyCode);
}

export function classifyEnvironmentClubLocaleSeed(): EnvironmentClubFormatField {
  return classify(readEnvironmentClubLocaleSeed(), normaliseClubLocale);
}

/**
 * The environment leg of the fallback chain, already judged — what
 * `resolveClubFormat`'s second argument wants.
 *
 * A field that is absent or unusable comes back `null`, which is what makes the
 * chain fall through to the shipped default rather than to a guess.
 */
export function readEnvironmentClubFormatSeed(): {
  currencyCode: string | null;
  locale: string | null;
} {
  const currency = classifyEnvironmentClubCurrencySeed();
  const locale = classifyEnvironmentClubLocaleSeed();
  return {
    currencyCode: currency.kind === "preserved" ? currency.value : null,
    locale: locale.kind === "preserved" ? locale.value : null,
  };
}

/**
 * What the boot backfill and any other create-if-absent writer should record for
 * one field, and which of the three ways it got there.
 *
 * `absent` and `defaulted` write the same string and are DIFFERENT ANSWERS, for
 * the reason `ClubTimeZoneBackfillDecision` states: a club whose `CURRENCY` says
 * something unusable has just been handed a currency it may not charge in, and
 * `defaulted` is what lets a caller say so out loud. Every caller must
 * distinguish them; a caller that treats the two alike is the defect this
 * discriminator is here to make visible.
 *
 * Pure — no logging, no database, no clock — so a caller can log in its own
 * idiom and the decision itself is unit-testable on its own.
 */
export type ClubFormatFieldBackfill = {
  kind: "preserved" | "absent" | "defaulted";
  /** The value to write. Always valid, never null. */
  value: string;
  /** What the environment said. Null only for `absent`. */
  raw: string | null;
};

function decide(
  field: EnvironmentClubFormatField,
  fallback: string,
): ClubFormatFieldBackfill {
  switch (field.kind) {
    case "preserved":
      return { kind: "preserved", value: field.value, raw: field.raw };
    case "absent":
      return { kind: "absent", value: fallback, raw: null };
    case "unusable":
      return { kind: "defaulted", value: fallback, raw: field.raw };
  }
}

export interface ClubFormatBackfillDecision {
  currency: ClubFormatFieldBackfill;
  locale: ClubFormatFieldBackfill;
}

export function decideClubFormatBackfill(): ClubFormatBackfillDecision {
  return {
    currency: decide(
      classifyEnvironmentClubCurrencySeed(),
      CLUB_CURRENCY_FALLBACK,
    ),
    locale: decide(classifyEnvironmentClubLocaleSeed(), CLUB_LOCALE_FALLBACK),
  };
}

/**
 * The club's format from a STORED row, falling back per field to the environment
 * seed and then to the shipped defaults — `resolveClubFormat` with this module's
 * seed as its second leg. The ONE spelling of that pairing (#3566): the request
 * reader, the AI spend reader, the currency-change clear and the email cache all
 * resolve through it, so none of them can drift onto a different fallback.
 */
export function resolveStoredClubFormat(
  stored: ClubFormatCandidate | null | undefined,
): ClubFormat {
  return resolveClubFormat(stored, readEnvironmentClubFormatSeed());
}
