/**
 * The deployment's DECLARATION of what this installation is (ENV-SAFETY 1,
 * #3034; epic #2986).
 *
 * One environment variable, `APP_ENVIRONMENT_ROLE`, and two legal values:
 * `production` and `non-production`. This module parses that declaration and
 * does nothing else — it does not decide the effective role, which is
 * `resolveEnvironmentRole()` in `environment-role.ts`, because the database
 * safer-override is part of that answer and this module deliberately cannot
 * reach a database.
 *
 * WHY A DECLARATION AND NOT AN INFERENCE (INV-CONFIG-003). The whole of epic
 * #2986 is that a copy of production must not be able to email the club's real
 * members, and every cheap way of telling "am I production?" is a guess:
 * `NODE_ENV` is a BUILD mode (a staging container runs a production build),
 * `APP_RUNTIME_ROLE` is a deployment naming convention, a hostname is DNS, a
 * `DATABASE_URL` is where the data came from and a restored production dump
 * makes it lie. Each of those is right until the day somebody stands up a copy
 * that breaks the convention, and that day is exactly the day it matters. So the
 * deployment SAYS which it is, in one variable, and nothing infers it.
 *
 * DO NOT CONFUSE THIS WITH `APP_RUNTIME_ROLE`, which already exists and sits
 * beside it in the same Compose environment. `APP_RUNTIME_ROLE` says which SLOT
 * a container is — `web-blue`, `web-green`, `cron-leader`, `staging` — and it is
 * a deployment naming convention, so it is exactly the kind of signal this
 * epic forbids as an authority. It is never read here or by the resolver. The
 * two names are close enough that an operator will reach for the wrong one, so
 * both plausible mistakes are made to fail loudly and safely rather than
 * silently: `APP_ENVIRONMENT_ROLE=staging` is `invalid` and therefore resolves
 * UNKNOWN, and setting `APP_RUNTIME_ROLE=production` changes no safety decision
 * at all.
 *
 * NOT `NEXT_PUBLIC_*`, AND THAT IS LOAD-BEARING. Next inlines only
 * `NEXT_PUBLIC_` variables into the browser bundle, at BUILD time. A public
 * spelling of this variable would therefore give a browser a second, possibly
 * stale answer to "is this production?" — the split-brain second authority
 * `INV-CONFIG-002` forbids for the club timezone, with worse consequences here,
 * because the thing keyed on the answer is whether real members get emailed. The
 * name is pinned in `environment-role-declaration.test.ts`, which asserts both
 * the exact spelling and that it does NOT begin with `NEXT_PUBLIC_`. (This
 * paragraph used to cite `environment-role-env-var-name.test.ts`, which has never
 * existed — #3034 review.)
 *
 * WHY THIS IS ITS OWN MODULE, separate from the resolver, is the reason
 * `club-time-zone-env.ts` gives for the same split: a `process.env` read that
 * can reach the client bundle is a latent second authority. This module is
 * deliberately NOT marked `server-only` — `setup-readiness-db.ts` reaches the
 * resolver from the `tsx` entrypoint `npm run setup`, which a `server-only`
 * import would abort — so it is kept off the client graph by being NAMED as a
 * forbidden leaf in both halves of `INV-OPS-013`: `FORBIDDEN_MODULES` in
 * `src/lib/__tests__/client-server-boundary-census.test.ts`, which walks the
 * real import graph out of every `"use client"` module, and the `$MOD`
 * alternation in `.semgrep/rules/acb-client-server-boundary.yml`. Both are FIXED
 * LEAF LISTS: a module in neither is protected by neither, however firmly a
 * docblock says otherwise.
 */

/** The one variable that declares this installation's role. */
export const ENVIRONMENT_ROLE_ENV_VAR = "APP_ENVIRONMENT_ROLE";

/** The two values `APP_ENVIRONMENT_ROLE` may hold, and nothing else. */
export const ENVIRONMENT_ROLE_DECLARED_VALUES = [
  "production",
  "non-production",
] as const;

/**
 * How long a rejected value may be when it is shown back to the operator.
 *
 * It is their own configuration value, not a secret, and they cannot fix a typo
 * they are not shown — but it is also unbounded text from a deployment
 * environment, so it is capped and stripped before it is ever put in a log line
 * or on a page. Same reasoning and same treatment as `printableTimeZoneValue`
 * in `setup-readiness.ts`.
 */
export const ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH = 64;

export type EnvironmentRoleDeclaration =
  | { kind: "production" }
  | { kind: "non-production" }
  | { kind: "absent" }
  | { kind: "invalid"; raw: string };

/**
 * A rejected value made safe to display, capped at
 * {@link ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH} characters INCLUDING the
 * truncation marker, so the cap is a fact about the returned string rather than
 * about some intermediate.
 *
 * Control characters are REPLACED with `?` rather than deleted. A deployment
 * variable holding `produc\ntion` must not be able to write a second line into
 * a boot log or an operator's terminal, and showing `produc?tion` tells them
 * something is in there — deleting it silently would render as `production`
 * beside a message saying that value was refused, which reads as a bug in the
 * app rather than a stray byte in their configuration.
 *
 * THE WHOLE RESULT IS PRINTABLE ASCII, marker included: the truncation marker
 * is `...` and not an ellipsis character, so the promise the paragraph above
 * makes is true of the string that is actually returned. It first used the
 * single-character ellipsis, which reduced everything to ASCII and then
 * appended a character that is not — harmless, but a docblock that overstates
 * by one character is a docblock the next reader has to go and check (#3034
 * review).
 */
export function sanitizeEnvironmentRoleRawValue(value: string): string {
  const printable = value.replace(/[^\x20-\x7E]/g, "?");
  return printable.length > ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH
    ? `${printable.slice(0, ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH - 3)}...`
    : printable;
}

/**
 * What the deployment declares, or why it declares nothing usable.
 *
 * READ LIVE from the injected environment (`process.env` by default) on every
 * call, never from a module-level constant. That is not a style preference: a
 * constant frozen at import makes a "the declaration decides" test unable to
 * tell a real rule from an environment read that never happened, which is the
 * exact trap `club-time-zone-env.ts` documents.
 *
 * A NEAR MISS IS `invalid`, NOT A GUESS. `prod`, `PRODUCTION ` (accepted — it is
 * only case and surrounding whitespace), `non_production`, `nonproduction`,
 * `staging`, `true`: only the first and the second of those are the same
 * DECISION. Widening the accepted set is how a typo silently becomes
 * "production", so anything that is not exactly one of the two words — once
 * trimmed and lowercased — is refused and reported, and the caller resolves
 * UNKNOWN rather than picking whichever value looks closest.
 */
export function readEnvironmentRoleDeclaration(
  env: Record<string, string | undefined> = process.env,
): EnvironmentRoleDeclaration {
  const raw = env[ENVIRONMENT_ROLE_ENV_VAR];
  if (raw === undefined || raw === null) return { kind: "absent" };

  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "absent" };

  const normalised = trimmed.toLowerCase();
  if (normalised === "production") return { kind: "production" };
  if (normalised === "non-production") return { kind: "non-production" };

  return { kind: "invalid", raw: sanitizeEnvironmentRoleRawValue(trimmed) };
}
