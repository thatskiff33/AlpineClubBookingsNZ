/**
 * The zone an implementation that read the ENVIRONMENT would use — the wrong
 * answer the club-time helpers must stay away from.
 *
 * It was `APP_TIME_ZONE` in `src/config/operational.ts` until #3567 deleted that
 * module. The environment's claim itself is unchanged: `TZ`, then
 * `NEXT_PUBLIC_TZ`, then the shipped `Pacific/Auckland`, which is exactly what
 * the seed reader (`club-time-zone-env.ts`) offers when no zone is stored. It is
 * read once at module load, as the constant was, and it lives in its own module
 * so `club-time-zone.test.ts` can pin it with a module mock without touching
 * anything else in a suite's graph.
 */
export const ENVIRONMENT_CLUB_ZONE =
  process.env.TZ?.trim() || process.env.NEXT_PUBLIC_TZ?.trim() || "Pacific/Auckland";
