/**
 * How much application email this installation has held back for
 * environment-safety reasons, and when the most recent one was (ENV-SAFETY 1,
 * #3034; epic #2986).
 *
 * WHY A COUNT IS THE SIGNAL, when nothing about the DATA can be one. The one
 * hole this epic cannot close by configuration is a live club installation that
 * is not sending: the production deploy refuses a `.env` saying `non-production`,
 * and it asks each container what it actually received before the cutover, but a
 * site somebody brings up by hand with `docker compose up` runs none of that. It
 * comes up, resolves NON_PRODUCTION or UNKNOWN, and holds back mail its members
 * are waiting for.
 *
 * BOTH of those states hold delivery back, so both surfaces render this line for
 * both. UNKNOWN is if anything the likelier one, because it is what an existing
 * live installation reaches simply by upgrading without adding the declaration.
 *
 * The tempting detector — "warn when the database looks like a real club's
 * records" — cannot work, and it is worth writing down why so nobody builds it.
 * A staging copy is RESTORED from production, so it contains exactly those
 * records; the check would fire on every legitimate copy, which is the common
 * case, and a gate that cries wolf trains its reader to ignore it. It also
 * contradicts the premise of #2986, which is that a copy is indistinguishable
 * from the real thing by inspecting its data.
 *
 * WHAT DOES DISTINGUISH THEM IS CONSEQUENCE. A real club that is not sending —
 * wrongly declared a copy, or left undeclared — holds back a steady stream of
 * member mail, confirmations, payment notices and renewal reminders, hour after
 * hour. A genuine copy nobody is using holds back almost nothing. So the COUNT, and how recent the most recent one is, separates
 * the two cases where no property of the data can. It is also simply what an
 * operator needs to see either way: *you are not sending mail, and this is how
 * much*.
 *
 * WHAT IS COUNTED, now that #3035 has landed the delivery boundary: the two
 * EmailLog outcomes that boundary writes, and nothing else.
 *
 * - `SKIPPED_NON_PRODUCTION` — a confirmed copy held the message back. Terminal.
 * - `FAILED` carrying a `deliveryBlockReason` — nothing has declared which
 *   installation this is, so the send failed closed. Retryable, and it drains by
 *   itself once the role is declared.
 *
 * BOTH, in one number, because both are "held back for environment-safety
 * reasons" and the operator question is the same in either state: *is this
 * installation quietly not sending mail its members are waiting for?* The
 * unknown-environment half is the MORE urgent of the two — it is the live club
 * that upgraded without the declaration — and leaving it out would have made this
 * number read as reassurance on exactly that installation. The distinction is not
 * lost by summing them: the two outcomes are different rows with different
 * statuses, and every surface that shows this number shows the effective role
 * immediately beside it, so which of the two states produced the count is already
 * on the screen.
 *
 * Nothing here counts a stand-in from some other table. `SKIPPED_NO_EMAILS` in
 * particular is NOT counted: that is the club's own per-booking "No emails"
 * decision, which a copy and a live site both honour, so including it would make
 * a busy live club look like a copy holding mail back.
 *
 * An unreadable count still answers `{ available: false }`. That distinction is
 * the point: "nothing has been held back" and "we could not count" look identical
 * on a screen and mean opposite things — one says the copy is idle, the other
 * says nobody knows.
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The summary, in the three states a reader has to be able to tell apart.
 *
 * `available: false` is not an error and not a zero. It is "this installation
 * cannot tell you", which is what an unreadable database answers.
 */
export type WithheldApplicationEmail =
  | { available: false }
  | {
      available: true;
      /** How many application messages were held back for safety reasons. */
      count: number;
      /** ISO instant of the most recent, or `null` when the count is 0. */
      mostRecentAt: string | null;
      /**
       * How many of those are the FIFTH outcome — the club's LIVE site declaring
       * a capture mailbox — broken out on its own.
       *
       * WHY IT NEEDS ITS OWN NUMBER (#3035 review). Both operator surfaces
       * rendered the withheld line only under NON_PRODUCTION and UNKNOWN, on the
       * premise that a live site holds nothing back. That premise is false for
       * exactly this outcome: a live club that declares `USE_LOCAL_CAPTURE=true`
       * is in a total mail outage, every message lands as `FAILED` carrying
       * `CAPTURE_TRANSPORT_IN_PRODUCTION`, the count climbs — and Admin →
       * Environment showed PRODUCTION with no withheld line at all.
       *
       * A SEPARATE COUNT RATHER THAN JUST SHOWING THE TOTAL, because the total is
       * not actionable on a live site. `SKIPPED_NON_PRODUCTION` rows are terminal
       * by design, so an installation that spent an afternoon as a forced copy
       * during a restore rehearsal carries those rows for ever — and a permanent
       * "42 messages held back" banner on a healthy live site is the kind of
       * line an operator learns to scroll past. This number can only be non-zero
       * while the transport flags are wrong, so it is the one that means *act
       * now*.
       */
      captureInProduction: number;
    };

/** The answer when the count cannot be read at all. */
export const WITHHELD_APPLICATION_EMAIL_NOT_RECORDED: WithheldApplicationEmail = {
  available: false,
};

/**
 * Read the summary.
 *
 * TWO AGGREGATES RATHER THAN ONE `OR`, because they are two different row
 * populations and Postgres can serve each from `EmailLog(status)` — the index
 * that already exists — as a plain range scan. An `OR` across two statuses would
 * be a bitmap union for no gain, and this way each half's cost is obvious.
 *
 * BOUNDED BY WHAT IT COUNTS, which is the property that matters on an operator
 * surface. The suppressed half scans only `SKIPPED_NON_PRODUCTION` rows, which is
 * exactly the population being counted. The blocked half scans `FAILED` rows,
 * which on a healthy installation is a small "something went wrong" population
 * and on an undeclared one is the very set being counted. Neither ever touches
 * the `SENT` rows, which are all of the volume.
 *
 * NO NEW INDEX, AND THE HONEST REASONING FOR THAT (corrected after review — the
 * first version of this note was wrong twice). A composite
 * `@@index([status, createdAt])` IS expressible in Prisma and WOULD make both
 * aggregates index-only, so "Prisma cannot express it" is not the reason. The
 * reason is that a seventh btree on this repository's highest-volume log table
 * means an `ACCESS EXCLUSIVE` index build inside Prisma's per-migration
 * transaction, where `CONCURRENTLY` is unavailable — a real deploy-window stall on
 * a club with years of rows, for an occasional admin read. Nor is a PARTIAL index
 * out of reach: this repository already ships six gated raw-SQL partial indexes
 * (`prisma/partial-unique-indexes.tsv`, `scripts/check-partial-indexes.sh`), so
 * that escalation is an established pattern rather than an impossibility.
 *
 * AND THE BOUNDEDNESS IS WEAKEST EXACTLY WHERE THIS COUNT MATTERS. On a live club
 * wrongly declared a copy — the case the number exists to reveal — the counted
 * population grows without bound, a row per message the club tries to send. That
 * is accepted because it is the state an operator is being told to repair within
 * hours; it is not a steady state to live with. See the migration's row in
 * `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.
 *
 * FAILS SOFT, deliberately. This runs inside the readiness snapshot and the admin
 * panel; a database that cannot answer must not turn either into a 500 when the
 * honest `available: false` is already a state both surfaces render.
 */
export async function readWithheldApplicationEmail(): Promise<WithheldApplicationEmail> {
  try {
    const [suppressed, blocked, captureInProduction] = await Promise.all([
      prisma.emailLog.aggregate({
        where: { status: "SKIPPED_NON_PRODUCTION" },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      prisma.emailLog.aggregate({
        where: { status: "FAILED", deliveryBlockReason: { not: null } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      // A SUBSET of `blocked`, not a third population: it is the same
      // `FAILED` + non-null-reason scan narrowed to the one reason that can be
      // true on the club's LIVE site. Counted separately so the operator surfaces
      // can act on it there — see `captureInProduction` above.
      prisma.emailLog.aggregate({
        where: {
          status: "FAILED",
          deliveryBlockReason: "CAPTURE_TRANSPORT_IN_PRODUCTION",
        },
        _count: { _all: true },
      }),
    ]);
    const instants = [
      suppressed._max.createdAt,
      blocked._max.createdAt,
    ].filter((value): value is Date => value != null);
    const mostRecent = instants.reduce<Date | null>(
      (latest, value) => (latest && latest >= value ? latest : value),
      null,
    );
    return {
      available: true,
      count: suppressed._count._all + blocked._count._all,
      mostRecentAt: mostRecent ? mostRecent.toISOString() : null,
      captureInProduction: captureInProduction._count._all,
    };
  } catch (error) {
    logger.error(
      {
        scope: "environment-safety-withheld",
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
      "Could not count the application email this installation has held back for environment-safety reasons, so the operator surfaces report that the number is unavailable rather than reporting a zero. Apply pending migrations (prisma migrate deploy) or restore database access.",
    );
    return WITHHELD_APPLICATION_EMAIL_NOT_RECORDED;
  }
}
