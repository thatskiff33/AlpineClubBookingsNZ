import "server-only";

/**
 * The server binding: the club's PERSISTED currency and locale, bound to the
 * money kernel (stage 3 of programme #3205, #3565). INV-CONFIG-006.
 *
 * This is where #3563's answer and this stage's operations meet. A server
 * component, route handler, cron job or email builder calls `clubFormat()` once
 * and renders everything through the result; the currency and locale it holds are
 * the ones persisted in `ClubFormatSettings`, never `process.env.CURRENCY` and
 * never `APP_CURRENCY` / `APP_LOCALE`, which after this stage are a migration
 * scaffold (`club-format-transitional.ts`) that #3567 deletes.
 *
 * ## The caching contract #3563 deferred to here
 *
 * `club-format-settings.ts` says outright that it caches nothing, deliberately,
 * and that this stage — "where the hot, per-format call sites arrive" — is the
 * change that should choose the contract rather than inherit one guessed at.
 *
 * The choice is React `cache()`, for the reasons `club-time/server.ts` records
 * at length for the identical question and which are not restated here: it is
 * request-scoped with no invalidation contract at all, so the admin route that
 * changes the club's currency cannot forget to bust anything and the very next
 * request reads the new value, where `unstable_cache` would need a revalidation
 * call in every writer. Two house patterns, and this is a choice between them
 * rather than a new dependency. The reasoning that picked `cache()` for the
 * timezone applies here word for word, and picking differently for the second
 * axis would mean two settings read through two contracts for no reason anybody
 * could state.
 *
 * Outside a React render pass — a cron tick, a webhook, a script — `cache()`
 * degrades to "no memo", which is correct: those are not requests, and each one
 * should read the current value. The formatter memo in `club-format-intl.ts` is
 * unaffected by that and still holds, so what an uncached call costs is one
 * primary-key read of a one-row table, not a rebuilt `Intl` instance.
 *
 * ## Why this file is separate from `club-format.ts`
 *
 * `import "server-only"` is the whole reason. `@/lib/club-format` has to reach
 * the browser bundle — the admin panel needs its currency list and its length
 * limits — and a database read must never. A client component receives the
 * resolved format as data and calls `bindClubFormat` on it.
 *
 * ## Which reader a given module wants
 *
 * A module a `tsx` entry point can reach takes the format as a PARAMETER, or
 * calls `getClubFormat()` from `@/lib/club-format-settings` if it already imports
 * `@/lib/prisma` (both carry `server-only`, so such a module is already inside
 * that boundary and adds no new reach). This module is for a render pass, where
 * the memo is the point.
 *
 * ## Inside a render pass, the raw reader is a SECOND read, not a synonym
 *
 * React `cache()` memoises per FUNCTION IDENTITY. `clubFormat()`,
 * `clubFormatValues()` and the raw `getClubFormat()` are three identities, so a
 * component calling the raw one in a pass where anything else calls either of
 * these reads the same one-row table twice. The two exported here share a memo
 * on purpose — `clubFormat()` builds its binding from `clubFormatValues()` —
 * so a page that takes the binding and a chrome that takes the values cost one
 * read between them.
 *
 * That was a real defect and not a hypothetical: the three surfaces that hand
 * the format to the browser (`app-providers.tsx`, `website/website-chrome.tsx`,
 * `app/display/page.tsx`) were written against the raw reader at #3564, before
 * this contract existed, and `app-providers.tsx`'s own docblock said so in as
 * many words. `club-format-provider-mount-census.test.tsx` now requires all
 * three to import from this module, which is what keeps the sentence above a
 * property rather than a claim.
 */

import { cache } from "react";

import { bindClubFormat, type BoundClubFormat } from "@/lib/club-format-bound";
import { getClubFormat } from "@/lib/club-format-settings";

import type { ClubFormat } from "@/lib/club-format";

/**
 * The club's currency and locale for this request, both validated.
 *
 * Separate from {@link clubFormat} because a server component very often needs
 * the VALUES rather than the operations — to hand down to a `"use client"` child
 * as a prop, or to pass to a `src/lib` helper that renders several amounts of its
 * own. `clubTimeZone()` stands in the same relation to `clubTime()`, for the same
 * reason.
 *
 * `getClubFormat()` never throws and returns a value that has already passed
 * #3563's validators on the way out, so nothing is re-validated here.
 */
export const clubFormatValues = cache(
  async (): Promise<ClubFormat> => getClubFormat(),
);

/** The whole money kernel with the club's persisted format already supplied. */
export const clubFormat = cache(
  async (): Promise<BoundClubFormat> => bindClubFormat(await clubFormatValues()),
);
