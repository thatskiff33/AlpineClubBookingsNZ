/**
 * How much of the club's Xero accounting this installation has contained
 * (ENV-SAFETY 3, #3036; epic #2986; INV-CONFIG-005).
 *
 * WHY AN OPERATOR NEEDS A NUMBER HERE, and why the role alone is not enough.
 * `/admin/environment` already says which installation this is. What it cannot
 * say from the role is whether this copy has been pointed at the club's REAL
 * Xero organisation — and if it has, containment has rewritten email addresses
 * on real accounting records. That is a destructive edit made for a good reason,
 * and the person who discovers it needs to know how many contacts it touched
 * before they decide what to do about it. So this reports two numbers that mean
 * different things:
 *
 * - **`containedContacts`** — how many Xero contacts this installation has
 *   proved cannot reach a member. On a copy that number climbing is the feature
 *   working.
 * - **`rewrittenContacts`** — the subset where Xero was actually holding a
 *   deliverable address that this installation overwrote. On a copy pointed at a
 *   sandbox Xero organisation that is ordinary. On a copy pointed at the club's
 *   real organisation it is the number that means *act now*, and it is why the
 *   two are not summed.
 *
 * AND IT NAMES WHICH CONTACTS, because a count is not something an operator can
 * act on. The repair is per contact and it is performed in Xero, so the surface
 * carries a bounded list of the rewritten ones: the member's name, a link into
 * Xero's own contact screen, and when the address was replaced. Without it,
 * "re-sync those members" has no "those".
 *
 * IT REPORTS THE ADDRESS OF NOBODY. The contained address is a SHA-256 of the
 * source address, so even the row it comes from carries no member's email, and
 * this summary carries no address at all — only counts, instants, names and
 * provider ids. The issue asks for exactly that: distinguish production,
 * confirmed non-production containment and environment-unknown blocking
 * "without unnecessarily exposing real email".
 *
 * THREE INSTANTS, NOT ONE, and mixing them up is how a true number becomes a
 * false sentence. `mostRecentAt` is the last containment CHECK; it moves whenever
 * a copy resolves any contact. `lastRewrittenAt` is when a deliverable address
 * was last actually replaced — the date of the damage. `firstContainedAt`
 * answers "how long has this copy been doing this". Reporting the first under
 * the second's sentence would date a June overwrite to this morning.
 *
 * AN UNREADABLE COUNT IS ITS OWN ANSWER, the same distinction
 * `environment-safety-withheld.ts` makes: "nothing has been contained" and "we
 * could not count" look identical on a screen and mean opposite things. One says
 * this copy has not touched Xero; the other says nobody knows.
 *
 * ZERO IS THE ONLY POSSIBLE ANSWER ON THE LIVE SITE, and that is why no surface
 * shows this number without the effective role beside it. Containment runs only
 * on a confirmed NON_PRODUCTION installation, so a PRODUCTION installation's
 * table stays empty for ever — an empty count there is not reassurance about
 * anything, it is the definition.
 *
 * NOTHING IS EVER SWEPT, so these counts only grow. A row whose Xero contact has
 * since been archived, deleted or unlinked is still a true record that this
 * installation edited that contact in the club's accounting, and it is the
 * record somebody wants when they discover a copy was pointed at the real
 * organisation — so a cleanup would delete the evidence and quietly reduce the
 * number reported here. The bound is one row per contact this copy has ever
 * resolved; see the model comment in `prisma/schema.prisma`.
 *
 * FAILS SOFT, deliberately: this runs inside an admin page's payload, and a
 * database that cannot answer must not turn the screen into a 500 when
 * `available: false` is a state the screen already renders.
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildXeroContactUrl } from "@/lib/xero-links";

/**
 * One contact whose deliverable address this installation overwrote.
 *
 * WHY A LIST AND NOT JUST A COUNT. A count tells an operator that damage exists
 * and gives them no way to act on it: the repair is per contact, and "re-sync
 * those members" has no addressable "those" behind it. The row already holds the
 * only identifier that matters, so the list costs one extra query and turns a
 * number into a job somebody can finish.
 *
 * NO EMAIL ADDRESS, IN EITHER DIRECTION. The member's name is here because an
 * administrator looking at a Xero contact needs to know whose it is, and the
 * whole point of hashing the contained address is that no member's real address
 * has to travel to a screen. `memberName` is `null` for a contact no member
 * points at any more — a merge moved the link, the member was deleted, the
 * contact was linked by the bulk importer and never claimed — and that is worth
 * showing rather than hiding: it is still a contact this installation edited.
 */
export type RewrittenXeroContact = {
  xeroContactId: string;
  /** Deep link into Xero's own contact screen, where the repair is performed. */
  xeroContactUrl: string;
  memberName: string | null;
  /** `/admin/members/<id>` on THIS installation, or `null` when unlinked. */
  memberId: string | null;
  /** ISO instant the deliverable address was replaced. */
  rewrittenAt: string | null;
};

/** The summary, in the two states a reader has to be able to tell apart. */
export type XeroContactContainment =
  | { available: false }
  | {
      available: true;
      /** Xero contacts proved unable to reach a member on this installation. */
      containedContacts: number;
      /**
       * The subset where a deliverable address was actually replaced. See the
       * module docblock: this is the number that distinguishes a copy pointed at
       * a sandbox Xero organisation from one pointed at the club's real books.
       */
      rewrittenContacts: number;
      /**
       * ISO instant of the most recent containment CHECK, or `null` when there
       * are none. Not the same question as {@link lastRewrittenAt}, and the two
       * are kept apart because a re-check happens whenever a copy runs anything
       * at all, while a rewrite is the destructive edit somebody wants dated.
       */
      mostRecentAt: string | null;
      /** ISO instant a deliverable address was last actually replaced. */
      lastRewrittenAt: string | null;
      /** ISO instant of the FIRST containment on this installation. */
      firstContainedAt: string | null;
      /**
       * The rewritten contacts themselves, newest first, capped at
       * {@link REWRITTEN_CONTACT_SAMPLE_LIMIT}. `rewrittenContacts` is the real
       * total; this is what an operator can act on now.
       */
      rewritten: RewrittenXeroContact[];
    };

/**
 * How many rewritten contacts the operator surface lists.
 *
 * Bounded because this runs inside an admin page's payload and a copy pointed at
 * a large club's real organisation could have hundreds. Fifty is enough to start
 * the repair and to show its shape; the count beside it is never truncated, so
 * the screen can say how many are not listed rather than implying there are none.
 */
export const REWRITTEN_CONTACT_SAMPLE_LIMIT = 50;

/** The answer when the count cannot be read at all. */
export const XERO_CONTACT_CONTAINMENT_NOT_RECORDED: XeroContactContainment = {
  available: false,
};

/**
 * Read the summary.
 *
 * FOUR QUERIES over a table holding at most one row per Xero contact — thousands
 * of rows on the largest club, not a log: one aggregate for the totals and the
 * instants, one count of the rewritten subset, one bounded page of those rows,
 * and one name lookup for the members they belong to. There is no index beyond
 * the unique key on `xeroContactId` and none is wanted: a sequential scan of a
 * few thousand narrow rows on an administrator's page load is cheaper than a
 * second btree to maintain on every containment write.
 *
 * THE NAME LOOKUP IS A SEPARATE QUERY, not a relation, because the containment
 * row deliberately holds no `memberId` — see the model comment: containment is a
 * property of the provider-side contact, and a merge or a deletion moves a link
 * without changing what Xero holds. So the join is done here, one way, over at
 * most {@link REWRITTEN_CONTACT_SAMPLE_LIMIT} ids.
 */
export async function readXeroContactContainment(): Promise<XeroContactContainment> {
  try {
    const [all, rewrittenCount, rewrittenRows] = await Promise.all([
      prisma.xeroSandboxContactContainment.aggregate({
        _count: { _all: true },
        _max: { updatedAt: true, rewrittenAt: true },
        _min: { containedAt: true },
      }),
      prisma.xeroSandboxContactContainment.count({
        where: { rewroteAddress: true },
      }),
      prisma.xeroSandboxContactContainment.findMany({
        where: { rewroteAddress: true },
        select: { xeroContactId: true, rewrittenAt: true },
        /*
          `nulls: "last"` is not decoration. Postgres sorts NULLs FIRST on a
          DESC order, so a row with `rewroteAddress: true` and a null
          `rewrittenAt` would head the list an operator repairs from — and
          nothing in the database enforces that the pair is always written
          together, only this application's writer. Ordering the nulls last means
          a writer that ever came apart degrades to "listed last" rather than to
          "listed first, undated, above the contacts that matter".
        */
        orderBy: { rewrittenAt: { sort: "desc", nulls: "last" } },
        take: REWRITTEN_CONTACT_SAMPLE_LIMIT,
      }),
    ]);
    const members = rewrittenRows.length
      ? await prisma.member.findMany({
          where: {
            xeroContactId: { in: rewrittenRows.map((row) => row.xeroContactId) },
          },
          select: { id: true, firstName: true, lastName: true, xeroContactId: true },
        })
      : [];
    const memberByContactId = new Map(
      members
        .filter((member) => member.xeroContactId)
        .map((member) => [member.xeroContactId as string, member]),
    );
    return {
      available: true,
      containedContacts: all._count._all,
      rewrittenContacts: rewrittenCount,
      mostRecentAt: all._max.updatedAt
        ? all._max.updatedAt.toISOString()
        : null,
      lastRewrittenAt: all._max.rewrittenAt
        ? all._max.rewrittenAt.toISOString()
        : null,
      firstContainedAt: all._min.containedAt
        ? all._min.containedAt.toISOString()
        : null,
      rewritten: rewrittenRows.map((row) => {
        const member = memberByContactId.get(row.xeroContactId) ?? null;
        return {
          xeroContactId: row.xeroContactId,
          xeroContactUrl: buildXeroContactUrl(row.xeroContactId),
          memberName: member ? `${member.firstName} ${member.lastName}` : null,
          memberId: member ? member.id : null,
          rewrittenAt: row.rewrittenAt ? row.rewrittenAt.toISOString() : null,
        };
      }),
    };
  } catch (error) {
    logger.error(
      {
        scope: "xero-contact-containment-status",
        err: { message: error instanceof Error ? error.message : String(error) },
      },
      "Could not count the Xero contacts this installation has contained, so the operator surface reports that the number is unavailable rather than reporting a zero. Apply pending migrations (prisma migrate deploy) or restore database access.",
    );
    return XERO_CONTACT_CONTAINMENT_NOT_RECORDED;
  }
}
