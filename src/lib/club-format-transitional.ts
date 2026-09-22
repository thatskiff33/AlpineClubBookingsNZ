/**
 * THE MIGRATION SCAFFOLD, AND IT IS DUE TO BE DELETED (stage 3 of programme
 * #3205, #3565).
 *
 * `formatCents(cents, format)` and the `finance-format.ts` renderings take the
 * club's resolved currency and locale explicitly. While the call sites move onto
 * that signature group by group, the one-argument spellings they have not
 * reached yet still have to render something, and this is what they render with:
 * the transitional `APP_CURRENCY` / `APP_LOCALE` constants, which is exactly what
 * every one of them rendered with before this stage started. So an unmoved call
 * site is byte-identical to its former self, which is what lets each group ship
 * green and small rather than as one 250-call-site change (the decision recorded
 * on #3565, taking the temporary-overload option over the required-argument one).
 *
 * WHAT IT CANNOT DO, STATED PLAINLY BECAUSE THE DECISION COMMENT ON #3565 SAYS
 * OTHERWISE. That comment expected the one-argument overload to "resolve the club
 * format itself", at the cost of an unmemoised read per call on a server path
 * outside a React render pass. It cannot, and no version of it can: the overload
 * lives in `@/lib/utils`, which around fifty `"use client"` files import, and the
 * persisted format is an asynchronous `server-only` database read. A synchronous
 * function on the browser's import graph has no way to reach it. The only value
 * available to it is the one the environment supplies — which is the transitional
 * constant, and is the defect programme #3205 exists to remove.
 *
 * THE CONSEQUENCE, WHICH IS A REAL COST AND NOT A SHRUG. Between this stage's
 * first group and its last, a club that has SET a currency in the admin panel
 * sees the persisted one on migrated surfaces and the environment's on the rest.
 * Before this stage it saw the environment's everywhere. For a club on the New
 * Zealand defaults — and for every club that has not yet touched the new setting,
 * which is all of them until they do — the two are the same string and nothing
 * changes at all. The window closes when #3567 deletes this module, and the way
 * to keep it short is to finish the groups.
 *
 * DELETING IT IS MECHANICAL, WHICH IS WHY IT IS A MODULE AND NOT A DEFAULT
 * ARGUMENT. Remove this file and the compiler names every remaining caller of
 * every one-argument spelling, the way deleting `getSeasonYear` rather than
 * repairing it made the typechecker enumerate its call sites (`utils.ts`, CT-4
 * group F1). A default parameter would have left them silently green.
 */

import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";
import { resolveClubFormat, type ClubFormat } from "@/lib/club-format";

/**
 * The club's currency and locale as the ENVIRONMENT supplies them — never the
 * persisted setting, which this module structurally cannot reach.
 *
 * Normalised through `resolveClubFormat` rather than used raw, so that an
 * unmigrated call site and `club-format-settings.ts`'s environment-seed leg
 * cannot disagree about the same two variables. The two are byte-identical for
 * every configuration that works today, with one deliberate exception worth
 * naming: a structurally invalid `LOCALE` — `english`, say — used to reach
 * `Intl` and be negotiated down to the runtime's own default, and now falls back
 * to the documented `en-NZ`. That is the judgement #3563 already took for the
 * seed, and the alternative is the two halves of one migration formatting the
 * same amount differently.
 *
 * Resolved once at module load. That is safe HERE and nowhere else: these are
 * `process.env` reads that Next inlines at build time on the client anyway, so
 * freezing them adds no staleness that was not already there. The persisted
 * setting is never frozen — `clubFormat()` re-reads it every render pass.
 */
export const TRANSITIONAL_CLUB_FORMAT: ClubFormat = resolveClubFormat(null, {
  currencyCode: APP_CURRENCY,
  locale: APP_LOCALE,
});
