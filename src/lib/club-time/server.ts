import "server-only";

/**
 * The server binding: the club's PERSISTED timezone, bound to the kernel
 * (CT-2, #2990; epic #2988).
 *
 * This is where CT-1's answer and CT-2's operations meet. A server component,
 * route handler, cron job or email builder calls `clubTime()` once and formats
 * everything through the result; the identifier it holds is the one persisted in
 * `ClubTimeSettings`, never `process.env.TZ`, never the database session's zone
 * and never the machine's (`INV-CONFIG-002`).
 *
 * ## The caching contract CT-1 deferred to here
 *
 * `club-time-zone-settings.ts` says outright that it caches nothing, deliberately,
 * and that CT-2 — "where the hot, per-format call sites arrive" — is the change
 * that should choose the contract rather than inherit one guessed at.
 *
 * The choice is React `cache()`: **request-scoped, with no invalidation contract
 * at all**. The memo lives for one render pass, so the admin route that changes
 * the club's timezone does not have to remember to bust anything and cannot
 * forget to, and the very next request reads the new value. `unstable_cache`
 * would be wrong here for the opposite reason — it is a tagged, cross-request
 * cache, so it would need a revalidation call in the writer and would go stale
 * the first time someone added a second writer. Both patterns are already live
 * in this tree, so this is a choice between two house patterns rather than a new
 * dependency.
 *
 * Outside a React render pass — a cron tick, a webhook, a script — `cache()`
 * degrades to "no memo", which is correct: those are not requests, and each one
 * should read the current value.
 *
 * ## Why this file is separate from the barrel
 *
 * `import "server-only"` is the whole reason. `@/lib/club-time` has to reach the
 * browser bundle (112 of the 400 files on the legacy temporal surfaces are
 * `"use client"`), and a database read must never. A client component receives
 * the resolved identifier as data and calls `bindClubTime` on it.
 */

import { cache } from "react";

import { getClubTimeZone } from "@/lib/club-time-zone-settings";

import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";

import { bindClubTime, type BoundClubTime } from "./bound";
import type { ClubTimeZone } from "./types";
import { asClubTimeZone, requireClubTimeZone } from "./zone";

/**
 * The club's timezone for this request, validated and branded.
 *
 * `getClubTimeZone()` never throws and already returns a value that passed
 * CT-1's validator on the way in, so the re-validation here is belt and braces
 * for the one path that could produce an unusable string — a runtime whose ICU
 * has forgotten a zone the club chose years ago. Falling back to the documented
 * default keeps the application answering, which is the same judgement CT-1's
 * reader makes for the same reason.
 */
export const clubTimeZone = cache(async (): Promise<ClubTimeZone> => {
  const resolved = await getClubTimeZone();
  return asClubTimeZone(resolved) ?? requireClubTimeZone(CLUB_TIME_ZONE_FALLBACK);
});

/** The whole kernel with the club's persisted zone already supplied. */
export const clubTime = cache(async (): Promise<BoundClubTime> =>
  bindClubTime(await clubTimeZone()),
);
