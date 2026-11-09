/**
 * THE ADMIN HUBS SWITCH (epic #4468, C1 #4798).
 *
 * One constant, not a module flag: `next.config.ts` builds its redirects at
 * build time, and no club would answer "where does Payments live" differently
 * (`INV-CONFIG-001`). While it is `false`, every moved admin page is still
 * served at its old URL and its hub URL redirects there; C18 (#4815) flips it.
 *
 * Relative imports only, in this file and in everything under
 * `src/lib/admin-hubs/`: `next.config.ts` will import it, and the config loader
 * does not resolve the `@/` alias.
 */
export const ADMIN_HUBS_LIVE = false;
