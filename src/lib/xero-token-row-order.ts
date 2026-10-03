/**
 * Which `XeroToken` row is "the" connection when there is more than one (#3454).
 *
 * The table has no singleton constraint, and two first connects that finish at
 * the same moment (in either release) can each create a row. An unordered
 * `findFirst` then answers with whichever row PostgreSQL happens to scan first,
 * and that changes when a row is updated — so two readers, or one reader twice,
 * could disagree about which row is current. Every reader that picks "the" row
 * without holding its lock orders by this, so they all agree: the row written
 * most recently. A reader that already holds a row's lock reads that row by id.
 *
 * Dependency-free on purpose: the token store, the health check, setup
 * readiness, config transfer and the admin cache all import it, and none of
 * them should pull in the token store's crypto to learn an ordering.
 */
export const XERO_TOKEN_ROW_ORDER = { updatedAt: "desc" } as const;
