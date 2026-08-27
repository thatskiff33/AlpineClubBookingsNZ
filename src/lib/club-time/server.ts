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
import { dateOnlyInstantOf } from "./instant";
import type { ClubTimeZone, Instant } from "./types";
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

/**
 * The club's today, encoded as the UTC-midnight `Date` a Prisma `@db.Date`
 * column round-trips through.
 *
 * `dateOnlyInstantOf((await clubTime()).today())` appeared fifteen times across
 * CT-4's route groups, always as a `@db.Date` query bound or column write, and
 * always costing the file two import lines — one from this module for
 * `clubTime`, one from the barrel for `dateOnlyInstantOf`. That import pair is
 * what group A reported (#2870) and this collapses both halves.
 *
 * THE ENCODING IS THE POINT AND ALSO THE LIMIT. What comes back is an encoding,
 * not a moment — `INV-DATE-026`'s corollary is why it has to be exactly this one,
 * because the Prisma adapter narrows whatever instant a `@db.Date` bound is
 * handed to its UTC calendar date. So it is the right value to compare against a
 * `date` column and the wrong one to compare against a `DateTime`, where
 * midnight UTC is a real instant that is the previous club day for roughly the
 * first half of every club day ahead of Greenwich. A caller that wants an instant boundary
 * wants `startOfClubDay` / `endOfClubDayExclusive`; one that wants the day itself
 * wants `(await clubTime()).today()` and no encoding at all.
 *
 * NOT FOR A MODULE A CLI CAN REACH. This file is `server-only`, which is a bare
 * `throw` outside the `react-server` condition, so a shared `src/lib` module
 * importing it kills every `tsx` entry point that reaches it — at import, before
 * `main()`. That has happened twice. Such a module composes
 * `dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()))`
 * instead — the cron jobs, the Xero writers, the group booking and settlement
 * paths and the subscription biller all do — and `docs/CLUB_TIME_KERNEL.md`
 * states which of the two readers a given module wants and how to check. NO
 * COUNT IS GIVEN, deliberately: this sentence used to say "nine sites do", the
 * number roughly doubled as CT-6 landed, and nothing anywhere would have failed.
 * `git grep -c "dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()))" -- src/`
 * answers it in a second, which is worth more than a figure the next reader has
 * to take on trust.
 */
export async function clubTodayDateOnlyInstant(): Promise<Instant> {
  return dateOnlyInstantOf((await clubTime()).today());
}
