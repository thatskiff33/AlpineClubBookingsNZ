/**
 * AI Diagnostics — the SERVER-OWNED tool registry (AID-5, #2374; first tool pack
 * AID-6A, #2375; contracts in ADR-001 §2, ADR-002 §2/§4, ADR-007).
 *
 * This table is the whole answer to "can the model run a query?". It cannot: a
 * registry entry pairs a FIXED evidence source with a FIXED projection, FIXED
 * row/byte ceilings and a FIXED admin-permission requirement. The model chooses an
 * entry by id and supplies arguments that a `.strict()` Zod schema has already
 * accepted. The definition contract — including the two allowed evidence sources
 * and why the second one is not a way around the gates — lives in `define.ts`.
 *
 * WHAT IS REGISTERED, AND WHOSE REVIEW IT PASSED:
 *
 *  - the substrate readiness probe (AID-5). Reads NO relation at all. It exists to
 *    prove the plumbing end to end without exposing one row of club data.
 *  - the AID-6A support pack (`packs/support-system.ts`,
 *    `packs/support-correlation.ts`): deployment/configuration/readiness evidence
 *    behind `support:view`, and sanitized audit correlation behind `support:view`
 *    AND the affected domain's own `area:view`.
 *  - the AID-6C finance pack (`packs/finance-search.ts`, `packs/finance-records.ts`,
 *    `packs/finance-state.ts`): bounded record selection and per-record payment,
 *    refund, webhook and Xero evidence behind `finance:view`; a member's Xero
 *    contact linkage behind `finance:view` AND `membership:view`; and the
 *    authoritative booking-finance calculation behind `finance:view` AND
 *    `bookings:view`. It reads only STORED evidence — no tool in it contacts
 *    Stripe, Xero or a bank.
 *  - the AID-6B booking/membership pack (`packs/booking-search.ts`,
 *    `packs/booking-records.ts`, `packs/membership-records.ts`,
 *    `packs/booking-state.ts`): bounded booking and member selection, per-record
 *    booking evidence (party and stay ranges, exception requests, audit history)
 *    behind `bookings:view`, per-record membership evidence (identity,
 *    subscription rows, family and dependent links, audit history) behind
 *    `membership:view`, and three combined entries. AID-6B permission split: 7
 *    booking-only, 6 membership-only, 3 combined.
 *
 *    `booking_bed_allocation_state` is combined: it requires `bookings:view` and
 *    `membership:view` because its double-bed verdict reads live membership and
 *    partner-link facts for both occupants. The other combined entries are a
 *    member's booking involvement and the authoritative booking blocker. The
 *    three `server_owned` answers are booking blockers (`bookings` AND
 *    `membership`), per-night capacity (`bookings`), and member eligibility
 *    (`membership`).
 *
 * Still to come in their own children: AID-7 (#2378, the permission-aware
 * Diagnostics UI and conversation surface, which also owns ADR-004's
 * per-invocation opt-in for any entry declaring `surfacesPersonalData`) and #2379
 * (release hardening and final security testing).
 *
 * ADDING A TOOL (the checklist a reviewer should hold you to):
 *  1. `requiredAreas` names the area(s) that already govern this data in the
 *     admin UI, at `view`. A cross-area tool lists every area (ADR-002 §3 — AND).
 *  2. For `select_only_sql`: `sql` is one statement, no semicolon,
 *     schema-qualified, parameterised. For `server_owned`: `readEvidence` names a
 *     first-party read-only calculation directly, and the pack argues in its own
 *     docblock why a SQL entry could not answer the question.
 *  3. `bind` maps parsed args to parameters positionally; it never formats SQL,
 *     and it returns exactly as many parameters as the SQL references — `$1..$N`,
 *     no gaps. One short is not an error at the database: the executor appends the
 *     row cap as the next `$n`, so a missing parameter silently ALIASES the row cap
 *     onto the entry's own predicate. `registry.test.ts` pins the arity at review
 *     time and `runDiagnosticsReadOnlyQuery` refuses it at runtime.
 *  4. `project` returns ONLY allowlisted columns, as flat scalars, and the SAME
 *     field set for every row (the executor refuses rows whose shapes disagree).
 *     A `Date` is not a flat scalar — a SQL entry formats its timestamps as text in
 *     SQL, and a server-owned one calls `.toISOString()` in its source.
 *  5. Add the relation's `GRANT SELECT` to `SELECT_GRANTS` in `provision-role.ts`
 *     in the SAME pull request, with the COLUMN list where the relation carries
 *     anything the tool should never be able to read, and never a blanket
 *     `ALL TABLES IN SCHEMA` grant.
 *  6. `surfacesPersonalData` is true if any projected field identifies a person;
 *     ADR-004 §1 then requires a per-invocation opt-in from the operator.
 *  7. Any entry that can return more than one row carries a TOTAL `ORDER BY`.
 *     Without one PostgreSQL may return the same rows in a different order run to
 *     run, and the audit `resultHash` — which is the hash of the projected rows in
 *     order — would then differ for identical evidence, making the hash useless
 *     for the "was this the same answer?" question it exists to settle.
 */

import { z } from "zod";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "./define";
import { DIAGNOSTICS_AID6B_BOOKING_RECORD_TOOLS } from "./packs/booking-records";
import { DIAGNOSTICS_AID6B_SEARCH_TOOLS } from "./packs/booking-search";
import { DIAGNOSTICS_AID6B_STATE_TOOLS } from "./packs/booking-state";
import { DIAGNOSTICS_AID6B_MEMBERSHIP_RECORD_TOOLS } from "./packs/membership-records";
import { DIAGNOSTICS_FINANCE_RECORD_TOOLS } from "./packs/finance-records";
import { DIAGNOSTICS_FINANCE_SEARCH_TOOLS } from "./packs/finance-search";
import { DIAGNOSTICS_FINANCE_STATE_TOOLS } from "./packs/finance-state";
import { DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS } from "./packs/support-correlation";
import { DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS } from "./packs/support-system";

/**
 * The substrate readiness probe. Reads NO relation — it asks the session about
 * itself, which is exactly what makes it safe to ship before any tool pack:
 *
 *  - `transaction_read_only` comes back `on` only if the executor really opened
 *    `BEGIN READ ONLY`, so a regression that dropped the read-only transaction
 *    shows up in the probe's own output.
 *  - `statement_timeout` comes back as the executor's `SET LOCAL` value, so a
 *    regression that dropped the timeout is visible the same way.
 *
 * THE TIMEOUT IS REPORTED TWICE, and that is deliberate. PostgreSQL does not echo
 * a GUC back in the units it was set in: `SET LOCAL statement_timeout = 5000`
 * reads back as `5s`, and the real-PostgreSQL proof caught a string assertion that
 * looked right and was not. The raw setting is kept because it is what an operator
 * sees in `psql`, and `statement_timeout_ms` is derived from it in SQL so the
 * control can be pinned NUMERICALLY — `0` means "no timeout at all", which a
 * string comparison against a formatted value would have let through.
 *
 * It requires `support:view` — the same area that already governs
 * `/admin/ai-diagnostics` and the rest of Admin > Support & System.
 */
export const DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID = "diagnostics.substrate_probe";

const substrateProbe = defineDiagnosticsTool({
  id: DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
  source: "select_only_sql",
  label: "Diagnostics read-only database probe",
  description:
    "Confirms the diagnostics read-only database connection is working and correctly restricted. Reads no club data of any kind — it returns only whether the connection is read-only and what query timeout is in force. Use it when asked whether diagnostics database access is set up.",
  requiredAreas: ["support"],
  argsSchema: z.object({}).strict(),
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  // `::int` and not `::bigint`: node-postgres hands a bigint back as a STRING to
  // avoid precision loss, which would arrive at the projection as a non-numeric
  // scalar. A millisecond timeout always fits in int4.
  sql: `SELECT
  true AS probe_ok,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('statement_timeout') AS statement_timeout,
  (EXTRACT(epoch FROM pg_catalog.current_setting('statement_timeout')::interval) * 1000)::int AS statement_timeout_ms`,
  bind: () => [],
  project: (row) => ({
    probeOk: row.probe_ok === true,
    transactionReadOnly: String(row.transaction_read_only ?? ""),
    statementTimeout: String(row.statement_timeout ?? ""),
    // `?? 0` rather than `?? null`: a missing value must project as a number the
    // caller can compare, and 0 is the honest reading of "no timeout reported".
    statementTimeoutMs: Number(row.statement_timeout_ms ?? 0),
  }),
  rowLimit: 1,
  // The probe's honest output is ~95 bytes ("on", "5s", 5000, true). 256 leaves
  // real margin while keeping the ceiling meaningful: a projected value that
  // ballooned would be REFUSED here rather than quietly shipped, which is how a
  // per-tool byte limit is supposed to behave.
  byteLimit: 256,
  surfacesPersonalData: false,
});

/**
 * Every registered tool. Order is presentation only; lookup is by id.
 *
 * Assembled from per-pack arrays rather than declared inline so each pack keeps
 * its own docblock arguing its own permissions, grants and projections — and so
 * two packs landing in parallel touch different files.
 */
export const DIAGNOSTICS_TOOLS: readonly DiagnosticsToolEntry[] = [
  substrateProbe,
  ...DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS,
  ...DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS,
  ...DIAGNOSTICS_FINANCE_SEARCH_TOOLS,
  ...DIAGNOSTICS_FINANCE_RECORD_TOOLS,
  ...DIAGNOSTICS_FINANCE_STATE_TOOLS,
  ...DIAGNOSTICS_AID6B_SEARCH_TOOLS,
  ...DIAGNOSTICS_AID6B_BOOKING_RECORD_TOOLS,
  ...DIAGNOSTICS_AID6B_MEMBERSHIP_RECORD_TOOLS,
  ...DIAGNOSTICS_AID6B_STATE_TOOLS,
];

/** Lookup by id. Returns `undefined` for an unknown key — never a default tool. */
export function findDiagnosticsTool(
  toolId: string,
): DiagnosticsToolEntry | undefined {
  return DIAGNOSTICS_TOOLS.find((tool) => tool.id === toolId);
}
